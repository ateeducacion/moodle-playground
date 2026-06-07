#!/usr/bin/env node
//
// chunk-bundles.mjs — split oversized bundle zips in a built _site into parts
// small enough for hosts with a per-file size cap (Cloudflare Pages: 25 MiB/file).
//
// The Moodle core bundles are ~170–240 MB single zips, far above Cloudflare's
// hard 25 MiB per-file limit. The PHP build and generate-manifest.mjs are left
// untouched; this runs as a post-processing pass over the assembled _site:
//   1. For each channel manifest whose bundle zip exceeds the cap, split the zip
//      into `<zip>.part-NNN` siblings (<= PART_SIZE each).
//   2. Rewrite every manifest that references that zip to
//      { format: "zip-parts", parts: [{ path, size, sha256 }], totalSize, sha256 }.
//   3. Delete the original oversized zip.
// The loader (lib/moodle-loader.js) reassembles the parts and verifies the
// overall sha256 — identical bytes to the original zip.
//
// Notes:
//   - Several manifests can point at the same zip (e.g. latest.json == the
//     default channel), so each unique zip is split exactly once and all
//     referencing manifests are rewritten.
//   - Idempotent: manifests already in "zip-parts" format are skipped.
//   - Fails loudly if, after splitting, any file in _site still exceeds the cap.
//
// Usage: node scripts/chunk-bundles.mjs [siteDir]   (default: _site)

import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SITE = process.argv[2] || "_site";
const MIB = 1024 * 1024;
const MAX_FILE = 25 * MIB; // Cloudflare Pages hard per-file limit
const PART_SIZE = 24 * MIB; // keep each part comfortably under the cap

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const partSuffix = (i) => `.part-${String(i).padStart(3, "0")}`;

function listManifests(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(dir, e.name));
}

function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}

// Split a zip into part files on disk and return the parts metadata. Cached so a
// zip shared by multiple manifests is only split once.
const splitCache = new Map();
function splitZip(zipAbs, relPath, expectedSha) {
  if (splitCache.has(zipAbs)) return splitCache.get(zipAbs);

  const data = readFileSync(zipAbs);
  const overall = sha256(data);
  if (expectedSha && overall !== String(expectedSha).toLowerCase()) {
    throw new Error(
      `${basename(zipAbs)}: sha256 mismatch vs manifest (${overall} != ${expectedSha})`,
    );
  }

  const parts = [];
  let index = 0;
  for (let offset = 0; offset < data.length; offset += PART_SIZE) {
    const slice = data.subarray(
      offset,
      Math.min(offset + PART_SIZE, data.length),
    );
    const partAbs = zipAbs + partSuffix(index);
    writeFileSync(partAbs, slice);
    parts.push({
      path: relPath + partSuffix(index),
      size: slice.length,
      sha256: sha256(slice),
    });
    index += 1;
  }

  const result = { parts, totalSize: data.length, sha256: overall };
  splitCache.set(zipAbs, result);
  return result;
}

function scanOversized(dir) {
  const offenders = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const s = fileSize(p);
        if (s > MAX_FILE) offenders.push([p, s]);
      }
    }
  };
  walk(dir);
  return offenders;
}

// ── main ──
const manifestFiles = listManifests(join(SITE, "assets", "manifests"));
const zipsToDelete = new Set();
const rewritten = [];

try {
  for (const manifestFile of manifestFiles) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const bundle = manifest.bundle;
    if (!bundle || !bundle.path || bundle.format === "zip-parts") continue;

    const zipAbs = resolve(dirname(manifestFile), bundle.path);
    const size = fileSize(zipAbs);
    if (size < 0 || size <= MAX_FILE) continue; // missing or small enough

    const {
      parts,
      totalSize,
      sha256: overall,
    } = splitZip(zipAbs, bundle.path, bundle.sha256);

    const newBundle = {
      format: "zip-parts",
      fileName: bundle.fileName ?? basename(bundle.path),
      size: totalSize,
      totalSize,
      sha256: overall,
      partSize: PART_SIZE,
      parts,
    };
    if (bundle.fileCount !== undefined) newBundle.fileCount = bundle.fileCount;
    manifest.bundle = newBundle;

    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    zipsToDelete.add(zipAbs);
    rewritten.push({
      manifest: basename(manifestFile),
      parts: parts.length,
      mib: totalSize / MIB,
    });
  }

  for (const zip of zipsToDelete) rmSync(zip);
} catch (err) {
  console.error(`chunk-bundles: ${err.message}`);
  process.exit(1);
}

for (const r of rewritten) {
  console.log(
    `chunk-bundles: ${r.manifest} -> ${r.parts} parts (${r.mib.toFixed(0)} MiB)`,
  );
}
if (rewritten.length === 0)
  console.log("chunk-bundles: no oversized bundles to split");

const offenders = scanOversized(SITE);
if (offenders.length > 0) {
  console.error("chunk-bundles: files still exceed the 25 MiB per-file limit:");
  for (const [p, s] of offenders)
    console.error(`  ${(s / MIB).toFixed(1)} MiB  ${p}`);
  process.exit(1);
}
console.log(
  `chunk-bundles: OK — all files within the ${MAX_FILE / MIB} MiB per-file limit`,
);
