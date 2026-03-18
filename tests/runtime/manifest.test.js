import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackManifestUrl,
  buildManifestState,
  fetchManifest,
} from "../../src/runtime/manifest.js";

describe("buildManifestState", () => {
  it("extracts state from manifest", () => {
    const manifest = {
      release: "2024-01-01",
      generatedAt: "2024-01-01T00:00:00Z",
      vfs: { data: { sha256: "abc123" } },
    };
    const state = buildManifestState(manifest, "php83-moodle50", "1.0.0");
    assert.strictEqual(state.runtimeId, "php83-moodle50");
    assert.strictEqual(state.bundleVersion, "1.0.0");
    assert.strictEqual(state.release, "2024-01-01");
    assert.strictEqual(state.sha256, "abc123");
    assert.strictEqual(state.generatedAt, "2024-01-01T00:00:00Z");
  });

  it("falls back to bundle sha256 when vfs is missing", () => {
    const manifest = {
      release: "2024-01-01",
      bundle: { sha256: "bundlehash" },
    };
    const state = buildManifestState(manifest, "runtime1", "1.0");
    assert.strictEqual(state.sha256, "bundlehash");
  });

  it("returns null sha256 when no hash available", () => {
    const manifest = { release: "2024-01-01" };
    const state = buildManifestState(manifest, "runtime1", "1.0");
    assert.strictEqual(state.sha256, null);
  });
});

describe("buildFallbackManifestUrl", () => {
  it("builds correct fallback URL", () => {
    const url = buildFallbackManifestUrl("https://example.com/playground/");
    assert.ok(url.includes("assets/manifests/latest.json"));
    assert.ok(url.startsWith("https://example.com/"));
  });
});

describe("fetchManifest", () => {
  it("requests manifests with cache:no-store", async () => {
    const originalFetch = globalThis.fetch;
    let seenInit = null;

    globalThis.fetch = async (_url, init = {}) => {
      seenInit = init;
      return {
        ok: true,
        async json() {
          return { release: "2024-01-01" };
        },
      };
    };

    try {
      await fetchManifest("https://example.com/assets/manifests/latest.json");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(seenInit?.cache, "no-store");
  });
});
