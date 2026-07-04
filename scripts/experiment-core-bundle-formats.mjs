#!/usr/bin/env node
//
// experiment-core-bundle-formats.mjs — Layer 1 of the solid-compression
// experiment (ADR 0018). Takes the ALREADY-BUILT `moodle-core-*.zip` for a
// branch, extracts it in memory, repacks the identical file tree into candidate
// container/codec combinations, and reports storage metrics.
//
// Why repack the built zip (not re-read .cache/moodle/<branch>): the built zip is
// the only artifact that already survived the full pipeline — composer --no-dev,
// runtime patches, and the ~40-line zip-time exclusion allowlist + tripwires in
// build-moodle-bundle.sh. Re-deriving that file set with a find filter would drift
// (root-anchored patterns like `README.md` vs `*/README*`). Repacking guarantees
// the ONLY variable across archives is container + codec.
//
// Output: <out>/results.json (machine-readable) + <out>/summary.md (human table).
// The compressed binaries are written under <out> too but are gitignored.
//
// Usage:
//   node scripts/experiment-core-bundle-formats.mjs --branch MOODLE_500_STABLE
//   node scripts/experiment-core-bundle-formats.mjs --branch MOODLE_500_STABLE --runtime bun
//   node scripts/experiment-core-bundle-formats.mjs --branch MOODLE_500_STABLE --formats tar.zst,tar.br
//   bun scripts/experiment-core-bundle-formats.mjs --branch MOODLE_500_STABLE --runtime bun

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import { unzipSync } from "fflate";
import {
  chunkCountFor,
  detectCodecCapabilities,
  parseCliVersion,
  ratioAndDeltas,
} from "./lib/compression-metrics.mjs";
import { createUstarTar, normalizeEntries } from "./lib/tar-ustar.mjs";

// --- args --------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true; // boolean flag
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const branch = args.branch || "MOODLE_500_STABLE";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const outDir = resolve(
  args.out || join(repoRoot, "artifacts", "compression-experiment", branch),
);
const writeArtifacts = args["no-artifacts"] !== true;
const zstdLevels = (
  args.levels ? String(args.levels).split(",") : ["19", "22"]
).map((s) => Number.parseInt(s, 10));

const isBun = typeof process.versions.bun === "string";
const runtimeName = args.runtime || (isBun ? "bun" : "node");
const runtimeVersion = isBun ? `bun ${process.versions.bun}` : process.version;

// --- helpers -----------------------------------------------------------------

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function cliVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], { encoding: "utf8" });
    return parseCliVersion(out);
  } catch {
    return null;
  }
}

