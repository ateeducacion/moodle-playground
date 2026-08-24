import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchAssetWithCache, fetchManifest } from "../../lib/moodle-loader.js";

const makeAsset = (size) => new Uint8Array(randomBytes(size));
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Minimal in-memory Cache Storage + fetch so the loader can run under node.
function installMocks() {
  const store = new Map();
  let fetchCount = 0;
  const responses = new Map();

  globalThis.__fetchCount = () => fetchCount;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    const entry = responses.get(String(url));
    if (entry === undefined) return new Response("not found", { status: 404 });
    if (typeof entry === "string") {
      return new Response(entry, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(entry, { status: 200 });
  };

  const cache = {
    async match(url) {
      const bytes = store.get(String(url));
      return bytes ? new Response(bytes, { status: 200 }) : undefined;
    },
    async put(url, response) {
      store.set(String(url), new Uint8Array(await response.arrayBuffer()));
    },
    async delete(url) {
      return store.delete(String(url));
    },
  };
  globalThis.caches = { open: async () => cache };
  // normalizeManifest resolves relative paths against self.location.href.
  globalThis.self = { location: { href: "https://example.test/" } };

  return { responses, store };
}

function teardownMocks() {
  delete globalThis.fetch;
  delete globalThis.caches;
  delete globalThis.__fetchCount;
  delete globalThis.self;
}

describe("fetchAssetWithCache", () => {
  let mocks;
  beforeEach(() => {
    mocks = installMocks();
  });
  afterEach(() => {
    teardownMocks();
  });

  it("downloads, verifies and caches an asset with a sha256", async () => {
    const url = "https://example.test/install.sq3";
    const bytes = makeAsset(64 * 1024);
    mocks.responses.set(url, bytes);

    const got = await fetchAssetWithCache(url, { sha256: sha256Hex(bytes) });
    assert.deepEqual(got, bytes);
    assert.equal(globalThis.__fetchCount(), 1);
    assert.ok(mocks.store.has(url), "asset cached after first fetch");
  });

  it("serves a cached asset without a second network fetch", async () => {
    const url = "https://example.test/install.sq3";
    const bytes = makeAsset(32 * 1024);
    const info = { sha256: sha256Hex(bytes) };
    mocks.responses.set(url, bytes);

    await fetchAssetWithCache(url, info);
    const fromCache = await fetchAssetWithCache(url, info);
    assert.deepEqual(fromCache, bytes);
    assert.equal(globalThis.__fetchCount(), 1, "second call hits the cache");
  });

  it("busts a stale cache entry whose checksum no longer matches", async () => {
    const url = "https://example.test/install.sq3";
    const stale = makeAsset(16 * 1024);
    const fresh = makeAsset(16 * 1024);
    // Seed the cache with stale bytes but advertise the fresh checksum.
    mocks.store.set(url, stale);
    mocks.responses.set(url, fresh);

    const got = await fetchAssetWithCache(url, { sha256: sha256Hex(fresh) });
    assert.deepEqual(got, fresh);
    assert.equal(globalThis.__fetchCount(), 1, "refetched after cache bust");
    assert.deepEqual(
      mocks.store.get(url),
      fresh,
      "cache replaced with fresh bytes",
    );
  });

  it("does NOT touch the cache when no sha256 is provided (legacy manifest)", async () => {
    const url = "https://example.test/install.sq3";
    const bytes = makeAsset(8 * 1024);
    mocks.responses.set(url, bytes);

    const got = await fetchAssetWithCache(url, {});
    assert.deepEqual(got, bytes);
    assert.equal(mocks.store.size, 0, "nothing cached without a checksum");
  });

  it("throws on a non-OK response", async () => {
    await assert.rejects(
      () => fetchAssetWithCache("https://example.test/missing.sq3", {}),
      /Unable to download asset/,
    );
  });

  it("throws when freshly downloaded bytes fail checksum verification", async () => {
    const url = "https://example.test/install.sq3";
    mocks.responses.set(url, makeAsset(4 * 1024));
    await assert.rejects(
      () =>
        fetchAssetWithCache(url, { sha256: sha256Hex(makeAsset(4 * 1024)) }),
      /checksum mismatch/i,
    );
  });
});

describe("normalizeManifest snapshot/localcache URL resolution", () => {
  let mocks;
  beforeEach(() => {
    mocks = installMocks();
  });
  afterEach(() => {
    teardownMocks();
  });

  it("resolves snapshot.path and snapshot.localcache.path to absolute URLs", async () => {
    const manifestUrl =
      "https://example.test/assets/manifests/MOODLE_500_STABLE.json";
    mocks.responses.set(
      manifestUrl,
      JSON.stringify({
        bundle: { path: "../moodle/MOODLE_500_STABLE/core.zip" },
        snapshot: {
          path: "../moodle/MOODLE_500_STABLE/snapshot/install.sq3",
          localcache: {
            path: "../moodle/MOODLE_500_STABLE/snapshot/localcache.zip",
          },
        },
      }),
    );

    const manifest = await fetchManifest(manifestUrl);
    assert.equal(
      manifest.snapshot.url,
      "https://example.test/assets/moodle/MOODLE_500_STABLE/snapshot/install.sq3",
    );
    assert.equal(
      manifest.snapshot.localcache.url,
      "https://example.test/assets/moodle/MOODLE_500_STABLE/snapshot/localcache.zip",
    );
  });

  it("leaves a manifest without a snapshot untouched", async () => {
    const manifestUrl = "https://example.test/assets/manifests/legacy.json";
    mocks.responses.set(
      manifestUrl,
      JSON.stringify({ bundle: { path: "../moodle/core.zip" } }),
    );

    const manifest = await fetchManifest(manifestUrl);
    assert.equal(manifest.snapshot, undefined);
  });
});

// Regression: WebKit reports a network-level fetch rejection as a bare
// "Load failed" and Firefox as "NetworkError when attempting to fetch
// resource". Those reached Sentry with no URL and no boot phase, so they were
// unactionable. The boot fetches now name both.
describe("boot fetch network errors", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    teardownMocks();
    globalThis.fetch = originalFetch;
  });

  it("names the phase and the query-less URL when the manifest fetch rejects", async () => {
    installMocks();
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };

    await assert.rejects(
      () =>
        fetchManifest(
          "https://example.test/assets/manifests/MOODLE_502_STABLE.json?build=abc123",
        ),
      (error) => {
        assert.match(error.message, /Network error while fetching manifest/);
        assert.match(
          error.message,
          /https:\/\/example\.test\/assets\/manifests\/MOODLE_502_STABLE\.json/,
        );
        // The cache-busting query string is stripped so Sentry groups the
        // reports together instead of one group per build.
        assert.ok(!error.message.includes("build=abc123"));
        assert.match(error.message, /Load failed/);
        assert.ok(error.cause instanceof TypeError);
        return true;
      },
    );
  });

  it("names the asset phase when an auxiliary boot asset fetch rejects", async () => {
    installMocks();
    globalThis.fetch = async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    };

    await assert.rejects(
      () => fetchAssetWithCache("https://example.test/install.sq3"),
      /Network error while fetching asset \(https:\/\/example\.test\/install\.sq3\): NetworkError/,
    );
  });
});
