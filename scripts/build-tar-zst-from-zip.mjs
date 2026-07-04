#!/usr/bin/env node
//
// build-tar-zst-from-zip.mjs — convert the built, trimmed, tripwire-verified core
// ZIP into the streaming `tar.zst` bundle the runtime extracts (ADR 0018/0019).
//
// Converting the ZIP (rather than re-deriving the trim as file deletions) keeps
// scripts/build-moodle-bundle.sh's exclusion list + PHP-parity/required-file
// tripwires exactly as they are — the ZIP is still the source of truth, we only
// re-container it. The tar is deterministic USTAR + GNU longlink (never PAX,
// which the streaming parser + PharData do not read), zstd level 19 with
// long-distance matching (windowLog 24) for strong cross-file dedup while
// keeping the client-side decode window small (see ADR 0019).
//
// Requires Node >= 22.15 (native node:zlib zstd); CI builds on Node 24 LTS.
//
// Usage: node scripts/build-tar-zst-from-zip.mjs <in.zip> <out.tar.zst>
// Prints JSON: { fileCount, bytes, sha256 }

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { unzipSync } from "fflate";
import { createUstarTar, normalizeEntries } from "./lib/tar-ustar.mjs";

if (typeof zlib.zstdCompressSync !== "function") {
  console.error(
    "Node >= 22.15 (native node:zlib zstd) is required to build tar.zst bundles.",
  );
  process.exit(1);
}

const [zipPath, outPath] = process.argv.slice(2);
if (!zipPath || !outPath) {
  console.error("Usage: build-tar-zst-from-zip.mjs <in.zip> <out.tar.zst>");
  process.exit(1);
}

const entries = normalizeEntries(unzipSync(readFileSync(zipPath)));
const tar = createUstarTar(entries, { mtime: 0 });
const compressed = zlib.zstdCompressSync(tar, {
  params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 19,
    [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
    // windowLog 24 (16 MiB) rather than 27 (128 MiB): measured on the 250.6 MiB
    // MOODLE_500_STABLE tree, wlog 24 costs only +0.90% size (34.61 -> 34.92 MiB)
    // in exchange for an 8x smaller zstd decode window that the zstddec decoder
    // must allocate on EVERY client (Firefox/Safari, where native
    // DecompressionStream("zstd") is absent). See ADR 0019.
    [zlib.constants.ZSTD_c_windowLog]: 24,
  },
});
writeFileSync(outPath, compressed);
console.log(
  JSON.stringify({
    fileCount: entries.length,
    bytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
  }),
);
