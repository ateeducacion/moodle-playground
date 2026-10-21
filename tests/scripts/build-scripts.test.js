import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { zipSync } from "fflate";
import { BUILD_VERSION_PATTERN } from "../../scripts/lib/build-version.mjs";
import { readUstarTar } from "../../scripts/lib/tar-ustar.mjs";

// CLI-level tests for the build/deploy helper scripts. Each script is spawned
// with `node` exactly as CI or the Makefile invokes it, against temp fixtures.
const script = (name) =>
  fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const MIB = 1024 * 1024;

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mp-scripts-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function run(name, args = [], { env = {}, cwd } = {}) {
  return spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });
}

describe("write-build-version.mjs", () => {
  it("prints a BUILD_VERSION override verbatim with --print-version", () => {
    const version = "20260816T065012Z-9e39f37d";
    const result = run("write-build-version.mjs", ["--print-version"], {
      env: { BUILD_VERSION: version },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  });

  it("derives a well-formed version from git when no override is set", () => {
    const env = { ...process.env };
    delete env.BUILD_VERSION;
    delete env.BUILD_SHA;
    const result = spawnSync(
      process.execPath,
      [script("write-build-version.mjs"), "--print-version"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), BUILD_VERSION_PATTERN);
  });

  it("writes the generated module and JSON metadata", async () => {
    const { writeBuildMetadata } = await import(
      "../../scripts/write-build-version.mjs"
    );
    const dir = tempDir();
    const metadata = {
      buildVersion: "20260816T065012Z-9e39f37d",
      generatedAt: "2026-08-16T06:50:12.345Z",
      gitSha: "9e39f37d",
      dirty: false,
    };
    const jsPath = join(dir, "gen", "build-version.js");
    const jsonPath = join(dir, "assets", "build-version.json");
    writeBuildMetadata(metadata, { jsPath, jsonPath });
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), metadata);
    const mod = await import(`${new URL(`file://${jsPath}`).href}`);
    assert.equal(mod.BUILD_VERSION, metadata.buildVersion);
  });
});

describe("generate-og-image.mjs", () => {
  it("renders the template at 1200x630 and screenshots it to the output path", async () => {
    const { generateOgImage, HTML, OUTPUT } = await import(
      "../../scripts/generate-og-image.mjs"
    );
    assert.match(OUTPUT, /og-image\.png$/);
    const calls = [];
    const page = {
      setContent: async (...args) => calls.push(["setContent", ...args]),
      waitForTimeout: async (ms) => calls.push(["wait", ms]),
      screenshot: async (opts) => calls.push(["screenshot", opts]),
    };
    const browserType = {
      launch: async () => ({
        newContext: async (opts) => {
          calls.push(["context", opts]);
          return { newPage: async () => page };
        },
        close: async () => calls.push(["close"]),
      }),
    };
    await generateOgImage({ browserType, output: "/tmp/out.png" });
    assert.deepEqual(calls[0], [
      "context",
      { viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 },
    ]);
    assert.deepEqual(calls[1], [
      "setContent",
      HTML,
      { waitUntil: "networkidle" },
    ]);
    assert.match(HTML, /Moodle <span>Playground<\/span>/);
    assert.deepEqual(calls[3], [
      "screenshot",
      { path: "/tmp/out.png", type: "png", omitBackground: false },
    ]);
    assert.deepEqual(calls.at(-1), ["close"]);
  });
});

describe("build-tar-zst-from-zip.mjs", () => {
  it("re-containers a ZIP into a deterministic zstd-compressed USTAR", () => {
    const dir = tempDir();
    const zipPath = join(dir, "in.zip");
    const outPath = join(dir, "out.tar.zst");
    writeFileSync(
      zipPath,
      zipSync({
        "moodle/index.php": Buffer.from("<?php echo 1;"),
        "moodle/lib/setup.php": Buffer.from("<?php"),
        "moodle/empty/": new Uint8Array(0),
      }),
    );
    const result = run("build-tar-zst-from-zip.mjs", [zipPath, outPath]);
    assert.equal(result.status, 0, result.stderr);
    const out = readFileSync(outPath);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report, {
      fileCount: 2,
      dirCount: 1,
      bytes: out.length,
      sha256: sha256(out),
    });
    const entries = readUstarTar(zlib.zstdDecompressSync(out));
    assert.deepEqual(
      entries.map((e) => e.name),
      ["moodle/empty", "moodle/index.php", "moodle/lib/setup.php"],
    );
    assert.equal(
      Buffer.from(
        entries.find((e) => e.name === "moodle/index.php").data,
      ).toString(),
      "<?php echo 1;",
    );

    // Same input → byte-identical output.
    const again = join(dir, "again.tar.zst");
    run("build-tar-zst-from-zip.mjs", [zipPath, again]);
    assert.equal(sha256(readFileSync(again)), report.sha256);
  });

  it("prints usage and fails without both paths", () => {
    const result = run("build-tar-zst-from-zip.mjs", ["only.zip"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: build-tar-zst-from-zip\.mjs/);
  });
});

describe("chunk-bundles.mjs", () => {
  function site({ manifests = {}, files = {} } = {}) {
    const root = tempDir();
    const manifestDir = join(root, "assets", "manifests");
    mkdirSync(manifestDir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), data);
    }
    for (const [name, manifest] of Object.entries(manifests)) {
      writeFileSync(join(manifestDir, name), JSON.stringify(manifest));
    }
    return root;
  }
  const readManifest = (root, name) =>
    JSON.parse(readFileSync(join(root, "assets", "manifests", name), "utf8"));

  it("splits an oversized bundle shared by several manifests exactly once", () => {
    const big = Buffer.alloc(26 * MIB);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    const bundle = {
      path: "../moodle/core.tar.zst",
      format: "tar",
      codec: "zstd",
      sha256: sha256(big).toUpperCase(),
    };
    const root = site({
      files: {
        "assets/moodle/core.tar.zst": big,
        "assets/moodle/small.tar.zst": Buffer.from("small"),
      },
      manifests: {
        "MOODLE_503_STABLE.json": { bundle },
        "latest.json": { bundle },
        "small.json": { bundle: { path: "../moodle/small.tar.zst" } },
        "already.json": { bundle: { parts: [{ path: "x.part-000" }] } },
        "nobundle.json": { release: "5.0" },
      },
    });
    const result = run("chunk-bundles.mjs", [root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /MOODLE_503_STABLE\.json -> 2 parts \(26 MiB\)/,
    );
    assert.match(result.stdout, /OK — all files within the 25 MiB/);

    assert.equal(existsSync(join(root, "assets/moodle/core.tar.zst")), false);
    const rewritten = readManifest(root, "MOODLE_503_STABLE.json").bundle;
    assert.deepEqual(readManifest(root, "latest.json").bundle, rewritten);
    assert.equal(rewritten.path, undefined);
    assert.equal(rewritten.format, "tar");
    assert.equal(rewritten.codec, "zstd");
    assert.equal(rewritten.totalSize, big.length);
    assert.equal(rewritten.size, big.length);
    assert.equal(rewritten.partSize, 24 * MIB);
    assert.equal(rewritten.sha256, sha256(big));
    assert.deepEqual(
      rewritten.parts.map((p) => [p.path, p.size]),
      [
        ["../moodle/core.tar.zst.part-000", 24 * MIB],
        ["../moodle/core.tar.zst.part-001", 2 * MIB],
      ],
    );
    const reassembled = Buffer.concat(
      rewritten.parts.map((p) => {
        const data = readFileSync(join(root, "assets", "manifests", p.path));
        assert.equal(sha256(data), p.sha256);
        return data;
      }),
    );
    assert.ok(reassembled.equals(big));
    // Small and already-chunked manifests are untouched.
    assert.deepEqual(readManifest(root, "small.json").bundle, {
      path: "../moodle/small.tar.zst",
    });
    assert.deepEqual(readManifest(root, "already.json").bundle, {
      parts: [{ path: "x.part-000" }],
    });
  });

  it("is a no-op for a site without oversized bundles or manifests", () => {
    const root = tempDir();
    const result = run("chunk-bundles.mjs", [root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no oversized bundles to split/);
  });

  it("defaults the site directory to _site", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "_site"));
    const result = run("chunk-bundles.mjs", [], { cwd });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK/);
  });

  it("fails on a sha256 mismatch without touching the bundle", () => {
    const root = site({
      files: { "assets/moodle/core.tar.zst": Buffer.alloc(26 * MIB) },
      manifests: {
        "x.json": {
          bundle: { path: "../moodle/core.tar.zst", sha256: "deadbeef" },
        },
      },
    });
    const result = run("chunk-bundles.mjs", [root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /core\.tar\.zst: sha256 mismatch vs manifest/);
    assert.ok(existsSync(join(root, "assets/moodle/core.tar.zst")));
  });

  it("fails when an unmanaged file still exceeds the per-file limit", () => {
    const root = site({
      files: { "assets/other/huge.bin": Buffer.alloc(25 * MIB + 1) },
    });
    const result = run("chunk-bundles.mjs", [root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /still exceed the 25 MiB per-file limit/);
    assert.match(result.stderr, /25\.0 MiB {2}.*huge\.bin/);
  });
});

