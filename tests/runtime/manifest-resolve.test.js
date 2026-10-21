import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildFallbackManifestUrl,
  fetchManifest,
  resolveManifestUrl,
} from "../../src/runtime/manifest.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__APP_ROOT__;
});

describe("manifest defaults", () => {
  it("loads latest.json next to the app when no URL is given", async () => {
    let requested;
    globalThis.fetch = async (url) => {
      requested = String(url);
      return { ok: true, json: async () => ({ release: "5.0" }) };
    };
    assert.deepEqual(await fetchManifest(), { release: "5.0" });
    assert.match(requested, /^file:\/\/.*\/assets\/manifests\/latest\.json$/);

    globalThis.__APP_ROOT__ = "https://cdn.test/pg/";
    await fetchManifest();
    assert.equal(requested, "https://cdn.test/pg/assets/manifests/latest.json");
    assert.equal(
      buildFallbackManifestUrl(),
      "https://cdn.test/pg/assets/manifests/latest.json",
    );
  });

  it("reports the HTTP status of a failed manifest download", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      statusText: "Server Error",
    });
    await assert.rejects(
      fetchManifest("https://example.test/m.json"),
      /Unable to load manifest: 500 Server Error/,
    );
  });
});

describe("resolveManifestUrl fallback verification", () => {
  it("names unknown channel and release when latest.json has neither", async () => {
    globalThis.fetch = async (_url, init) =>
      init?.method === "HEAD"
        ? { ok: false, status: 404, statusText: "Not Found" }
        : { ok: true, json: async () => ({}) };
    await assert.rejects(
      resolveManifestUrl("main", "https://example.test/"),
      /fallback manifest \(channel: unknown, release: unknown\) does not match/,
    );
  });
});
