import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  fetchAssetWithCache,
  fetchBootAsset,
  fetchBundleWithCache,
  fetchManifest,
  fetchWithProgress,
  resolveBootstrapArchive,
} from "../../lib/moodle-loader.js";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// In-memory Cache Storage + fetch; a response factory lets a test control
// headers, status or a body without a stream reader.
function installMocks() {
  const store = new Map();
  const responses = new Map();
  const fetched = [];
  const inits = [];
  globalThis.fetch = async (url, init) => {
    fetched.push(String(url));
    inits.push(init);
    const entry = responses.get(String(url));
    if (typeof entry === "function") return entry(init);
    if (entry === undefined)
      return new Response("nope", { status: 404, statusText: "Not Found" });
    return new Response(entry, { status: 200 });
  };
  const cache = {
    putFails: false,
    async match(url) {
      const bytes = store.get(String(url));
      return bytes ? new Response(bytes) : undefined;
    },
    async put(url, response) {
      if (cache.putFails) throw new Error("quota");
      store.set(String(url), new Uint8Array(await response.arrayBuffer()));
    },
    async delete(url) {
      return store.delete(String(url));
    },
  };
  globalThis.caches = { open: async () => cache };
  globalThis.self = { location: { href: "https://app.test/sub/" } };
  return { store, responses, fetched, cache, inits };
}

let mocks;
beforeEach(() => {
  mocks = installMocks();
});
afterEach(() => {
  delete globalThis.fetch;
  delete globalThis.caches;
  delete globalThis.self;
});

describe("fetchBootAsset", () => {
  it("names the phase and strips the query from network errors", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Load failed");
    };
    await assert.rejects(
      fetchBootAsset(
        "https://app.test/a.zip?token=secret",
        undefined,
        "bundle",
      ),
      (error) =>
        error.message ===
          "Network error while fetching bundle (https://app.test/a.zip): Load failed" &&
        error.cause instanceof TypeError,
    );
  });
});

describe("fetchWithProgress", () => {
  it("streams chunks and reports ratio against content-length", async () => {
    const data = new Uint8Array(randomBytes(300));
    mocks.responses.set("https://app.test/b", () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(data.subarray(0, 100));
          controller.enqueue(data.subarray(100));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-length": "300" } });
    });
    const events = [];
    const bytes = await fetchWithProgress("https://app.test/b", (e) =>
      events.push(e),
    );
    assert.deepEqual(bytes, data);
    assert.deepEqual(
      events.map((e) => e.ratio),
      [100 / 300, 1, 1],
    );
  });

  it("reports ratio 0 without content-length and reads bodies without a reader", async () => {
    mocks.responses.set("https://app.test/s", () => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.close();
        },
      });
      return new Response(body);
    });
    const events = [];
    await fetchWithProgress("https://app.test/s", (e) => events.push(e));
    assert.equal(events[0].ratio, 0);

    const fake = {
      ok: true,
      headers: new Headers({ "content-length": "2" }),
      body: null,
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    };
    globalThis.fetch = async () => fake;
    const progress = [];
    const bytes = await fetchWithProgress("https://app.test/n", (e) =>
      progress.push(e),
    );
    assert.deepEqual([...bytes], [7, 8]);
    assert.deepEqual(progress, [{ loaded: 2, total: 2, ratio: 1 }]);

    fake.headers = new Headers();
    const zero = [];
    await fetchWithProgress("https://app.test/n", (e) => zero.push(e));
    assert.equal(zero[0].ratio, 0);
  });

  it("rejects a non-OK response", async () => {
    await assert.rejects(
      fetchWithProgress("https://app.test/missing"),
      /Unable to download Moodle archive: 404 Not Found/,
    );
  });
});