describe("cleanup-cloudflare-pages.mjs", () => {
  // A fake `npx` placed first on PATH stands in for `npx wrangler`: it prints
  // the deployment list from FAKE_DEPLOYMENTS and logs every delete.
  function fakeNpx() {
    const bin = tempDir();
    const npx = join(bin, "npx");
    writeFileSync(
      npx,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (args.includes("list")) {
  if (process.env.FAKE_LIST_FAIL) {
    process.stderr.write("auth error");
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_DEPLOYMENTS);
} else if (args.includes(process.env.FAKE_FAIL_ID)) {
  process.stderr.write("boom");
  process.exit(1);
}
`,
    );
    chmodSync(npx, 0o755);
    return bin;
  }

  const deployments = [
    { Id: "p2", Environment: "production", Branch: "main", Source: "abc" },
    { Id: "p1", Environment: "production", Branch: "main", Source: "abd" },
    { Id: "f2", Environment: "preview", Branch: "feature/x", Source: "abe" },
    { Id: "f1", Environment: "preview", Branch: "feature/x", Source: "abf" },
    { Id: "g1", Environment: "preview", Branch: "feature/y", Source: "abg" },
  ];

  function cleanup(env = {}) {
    const bin = fakeNpx();
    const log = join(bin, "calls.log");
    writeFileSync(log, "");
    const result = run("cleanup-cloudflare-pages.mjs", [], {
      env: {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_LOG: log,
        FAKE_DEPLOYMENTS: JSON.stringify(deployments),
        CLOUDFLARE_PAGES_PROJECT: "moodle-playground",
        CLOUDFLARE_ACCOUNT_ID: "acc",
        ...env,
      },
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { result, calls };
  }
  const deletedIds = (calls) =>
    calls.filter((c) => c.includes("delete")).map((c) => c[4]);

  it("keeps the newest deployment per environment/branch and deletes the rest", () => {
    const { result, calls } = cleanup();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls[0], [
      "wrangler",
      "pages",
      "deployment",
      "list",
      "--project-name",
      "moodle-playground",
      "--json",
    ]);
    assert.deepEqual(deletedIds(calls), ["p1", "f1"]);
    assert.deepEqual(calls[1].slice(-3), [
      "--project-name",
      "moodle-playground",
      "--force",
    ]);
    assert.match(result.stdout, /Deleted p1 \(production\/main\/abd\)/);
  });

  it("deletes every deployment of a branch when asked to", () => {
    const { calls } = cleanup({
      CLOUDFLARE_PAGES_BRANCH: "feature/x",
      CLOUDFLARE_PAGES_DELETE_BRANCH_ALL: "true",
    });
    assert.deepEqual(deletedIds(calls), ["p1", "f2", "f1"]);
  });

  it("only reports deletions in dry-run mode", () => {
    const { result, calls } = cleanup({
      CLOUDFLARE_PAGES_CLEANUP_DRY_RUN: "true",
    });
    assert.deepEqual(deletedIds(calls), []);
    assert.match(result.stdout, /\[dry-run\] Would delete p1/);
    assert.match(result.stdout, /\[dry-run\] Would delete f1/);
  });

  it("reports when there is nothing stale", () => {
    const { result } = cleanup({
      FAKE_DEPLOYMENTS: JSON.stringify(deployments.slice(0, 1)),
    });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /No stale Cloudflare Pages deployments found for moodle-playground\./,
    );
  });

  it("keeps going when a delete fails", () => {
    const { result } = cleanup({ FAKE_FAIL_ID: "p1" });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /Skipped p1 .*wrangler pages deployment delete p1/,
    );
    assert.match(result.stdout, /boom/);
    assert.match(result.stdout, /Deleted f1/);
  });

  it("fails with wrangler's output when listing fails", () => {
    const { result } = cleanup({ FAKE_LIST_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wrangler pages deployment list .* failed/);
    assert.match(result.stderr, /auth error/);
  });

  it("requires the project name and account id", () => {
    let { result } = cleanup({ CLOUDFLARE_PAGES_PROJECT: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLOUDFLARE_PAGES_PROJECT is required/);
    ({ result } = cleanup({ CLOUDFLARE_ACCOUNT_ID: "" }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID is required/);
  });
});
