import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/experiment-core-bundle-formats.mjs", import.meta.url),
);

let workDir;
let zipPath;
let outDir;
let report;

describe("experiment-core-bundle-formats.mjs", () => {
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "compression-exp-"));
    zipPath = join(workDir, "moodle-core-test.zip");
    outDir = join(workDir, "out");
    // A tiny but compressible synthetic bundle (repeated text so gzip ratio > 1).
    const filler = new TextEncoder().encode("moodle ".repeat(500));
    const zip = zipSync({
      "lib/setup.php": new TextEncoder().encode("<?php // setup\n"),
      "admin/index.php": filler,
      "z-last.txt": filler,
    });
    writeFileSync(zipPath, zip);
    // Restrict to always-available codecs (tar writer + node:zlib gzip) so the
    // test is hermetic across Node 20 (no native zstd) and Node 26.
    execFileSync(process.execPath, [
      SCRIPT,
      "--branch",
      "TEST",
      "--zip",
      zipPath,
      "--out",
      outDir,
      "--formats",
      "zip,tar,tar.gz",
    ]);
    report = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8"));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("emits a well-formed results.json with source + host metadata", () => {
    assert.equal(report.branch, "TEST");
    assert.equal(report.sourceFileCount, 3);
    assert.ok(report.sourceUncompressedBytes > 0);
    assert.ok(report.host.runtime);
    assert.ok(Array.isArray(report.results) && report.results.length >= 3);
  });

  it("includes the zip baseline and the uncompressed tar reference", () => {
    const zip = report.results.find((r) => r.format === "zip");
    const tar = report.results.find((r) => r.format === "tar");
    assert.ok(zip && tar);
    assert.equal(zip.codec, "deflate");
    assert.equal(tar.codec, "none");
    assert.match(tar.sha256, /^[0-9a-f]{64}$/);
    assert.equal(tar.chunkCountAt24MiB, 1);
  });

  it("gzip compresses the tar (ratio > 1) with the full row schema", () => {
    const gz = report.results.find((r) => r.format === "tar.gz");
    assert.ok(gz);
    assert.equal(gz.container, "tar");
    assert.equal(gz.codec, "gzip");
    assert.ok(gz.compressionRatioVsTar > 1);
    assert.equal(typeof gz.buildMilliseconds, "number");
    assert.match(gz.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof gz.sizeDeltaVsZipBytes, "number");
    // artifact path is repo-relative, not absolute.
    assert.ok(!gz.path.startsWith("/"));
  });

  it("writes a human-readable summary.md", () => {
    const md = readFileSync(join(outDir, "summary.md"), "utf8");
    assert.match(md, /Core bundle format experiment/);
    assert.match(md, /\| Format \|/);
  });
});
