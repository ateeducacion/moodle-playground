#!/usr/bin/env node
// Writes the Playground Build ID metadata consumed by the shell, the Service
// Worker and the deployed site. Run via `npm run build:version`.
//
//   node scripts/write-build-version.mjs                 # generate both files
//   node scripts/write-build-version.mjs --print-version # print the ID only
//
// CI generates the Build ID once (with --print-version) and replays it through
// every later job via the BUILD_VERSION environment variable, so one pipeline
// run produces exactly one Build ID.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  renderBuildVersionModule,
  resolveBuildMetadata,
} from "./lib/build-version.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, "..");
const jsOutputPath = resolve(repoDir, "src/generated/build-version.js");
const jsonOutputPath = resolve(repoDir, "assets/build-version.json");

function tryGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const git = {
  sha: () => tryGit(["rev-parse", "HEAD"]),
  dirty: () => Boolean(tryGit(["status", "--porcelain"])),
};

// Write the generated module and JSON metadata (paths overridable for tests).
export function writeBuildMetadata(
  metadata,
  { jsPath = jsOutputPath, jsonPath = jsonOutputPath } = {},
) {
  mkdirSync(dirname(jsPath), { recursive: true });
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsPath, renderBuildVersionModule(metadata), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = resolveBuildMetadata({ env: process.env, git });

  if (process.argv.includes("--print-version")) {
    process.stdout.write(`${metadata.buildVersion}\n`);
  } else {
    writeBuildMetadata(metadata);
    console.log(`Wrote build metadata ${metadata.buildVersion}`);
  }
}
