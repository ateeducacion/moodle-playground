import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchBundleWithCache } from "../../lib/moodle-loader.js";

// fetchBundleWithCache only fetches, reassembles and sha256-verifies the bundle
// bytes (it does not unzip), so the fixture is just incompressible random bytes
// standing in for a zip — large enough to split into several parts.
const makeBundle = (size) => new Uint8Array(randomBytes(size));

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Minimal in-memory Cache Storage so fetchBundleWithCache can run under node.
function installMocks() {
  const store = new Map();
  let fetchCount = 0;
  const responses = new Map();

  globalThis.__fetchCount = () => fetchCount;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    const bytes = responses.get(String(url));
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(bytes, { status: 200 });
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

  return { responses, store };
}

function teardownMocks() {
  delete globalThis.fetch;
  delete globalThis.caches;
  delete globalThis.__fetchCount;
}

function makeChunkedManifest(zipBytes, partSize) {
  const parts = [];
  for (
    let offset = 0, i = 0;
    offset < zipBytes.length;
    offset += partSize, i += 1
  ) {
    const slice = zipBytes.subarray(
      offset,
      Math.min(offset + partSize, zipBytes.length),
    );
    parts.push({
      url: `https://example.test/core.zip.part-${String(i).padStart(3, "0")}`,
      size: slice.length,
      sha256: sha256Hex(slice),
      bytes: slice,
    });
  }
  const manifest = {
    bundle: {
      format: "zip-parts",
      sha256: sha256Hex(zipBytes),
      totalSize: zipBytes.length,
      parts: parts.map(({ url, size, sha256 }) => ({ url, size, sha256 })),
    },
  };
  return { manifest, parts };
}

describe("fetchBundleWithCache (zip-parts)", () => {
  let mocks;
  beforeEach(() => {
    mocks = installMocks();
  });
  afterEach(() => {
    teardownMocks();
  });

  it("reassembles parts into the original bytes and verifies the overall sha256", async () => {
    const zip = makeBundle(300 * 1024);
    const { manifest, parts } = makeChunkedManifest(zip, 64 * 1024);
    assert.ok(
      parts.length >= 3,
      "expected the fixture to split into several parts",
    );
    for (const part of parts) mocks.responses.set(part.url, part.bytes);

    const result = await fetchBundleWithCache(manifest);
    assert.equal(result.byteLength, zip.byteLength);
    assert.equal(sha256Hex(result), sha256Hex(zip));
    assert.deepEqual(result, zip);
  });

  it("serves parts from cache on a second call (no extra network fetches)", async () => {
    const zip = makeBundle(200 * 1024);
    const { manifest, parts } = makeChunkedManifest(zip, 48 * 1024);
    for (const part of parts) mocks.responses.set(part.url, part.bytes);

    await fetchBundleWithCache(manifest);
    const afterFirst = globalThis.__fetchCount();
    const again = await fetchBundleWithCache(manifest);
    assert.equal(
      globalThis.__fetchCount(),
      afterFirst,
      "second call must hit the cache",
    );
    assert.equal(sha256Hex(again), sha256Hex(zip));
  });

  it("rejects a corrupted part (per-part sha256 mismatch)", async () => {
    const zip = makeBundle(200 * 1024);
    const { manifest, parts } = makeChunkedManifest(zip, 48 * 1024);
    for (const part of parts) mocks.responses.set(part.url, part.bytes);
    // Corrupt the first part's served bytes (flip a byte) without touching its
    // declared sha256, so verification must fail.
    const corrupt = new Uint8Array(parts[0].bytes);
    corrupt[0] ^= 0xff;
    mocks.responses.set(parts[0].url, corrupt);

    await assert.rejects(
      () => fetchBundleWithCache(manifest),
      /checksum mismatch/i,
    );
  });
});