describe("fetchManifest normalization", () => {
  it("resolves bundle, parts, snapshot and localcache paths against the manifest URL", async () => {
    mocks.responses.set("https://app.test/sub/m/manifest.json", () =>
      Response.json({
        bundle: { path: "core.tar.zst" },
        snapshot: { path: "install.sq3", localcache: { path: "lc.zip" } },
      }),
    );
    const single = await fetchManifest("https://app.test/sub/m/manifest.json");
    assert.equal(single.bundle.url, "https://app.test/sub/m/core.tar.zst");
    assert.equal(single.snapshot.url, "https://app.test/sub/m/install.sq3");
    assert.equal(
      single.snapshot.localcache.url,
      "https://app.test/sub/m/lc.zip",
    );

    mocks.responses.set("https://app.test/sub/p.json", () =>
      Response.json({
        bundle: { parts: [{ path: "x/p0" }] },
        snapshot: { path: "s" },
      }),
    );
    const parts = await fetchManifest("https://app.test/sub/p.json");
    assert.equal(parts.bundle.parts[0].url, "https://app.test/sub/x/p0");
    assert.equal(parts.snapshot.localcache, undefined);
  });

  it("rejects manifests without a bundle and failed manifest responses", async () => {
    mocks.responses.set("https://app.test/sub/e.json", () => Response.json({}));
    await assert.rejects(
      fetchManifest("https://app.test/sub/e.json"),
      /does not include bundle.path/,
    );
    await assert.rejects(
      fetchManifest("https://app.test/sub/gone.json"),
      /Unable to load manifest: 404/,
    );
  });
});

describe("fetchBundleWithCache (single bundle)", () => {
  const url = "https://app.test/core.tar.zst";

  it("downloads, verifies and caches, then serves the cache", async () => {
    const data = new Uint8Array(randomBytes(64));
    mocks.responses.set(url, data);
    const manifest = {
      release: "5.0",
      bundle: { url, sha256: sha256Hex(data), size: 64 },
    };

    assert.deepEqual(await fetchBundleWithCache(manifest), data);
    assert.ok(mocks.store.has(url));

    const events = [];
    assert.deepEqual(
      await fetchBundleWithCache(manifest, (e) => events.push(e)),
      data,
    );
    assert.equal(mocks.fetched.length, 1);
    assert.equal(events[0].cached, true);
  });

  it("busts a corrupted cache entry and redownloads", async () => {
    const data = new Uint8Array(randomBytes(32));
    mocks.store.set(url, new Uint8Array([9, 9]));
    mocks.responses.set(url, data);
    const events = [];
    const bytes = await fetchBundleWithCache(
      { bundle: { url, sha256: sha256Hex(data).toUpperCase() } },
      (e) => events.push(e),
    );
    assert.deepEqual(bytes, data);
    assert.equal(events[0].total, 0);
    assert.ok(
      events.some(
        (e) => e.phase === "cache-bust" && /checksum mismatch/.test(e.error),
      ),
    );
    assert.deepEqual(mocks.store.get(url), data);
  });

  it("keeps working when the cache rejects the write", async () => {
    const data = new Uint8Array([1, 2, 3]);
    mocks.responses.set(url, data);
    mocks.cache.putFails = true;
    assert.deepEqual(await fetchBundleWithCache({ bundle: { url } }), data);
  });

  it("rejects a downloaded bundle with the wrong checksum", async () => {
    mocks.responses.set(url, new Uint8Array([1]));
    await assert.rejects(
      fetchBundleWithCache({ bundle: { url, sha256: "00" } }),
      /Bundle checksum mismatch/,
    );
  });

  it("refetches past the HTTP cache when the downloaded bytes mismatch", async () => {
    const stale = new Uint8Array(randomBytes(32));
    const fresh = new Uint8Array(randomBytes(32));
    mocks.responses.set(
      url,
      (init) =>
        new Response(init?.cache === "reload" ? fresh : stale, { status: 200 }),
    );

    const bytes = await fetchBundleWithCache({
      bundle: { url, sha256: sha256Hex(fresh) },
    });
    assert.deepEqual(bytes, fresh);
    assert.equal(mocks.fetched.length, 2, "one retry");
    assert.equal(mocks.inits[1]?.cache, "reload");
    assert.deepEqual(mocks.store.get(url), fresh);
  });
});

