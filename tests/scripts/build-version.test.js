import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILD_VERSION_PATTERN,
  composeBuildVersion,
  formatBuildTimestamp,
  isValidBuildVersion,
  normalizeGitSha,
  parseBuildVersion,
  renderBuildVersionModule,
  resolveBuildMetadata,
  SHORT_SHA_LENGTH,
} from "../../scripts/lib/build-version.mjs";

// Time and git are injected everywhere below so the suite never depends on the
// wall clock or on the checkout it happens to run in.
const FIXED_NOW = new Date("2026-08-16T06:50:12.345Z");
const cleanGit = {
  sha: () => "9e39f37d1c0ffee0ba5eba11deadbeef12345678",
  dirty: () => false,
};
const dirtyGit = { ...cleanGit, dirty: () => true };

describe("formatBuildTimestamp", () => {
  it("formats a UTC timestamp to the second", () => {
    assert.strictEqual(formatBuildTimestamp(FIXED_NOW), "20260816T065012Z");
  });

  it("zero-pads every component", () => {
    assert.strictEqual(
      formatBuildTimestamp(new Date("2026-01-02T03:04:05Z")),
      "20260102T030405Z",
    );
  });

  it("uses UTC rather than local time", () => {
    // 23:30 UTC — a positive-offset local zone would roll the date forward.
    assert.strictEqual(
      formatBuildTimestamp(new Date("2026-12-31T23:30:00Z")),
      "20261231T233000Z",
    );
  });
});

describe("normalizeGitSha", () => {
  it("truncates a full SHA to the short form", () => {
    const sha = normalizeGitSha("9e39f37d1c0ffee0ba5eba11deadbeef12345678");
    assert.strictEqual(sha, "9e39f37d");
    assert.strictEqual(sha.length, SHORT_SHA_LENGTH);
  });

  it("lowercases and trims", () => {
    assert.strictEqual(normalizeGitSha("  9E39F37D1C0F  "), "9e39f37d");
  });

  it("falls back to nogit outside a git checkout", () => {
    assert.strictEqual(normalizeGitSha(""), "nogit");
    assert.strictEqual(normalizeGitSha(undefined), "nogit");
    assert.strictEqual(normalizeGitSha("not-a-sha"), "nogit");
  });
});

describe("composeBuildVersion / parseBuildVersion", () => {
  it("round-trips a clean build", () => {
    const version = composeBuildVersion({
      timestamp: "20260816T065012Z",
      gitSha: "9e39f37d",
    });
    assert.strictEqual(version, "20260816T065012Z-9e39f37d");
    assert.deepStrictEqual(parseBuildVersion(version), {
      timestamp: "20260816T065012Z",
      gitSha: "9e39f37d",
      dirty: false,
    });
  });

  it("round-trips a dirty build", () => {
    const version = composeBuildVersion({
      timestamp: "20260816T065012Z",
      gitSha: "9e39f37d",
      dirty: true,
    });
    assert.strictEqual(version, "20260816T065012Z-9e39f37d-dirty");
    assert.deepStrictEqual(parseBuildVersion(version), {
      timestamp: "20260816T065012Z",
      gitSha: "9e39f37d",
      dirty: true,
    });
  });

  it("rejects malformed identifiers", () => {
    for (const value of [
      "",
      "1.2.3",
      "20260816T065012Z",
      "20260816T065012-9e39f37d", // missing Z
      "20260816T065012Z-9e39f37", // 7-char SHA
      "20260816T065012Z-9e39f37dd", // 9-char SHA
      "20260816T065012Z-ZZZZZZZZ", // non-hex
      "20260816T065012Z-9e39f37d-wip", // unknown suffix
    ]) {
      assert.strictEqual(
        isValidBuildVersion(value),
        false,
        `accepted ${value}`,
      );
      assert.strictEqual(parseBuildVersion(value), null);
    }
  });
});

