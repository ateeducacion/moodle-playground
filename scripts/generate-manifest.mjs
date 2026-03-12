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

const required = [
  "channel",
  "manifest",
  "runtimeVersion",
  "release",
];

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
    format: "zip",
    path: relative(resolve(manifestPath, ".."), bundlePath).replaceAll("\\", "/"),
    fileName: basename(bundlePath),
    size: stats.size,
    sha256: sha256For(bundlePath),
    fileCount: Number(args.fileCount || 0),
  };
}

if (args.imageData && args.imageIndex) {
  const imageDataPath = resolve(args.imageData);
  const imageIndexPath = resolve(args.imageIndex);
  const imageDataStats = statSync(imageDataPath);
  const imageIndexStats = statSync(imageIndexPath);

  manifest.vfs = {
    format: args.imageFormat || "moodle-vfs-image-v1",
    mountMode: "readonly-vfs-overlay-v1",
    data: {
      path: relative(resolve(manifestPath, ".."), imageDataPath).replaceAll("\\", "/"),
      fileName: basename(imageDataPath),
      size: imageDataStats.size,
      sha256: sha256For(imageDataPath),
    },
    index: {
      path: relative(resolve(manifestPath, ".."), imageIndexPath).replaceAll("\\", "/"),
      fileName: basename(imageIndexPath),
      size: imageIndexStats.size,
      sha256: sha256For(imageIndexPath),
    },
    fileCount: Number(args.fileCount || 0),
  };
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
