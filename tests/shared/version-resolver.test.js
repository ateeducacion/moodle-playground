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
  resolveRuntimeConfig,
  resolveRuntimeSelection,
  resolveVersions,
} from "../../src/shared/version-resolver.js";

describe("getBranchMetadata", () => {
  it("returns metadata for a known branch", () => {
    const meta = getBranchMetadata("MOODLE_500_STABLE");
    assert.ok(meta);
    assert.strictEqual(meta.version, "5.0");
    assert.strictEqual(meta.label, "Moodle 5.0.x");
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

describe("parseQueryParams", () => {
  it("reads addonProxyUrl and phpCorsProxyUrl when present", () => {
    const parsed = parseQueryParams(
      "https://example.com/?addonProxyUrl=http%3A%2F%2F127.0.0.1%3A9999%2F&phpCorsProxyUrl=http%3A%2F%2F127.0.0.1%3A9999%2F%3Furl%3D&debug=true",
    );

    assert.strictEqual(parsed.addonProxyUrl, "http://127.0.0.1:9999/");
    assert.strictEqual(parsed.phpCorsProxyUrl, "http://127.0.0.1:9999/?url=");
    assert.strictEqual(parsed.debug, "true");
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

  it("accepts phpVersion alias", () => {
    const result = resolveVersions({
      phpVersion: "8.2",
      moodleBranch: "MOODLE_405_STABLE",
    });
    assert.strictEqual(result.phpVersion, "8.2");
    assert.strictEqual(result.moodleBranch, "MOODLE_405_STABLE");
  });
});

describe("resolveRuntimeSelection", () => {
  it("builds a canonical runtime selection from query-style params", () => {
    const result = resolveRuntimeSelection({ php: "8.2", moodle: "4.5" });
    assert.deepStrictEqual(result, {
      phpVersion: "8.2",
      moodleBranch: "MOODLE_405_STABLE",
      runtimeId: "php82-moodle45",
    });
  });

  it("accepts phpVersion + moodleBranch aliases", () => {
    const result = resolveRuntimeSelection({
      phpVersion: "8.2",
      moodleBranch: "MOODLE_405_STABLE",
    });
    assert.deepStrictEqual(result, {
      phpVersion: "8.2",
      moodleBranch: "MOODLE_405_STABLE",
      runtimeId: "php82-moodle45",
    });
  });

  it("falls back to runtimeId when explicit params are absent", () => {
    const result = resolveRuntimeSelection({ runtimeId: "php84-moodle51" });
    assert.deepStrictEqual(result, {
      phpVersion: "8.4",
      moodleBranch: "MOODLE_501_STABLE",
      runtimeId: "php84-moodle51",
    });
  });

  it("uses defaults only when params are invalid", () => {
    const result = resolveRuntimeSelection({
      phpVersion: "8.1",
      moodleBranch: "MOODLE_500_STABLE",
    });
    assert.deepStrictEqual(result, {
      phpVersion: "8.3",
      moodleBranch: "MOODLE_500_STABLE",
      runtimeId: "php83-moodle50",
    });
  });
});

describe("resolveRuntimeConfig", () => {
  const singleRuntimeConfig = {
    runtimes: [
      {
        id: "php83-moodle50",
        label: "PHP 8.3 + Moodle 5.0",
        phpVersionLabel: "8.3",
        mountStrategy: "readonly-vfs",
        default: true,
      },
    ],
  };

  it("preserves the requested runtimeId when config only has the default runtime entry", () => {
    const selection = resolveRuntimeSelection({ php: "8.2", moodle: "4.5" });
    const runtime = resolveRuntimeConfig(singleRuntimeConfig, selection);

    assert.strictEqual(runtime.id, "php82-moodle45");
    assert.strictEqual(runtime.mountStrategy, "readonly-vfs");
    assert.strictEqual(runtime.phpVersionLabel, "8.2");
  });

  it("reuses exact runtime entries when they exist", () => {
    const runtime = resolveRuntimeConfig(
      {
        runtimes: [
          singleRuntimeConfig.runtimes[0],
          {
            id: "php82-moodle45",
            label: "PHP 8.2 + Moodle 4.5",
            phpVersionLabel: "8.2",
            mountStrategy: "zip-extract",
          },
        ],
      },
      resolveRuntimeSelection({
        phpVersion: "8.2",
        moodleBranch: "MOODLE_405_STABLE",
      }),
    );

    assert.strictEqual(runtime.id, "php82-moodle45");
    assert.strictEqual(runtime.mountStrategy, "zip-extract");
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
    assert.strictEqual(result.phpVersion, null);
    assert.strictEqual(result.moodle, "5.0");
    assert.strictEqual(result.debug, "true");
  });

  it("parses URL string", () => {
    const result = parseQueryParams(
      "https://example.com/?php=8.4&moodleBranch=main",
    );
    assert.strictEqual(result.php, "8.4");
    assert.strictEqual(result.phpVersion, null);
    assert.strictEqual(result.moodleBranch, "main");
  });

  it("parses phpVersion alias alongside debug/profile params", () => {
    const result = parseQueryParams(
      "https://example.com/?phpVersion=8.2&moodleBranch=MOODLE_405_STABLE&debug=true&profile=runtime",
    );
    assert.strictEqual(result.php, "8.2");
    assert.strictEqual(result.phpVersion, "8.2");
    assert.strictEqual(result.moodleBranch, "MOODLE_405_STABLE");
    assert.strictEqual(result.debug, "true");
    assert.strictEqual(result.profile, "runtime");
  });

  it("parses location-like object with search", () => {
    const result = parseQueryParams({ search: "?php=8.2" });
    assert.strictEqual(result.php, "8.2");
  });

  it("returns nulls for missing params", () => {
    const result = parseQueryParams(new URLSearchParams());
    assert.strictEqual(result.php, null);
    assert.strictEqual(result.phpVersion, null);
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