describe("resolveBuildMetadata", () => {
  it("builds the canonical identifier from build time and git SHA", () => {
    const metadata = resolveBuildMetadata({
      env: {},
      now: FIXED_NOW,
      git: cleanGit,
    });

    assert.strictEqual(metadata.buildVersion, "20260816T065012Z-9e39f37d");
    assert.match(metadata.buildVersion, BUILD_VERSION_PATTERN);
  });

  it("exposes the documented metadata fields", () => {
    const metadata = resolveBuildMetadata({
      env: {},
      now: FIXED_NOW,
      git: cleanGit,
    });

    assert.deepStrictEqual(Object.keys(metadata).sort(), [
      "buildVersion",
      "dirty",
      "generatedAt",
      "gitSha",
    ]);
    assert.strictEqual(metadata.generatedAt, "2026-08-16T06:50:12.345Z");
    assert.strictEqual(metadata.gitSha, "9e39f37d");
    assert.strictEqual(metadata.gitSha.length, SHORT_SHA_LENGTH);
    assert.strictEqual(metadata.dirty, false);
  });

  it("marks local builds with uncommitted changes as dirty", () => {
    const metadata = resolveBuildMetadata({
      env: {},
      now: FIXED_NOW,
      git: dirtyGit,
    });

    assert.strictEqual(
      metadata.buildVersion,
      "20260816T065012Z-9e39f37d-dirty",
    );
    assert.strictEqual(metadata.dirty, true);
  });

  it("honors an explicit BUILD_VERSION verbatim", () => {
    const metadata = resolveBuildMetadata({
      env: { BUILD_VERSION: "20260101T000000Z-abcdef12" },
      now: FIXED_NOW,
      git: cleanGit,
    });

    assert.strictEqual(metadata.buildVersion, "20260101T000000Z-abcdef12");
  });

  it("derives metadata from an explicit BUILD_VERSION, not the local checkout", () => {
    // CI replays one Build ID across jobs; the metadata must describe that
    // build rather than whatever the job's working tree happens to look like.
    const metadata = resolveBuildMetadata({
      env: { BUILD_VERSION: "20260101T000000Z-abcdef12" },
      now: FIXED_NOW,
      git: dirtyGit,
    });

    assert.strictEqual(metadata.gitSha, "abcdef12");
    assert.strictEqual(metadata.dirty, false);
  });

  it("keeps a non-canonical BUILD_VERSION but falls back to git for metadata", () => {
    const metadata = resolveBuildMetadata({
      env: { BUILD_VERSION: "custom-label" },
      now: FIXED_NOW,
      git: cleanGit,
    });

    assert.strictEqual(metadata.buildVersion, "custom-label");
    assert.strictEqual(metadata.gitSha, "9e39f37d");
  });

  it("ignores a blank BUILD_VERSION", () => {
    const metadata = resolveBuildMetadata({
      env: { BUILD_VERSION: "   " },
      now: FIXED_NOW,
      git: cleanGit,
    });

    assert.strictEqual(metadata.buildVersion, "20260816T065012Z-9e39f37d");
  });

  it("lets BUILD_SHA override the revision for pull request builds", () => {
    // actions/checkout resolves a merge commit on pull_request; CI passes the
    // PR head SHA so the Build ID stays traceable to the source commit.
    const metadata = resolveBuildMetadata({
      env: { BUILD_SHA: "feedface0000000000000000000000000000cafe" },
      now: FIXED_NOW,
      git: cleanGit,
    });

    assert.strictEqual(metadata.buildVersion, "20260816T065012Z-feedface");
    assert.strictEqual(metadata.gitSha, "feedface");
  });

  it("gives a rebuild of the same commit a different Build ID", () => {
    // Periodic rebuilds ship new upstream artifacts from an unchanged commit.
    const first = resolveBuildMetadata({
      env: {},
      now: new Date("2026-08-16T06:50:12Z"),
      git: cleanGit,
    });
    const second = resolveBuildMetadata({
      env: {},
      now: new Date("2026-08-23T06:00:03Z"),
      git: cleanGit,
    });

    assert.notStrictEqual(first.buildVersion, second.buildVersion);
    assert.strictEqual(first.gitSha, second.gitSha);
    assert.strictEqual(first.buildVersion, "20260816T065012Z-9e39f37d");
    assert.strictEqual(second.buildVersion, "20260823T060003Z-9e39f37d");
  });

  it("records nogit when git is unavailable", () => {
    const metadata = resolveBuildMetadata({
      env: {},
      now: FIXED_NOW,
      git: { sha: () => "", dirty: () => false },
    });

    assert.strictEqual(metadata.buildVersion, "20260816T065012Z-nogit");
    assert.match(metadata.buildVersion, BUILD_VERSION_PATTERN);
  });
});

describe("renderBuildVersionModule", () => {
  it("emits a module exposing BUILD_VERSION and BUILD_METADATA", () => {
    const metadata = resolveBuildMetadata({
      env: {},
      now: FIXED_NOW,
      git: cleanGit,
    });
    const source = renderBuildVersionModule(metadata);

    assert.match(
      source,
      /^\/\/ Generated by scripts\/write-build-version\.mjs/,
    );
    assert.match(
      source,
      /export const BUILD_VERSION = "20260816T065012Z-9e39f37d";/,
    );
    assert.match(source, /export const BUILD_METADATA = \{/);
    for (const key of ["buildVersion", "generatedAt", "gitSha", "dirty"]) {
      assert.match(source, new RegExp(`${key}:`));
    }
  });
});