function hasCli(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const caps = detectCodecCapabilities();

// zstd: prefer node:zlib (Node >=22.15 / Bun), then Bun global, then the CLI.
function compressZstd(tar, level) {
  const t0 = performance.now();
  if (caps.zstd) {
    const out = zlib.zstdCompressSync(tar, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: level,
        [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
        [zlib.constants.ZSTD_c_windowLog]: 27,
      },
    });
    return {
      bytes: out,
      ms: performance.now() - t0,
      engine: "js",
      library: "node:zlib",
      libraryVersion: caps.zstdLibraryVersion,
    };
  }
  if (
    typeof globalThis.Bun !== "undefined" &&
    typeof globalThis.Bun.zstdCompressSync === "function"
  ) {
    const out = globalThis.Bun.zstdCompressSync(tar, { level });
    return {
      bytes: Buffer.from(out),
      ms: performance.now() - t0,
      engine: "js-bun",
      library: "Bun",
      libraryVersion: process.versions.bun,
    };
  }
  // CLI fallback (e.g. Node 20, which has no native zstd). --long matches the
  // node:zlib long-distance-matching option; --ultra unlocks levels >19.
  if (!hasCli("zstd"))
    throw new Error("zstd unavailable: no node:zlib, no Bun, no CLI");
  const flags = [`-${level}`, "--long=27", "-c"];
  if (level > 19) flags.unshift("--ultra");
  const out = execFileSync("zstd", flags, {
    input: tar,
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  return {
    bytes: out,
    ms: performance.now() - t0,
    engine: "cli",
    library: "zstd-cli",
    libraryVersion: cliVersion("zstd"),
  };
}

function compressBrotli(tar, quality = 11) {
  const t0 = performance.now();
  if (caps.brotli) {
    const out = zlib.brotliCompressSync(tar, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: tar.length,
      },
    });
    return {
      bytes: out,
      ms: performance.now() - t0,
      engine: "js",
      library: "node:zlib",
      libraryVersion: caps.brotliLibraryVersion,
    };
  }
  if (!hasCli("brotli"))
    throw new Error("brotli unavailable: no node:zlib, no CLI");
  const out = execFileSync("brotli", [`-q`, String(quality), "-c"], {
    input: tar,
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  return {
    bytes: out,
    ms: performance.now() - t0,
    engine: "cli",
    library: "brotli-cli",
    libraryVersion: cliVersion("brotli"),
  };
}

function compressGzip(tar, level = 9) {
  const t0 = performance.now();
  const out = zlib.gzipSync(tar, { level });
  return {
    bytes: out,
    ms: performance.now() - t0,
    engine: "js",
    library: "node:zlib",
    libraryVersion: process.versions.zlib || null,
  };
}

// --- locate + extract the built zip ------------------------------------------

function findBuiltZip() {
  if (args.zip) return resolve(args.zip);
  const dir = join(repoRoot, "assets", "moodle", branch);
  if (!existsSync(dir))
    throw new Error(
      `No built bundle dir for ${branch}: ${dir}. Run \`BRANCH=${branch} npm run bundle\` first.`,
    );
  const zips = readdirSync(dir).filter(
    (f) => f.startsWith("moodle-core-") && f.endsWith(".zip"),
  );
  if (zips.length === 0)
    throw new Error(
      `No moodle-core-*.zip in ${dir}. Run \`BRANCH=${branch} npm run bundle\` first.`,
    );
  return join(dir, zips[0]);
}

console.log(
  `[experiment] branch=${branch} runtime=${runtimeName} (${runtimeVersion})`,
);
const zipPath = findBuiltZip();
const zipBuf = readFileSync(zipPath);
const zipBytes = zipBuf.length;
const zipSha = sha256(zipBuf);
console.log(
  `[experiment] baseline zip: ${basename(zipPath)} = ${zipBytes} bytes`,
);

console.log("[experiment] extracting zip in memory (fflate)…");
const tExtract0 = performance.now();
const fileMap = unzipSync(zipBuf);
const entries = normalizeEntries(fileMap);
const sourceUncompressedBytes = entries.reduce(
  (sum, e) => sum + e.data.length,
  0,
);
console.log(
  `[experiment] ${entries.length} files, ${sourceUncompressedBytes} uncompressed bytes (${(performance.now() - tExtract0).toFixed(0)} ms)`,
);

console.log("[experiment] building canonical deterministic tar…");
const tTar0 = performance.now();
const tarBuf = createUstarTar(entries, { mtime: 0 });
const tarBuildMs = performance.now() - tTar0;
const tarBytes = tarBuf.length;
console.log(
  `[experiment] tar = ${tarBytes} bytes (${tarBuildMs.toFixed(0)} ms)`,
);

// --- build the requested format rows -----------------------------------------

const requested = args.formats
  ? new Set(String(args.formats).split(","))
  : null;
const want = (fmt) => !requested || requested.has(fmt);

if (writeArtifacts) mkdirSync(outDir, { recursive: true });

/** Push one result row and optionally persist the artifact. */
function makeRow({
  format,
  container,
  codec,
  level,
  bytes,
  ms,
  engine,
  library,
  libraryVersion,
  fileName,
}) {
  if (writeArtifacts && fileName) writeFileSync(join(outDir, fileName), bytes);
  return {
    format,
    container,
    codec,
    compressionLevel: level,
    codecEngine: engine,
    codecLibrary: library,
    codecLibraryVersion: libraryVersion ?? null,
    path: fileName
      ? `artifacts/compression-experiment/${branch}/${fileName}`
      : null,
    fileName: fileName ?? basename(zipPath),
    bytes: bytes.length,
    sha256: sha256(bytes),
    fileCount: entries.length,
    buildRuntime: runtimeName,
    buildRuntimeVersion: runtimeVersion,
    buildMilliseconds: ms === null ? null : Math.round(ms),
    chunkCountAt24MiB: chunkCountFor(bytes.length),
    ...ratioAndDeltas(bytes.length, tarBytes, zipBytes),
  };
}

const results = [];

// zip baseline (already built; not compressed by us).
if (want("zip")) {
  results.push(
    makeRow({
      format: "zip",
      container: "zip",
      codec: "deflate",
      level: "deflate",
      bytes: zipBuf,
      ms: null,
      engine: "prebuilt",
      library: "info-zip",
      libraryVersion: null,
      fileName: null,
    }),
  );
}

// tar reference (incompressible baseline for the ratio column).
if (want("tar")) {
  results.push(
    makeRow({
      format: "tar",
      container: "tar",
      codec: "none",
      level: "none",
      bytes: tarBuf,
      ms: tarBuildMs,
      engine: runtimeName,
      library: "tar-ustar.mjs",
      libraryVersion: null,
      fileName: "moodle-core.tar",
    }),
  );
}

// tar.zst — the primary candidate, one row per level.
for (const level of zstdLevels) {
  const fmt = level === zstdLevels[0] ? "tar.zst" : `tar.zst-l${level}`;
  if (!want("tar.zst") && !want(fmt)) continue;
  try {
    const z = compressZstd(tarBuf, level);
    const fileName =
      level === zstdLevels[0]
        ? "moodle-core.tar.zst"
        : `moodle-core-l${level}.tar.zst`;
    results.push(
      makeRow({
        format: fmt,
        container: "tar",
        codec: "zstd",
        level: `${level}+ldm+wlog27`,
        bytes: z.bytes,
        ms: z.ms,
        engine: z.engine,
        library: z.library,
        libraryVersion: z.libraryVersion,
        fileName,
      }),
    );
    console.log(
      `[experiment] ${fmt}: ${z.bytes.length} bytes (${Math.round(z.ms)} ms, ${z.engine})`,
    );
  } catch (err) {
    console.warn(`[experiment] ${fmt} skipped: ${err.message}`);
    results.push({
      format: fmt,
      container: "tar",
      codec: "zstd",
      compressionLevel: `${level}`,
      codecEngine: "unsupported",
      error: err.message,
      buildRuntime: runtimeName,
      buildRuntimeVersion: runtimeVersion,
    });
  }
}

// tar.br — primary candidate (brotli quality 11).
if (want("tar.br")) {
  try {
    const b = compressBrotli(tarBuf, 11);
    results.push(
      makeRow({
        format: "tar.br",
        container: "tar",
        codec: "brotli",
        level: "q11+lgwin24",
        bytes: b.bytes,
        ms: b.ms,
        engine: b.engine,
        library: b.library,
        libraryVersion: b.libraryVersion,
        fileName: "moodle-core.tar.br",
      }),
    );
    console.log(
      `[experiment] tar.br: ${b.bytes.length} bytes (${Math.round(b.ms)} ms, ${b.engine})`,
    );
  } catch (err) {
    console.warn(`[experiment] tar.br skipped: ${err.message}`);
  }
}

// tar.gz — cross-browser decode control (gzip decodes natively everywhere).
if (want("tar.gz")) {
  const g = compressGzip(tarBuf, 9);
  results.push(
    makeRow({
      format: "tar.gz",
      container: "tar",
      codec: "gzip",
      level: "9",
      bytes: g.bytes,
      ms: g.ms,
      engine: g.engine,
      library: g.library,
      libraryVersion: g.libraryVersion,
      fileName: "moodle-core.tar.gz",
    }),
  );
  console.log(
    `[experiment] tar.gz: ${g.bytes.length} bytes (${Math.round(g.ms)} ms)`,
  );
}

// zip.zst / zip.br — SECONDARY, size-only. Compressing an already-compressed zip
// is expected to gain little; kept for completeness. Not a real ".zip" a reader
// can open without first decompressing.
if (want("zip.zst")) {
  try {
    const z = compressZstd(zipBuf, zstdLevels[0]);
    results.push(
      makeRow({
        format: "zip.zst",
        container: "zip",
        codec: "zstd",
        level: `${zstdLevels[0]}`,
        bytes: z.bytes,
        ms: z.ms,
        engine: z.engine,
        library: z.library,
        libraryVersion: z.libraryVersion,
        fileName: "moodle-core.zip.zst",
      }),
    );
    console.log(`[experiment] zip.zst: ${z.bytes.length} bytes`);
  } catch (err) {
    console.warn(`[experiment] zip.zst skipped: ${err.message}`);
  }
}
if (want("zip.br")) {
  try {
    const b = compressBrotli(zipBuf, 11);
    results.push(
      makeRow({
        format: "zip.br",
        container: "zip",
        codec: "brotli",
        level: "q11",
        bytes: b.bytes,
        ms: b.ms,
        engine: b.engine,
        library: b.library,
        libraryVersion: b.libraryVersion,
        fileName: "moodle-core.zip.br",
      }),
    );
    console.log(`[experiment] zip.br: ${b.bytes.length} bytes`);
  } catch (err) {
    console.warn(`[experiment] zip.br skipped: ${err.message}`);
  }
}

// --- reports -----------------------------------------------------------------

const report = {
  branch,
  generatedAt: new Date().toISOString(),
  sourceFileCount: entries.length,
  sourceUncompressedBytes,
  baseline: {
    format: "zip",
    fileName: basename(zipPath),
    bytes: zipBytes,
    sha256: zipSha,
    fileCount: entries.length,
  },
  tar: { bytes: tarBytes, buildMilliseconds: Math.round(tarBuildMs) },
  host: {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    memBytes: os.totalmem(),
    runtime: runtimeName,
    runtimeVersion,
  },
  codecCapabilities: caps,
  results,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "results.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

// summary.md — table sorted by bytes ascending.
const fmtBytes = (n) => `${(n / 1048576).toFixed(2)} MiB`;
const rows = results
  .filter((r) => Number.isFinite(r.bytes))
  .slice()
  .sort((a, b) => a.bytes - b.bytes)
  .map((r) => {
    const delta =
      r.sizeDeltaVsZipPercent == null
        ? "—"
        : `${r.sizeDeltaVsZipPercent > 0 ? "+" : ""}${r.sizeDeltaVsZipPercent}%`;
    const buildMs =
      r.buildMilliseconds == null ? "—" : `${r.buildMilliseconds} ms`;
    return `| ${r.format} | ${r.compressionLevel} | ${fmtBytes(r.bytes)} | ${r.bytes} | ${delta} | ${r.chunkCountAt24MiB} | ${buildMs} | ${r.codecEngine}/${r.codecLibraryVersion ?? "?"} |`;
  })
  .join("\n");

const summary = `# Core bundle format experiment — ${branch}

- Generated: ${report.generatedAt}
- Runtime: ${runtimeName} ${runtimeVersion}
- Host: ${report.host.cpuModel} × ${report.host.cpuCount}, ${(report.host.memBytes / 1073741824).toFixed(0)} GiB, ${report.host.os} ${report.host.arch}
- Source: ${entries.length} files, ${fmtBytes(sourceUncompressedBytes)} uncompressed
- Baseline zip: ${fmtBytes(zipBytes)} (${zipBytes} bytes), ${chunkCountFor(zipBytes)} chunk(s) at 24 MiB
- Codec support (this runtime): zstd=${caps.zstd} (${caps.zstdLibraryVersion}), brotli=${caps.brotli} (${caps.brotliLibraryVersion})

| Format | Level | Size | Bytes | Δ vs ZIP | Chunks@24MiB | Build time | Engine/lib |
|--------|-------|------|-------|----------|--------------|------------|------------|
${rows}

_Δ vs ZIP negative = smaller than the current ZIP bundle. Chunks column is the hosted
file count after chunk-bundles.mjs (split only when > 25 MiB, into 24 MiB parts)._
`;

writeFileSync(join(outDir, "summary.md"), summary);

console.log(`\n[experiment] wrote ${join(outDir, "results.json")}`);
console.log(`[experiment] wrote ${join(outDir, "summary.md")}`);
console.log(`\n${summary}`);
