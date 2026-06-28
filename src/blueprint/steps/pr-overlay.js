/**
 * PR overlay step handlers: purgeMoodleCaches, applyPrOverlay.
 *
 * applyPrOverlay applies the final contents of a pull request's changed files on
 * top of an already-booted, prebuilt Moodle base (whole-file replacement), then
 * purges caches and optionally runs Moodle's upgrade. It powers the "PR Overlay
 * Preview" feature: a Moodle core PR is previewed by booting the base for its
 * target branch and overlaying the changed files at runtime in the browser
 * filesystem — no per-PR WASM bundle is built.
 *
 * See docs/decisions/0016-runtime-pr-file-overlay.md.
 */
import {
  escapePhp,
  phpPurgeMoodleCaches,
  phpRunCoreUpgrade,
} from "../php/helpers.js";
import {
  applyProxy,
  buildPrFilesApiUrl,
  DEFAULT_MAX_OVERLAY_FILE_BYTES,
  DEFAULT_MAX_OVERLAY_FILES,
  DEFAULT_OVERLAY_ROOT,
  joinRoot,
  normalizeOverlayManifest,
  normalizeRunUpgrade,
  overlayNeedsUpgrade,
} from "../pr-overlay.js";
import { checkPhpResult } from "./check-result.js";

export function registerPrOverlaySteps(register) {
  register("purgeMoodleCaches", handlePurgeMoodleCaches);
  register("applyPrOverlay", handleApplyPrOverlay);
}

/**
 * Purge Moodle's caches and reset the component registry. Safe to run after
 * core files are overwritten. Surfaces a failure by throwing (checkPhpResult).
 */
async function handlePurgeMoodleCaches(_step, { php }) {
  const result = await php.run(phpPurgeMoodleCaches());
  checkPhpResult(result, "purgeMoodleCaches");
}

/**
 * Apply a pull request's changed files over the booted Moodle base.
 */
async function handleApplyPrOverlay(step, { php, publish }) {
  const root = step.root || DEFAULT_OVERLAY_ROOT;
  const maxFiles = Number.isFinite(step.maxFiles)
    ? step.maxFiles
    : DEFAULT_MAX_OVERLAY_FILES;
  const maxFileBytes = Number.isFinite(step.maxFileBytes)
    ? step.maxFileBytes
    : DEFAULT_MAX_OVERLAY_FILE_BYTES;
  const runUpgrade = normalizeRunUpgrade(step.runUpgrade);

  // 1. Resolve the manifest: an explicit pre-resolved `files` list, or a
  //    `repo` + `pr` pair fetched from the GitHub API at runtime.
  let rawFiles;
  if (Array.isArray(step.files)) {
    rawFiles = step.files;
  } else if (step.repo && step.pr) {
    if (publish) {
      publish(`Fetching changed files for ${step.repo}#${step.pr}…`, 0.93);
    }
    rawFiles = await fetchPrFiles(step.repo, step.pr, step.proxy);
  } else {
    throw new Error(
      "applyPrOverlay: provide a 'files' manifest, or both 'repo' and 'pr'.",
    );
  }

  const ops = normalizeOverlayManifest(rawFiles);
  if (ops.length > maxFiles) {
    throw new Error(
      `applyPrOverlay: ${ops.length} changed files exceed maxFiles=${maxFiles}.`,
    );
  }

  // 2. Apply each operation. Whole-file replacement handles add/modify/remove/
  //    rename predictably; paths were validated by normalizeOverlayManifest.
  //    Each file is applied independently: a single unreachable / oversized /
  //    failed file is skipped with a visible warning rather than aborting the
  //    whole preview (so the remaining files and the login step still run).
  let written = 0;
  let removed = 0;
  let skipped = 0;
  for (const op of ops) {
    try {
      if (op.status === "removed") {
        await deletePath(php, joinRoot(root, op.path));
        removed++;
      } else if (op.status === "renamed") {
        await deletePath(php, joinRoot(root, op.previousPath));
        const bytes = await fetchBytes(op.rawUrl, step.proxy, maxFileBytes);
        await writePath(php, joinRoot(root, op.path), bytes);
        written++;
      } else {
        // added | modified
        const bytes = await fetchBytes(op.rawUrl, step.proxy, maxFileBytes);
        await writePath(php, joinRoot(root, op.path), bytes);
        written++;
      }
    } catch (err) {
      skipped++;
      if (publish) {
        publish(
          `Overlay: skipped ${op.path} (${String(err?.message || err).slice(0, 160)})`,
          0.94,
        );
      }
    }
  }
  if (publish) {
    publish(
      `Overlay applied: ${written} written, ${removed} removed${
        skipped ? `, ${skipped} skipped` : ""
      }.`,
      0.94,
    );
  }

  // 3. Purge caches by default (core files just changed under MUC's feet).
  if (step.purgeCaches !== false) {
    await runPhpGraceful(
      php,
      phpPurgeMoodleCaches(),
      "applyPrOverlay cache purge",
      publish,
    );
  }

  // 4. Run the upgrade according to runUpgrade (off | on | auto).
  const shouldUpgrade =
    runUpgrade === "on" || (runUpgrade === "auto" && overlayNeedsUpgrade(ops));
  if (shouldUpgrade) {
    if (publish) publish("Running Moodle upgrade after overlay…", 0.945);
    const res = await runPhpGraceful(
      php,
      phpRunCoreUpgrade(),
      "applyPrOverlay upgrade",
      publish,
    );
    if (!res.ok && publish) {
      publish(
        "Moodle upgrade did not complete cleanly; this runtime preview may be " +
          "partial (SQLite/WASM has lower schema-upgrade fidelity). See KNOWN-ISSUES.",
        0.95,
      );
    }
  }
}

