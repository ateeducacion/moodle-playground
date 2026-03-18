import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILD_VERSION } from "../../src/generated/build-version.js";
import { buildVersionedServiceWorkerUrl } from "../../src/shared/service-worker-version.js";

describe("buildVersionedServiceWorkerUrl", () => {
  it("adds the build version to a relative service worker URL", () => {
    const url = buildVersionedServiceWorkerUrl(
      "./sw.js",
      "https://example.com/moodle-playground/index.html",
    );

    assert.strictEqual(
      url.toString(),
      `https://example.com/moodle-playground/sw.js?build=${BUILD_VERSION}`,
    );
  });

  it("overwrites an existing build query parameter and preserves others", () => {
    const url = buildVersionedServiceWorkerUrl(
      "https://example.com/sw.js?foo=1&build=stale",
      "https://example.com/index.html",
    );

    assert.strictEqual(url.searchParams.get("foo"), "1");
    assert.strictEqual(url.searchParams.get("build"), BUILD_VERSION);
  });
});
