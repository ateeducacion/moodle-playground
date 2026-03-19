import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_PHP_VERSIONS,
  buildManifestUrl,
  buildRuntimeId,
  DEFAULT_MOODLE_BRANCH,
  DEFAULT_PHP_VERSION,
  getBranchMetadata,
  getCompatiblePhpVersions,
  getDefaultBranch,
  isCompatibleCombination,
  MOODLE_BRANCHES,
  parseQueryParams,
  parseRuntimeId,
  resolveMoodleBranch,
  resolveVersions,
} from "../../src/shared/version-resolver.js";

describe("getBranchMetadata", () => {
  it("returns metadata for a known branch", () => {
    const meta = getBranchMetadata("MOODLE_500_STABLE");
    assert.ok(meta);
    assert.strictEqual(meta.version, "5.0");
    assert.strictEqual(meta.label, "Moodle 5.0");
  });

  it("returns null for unknown branch", () => {
    assert.strictEqual(getBranchMetadata("NONEXISTENT"), null);
  });

  it("returns correct webRoot for 5.1+", () => {
    const meta = getBranchMetadata("MOODLE_501_STABLE");
    assert.strictEqual(meta.webRoot, "/www/moodle/public");
  });

  it("returns correct webRoot for <=5.0", () => {
    const meta = getBranchMetadata("MOODLE_500_STABLE");
    assert.strictEqual(meta.webRoot, "/www/moodle");
  });
});

describe("getDefaultBranch", () => {
  it("returns a branch with default=true", () => {
    const def = getDefaultBranch();
    assert.ok(def);
    assert.strictEqual(def.default, true);
  });
});

describe("getCompatiblePhpVersions", () => {
  it("returns PHP versions for a known branch", () => {
    const versions = getCompatiblePhpVersions("MOODLE_500_STABLE");
    assert.ok(Array.isArray(versions));
    assert.ok(versions.includes("8.3"));
  });

  it("returns default PHP version for unknown branch", () => {
    const versions = getCompatiblePhpVersions("UNKNOWN");
    assert.deepStrictEqual(versions, [DEFAULT_PHP_VERSION]);
  });

  it("Moodle 4.4 supports PHP 8.1", () => {
    const versions = getCompatiblePhpVersions("MOODLE_404_STABLE");
    assert.ok(versions.includes("8.1"));
  });

  it("Moodle 5.0 does NOT support PHP 8.1", () => {
    const versions = getCompatiblePhpVersions("MOODLE_500_STABLE");
    assert.ok(!versions.includes("8.1"));
  });
});

describe("isCompatibleCombination", () => {
  it("returns true for compatible pair", () => {
    assert.strictEqual(
      isCompatibleCombination("8.3", "MOODLE_500_STABLE"),
      true,
    );
  });

  it("returns false for incompatible pair", () => {
    assert.strictEqual(
      isCompatibleCombination("8.1", "MOODLE_500_STABLE"),
      false,
    );
  });

  it("returns false for unknown branch", () => {
    assert.strictEqual(isCompatibleCombination("8.3", "NONEXISTENT"), false);
  });
});

describe("resolveMoodleBranch", () => {
  it("resolves by branch name", () => {
    assert.strictEqual(
      resolveMoodleBranch("MOODLE_500_STABLE"),
      "MOODLE_500_STABLE",
    );
  });

  it("resolves by version string", () => {
    assert.strictEqual(resolveMoodleBranch("5.0"), "MOODLE_500_STABLE");
  });

  it("resolves 'dev' to main", () => {
    assert.strictEqual(resolveMoodleBranch("dev"), "main");
  });

  it("resolves version with .x suffix", () => {
    assert.strictEqual(resolveMoodleBranch("5.0.x"), "MOODLE_500_STABLE");
  });

  it("returns null for unknown version", () => {
    assert.strictEqual(resolveMoodleBranch("99.99"), null);
  });

  it("returns null for null/undefined", () => {
    assert.strictEqual(resolveMoodleBranch(null), null);
    assert.strictEqual(resolveMoodleBranch(undefined), null);
  });
});

describe("resolveVersions", () => {
  it("returns defaults when called with no args", () => {
    const result = resolveVersions();
    assert.strictEqual(result.moodleBranch, DEFAULT_MOODLE_BRANCH);
    assert.strictEqual(result.phpVersion, DEFAULT_PHP_VERSION);
  });

  it("uses explicit moodle version", () => {
    const result = resolveVersions({ moodle: "4.4" });
    assert.strictEqual(result.moodleBranch, "MOODLE_404_STABLE");
  });

  it("moodleBranch takes precedence over moodle", () => {
    const result = resolveVersions({
      moodle: "4.4",
      moodleBranch: "MOODLE_500_STABLE",
    });
    assert.strictEqual(result.moodleBranch, "MOODLE_500_STABLE");
  });

  it("falls back when PHP version is incompatible", () => {
    const result = resolveVersions({ php: "8.1", moodle: "5.0" });
    // 8.1 not compatible with 5.0, should fallback
    assert.notStrictEqual(result.phpVersion, "8.1");
  });

  it("keeps compatible PHP version", () => {
    const result = resolveVersions({ php: "8.2", moodle: "5.0" });
    assert.strictEqual(result.phpVersion, "8.2");
  });
});

