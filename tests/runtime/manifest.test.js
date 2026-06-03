import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackManifestUrl,
  buildManifestState,
  fetchManifest,
  resolveManifestUrl,
} from "../../src/runtime/manifest.js";

const APP_BASE = "https://example.com/pg/";
const MAIN_BRANCH_URL = "https://example.com/pg/assets/manifests/main.json";
const FALLBACK_URL = "https://example.com/pg/assets/manifests/latest.json";

/**
 * Install a fetch stub for the duration of `fn`. The handler receives
 * `(url, init)` and returns a Response-like object (or throws to simulate a
 * network error). Always restores the original fetch.
 */
async function withFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(String(url), init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
  };
}

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

describe("resolveManifestUrl", () => {
  it("returns the branch URL when the HEAD probe succeeds", async () => {
    const result = await withFetch(
      (url, init) => {
        assert.strictEqual(url, MAIN_BRANCH_URL);
        assert.strictEqual(init.method, "HEAD");
        return { ok: true, status: 200, statusText: "OK" };
      },
      () => resolveManifestUrl("main", APP_BASE),
    );
    assert.strictEqual(result, MAIN_BRANCH_URL);
  });

  it("falls back to latest.json only on a definitive 404 when channel matches", async () => {
    const result = await withFetch(
      (url, init) => {
        if (init.method === "HEAD") {
          assert.strictEqual(url, MAIN_BRANCH_URL);
          return { ok: false, status: 404, statusText: "Not Found" };
        }
        // GET of the fallback manifest — channel matches the requested branch.
        assert.strictEqual(url, FALLBACK_URL);
        return jsonResponse({ channel: "main", release: "5.3dev" });
      },
      () => resolveManifestUrl("main", APP_BASE),
    );
    assert.strictEqual(result, FALLBACK_URL);
  });

  it("throws on a 404 when the fallback manifest is a different branch", async () => {
    // latest.json points at MOODLE_500_STABLE (webRoot /www/moodle) but the
    // request is for `main` (webRoot /www/moodle/public). Using it would
    // extract a bundle with no public/ docroot — must refuse.
    await assert.rejects(
      () =>
        withFetch(
          (_url, init) => {
            if (init.method === "HEAD") {
              return { ok: false, status: 404, statusText: "Not Found" };
            }
            return jsonResponse({
              channel: "MOODLE_500_STABLE",
              release: "5.0.7",
            });
          },
          () => resolveManifestUrl("main", APP_BASE),
        ),
      /does not match the requested branch/,
    );
  });

  it("does NOT fall back on a transient network error — it propagates", async () => {
    let headAttempts = 0;
    await assert.rejects(
      () =>
        withFetch(
          (_url, init) => {
            if (init.method === "HEAD") {
              headAttempts++;
              throw new Error("network down");
            }
            // The fallback must never be fetched on a transient failure.
            throw new Error("fallback should not be fetched");
          },
          () => resolveManifestUrl("main", APP_BASE),
        ),
      /network down/,
    );
    // Transient errors are retried before propagating.
    assert.ok(headAttempts >= 2, `expected retries, got ${headAttempts}`);
  });

  it("retries a transient failure then succeeds on the branch URL", async () => {
    let headAttempts = 0;
    const result = await withFetch(
      (_url, init) => {
        if (init.method === "HEAD") {
          headAttempts++;
          if (headAttempts === 1) {
            throw new Error("flaky");
          }
          return { ok: true, status: 200, statusText: "OK" };
        }
        throw new Error("fallback should not be fetched");
      },
      () => resolveManifestUrl("main", APP_BASE),
    );
    assert.strictEqual(result, MAIN_BRANCH_URL);
    assert.strictEqual(headAttempts, 2);
  });

  it("does NOT fall back on a non-404 status (e.g. 503) — it propagates", async () => {
    await assert.rejects(
      () =>
        withFetch(
          (_url, init) => {
            if (init.method === "HEAD") {
              return {
                ok: false,
                status: 503,
                statusText: "Service Unavailable",
              };
            }
            throw new Error("fallback should not be fetched");
          },
          () => resolveManifestUrl("main", APP_BASE),
        ),
      /503/,
    );
  });

  it("skips the probe when branch and fallback URLs are identical (default branch)", async () => {
    // The default branch's manifest IS latest.json's channel, but buildManifestUrl
    // uses the per-branch manifestFile, so they differ; verify the short-circuit
    // path by pointing the requested branch at latest.json directly via an
    // unknown branch (falls back to latest.json filename in buildManifestUrl).
    let fetchCalled = false;
    const result = await withFetch(
      () => {
        fetchCalled = true;
        return { ok: true, status: 200, statusText: "OK" };
      },
      () => resolveManifestUrl("__unknown_branch__", APP_BASE),
    );
    assert.strictEqual(result, FALLBACK_URL);
    assert.strictEqual(fetchCalled, false);
  });
});
