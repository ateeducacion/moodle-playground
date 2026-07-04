#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

const required = ["channel", "manifest", "runtimeVersion", "release"];

// Optional: --snapshot <path-to-install.sq3>

for (const name of required) {
  if (!args[name]) {
    throw new Error(`Missing required argument --${name}`);
  }
}

const manifestPath = resolve(args.manifest);

function sha256For(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  channel: args.channel,
  release: args.release,
  runtimeVersion: args.runtimeVersion,
  source: {
    url: args.sourceUrl || "",
  },
};

if (args.bundle) {
  const bundlePath = resolve(args.bundle);
  const stats = statSync(bundlePath);

  manifest.bundle = {
    format: "tar.zst",
    container: "tar",
    codec: "zstd",
    path: relative(resolve(manifestPath, ".."), bundlePath).replaceAll(
      "\\",
      "/",
    ),
    fileName: basename(bundlePath),
    size: stats.size,
    sha256: sha256For(bundlePath),
    fileCount: Number(args.fileCount || 0),
  };
}

if (args.snapshot) {
  const snapshotPath = resolve(args.snapshot);
  const snapshotStats = statSync(snapshotPath);

  manifest.snapshot = {
    path: relative(resolve(manifestPath, ".."), snapshotPath).replaceAll(
      "\\",
      "/",
    ),
    fileName: basename(snapshotPath),
    size: snapshotStats.size,
    sha256: sha256For(snapshotPath),
  };

  // The snapshot generator drains the adhoc task queue and packages the
  // localcache seed (compiled theme CSS + DI container) in the same run;
  // both flags travel together so the runtime can skip the corresponding
  // boot steps. Additive fields — schemaVersion stays at 1.
  if (args.snapshotDrained === "1" || args.snapshotDrained === "true") {
    manifest.snapshot.drained = true;
  }

  // The localcache seed carries a pre-built combined RequireJS bundle: the
  // runtime re-enables $CFG->cachejs (one combined JS request per page instead
  // of dozens). Keyed off the actual artifact so cached/legacy seeds without it
  // keep cachejs=false. See ADR 0013.
  if (args.snapshotRequirejs === "1" || args.snapshotRequirejs === "true") {
    manifest.snapshot.requirejs = true;
  }

  if (args.snapshotLocalcache) {
    const seedPath = resolve(args.snapshotLocalcache);
    const seedStats = statSync(seedPath);

    manifest.snapshot.localcache = {
      path: relative(resolve(manifestPath, ".."), seedPath).replaceAll(
        "\\",
        "/",
      ),
      fileName: basename(seedPath),
      size: seedStats.size,
      sha256: sha256For(seedPath),
    };
  }
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
