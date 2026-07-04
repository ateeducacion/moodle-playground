#!/usr/bin/env node
//
// emit-bundle-alternatives.mjs — stage the solid-compressed alternatives from a
// completed experiment run into the servable assets tree and patch the branch
// manifest with an additive `bundleAlternatives[]` array (ADR 0018).
//
// This is an EXPERIMENT helper, not part of the normal build: the default
// `make bundle` still emits only the ZIP `bundle`. Run it after
// `experiment-core-bundle-formats.mjs` to let the running app serve the tar.*
// candidates for the runtime prototype / benchmark (`?bundle-format=tar.zst`).
//
// Usage:
//   node scripts/emit-bundle-alternatives.mjs --branch MOODLE_500_STABLE
//   node scripts/emit-bundle-alternatives.mjs --branch MOODLE_500_STABLE --formats tar.zst,tar.gz

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[token.slice(2)] = true;
    } else {
      args[token.slice(2)] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const branch = args.branch || "MOODLE_500_STABLE";
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const wanted = new Set(
  (args.formats
    ? String(args.formats).split(",")
    : ["tar.zst", "tar.br", "tar.gz"]
  ).map((s) => s.trim()),
);

const resultsPath = join(
  repoRoot,
  "artifacts",
  "compression-experiment",
  branch,
  "results.json",
);
const manifestPath = join(repoRoot, "assets", "manifests", `${branch}.json`);
const assetsDir = join(repoRoot, "assets", "moodle", branch);

if (!existsSync(resultsPath)) {
  throw new Error(
    `No experiment results at ${resultsPath}. Run experiment-core-bundle-formats.mjs first.`,
  );
}
if (!existsSync(manifestPath)) {
  throw new Error(
    `No manifest at ${manifestPath}. Run \`BRANCH=${branch} npm run bundle\` first.`,
  );
}

const report = JSON.parse(readFileSync(resultsPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const uncompressedSize = report.tar?.bytes ?? null;

// Clear any previously-staged tar alternatives (and their chunk parts) so a
// re-run with a different --formats set never leaves an orphan behind — an
// oversized orphan not referenced by the manifest would fail chunk-bundles.mjs.
for (const name of readdirSync(assetsDir)) {
  if (/^moodle-core\.tar(\.|$)/.test(name)) {
    rmSync(join(assetsDir, name));
  }
}

const alternatives = [];
for (const row of report.results) {
  if (!wanted.has(row.format) || row.container !== "tar") continue;
  const srcArtifact = join(repoRoot, row.path); // repo-relative path from the report
  if (!existsSync(srcArtifact)) {
    console.warn(`[alt] skip ${row.format}: artifact missing at ${row.path}`);
    continue;
  }
  const fileName = row.fileName;
  copyFileSync(srcArtifact, join(assetsDir, fileName));
  alternatives.push({
    format: row.format,
    container: "tar",
    codec: row.codec,
    // Manifest-relative path, mirroring manifest.bundle.path.
    path: `../moodle/${branch}/${fileName}`,
    fileName,
    size: row.bytes,
    uncompressedSize,
    sha256: row.sha256,
    fileCount: row.fileCount,
  });
  console.log(
    `[alt] staged ${row.format}: ${fileName} (${(row.bytes / 1048576).toFixed(1)} MiB)`,
  );
}

// Order smallest-first so `?bundle-format=auto` prefers the smallest download.
alternatives.sort((a, b) => a.size - b.size);
manifest.bundleAlternatives = alternatives;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `[alt] wrote ${alternatives.length} alternatives into ${basename(manifestPath)}`,
);
