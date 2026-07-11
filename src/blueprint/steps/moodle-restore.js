/**
 * Course restore step: restoreCourse.
 *
 * Restores a Moodle course backup (.mbz) into a category using Moodle's own
 * restore_controller. The backup can come from a URL (downloaded inside PHP,
 * streamed straight to MEMFS — the memory-efficient path for large files), an
 * existing MEMFS path, or embedded resource data.
 *
 * Large/complex backups can fail (in-browser memory limits and SQLite-WASM
 * transaction limits); failures are reported gracefully and never abort the
 * blueprint. See docs/architecture/adr/ADR-0007-course-restore-step.md.
 */

import { phpRestoreCourse } from "../php/helpers.js";

// Per-session counter for unique temp paths when restoring from embedded data
// or a browser-side download.
let embeddedRestoreCounter = 0;

// A course backup is downloaded browser-side (native fetch) instead of inside
// PHP when it fits this budget. PHP's download_file_content() runs over the
// tcpOverFetch bridge, which is ~35x slower than a native fetch for a bulk
// transfer (measured: ~30s vs ~1s for a 20 MB .mbz); the native fetch also
// exposes streaming progress. Larger or non-CORS backups fall back to the PHP
// path, which streams straight to MEMFS without a large JS buffer.
const MAX_BROWSER_BACKUP_BYTES = 50 * 1024 * 1024;

export function registerMoodleRestoreSteps(register) {
  register("restoreCourse", handleRestoreCourse);
}

function trimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Download a course backup browser-side (native fetch) into a MEMFS file,
 * reporting progress. Returns the MEMFS path on success, or null if the fast
 * path is not applicable (network/CORS error, or larger than the size budget) —
 * the caller then falls back to the in-PHP download.
 *
 * @returns {Promise<string|null>}
 */
async function downloadBackupToMemfs(url, context) {
  const { php, publish } = context;
  const fetchImpl = context.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response?.ok) {
    throw new Error(`HTTP ${response?.status ?? "error"}`);
  }

  const total = Number(response.headers?.get?.("content-length")) || 0;
  if (total && total > MAX_BROWSER_BACKUP_BYTES) {
    throw new Error(`backup is ${formatMb(total)} MB (over browser budget)`);
  }

  const reader = response.body?.getReader?.();
  let bytes;
  if (reader) {
    const chunks = [];
    let loaded = 0;
    let lastPct = -10;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      loaded += value.length;
      if (loaded > MAX_BROWSER_BACKUP_BYTES) {
        throw new Error("backup exceeds the browser size budget");
      }
      if (publish && total) {
        const pct = Math.floor((loaded / total) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          publish(
            `Downloading course backup… ${pct}% (${formatMb(loaded)}/${formatMb(total)} MB)`,
            0.93,
          );
        }
      }
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    // No streaming body available — fall back to a buffered read.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BROWSER_BACKUP_BYTES) {
      throw new Error("backup exceeds the browser size budget");
    }
    bytes = new Uint8Array(buffer);
  }

  if (bytes.length < 1000) {
    throw new Error("downloaded backup is too small");
  }

  const memfsPath = `/tmp/restore_dl_${++embeddedRestoreCounter}.mbz`;
  await php.writeFile(memfsPath, bytes);
  if (publish) {
    publish(`Downloaded course backup (${formatMb(bytes.length)} MB).`, 0.94);
  }
  return memfsPath;
}

async function handleRestoreCourse(step, context) {
  const { php, publish, resources } = context;

  const url = trimmedString(step.url);
  const path = trimmedString(step.path);
  const hasData =
    step.data !== undefined && step.data !== null && step.data !== "";

  if (!url && !path && !hasData) {
    throw new Error(
      "restoreCourse: one of 'url', 'path', or 'data' is required.",
    );
  }
  if (url && !/^https?:\/\//iu.test(url)) {
    throw new Error("restoreCourse: 'url' must be an http(s) URL.");
  }

  if (publish) {
    publish(
      "Restoring course backup — large or complex backups may exceed the in-browser runtime and fail.",
      0.93,
    );
  }

  // Resolve the backup source into options for the PHP generator. Precedence:
  // url > path > embedded data.
  const opts = {
    category: trimmedString(step.category),
    createCategory: step.createCategory !== false,
    fullname: trimmedString(step.fullname),
    shortname: trimmedString(step.shortname),
    visible: step.visible !== false,
  };

  if (url) {
    // Prefer a fast browser-side download (with progress); fall back to the
    // in-PHP streamed download for non-CORS or oversized backups.
    try {
      const downloadedPath = await downloadBackupToMemfs(url, context);
      if (downloadedPath) {
        opts.localPath = downloadedPath;
        opts.cleanupSource = true;
      } else {
        opts.downloadUrl = url;
      }
    } catch (err) {
      if (publish) {
        publish(
          `Fast backup download unavailable (${String(err.message || err).slice(0, 120)}); using in-PHP download.`,
          0.93,
        );
      }
      opts.downloadUrl = url;
    }
  } else if (path) {
    opts.localPath = path;
  } else {
    // Embedded backup: resolve via the resource registry and write to MEMFS.
    // This buffers the whole file in JS, so it is only suitable for small
    // backups — large ones should use `url`.
    const bytes = await resources.resolve(step.data);
    const tempPath = `/tmp/restore_${++embeddedRestoreCounter}.mbz`;
    await php.writeFile(tempPath, bytes);
    opts.localPath = tempPath;
  }

  let result;
  try {
    result = await php.run(phpRestoreCourse(opts));
  } catch (err) {
    // A hard failure (e.g. OOM, nested-savepoint crash) can throw. Don't abort
    // the blueprint — the course is a non-critical add-on.
    if (publish) {
      publish(
        `Course restore crashed: ${String(err.message || err).slice(0, 200)}`,
        0.94,
      );
    }
    return;
  }

  const text = result?.text || "";
  if (publish) {
    if (text.includes('"ok":true')) {
      const idMatch = text.match(/"courseid":(\d+)/u);
      publish(`Course restored${idMatch ? ` (id ${idMatch[1]})` : ""}.`, 0.94);
      // Surface the per-phase restore breakdown (download / extract / precheck /
      // execute / finalize) so the slowest part is observable. Machine-readable
      // and delimited; carries no payload or secrets. See issue #249.
      const timings = parseRestoreTimings(text);
      if (timings) {
        publish(
          `[restore-perf] ${JSON.stringify(timings)} [/restore-perf]`,
          0.94,
        );
      }
    } else {
      publish(`Course restore reported issues: ${text.slice(0, 200)}`, 0.94);
    }
  }
}

/**
 * Extract the `timings` object from the restore PHP result JSON without trusting
 * the whole payload to be clean JSON (Moodle can emit stray output before it).
 * @returns {object|null}
 */
function parseRestoreTimings(text) {
  const match = text.match(/"timings"\s*:\s*(\{[^}]*\})/u);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export const __testables = { trimmedString };
