// compression-metrics.mjs — pure helpers for the core-bundle format experiment.
//
// Kept dependency-free and side-effect-free so they can be unit-tested directly
// (see tests/scripts/compression-metrics.test.js). The chunk constants mirror
// scripts/chunk-bundles.mjs (Cloudflare Pages 25 MiB per-file cap).

import zlib from "node:zlib";

export const MIB = 1024 * 1024;
export const MAX_FILE = 25 * MIB; // Cloudflare Pages hard per-file limit
export const PART_SIZE = 24 * MIB; // each split part is kept under the cap

/**
 * Number of hosted files an artifact of `bytes` becomes after chunk-bundles.mjs.
 * Artifacts at or below the per-file cap are hosted whole (1 file); larger ones
 * are split into ceil(bytes / PART_SIZE) parts. Matches chunk-bundles.mjs, which
 * only splits when the size strictly exceeds MAX_FILE.
 */
export function chunkCountFor(bytes, partSize = PART_SIZE, maxFile = MAX_FILE) {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  if (bytes <= maxFile) return 1;
  return Math.ceil(bytes / partSize);
}

/**
 * Ratio-vs-tar and delta-vs-zip figures for one candidate row.
 * - compressionRatioVsTar: how many times smaller than the uncompressed tar.
 * - sizeDeltaVsZipBytes / Percent: signed difference against the ZIP baseline
 *   (negative = smaller than ZIP, the desired direction).
 */
export function ratioAndDeltas(bytes, tarBytes, zipBytes) {
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    compressionRatioVsTar: tarBytes ? round2(tarBytes / bytes) : null,
    sizeDeltaVsZipBytes: Number.isFinite(zipBytes) ? bytes - zipBytes : null,
    sizeDeltaVsZipPercent:
      Number.isFinite(zipBytes) && zipBytes > 0
        ? round2((100 * (bytes - zipBytes)) / zipBytes)
        : null,
  };
}

/**
 * Which codecs the current JS runtime can drive natively, plus the underlying
 * library versions. zstd landed in node:zlib in Node 22.15 / 23.8, so on Node 20
 * `zstd` is false here and the experiment must fall back to the zstd CLI.
 */
export function detectCodecCapabilities() {
  return {
    zstd: typeof zlib.zstdCompressSync === "function",
    brotli: typeof zlib.brotliCompressSync === "function",
    gzip: typeof zlib.gzipSync === "function",
    zstdLibraryVersion: process.versions.zstd || null,
    brotliLibraryVersion: process.versions.brotli || null,
  };
}

/**
 * Extract the first semantic version from a CLI `--version` banner, e.g.
 * "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***" -> "1.5.7".
 * Returns null when no version-like token is present.
 */
export function parseCliVersion(text) {
  if (!text) return null;
  const match = String(text).match(/v?(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}
