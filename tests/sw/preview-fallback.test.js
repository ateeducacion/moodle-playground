/**
 * Tests for the preview-fallback helpers in sw.js.
 *
 * The service worker retries `draftfile.php` / `pluginfile.php` requests
 * without the `?preview=` parameter when the runtime answers 404, because
 * GD-based thumbnail generation fails inside @php-wasm. See sw.js +
 * issue #90 for the background.
 *
 * Following the project convention (tests/sw/sw-helpers.test.js), the
 * pure helpers are replicated here so they can be exercised with
 * `node --test` without booting a Service Worker context.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const PREVIEW_FALLBACK_PATH_RE = /\/(draftfile|pluginfile)\.php(?:\/|$)/u;

function isPreviewFallbackCandidate(requestPath, status) {
  if (status !== 404) {
    return false;
  }
  const qIdx = requestPath.indexOf("?");
  if (qIdx < 0) {
    return false;
  }
  const pathOnly = requestPath.slice(0, qIdx);
  if (!PREVIEW_FALLBACK_PATH_RE.test(pathOnly)) {
    return false;
  }
  const params = new URLSearchParams(requestPath.slice(qIdx + 1));
  const value = params.get("preview");
  return value !== null && value !== "";
}

function stripPreviewParam(requestPath) {
  const qIdx = requestPath.indexOf("?");
  if (qIdx < 0) {
    return requestPath;
  }
  const params = new URLSearchParams(requestPath.slice(qIdx + 1));
  if (!params.has("preview")) {
    return requestPath;
  }
  params.delete("preview");
  const remaining = params.toString();
  const pathOnly = requestPath.slice(0, qIdx);
  return remaining ? `${pathOnly}?${remaining}` : pathOnly;
}

describe("isPreviewFallbackCandidate", () => {
  it("matches a 404 for draftfile.php?preview=thumb", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?preview=thumb&oid=42",
        404,
      ),
      true,
    );
  });

  it("matches a 404 for pluginfile.php?preview=bigthumb", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/pluginfile.php/12/mod_resource/content/0/photo.png?preview=bigthumb",
        404,
      ),
      true,
    );
  });

  it("ignores non-404 responses", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?preview=thumb",
        200,
      ),
      false,
    );
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?preview=thumb",
        500,
      ),
      false,
    );
  });

  it("ignores 404s without a preview parameter", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/draftfile.php/5/user/draft/1/missing.jpg?oid=42",
        404,
      ),
      false,
    );
  });

  it("ignores 404s with an empty preview parameter", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?preview=",
        404,
      ),
      false,
    );
  });

  it("ignores 404s without a query string", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/draftfile.php/5/user/draft/1/missing.jpg",
        404,
      ),
      false,
    );
  });

  it("ignores unrelated Moodle scripts", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/lib/javascript.php/-1/lib/requirejs/require.js?preview=thumb",
        404,
      ),
      false,
    );
    assert.strictEqual(
      isPreviewFallbackCandidate(
        "/theme/image.php/boost/core/1/f/folder?preview=thumb",
        404,
      ),
      false,
    );
  });

  it("does not match a path that merely contains 'draftfile.php' as a substring", () => {
    assert.strictEqual(
      isPreviewFallbackCandidate("/not-draftfile.php-decoy?preview=thumb", 404),
      false,
    );
  });
});

describe("stripPreviewParam", () => {
  it("removes preview= and keeps the rest of the query string", () => {
    assert.strictEqual(
      stripPreviewParam(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?preview=thumb&oid=42",
      ),
      "/draftfile.php/5/user/draft/1/Sherlock.jpg?oid=42",
    );
  });

  it("handles preview= appearing after other params", () => {
    assert.strictEqual(
      stripPreviewParam(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?oid=42&preview=thumb",
      ),
      "/draftfile.php/5/user/draft/1/Sherlock.jpg?oid=42",
    );
  });

  it("drops the lone ? when preview= is the only param", () => {
    assert.strictEqual(
      stripPreviewParam(
        "/draftfile.php/5/user/draft/1/Sherlock.jpg?preview=thumb",
      ),
      "/draftfile.php/5/user/draft/1/Sherlock.jpg",
    );
  });

  it("returns the path unchanged when no preview param is present", () => {
    assert.strictEqual(
      stripPreviewParam("/draftfile.php/5/user/draft/1/Sherlock.jpg?oid=42"),
      "/draftfile.php/5/user/draft/1/Sherlock.jpg?oid=42",
    );
  });

  it("returns the path unchanged when there is no query string", () => {
    assert.strictEqual(
      stripPreviewParam("/draftfile.php/5/user/draft/1/Sherlock.jpg"),
      "/draftfile.php/5/user/draft/1/Sherlock.jpg",
    );
  });

  it("preserves repeated non-preview params", () => {
    assert.strictEqual(
      stripPreviewParam(
        "/pluginfile.php/12/mod_resource/0/file.png?tag=a&tag=b&preview=thumb",
      ),
      "/pluginfile.php/12/mod_resource/0/file.png?tag=a&tag=b",
    );
  });
});
