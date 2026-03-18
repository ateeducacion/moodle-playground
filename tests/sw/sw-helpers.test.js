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
