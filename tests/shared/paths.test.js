import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinBasePath, resolveRemoteUrl } from "../../src/shared/paths.js";

describe("joinBasePath", () => {
  it("joins base and path", () => {
    assert.strictEqual(joinBasePath("/base/", "path"), "/base/path");
  });

  it("handles base without trailing slash", () => {
    assert.strictEqual(joinBasePath("/base", "path"), "/base/path");
  });

  it("handles path with leading slash", () => {
    assert.strictEqual(joinBasePath("/base/", "/path"), "/base/path");
  });

  it("handles root base", () => {
    assert.strictEqual(joinBasePath("/", "path"), "/path");
  });

  it("deduplicates multiple slashes", () => {
    assert.strictEqual(joinBasePath("/base//", "//path"), "/base/path");
  });

  it("handles empty path", () => {
    assert.strictEqual(joinBasePath("/base/", ""), "/base/");
  });
});

describe("resolveRemoteUrl", () => {
  it("preserves version and debug/profile params", () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      location: {
        href: "https://example.com/moodle-playground/index.html",
      },
    };

    try {
      const url = resolveRemoteUrl("main", "php82-moodle45", "/admin", {
        phpVersion: "8.2",
        moodleBranch: "MOODLE_405_STABLE",
        addonProxyUrl: "http://127.0.0.1:9999/",
        phpCorsProxyUrl: "http://127.0.0.1:9999/?url=",
        debug: "true",
        profile: "runtime",
      });

      assert.strictEqual(url.pathname, "/moodle-playground/remote.html");
      assert.strictEqual(url.searchParams.get("scope"), "main");
      assert.strictEqual(url.searchParams.get("runtime"), "php82-moodle45");
      assert.strictEqual(url.searchParams.get("path"), "/admin");
      assert.strictEqual(url.searchParams.get("phpVersion"), "8.2");
      assert.strictEqual(
        url.searchParams.get("moodleBranch"),
        "MOODLE_405_STABLE",
      );
      assert.strictEqual(
        url.searchParams.get("addonProxyUrl"),
        "http://127.0.0.1:9999/",
      );
      assert.strictEqual(
        url.searchParams.get("phpCorsProxyUrl"),
        "http://127.0.0.1:9999/?url=",
      );
      assert.strictEqual(url.searchParams.get("debug"), "true");
      assert.strictEqual(url.searchParams.get("profile"), "runtime");
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