/**
 * Delete a file if it exists. Idempotent (a missing file is not an error), but a
 * real unlink failure is surfaced via checkPhpResult.
 */
async function deletePath(php, fullPath) {
  const result = await php.run(`<?php
$p = '${escapePhp(fullPath)}';
if (!file_exists($p)) { echo json_encode(['ok' => true, 'skipped' => true]); }
else if (@unlink($p)) { echo json_encode(['ok' => true]); }
else { echo json_encode(['ok' => false, 'error' => 'Could not delete ' . $p]); }
`);
  checkPhpResult(result, "applyPrOverlay:delete");
}

/**
 * Write bytes to a path, creating parent directories first. Binary-safe: bytes
 * are written verbatim via php.writeFile().
 */
async function writePath(php, fullPath, bytes) {
  const parent = fullPath.substring(0, fullPath.lastIndexOf("/"));
  if (parent) {
    if (php._php?.mkdirTree) {
      php._php.mkdirTree(parent);
    } else {
      await php.run(`<?php @mkdir('${escapePhp(parent)}', 0777, true);`);
    }
  }
  await php.writeFile(fullPath, bytes);
}

/**
 * Fetch a single file's bytes, optionally through a proxy, enforcing a per-file
 * size cap.
 */
async function fetchBytes(rawUrl, proxy, maxBytes) {
  const target = applyProxy(rawUrl, proxy);
  const res = await fetch(target);
  if (!res.ok) {
    throw new Error(
      `applyPrOverlay: failed to fetch ${rawUrl} (HTTP ${res.status}).`,
    );
  }
  // Reject oversized files by their declared length before buffering the body,
  // so a huge blob never gets fully materialized into the worker heap.
  if (maxBytes) {
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(
        `applyPrOverlay: ${rawUrl} is ${declared} bytes (> maxFileBytes=${maxBytes}).`,
      );
    }
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (maxBytes && bytes.byteLength > maxBytes) {
    throw new Error(
      `applyPrOverlay: ${rawUrl} is ${bytes.byteLength} bytes (> maxFileBytes=${maxBytes}).`,
    );
  }
  return bytes;
}

/**
 * Fetch the changed-files manifest for a PR from the GitHub REST API, following
 * pagination. Each entry's raw_url is already pinned to the PR head SHA.
 */
async function fetchPrFiles(repo, pr, proxy) {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const url = applyProxy(buildPrFilesApiUrl(repo, pr, { page }), proxy);
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(
        `applyPrOverlay: GitHub API returned HTTP ${res.status} for ${repo}#${pr}.`,
      );
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const f of batch) {
      out.push({
        path: f.filename,
        status: f.status,
        rawUrl: f.raw_url || null,
        previousPath: f.previous_filename || null,
        size: null,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * Run a PHP generator, treating failures as non-fatal: a crash (non-zero exit)
 * or a JSON {"ok":false} result is reported via publish() instead of aborting
 * the blueprint, because the overlay files are already in place.
 */
async function runPhpGraceful(php, code, label, publish) {
  let result;
  try {
    result = await php.run(code);
  } catch (err) {
    if (publish) {
      publish(
        `${label} crashed: ${String(err?.message || err).slice(0, 200)}`,
        0.95,
      );
    }
    return { ok: false, crashed: true };
  }
  const text = result?.text || "";
  if (result?.errors && publish) {
    publish(`${label} warnings: ${String(result.errors).slice(0, 200)}`, 0.95);
  }
  const ok = !text.includes('"ok":false');
  return { ok, text };
}
