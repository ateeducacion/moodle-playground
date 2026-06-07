#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const projectName = process.env.CLOUDFLARE_PAGES_PROJECT;
const targetBranch = process.env.CLOUDFLARE_PAGES_BRANCH || "";
const deleteBranchAll =
  process.env.CLOUDFLARE_PAGES_DELETE_BRANCH_ALL === "true";
const dryRun = process.env.CLOUDFLARE_PAGES_CLEANUP_DRY_RUN === "true";

if (!projectName) {
  throw new Error("CLOUDFLARE_PAGES_PROJECT is required");
}

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
}

function wrangler(args, options = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`wrangler ${args.join(" ")} failed\n${detail}`);
  }
  return result.stdout;
}

const deployments = JSON.parse(
  wrangler([
    "pages",
    "deployment",
    "list",
    "--project-name",
    projectName,
    "--json",
  ]),
);

const seen = new Set();
const deletions = [];

for (const deployment of deployments) {
  const branch = deployment.Branch;
  const environment = deployment.Environment;
  const key = `${environment}:${branch}`;

  if (deleteBranchAll && targetBranch && branch === targetBranch) {
    deletions.push(deployment);
    continue;
  }

  if (seen.has(key)) {
    deletions.push(deployment);
    continue;
  }

  seen.add(key);
}

if (deletions.length === 0) {
  console.log(
    `No stale Cloudflare Pages deployments found for ${projectName}.`,
  );
  process.exit(0);
}

for (const deployment of deletions) {
  const label = `${deployment.Id} (${deployment.Environment}/${deployment.Branch}/${deployment.Source})`;
  if (dryRun) {
    console.log(`[dry-run] Would delete ${label}`);
    continue;
  }

  try {
    wrangler(
      [
        "pages",
        "deployment",
        "delete",
        deployment.Id,
        "--project-name",
        projectName,
        "--force",
      ],
      { stdio: "pipe" },
    );
    console.log(`Deleted ${label}`);
  } catch (error) {
    console.log(`Skipped ${label}: ${error.message}`);
  }
}
