/**
 * Tests for the pure URL/HTML rewriting helpers used by sw.js.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScopedCacheKey,
  decodeHtmlAttributeEntities,
  escapeHtml,
  extractScopedRuntime,
  isSensitiveStaticPath,
  markExternalAnchorsBlank,
  rewriteHtmlAttributeUrl,
  rewriteHtmlDocument,
} from "../../src/shared/sw-url-rewrite.js";

// Reference (unoptimized) attribute pass: decode -> rewrite -> escapeHtml for
// every matched value. rewriteHtmlDocument adds a fast path and a memo on top of
// this and must stay byte-identical to it.
function rewriteHtmlDocumentAttributes(html, scope) {
  return html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    (_match, prefix, rawValue, suffix) =>
      `${prefix}${escapeHtml(rewriteHtmlAttributeUrl(rawValue, scope))}${suffix}`,
  );
}

describe("decodeHtmlAttributeEntities", () => {
  it("decodes &amp; last so an escaped entity is not decoded twice", () => {
    assert.strictEqual(decodeHtmlAttributeEntities("&amp;quot;"), "&quot;");
  });

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

  it("marks the generated build ID module and core bundles as network-first", () => {
    assert.strictEqual(
      isSensitiveStaticPath("/src/generated/build-version.js"),
      true,
    );
    assert.strictEqual(
      isSensitiveStaticPath("/assets/moodle/MOODLE_500_STABLE/moodle.tar.zst"),
      true,
    );
  });

  it("honours the app base path", () => {
    assert.strictEqual(
      isSensitiveStaticPath(
        "/moodle-playground/remote.html",
        "/moodle-playground",
      ),
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

describe("rewriteHtmlDocument (attribute re-encoding)", () => {
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
    const out = rewriteHtmlDocument(html, scope);
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
    const out = rewriteHtmlDocument(html, scope);
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
    const out = rewriteHtmlDocument(html, scope);
    assert.ok(out.includes("&#39;"), "single quote must be encoded");
    assert.ok(!/n='a'/u.test(out), "raw single quotes must not appear");
  });

  it("leaves clean relative URLs intact after re-encoding", () => {
    const html = '<a href="upgradesettings.php">x</a>';
    const out = rewriteHtmlDocument(html, scope);
    assert.strictEqual(out, '<a href="upgradesettings.php">x</a>');
  });
});

describe("rewriteHtmlDocument fast-path equivalence", () => {
  // The fast-path filter + memo in sw.js must produce BYTE-IDENTICAL output to
  // the unfiltered decode -> rewrite -> escapeHtml path for every value,
  // otherwise it changes behaviour (and, for the escape cases, security).
  const scope = {
    origin: "https://ateeducacion.github.io",
    scopeId: "main",
    runtimeId: "php83-moodle50",
    appBasePath: "/moodle-playground",
  };

  const corpus = [
    // Relative URLs without special chars (the values the fast path skips).
    '<a href="upgradesettings.php">x</a>',
    '<a href="view.php?id=3">x</a>',
    '<form action="">x</form>',
    '<a href="#section">x</a>',
    '<img src="logo.png">',
    "<a href='../course/index.php'>x</a>",
    // Anchor / scheme values handled by the early returns.
    '<a href="javascript:void(0)">x</a>',
    '<a href="mailto:a@b.test">x</a>',
    '<a href="data:image/png;base64,AAAA">x</a>',
    '<a href="//cdn.example.test/x.js">x</a>',
    // Entity-encoded query strings (force the slow path via "&").
    '<a href="/moodle-playground/admin/index.php?cache=1&amp;sesskey=abc">x</a>',
    // Absolute same-origin path (force the slow path via leading "/").
    '<a href="/moodle-playground/course/edit.php">x</a>',
    // Absolute URL (force the slow path via "://").
    '<a href="https://ateeducacion.github.io/moodle-playground/x.php">x</a>',
    // Quote-breakout payloads (force the slow path via "<"/">" and "&").
    '<a href="foo.php?x=&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">x</a>',
    "<a href='foo.php?n=&#39;a&#39;'>x</a>",
    // Repeated identical values (exercise the memo).
    '<img src="/moodle-playground/pix/i.svg"><img src="/moodle-playground/pix/i.svg">',
    // Multiple attributes in one tag.
    '<a href="/moodle-playground/a.php" data-url="b.php" data-action="/moodle-playground/c.php">x</a>',
  ];

  for (const html of corpus) {
    it(`is byte-identical for: ${html.slice(0, 50)}`, () => {
      assert.strictEqual(
        rewriteHtmlDocument(html, scope),
        markExternalAnchorsBlank(
          rewriteHtmlDocumentAttributes(html, scope),
          scope.origin,
        ),
      );
    });
  }

  it("is byte-identical for a combined document", () => {
    const html = corpus.join("\n");
    assert.strictEqual(
      rewriteHtmlDocument(html, scope),
      markExternalAnchorsBlank(
        rewriteHtmlDocumentAttributes(html, scope),
        scope.origin,
      ),
    );
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

describe("markExternalAnchorsBlank", () => {
  const origin = "https://ateeducacion.github.io";

  it("opens the plugin directory link in a new tab", () => {
    const html =
      '<a href="https://marketplace.moodle.com/?site=eyJ4IjoxfQ%3D%3D">Browse new plugins</a>';
    assert.strictEqual(
      markExternalAnchorsBlank(html, origin),
      '<a href="https://marketplace.moodle.com/?site=eyJ4IjoxfQ%3D%3D" target="_blank" rel="noopener noreferrer">Browse new plugins</a>',
    );
  });

  it("re-targets moodle.org links too", () => {
    const html = '<a class="btn" href="https://moodle.org/plugins/">dir</a>';
    assert.strictEqual(
      markExternalAnchorsBlank(html, origin),
      '<a class="btn" href="https://moodle.org/plugins/" target="_blank" rel="noopener noreferrer">dir</a>',
    );
  });

  it("leaves same-origin links untouched", () => {
    const html =
      '<a href="https://ateeducacion.github.io/admin/index.php">Home</a>';
    assert.strictEqual(markExternalAnchorsBlank(html, origin), html);
  });

  it("leaves relative links untouched", () => {
    const html = '<a href="../course/view.php?id=2">Course</a>';
    assert.strictEqual(markExternalAnchorsBlank(html, origin), html);
  });

  it("ignores mailto:, tel: and #fragment links", () => {
    const html =
      '<a href="mailto:a@b.com">m</a><a href="tel:+1">t</a><a href="#top">up</a>';
    assert.strictEqual(markExternalAnchorsBlank(html, origin), html);
  });

  it("respects an existing target attribute", () => {
    const html = '<a target="_self" href="https://moodle.org/">x</a>';
    assert.strictEqual(markExternalAnchorsBlank(html, origin), html);
  });

  it("decodes HTML entities before checking the origin", () => {
    const html =
      '<a href="https://marketplace.moodle.com/?a=1&amp;b=2">plugins</a>';
    assert.strictEqual(
      markExternalAnchorsBlank(html, origin),
      '<a href="https://marketplace.moodle.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">plugins</a>',
    );
  });

  it("does not match unrelated tags like <area> or <abbr>", () => {
    const html = '<area href="https://moodle.org/"><abbr>a</abbr>';
    assert.strictEqual(markExternalAnchorsBlank(html, origin), html);
  });
});
