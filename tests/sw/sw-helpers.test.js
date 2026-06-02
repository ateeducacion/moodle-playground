/**
 * Tests for the pure helper functions in sw.js.
 * Since sw.js runs in a Service Worker context and doesn't export functions,
 * we replicate the pure logic here for testing — same approach as php-compat tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const STATIC_PREFIXES = [
  "/assets/",
  "/dist/",
  "/src/",
  "/vendor/",
  "/php-worker.js",
  "/sw.js",
  "/remote.html",
  "/index.html",
  "/playground.config.json",
  "/favicon.ico",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/logo.png",
];

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

function stripAppBasePath(pathname, appBasePath = "/") {
  if (appBasePath === "/") {
    return pathname || "/";
  }

  if (pathname === appBasePath) {
    return "/";
  }

  if (pathname.startsWith(`${appBasePath}/`)) {
    return pathname.slice(appBasePath.length) || "/";
  }

  return pathname || "/";
}

function isStaticHostPath(pathname, appBasePath = "/") {
  const strippedPathname = stripAppBasePath(pathname, appBasePath);
  return STATIC_PREFIXES.some(
    (prefix) =>
      strippedPathname === prefix || strippedPathname.startsWith(prefix),
  );
}

function isSensitiveStaticPath(pathname, appBasePath = "/") {
  const strippedPathname = stripAppBasePath(pathname, appBasePath);
  return (
    strippedPathname === "/" ||
    strippedPathname === "/index.html" ||
    strippedPathname === "/remote.html" ||
    strippedPathname === "/playground.config.json" ||
    strippedPathname === "/assets/build-version.json" ||
    /^\/assets\/manifests\/[^/]+\.json$/u.test(strippedPathname)
  );
}

function rewriteHtmlAttributeUrl(
  rawValue,
  { origin, scopeId, runtimeId, appBasePath = "/" },
) {
  const decodedValue = decodeHtmlAttributeEntities(rawValue);
  const scopedBasePath =
    appBasePath === "/"
      ? `/playground/${scopeId}/${runtimeId}`
      : `${appBasePath}/playground/${scopeId}/${runtimeId}`;

  if (!decodedValue) {
    return decodedValue;
  }

  if (
    decodedValue.startsWith("#") ||
    decodedValue.startsWith("javascript:") ||
    decodedValue.startsWith("data:") ||
    decodedValue.startsWith("mailto:") ||
    decodedValue.startsWith("tel:") ||
    decodedValue.startsWith("//")
  ) {
    return decodedValue;
  }

  if (!decodedValue.startsWith("/") && !decodedValue.includes("://")) {
    return decodedValue;
  }

  try {
    const absolute = new URL(decodedValue, origin);
    if (absolute.origin !== origin) {
      return decodedValue;
    }

    const absolutePath = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    if (
      absolute.pathname.startsWith(`${scopedBasePath}/`) ||
      absolute.pathname === scopedBasePath
    ) {
      return absolutePath;
    }

    if (isStaticHostPath(absolute.pathname, appBasePath)) {
      return absolutePath;
    }

    if (!absolute.pathname.startsWith("/")) {
      return decodedValue;
    }

    if (
      appBasePath !== "/" &&
      absolute.pathname !== appBasePath &&
      !absolute.pathname.startsWith(`${appBasePath}/`)
    ) {
      return decodedValue;
    }

    const runtimePath = `${stripAppBasePath(
      absolute.pathname,
      appBasePath,
    )}${absolute.search}${absolute.hash}`;
    return `${scopedBasePath}${
      runtimePath.startsWith("/") ? runtimePath : `/${runtimePath}`
    }`.replace(/\/{2,}/gu, "/");
  } catch {
    return decodedValue;
  }
}

// Replicate escapeHtml from sw.js
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Replicate the attribute-rewrite step from rewriteHtmlDocument in sw.js: the
// decoded, rewritten value must be re-encoded for HTML attribute context before
// it is interpolated back between the quotes.
function rewriteHtmlDocumentAttributes(html, scope) {
  return html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    (_match, prefix, rawValue, suffix) =>
      `${prefix}${escapeHtml(rewriteHtmlAttributeUrl(rawValue, scope))}${suffix}`,
  );
}

// Replicate buildScopedCacheKey from sw.js
function buildScopedCacheKey(origin, scopeId, runtimeId, requestPath) {
  const queryIndex = requestPath.indexOf("?");
  const pathPart =
    queryIndex === -1 ? requestPath : requestPath.slice(0, queryIndex);
  const searchPart = queryIndex === -1 ? "" : requestPath.slice(queryIndex);
  const normalizedPath = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const scopedPath =
    `/playground/${scopeId}/${runtimeId}${normalizedPath}`.replace(
      /\/{2,}/gu,
      "/",
    );
  return new URL(`${scopedPath}${searchPart}`, origin).toString();
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

describe("isSensitiveStaticPath", () => {
  it("marks the app root as network-first", () => {
    assert.strictEqual(isSensitiveStaticPath("/"), true);
  });

  it("marks remote.html as network-first", () => {
    assert.strictEqual(isSensitiveStaticPath("/remote.html"), true);
  });

  it("marks manifest JSON as network-first", () => {
    assert.strictEqual(
      isSensitiveStaticPath("/assets/manifests/latest.json"),
      true,
    );
  });

  it("marks build metadata as network-first", () => {
    assert.strictEqual(
      isSensitiveStaticPath("/assets/build-version.json"),
      true,
    );
  });

  it("does not mark regular static assets as sensitive", () => {
    assert.strictEqual(isSensitiveStaticPath("/src/shell/main.js"), false);
    assert.strictEqual(
      isSensitiveStaticPath("/dist/php-worker.bundle.js"),
      false,
    );
  });
});

describe("rewriteHtmlAttributeUrl", () => {
  const scope = {
    origin: "https://ateeducacion.github.io",
    scopeId: "main",
    runtimeId: "php83-moodle50",
    appBasePath: "/moodle-playground",
  };

  it("rewrites dynamic form actions under the app base path", () => {
    assert.strictEqual(
      rewriteHtmlAttributeUrl("/moodle-playground/course/edit.php", scope),
      "/moodle-playground/playground/main/php83-moodle50/course/edit.php",
    );
  });

  it("rewrites javascript.php asset URLs to the runtime scope", () => {
    assert.strictEqual(
      rewriteHtmlAttributeUrl(
        "/moodle-playground/lib/javascript.php/-1/lib/requirejs/require.js",
        scope,
      ),
      "/moodle-playground/playground/main/php83-moodle50/lib/javascript.php/-1/lib/requirejs/require.js",
    );
  });

  it("rewrites theme font URLs to the runtime scope", () => {
    assert.strictEqual(
      rewriteHtmlAttributeUrl(
        "/moodle-playground/theme/font.php/boost/core/1773844643/fa-regular-400.woff2",
        scope,
      ),
      "/moodle-playground/playground/main/php83-moodle50/theme/font.php/boost/core/1773844643/fa-regular-400.woff2",
    );
  });

  it("keeps static host assets unchanged", () => {
    assert.strictEqual(
      rewriteHtmlAttributeUrl("/moodle-playground/assets/logo.png", scope),
      "/moodle-playground/assets/logo.png",
    );
    assert.strictEqual(
      rewriteHtmlAttributeUrl("/moodle-playground/sw.js", scope),
      "/moodle-playground/sw.js",
    );
    assert.strictEqual(
      rewriteHtmlAttributeUrl("/moodle-playground/remote.html", scope),
      "/moodle-playground/remote.html",
    );
  });

  it("keeps already scoped URLs unchanged", () => {
    assert.strictEqual(
      rewriteHtmlAttributeUrl(
        "/moodle-playground/playground/main/php83-moodle50/course/edit.php?category=0",
        scope,
      ),
      "/moodle-playground/playground/main/php83-moodle50/course/edit.php?category=0",
    );
  });
});

describe("rewriteHtmlDocumentAttributes (attribute re-encoding)", () => {
  const scope = {
    origin: "https://ateeducacion.github.io",
    scopeId: "main",
    runtimeId: "php83-moodle50",
    appBasePath: "/moodle-playground",
  };

  it("re-encodes & in rewritten query strings for attribute context", () => {
    // Moodle emits &amp; in attributes; rewriteHtmlAttributeUrl decodes it,
    // so the document rewrite must re-encode it back to &amp; (not raw &).
    const html =
      '<a href="/moodle-playground/admin/index.php?cache=1&amp;sesskey=abc">x</a>';
    const out = rewriteHtmlDocumentAttributes(html, scope);
    assert.strictEqual(
      out,
      '<a href="/moodle-playground/playground/main/php83-moodle50/admin/index.php?cache=1&amp;sesskey=abc">x</a>',
    );
    // The raw, unescaped ampersand must never appear in the output attribute.
    assert.ok(!/sesskey=abc/.test(out) || /&amp;sesskey=abc/.test(out));
  });

  it("neutralizes a quote-injection payload that would close the attribute", () => {
    // A reflected RELATIVE URL whose entity-decoded form contains a double quote.
    // rewriteHtmlAttributeUrl returns relative URLs untouched (without going
    // through URL normalization that would percent-encode the quote), so the
    // document rewrite's escapeHtml is the layer that prevents the decoded quote
    // from closing the attribute early and injecting markup into the iframe.
    const html =
      '<a href="foo.php?x=&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">x</a>';
    const out = rewriteHtmlDocumentAttributes(html, scope);
    // The attribute must still be a single quoted value (not broken out of).
    const valueMatch = out.match(/href="([^"]*)"/u);
    assert.ok(valueMatch, "attribute should still be a single quoted value");
    // The decoded quote must have been re-encoded back to an entity.
    assert.ok(out.includes("&quot;"), "double quote must be encoded");
    // The dangerous unencoded markup must not be present.
    assert.ok(!out.includes('"><img'), "must not break out of the attribute");
    assert.ok(
      !/<img\s+src=x\s+onerror=/u.test(out),
      "injected <img> tag must not appear unescaped",
    );
  });

  it("re-encodes a single quote in a relative URL (single-quote breakout)", () => {
    // Single-quoted attribute with a decoded single quote in a relative URL.
    const html = "<a href='foo.php?n=&#39;a&#39;'>x</a>";
    const out = rewriteHtmlDocumentAttributes(html, scope);
    assert.ok(out.includes("&#39;"), "single quote must be encoded");
    assert.ok(!/n='a'/u.test(out), "raw single quotes must not appear");
  });

  it("leaves clean relative URLs intact after re-encoding", () => {
    const html = '<a href="upgradesettings.php">x</a>';
    const out = rewriteHtmlDocumentAttributes(html, scope);
    assert.strictEqual(out, '<a href="upgradesettings.php">x</a>');
  });
});

describe("buildScopedCacheKey", () => {
  const origin = "https://ateeducacion.github.io";

  it("namespaces the cache key by scope and runtime", () => {
    assert.strictEqual(
      buildScopedCacheKey(origin, "main", "php83-moodle50", "/theme/main.css"),
      "https://ateeducacion.github.io/playground/main/php83-moodle50/theme/main.css",
    );
  });

  it("produces different keys for different runtimes (no cross-runtime collision)", () => {
    const path = "/pix/i/logo.svg";
    const keyA = buildScopedCacheKey(origin, "main", "php83-moodle50", path);
    const keyB = buildScopedCacheKey(origin, "main", "php83-moodle51", path);
    assert.notStrictEqual(keyA, keyB);
  });

  it("produces different keys for different scopes", () => {
    const path = "/theme/font.php/boost/core/fa.woff2";
    const keyA = buildScopedCacheKey(origin, "main", "php83-moodle50", path);
    const keyB = buildScopedCacheKey(origin, "alt", "php83-moodle50", path);
    assert.notStrictEqual(keyA, keyB);
  });

  it("preserves the query string", () => {
    assert.strictEqual(
      buildScopedCacheKey(
        origin,
        "main",
        "php83-moodle50",
        "/lib/javascript.php?ver=123",
      ),
      "https://ateeducacion.github.io/playground/main/php83-moodle50/lib/javascript.php?ver=123",
    );
  });

  it("normalizes a leading-slash-less request path", () => {
    assert.strictEqual(
      buildScopedCacheKey(origin, "main", "php83-moodle50", "theme/main.css"),
      "https://ateeducacion.github.io/playground/main/php83-moodle50/theme/main.css",
    );
  });

  it("collapses duplicate slashes in the path but not the query", () => {
    assert.strictEqual(
      buildScopedCacheKey(
        origin,
        "main",
        "php83-moodle50",
        "//theme//main.css?u=a//b",
      ),
      "https://ateeducacion.github.io/playground/main/php83-moodle50/theme/main.css?u=a//b",
    );
  });
});
