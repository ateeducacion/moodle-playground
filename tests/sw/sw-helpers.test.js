/**
 * Tests for the pure helper functions in sw.js.
 * Since sw.js runs in a Service Worker context and doesn't export functions,
 * we replicate the pure logic here for testing — same approach as php-compat tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Replicate decodeHtmlAttributeEntities from sw.js
function decodeHtmlAttributeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/gu, (_, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&sol;", "/")
    .replaceAll("&colon;", ":");
}

// Replicate extractScopedRuntime pattern from sw.js
function extractScopedRuntime(pathname, search = "") {
  const match = pathname.match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (!match) {
    return null;
  }

  return {
    scopeId: match[1],
    runtimeId: match[2],
    requestPath: `${match[3] || "/"}${search}`,
  };
}

describe("decodeHtmlAttributeEntities", () => {
  it("decodes &amp;", () => {
    assert.strictEqual(decodeHtmlAttributeEntities("a&amp;b"), "a&b");
  });

  it("decodes &quot;", () => {
    assert.strictEqual(
      decodeHtmlAttributeEntities("say &quot;hello&quot;"),
      'say "hello"',
    );
  });

  it("decodes &#39; and &apos;", () => {
    assert.strictEqual(decodeHtmlAttributeEntities("it&#39;s"), "it's");
    assert.strictEqual(decodeHtmlAttributeEntities("it&apos;s"), "it's");
  });

  it("decodes hex entities", () => {
    assert.strictEqual(decodeHtmlAttributeEntities("&#x2F;"), "/");
    assert.strictEqual(decodeHtmlAttributeEntities("&#x3A;"), ":");
  });

  it("decodes decimal entities", () => {
    assert.strictEqual(decodeHtmlAttributeEntities("&#47;"), "/");
    assert.strictEqual(decodeHtmlAttributeEntities("&#58;"), ":");
  });

  it("decodes &sol; and &colon;", () => {
    assert.strictEqual(
      decodeHtmlAttributeEntities("http&colon;&sol;&sol;example.com"),
      "http://example.com",
    );
  });

  it("handles Moodle-style escaped URLs", () => {
    const encoded = "/admin/index.php?cache=1&amp;sesskey=abc123";
    const decoded = decodeHtmlAttributeEntities(encoded);
    assert.strictEqual(decoded, "/admin/index.php?cache=1&sesskey=abc123");
  });

  it("passes through clean strings unchanged", () => {
    assert.strictEqual(
      decodeHtmlAttributeEntities("/my/index.php"),
      "/my/index.php",
    );
  });
});

describe("extractScopedRuntime", () => {
  it("extracts scope, runtime, and path", () => {
    const result = extractScopedRuntime(
      "/playground/main/php83-moodle50/admin/index.php",
    );
    assert.deepStrictEqual(result, {
      scopeId: "main",
      runtimeId: "php83-moodle50",
      requestPath: "/admin/index.php",
    });
  });

  it("handles root path", () => {
    const result = extractScopedRuntime("/playground/main/php83-moodle50");
    assert.deepStrictEqual(result, {
      scopeId: "main",
      runtimeId: "php83-moodle50",
      requestPath: "/",
    });
  });

  it("includes search params", () => {
    const result = extractScopedRuntime(
      "/playground/main/php83-moodle50/admin/index.php",
      "?cache=1",
    );
    assert.strictEqual(result.requestPath, "/admin/index.php?cache=1");
  });

  it("handles subpath deployment", () => {
    const result = extractScopedRuntime(
      "/moodle-playground/playground/main/php83-cgi/my/",
    );
    assert.ok(result);
    assert.strictEqual(result.scopeId, "main");
    assert.strictEqual(result.requestPath, "/my/");
  });

  it("returns null for non-scoped paths", () => {
    assert.strictEqual(extractScopedRuntime("/assets/logo.png"), null);
    assert.strictEqual(extractScopedRuntime("/"), null);
    assert.strictEqual(extractScopedRuntime("/index.html"), null);
  });
});