describe("fetchBundleWithCache (parts edge cases)", () => {
  const partUrl = "https://app.test/core.part-000";

  it("refetches a part past the HTTP cache when its bytes mismatch", async () => {
    const stale = new Uint8Array(randomBytes(16));
    const fresh = new Uint8Array(randomBytes(16));
    mocks.responses.set(
      partUrl,
      (init) =>
        new Response(init?.cache === "reload" ? fresh : stale, { status: 200 }),
    );

    const bytes = await fetchBundleWithCache({
      bundle: {
        sha256: sha256Hex(fresh),
        parts: [{ url: partUrl, size: 16, sha256: sha256Hex(fresh) }],
      },
    });
    assert.deepEqual(bytes, fresh);
    assert.equal(mocks.fetched.length, 2, "one retry");
    assert.equal(mocks.inits[1]?.cache, "reload");
  });

  it("refetches a cached part with a bad checksum and tolerates cache write failures", async () => {
    const data = new Uint8Array(randomBytes(16));
    mocks.store.set(partUrl, new Uint8Array(16));
    mocks.responses.set(partUrl, data);
    mocks.cache.putFails = true;
    const bytes = await fetchBundleWithCache({
      bundle: {
        sha256: sha256Hex(data),
        parts: [{ url: partUrl, size: 16, sha256: sha256Hex(data) }],
      },
    });
    assert.deepEqual(bytes, data);
    assert.equal(mocks.fetched.length, 1);
  });

  it("rejects a part whose downloaded size differs from the manifest", async () => {
    mocks.responses.set(partUrl, new Uint8Array([1, 2]));
    await assert.rejects(
      fetchBundleWithCache({ bundle: { parts: [{ url: partUrl, size: 3 }] } }),
      /Bundle part size mismatch .*expected 3, received 2/,
    );
  });

  it("accepts a cached part without its own checksum", async () => {
    const data = new Uint8Array([4, 5]);
    mocks.store.set(partUrl, data);
    const bytes = await fetchBundleWithCache({
      bundle: { parts: [{ url: partUrl, size: 2 }] },
    });
    assert.deepEqual(bytes, data);
    assert.equal(mocks.fetched.length, 0);
  });

  it("reads a part body without a stream reader and rejects a failed part", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      body: null,
      arrayBuffer: async () => new Uint8Array([6, 7]).buffer,
    });
    const bytes = await fetchBundleWithCache({
      bundle: { parts: [{ url: partUrl, size: 2 }] },
    });
    assert.deepEqual([...bytes], [6, 7]);

    globalThis.fetch = async () =>
      new Response("x", { status: 500, statusText: "Boom" });
    await assert.rejects(
      fetchBundleWithCache({ bundle: { parts: [{ url: partUrl, size: 1 }] } }),
      /Unable to download bundle part: 500 Boom/,
    );
  });
});

describe("resolveBootstrapArchive", () => {
  it("loads the manifest, downloads the bundle and reports the source URL", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    mocks.responses.set("https://app.test/sub/manifest.json", () =>
      Response.json({ bundle: { path: "core.bin", sha256: sha256Hex(data) } }),
    );
    mocks.responses.set("https://app.test/sub/core.bin", data);
    const phases = [];
    const archive = await resolveBootstrapArchive(
      { manifestUrl: "https://app.test/sub/manifest.json" },
      (e) => phases.push(e.phase),
    );
    assert.equal(archive.kind, "bundle");
    assert.equal(archive.sourceUrl, "https://app.test/sub/core.bin");
    assert.deepEqual(archive.bytes, data);
    assert.equal(phases[0], "manifest");
  });

  it("reports the first part URL for chunked bundles", async () => {
    const data = new Uint8Array([1]);
    mocks.responses.set("https://app.test/sub/m.json", () =>
      Response.json({ bundle: { parts: [{ path: "p0", size: 1 }] } }),
    );
    mocks.responses.set("https://app.test/sub/p0", data);
    const archive = await resolveBootstrapArchive({
      manifestUrl: "https://app.test/sub/m.json",
    });
    assert.equal(archive.sourceUrl, "https://app.test/sub/p0");
  });
});

describe("fetchAssetWithCache cache write failure", () => {
  it("returns verified bytes even when the cache rejects the write", async () => {
    const data = new Uint8Array([3, 1, 4]);
    mocks.responses.set("https://app.test/seed.zip", data);
    mocks.cache.putFails = true;
    const bytes = await fetchAssetWithCache("https://app.test/seed.zip", {
      sha256: sha256Hex(data),
    });
    assert.deepEqual(bytes, data);
    assert.equal(mocks.store.size, 0);
  });
});
