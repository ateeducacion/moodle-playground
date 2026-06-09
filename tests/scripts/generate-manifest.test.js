import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/generate-manifest.mjs", import.meta.url),
);

let workDir;
let bundlePath;
let snapshotPath;
let localcachePath;

function runGenerator(extraArgs) {
  const manifestPath = join(workDir, `manifest-${extraArgs.length}.json`);
  execFileSync(process.execPath, [
    SCRIPT,
    "--bundle",
    bundlePath,
    "--channel",
    "MOODLE_500_STABLE",
    "--manifest",
    manifestPath,
    "--runtimeVersion",
    "0.0.0-test",
    "--release",
    "5.0-test",
    "--fileCount",
    "3",
    ...extraArgs,
  ]);
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("generate-manifest.mjs snapshot fields", () => {
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
    bundlePath = join(workDir, "bundle.zip");
    snapshotPath = join(workDir, "install.sq3");
    localcachePath = join(workDir, "localcache.zip");
    writeFileSync(bundlePath, "bundle-bytes");
    writeFileSync(snapshotPath, "snapshot-bytes");
    writeFileSync(localcachePath, "seed-bytes");
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("emits a legacy manifest without drained/localcache when not passed", () => {
    const manifest = runGenerator(["--snapshot", snapshotPath]);
    assert.strictEqual(manifest.schemaVersion, 1);
    assert.strictEqual(manifest.snapshot.fileName, "install.sq3");
    assert.ok(!("drained" in manifest.snapshot));
    assert.ok(!("localcache" in manifest.snapshot));
  });

  it("emits drained + localcache metadata when passed", () => {
    const manifest = runGenerator([
      "--snapshot",
      snapshotPath,
      "--snapshotLocalcache",
      localcachePath,
      "--snapshotDrained",
      "1",
    ]);
    assert.strictEqual(manifest.schemaVersion, 1);
    assert.strictEqual(manifest.snapshot.drained, true);
    assert.strictEqual(manifest.snapshot.localcache.fileName, "localcache.zip");
    assert.strictEqual(manifest.snapshot.localcache.size, 10);
    assert.match(manifest.snapshot.localcache.sha256, /^[0-9a-f]{64}$/);
    // The seed path must be manifest-relative like the snapshot path.
    assert.ok(!manifest.snapshot.localcache.path.startsWith("/"));
  });
});