describe("buildRuntimeId", () => {
  it("builds correct ID for stable branch", () => {
    assert.strictEqual(
      buildRuntimeId("8.3", "MOODLE_500_STABLE"),
      "php83-moodle50",
    );
  });

  it("builds correct ID for main branch", () => {
    assert.strictEqual(buildRuntimeId("8.4", "main"), "php84-main");
  });

  it("handles unknown branch gracefully", () => {
    const id = buildRuntimeId("8.3", "CUSTOM_BRANCH");
    assert.ok(id.startsWith("php83-"));
  });
});

describe("parseRuntimeId", () => {
  it("parses new format", () => {
    const parsed = parseRuntimeId("php83-moodle50");
    assert.deepStrictEqual(parsed, {
      phpVersion: "8.3",
      moodleBranch: "MOODLE_500_STABLE",
    });
  });

  it("parses main branch", () => {
    const parsed = parseRuntimeId("php84-main");
    assert.deepStrictEqual(parsed, {
      phpVersion: "8.4",
      moodleBranch: "main",
    });
  });

  it("parses legacy format", () => {
    const parsed = parseRuntimeId("php83-cgi");
    assert.ok(parsed);
    assert.strictEqual(parsed.phpVersion, "8.3");
    assert.strictEqual(parsed.moodleBranch, DEFAULT_MOODLE_BRANCH);
  });

  it("returns null for invalid format", () => {
    assert.strictEqual(parseRuntimeId("garbage"), null);
    assert.strictEqual(parseRuntimeId(null), null);
    assert.strictEqual(parseRuntimeId(""), null);
  });

  it("roundtrips with buildRuntimeId", () => {
    const id = buildRuntimeId("8.3", "MOODLE_500_STABLE");
    const parsed = parseRuntimeId(id);
    assert.strictEqual(parsed.phpVersion, "8.3");
    assert.strictEqual(parsed.moodleBranch, "MOODLE_500_STABLE");
  });
});

describe("parseQueryParams", () => {
  it("parses URLSearchParams", () => {
    const params = new URLSearchParams("php=8.3&moodle=5.0&debug=true");
    const result = parseQueryParams(params);
    assert.strictEqual(result.php, "8.3");
    assert.strictEqual(result.moodle, "5.0");
    assert.strictEqual(result.debug, "true");
  });

  it("parses URL string", () => {
    const result = parseQueryParams(
      "https://example.com/?php=8.4&moodleBranch=main",
    );
    assert.strictEqual(result.php, "8.4");
    assert.strictEqual(result.moodleBranch, "main");
  });

  it("parses location-like object with search", () => {
    const result = parseQueryParams({ search: "?php=8.2" });
    assert.strictEqual(result.php, "8.2");
  });

  it("returns nulls for missing params", () => {
    const result = parseQueryParams(new URLSearchParams());
    assert.strictEqual(result.php, null);
    assert.strictEqual(result.moodle, null);
    assert.strictEqual(result.moodleBranch, null);
    assert.strictEqual(result.debug, null);
  });
});

describe("buildManifestUrl", () => {
  it("builds correct URL for known branch", () => {
    const url = buildManifestUrl(
      "MOODLE_500_STABLE",
      "https://example.com/playground/",
    );
    assert.ok(url.includes("MOODLE_500_STABLE.json"));
    assert.ok(url.startsWith("https://example.com/"));
  });

  it("falls back to latest.json for unknown branch", () => {
    const url = buildManifestUrl(
      "NONEXISTENT",
      "https://example.com/playground/",
    );
    assert.ok(url.includes("latest.json"));
  });
});

describe("MOODLE_BRANCHES data integrity", () => {
  it("all branches have required fields", () => {
    for (const branch of MOODLE_BRANCHES) {
      assert.ok(branch.branch, `Missing branch name`);
      assert.ok(branch.version, `Missing version for ${branch.branch}`);
      assert.ok(branch.label, `Missing label for ${branch.branch}`);
      assert.ok(branch.webRoot, `Missing webRoot for ${branch.branch}`);
      assert.ok(
        Array.isArray(branch.phpVersions),
        `Missing phpVersions for ${branch.branch}`,
      );
      assert.ok(
        branch.phpVersions.length > 0,
        `Empty phpVersions for ${branch.branch}`,
      );
    }
  });

  it("exactly one branch is default", () => {
    const defaults = MOODLE_BRANCHES.filter((b) => b.default);
    assert.strictEqual(defaults.length, 1);
  });

  it("all PHP versions are from ALL_PHP_VERSIONS", () => {
    for (const branch of MOODLE_BRANCHES) {
      for (const v of branch.phpVersions) {
        assert.ok(
          ALL_PHP_VERSIONS.includes(v),
          `Unknown PHP version ${v} in ${branch.branch}`,
        );
      }
    }
  });
});
