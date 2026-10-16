import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCacheableScopedAssetPath,
  isCacheableScopedAssetResponse,
} from "../../src/shared/sw-asset-cache.js";

const esm = "/r.php/core/esm/1791030540/react-dom/client";
const response = (headers = {}, status = 200) =>
  new Response("export {};", {
    status,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      ...headers,
    },
  });

describe("scoped asset cache policy", () => {
  it("admits immutable ESM specifiers with and without a .js suffix", () => {
    for (const path of [
      esm,
      "/r.php/core/esm/1791030540/@moodle/lms/core/test.js",
    ]) {
      assert.equal(isCacheableScopedAssetPath(path), true);
      assert.equal(isCacheableScopedAssetResponse(path, response()), true);
    }
  });

  it("keeps static assets and the existing PHP asset allowlist", () => {
    for (const path of [
      "/lib/test.js?rev=1",
      "/theme/styles.php/boost/123/all",
      "/lib/requirejs.php/123/core/first.js",
      "/lib/editor/tiny/loader.php/123/tinymce/tinymce.js",
      "/lib/editor/tiny/lang.php/123/es",
    ]) {
      assert.equal(isCacheableScopedAssetPath(path), true);
    }
    // Uncached TinyMCE revisions stay on the PHP path, like development AMD.
    for (const path of [
      "/lib/editor/tiny/loader.php/-1/tinymce/tinymce.js",
      "/lib/editor/tiny/lang.php/-1/es",
    ]) {
      assert.equal(isCacheableScopedAssetPath(path), false);
    }
  });

  it("rejects invalid, encoded, development and query-bearing ESM paths", () => {
    for (const path of [
      "/r.php/core/esm/0/react",
      "/r.php/core/esm/-1/react.js",
      "/r.php/core/esm/9007199254740992/react",
      "/r.php/core/esm/12/",
      "/r.php/core/esm/12/../react",
      "/r.php/core/esm/12/%2e%2e/react",
      "/r.php/core/esm/12/react?x=1",
      "/r.php/core/%65sm/12/react.js",
      "/r.php/core/esm/12/react\\client",
      "/r.php/core/esm/12/react//client",
    ])
      assert.equal(isCacheableScopedAssetPath(path), false, path);
  });

  it("does not retain development AMD after plugin updates or cache purges", () => {
    assert.equal(
      isCacheableScopedAssetPath(
        "/lib/requirejs.php/-1/local_fixture/probe.js",
      ),
      false,
    );
    assert.equal(
      isCacheableScopedAssetResponse(
        "/lib/requirejs.php/123/local_fixture/probe.js",
        response({ "cache-control": "no-cache, no-store" }),
      ),
      false,
    );
  });

  it("never admits generic router, HTML, AJAX or protected PHP file paths", () => {
    for (const path of [
      "/r.php/private/test.js",
      "/my/",
      "/lib/ajax/service.php",
      "/pluginfile.php/1/private/secret.js",
      "/draftfile.php/1/private/secret.css",
      "/pluginfile%2ephp/1/private/secret.js",
      "/admin/example.php/file.js",
    ])
      assert.equal(isCacheableScopedAssetPath(path), false, path);
  });

  it("requires a successful public immutable JavaScript response for ESM", () => {
    for (const headers of [
      { "cache-control": "max-age=31536000, immutable" },
      { "cache-control": "public, max-age=2" },
      { "cache-control": "private, public, immutable" },
      { "cache-control": 'public, immutable, private = "field"' },
      { "cache-control": "public, immutable, no-store" },
      { "cache-control": "public, immutable, no-cache" },
      { "content-type": "text/html" },
      { "content-type": "application/json" },
      { "set-cookie": "session=fixture" },
      { vary: "*" },
    ])
      assert.equal(
        isCacheableScopedAssetResponse(esm, response(headers)),
        false,
      );
    for (const status of [206, 302, 403, 404, 500]) {
      assert.equal(
        isCacheableScopedAssetResponse(esm, response({}, status)),
        false,
      );
    }
    assert.equal(
      isCacheableScopedAssetResponse(
        esm,
        response({ "cache-control": "PUBLIC, max-age=30, IMMUTABLE" }),
      ),
      true,
    );
  });

  it("does not cache a response for a disallowed path or legacy HTML", () => {
    assert.equal(
      isCacheableScopedAssetResponse("/pluginfile.php/secret.js", response()),
      false,
    );
    assert.equal(
      isCacheableScopedAssetResponse(
        "/lib/test.js",
        response({ "content-type": "text/html" }),
      ),
      false,
    );
  });
});
