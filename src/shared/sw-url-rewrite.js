// Pure URL and HTML rewriting helpers used by the Service Worker (sw.js).
// They live in their own module so unit tests exercise the shipped code
// instead of a copy. The app base path is an explicit argument here; sw.js
// passes the value derived from its registration scope.

export const STATIC_PREFIXES = [
  "/assets/",
  "/dist/",
  "/src/",
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

export function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function stripAppBasePath(pathname, basePath = "/") {
  if (basePath === "/") {
    return pathname || "/";
  }

  if (pathname === basePath) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return pathname || "/";
}

export function withAppBasePath(pathname, basePath = "/") {
  if (basePath === "/") {
    return pathname;
  }

  return `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`.replace(
    /\/{2,}/gu,
    "/",
  );
}

export function isStaticHostPath(pathname, appBasePath = "/") {
  const strippedPathname = stripAppBasePath(pathname, appBasePath);
  return STATIC_PREFIXES.some(
    (prefix) =>
      strippedPathname === prefix || strippedPathname.startsWith(prefix),
  );
}

export function isSensitiveStaticPath(pathname, appBasePath = "/") {
  const strippedPathname = stripAppBasePath(pathname, appBasePath);
  return (
    strippedPathname === "/" ||
    strippedPathname === "/index.html" ||
    strippedPathname === "/remote.html" ||
    strippedPathname === "/playground.config.json" ||
    strippedPathname === "/assets/build-version.json" ||
    strippedPathname === "/src/generated/build-version.js" ||
    /^\/assets\/manifests\/[^/]+\.json$/u.test(strippedPathname) ||
    strippedPathname.startsWith("/assets/moodle/")
  );
}

export function extractScopedRuntime(pathname, search = "", appBasePath = "/") {
  const match = stripAppBasePath(pathname, appBasePath).match(
    /\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u,
  );
  if (!match) {
    return null;
  }

  return {
    scopeId: match[1],
    runtimeId: match[2],
    requestPath: `${match[3] || "/"}${search}`,
  };
}

export function getScopedBasePath(scopeId, runtimeId, appBasePath = "/") {
  return withAppBasePath(`/playground/${scopeId}/${runtimeId}`, appBasePath);
}

// Build a cache key for the shared scoped-static cache that is namespaced by
// scope AND runtime. Many Moodle assets (theme CSS, /pix svgs, fonts) are served
// without a revision in their URL, so keying on the prefix-stripped requestPath
// alone would make two runtimes / version switches collide on the same entry and
// serve stale cross-runtime content. Including scopeId + runtimeId keeps each
// runtime's assets isolated within the single global cache.
export function buildScopedCacheKey(origin, scopeId, runtimeId, requestPath) {
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

export function decodeHtmlAttributeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/gu, (_, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&sol;", "/")
    .replaceAll("&colon;", ":")
    .replaceAll("&amp;", "&");
}

export function rewriteHtmlAttributeUrl(rawValue, scope) {
  const { origin } = scope;
  // scopedBasePath / appBasePath are computed once per document by
  // rewriteHtmlDocument and threaded through `scope`, instead of being
  // recomputed for every matched attribute. Fall back to computing them for
  // callers that don't pre-populate the scope (keeps the function standalone).
  const appBasePath = scope.appBasePath ?? "/";
  const scopedBasePath =
    scope.scopedBasePath ??
    getScopedBasePath(scope.scopeId, scope.runtimeId, appBasePath);
  const decodedValue = decodeHtmlAttributeEntities(rawValue);

  if (!decodedValue) {
    return decodedValue;
  }

  if (
    decodedValue.startsWith("#") ||
    /^\s*(?:javascript|vbscript|data|mailto|tel):/iu.test(decodedValue) ||
    decodedValue.startsWith("//")
  ) {
    return decodedValue;
  }

  // Leave relative URLs (e.g. "upgradesettings.php", "../index.php") untouched.
  // The browser resolves them relative to the current page path, which already
  // carries the scoped prefix.  Rewriting them would resolve against the origin
  // root and lose the directory context (e.g. admin/).
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

    const runtimePath = `${stripAppBasePath(absolute.pathname, appBasePath)}${absolute.search}${absolute.hash}`;
    return `${scopedBasePath}${runtimePath.startsWith("/") ? runtimePath : `/${runtimePath}`}`.replace(
      /\/{2,}/gu,
      "/",
    );
  } catch {
    return decodedValue;
  }
}

// Anchors that point to a different origin — most notably the Moodle plugin
// directory ("Browse new plugins" -> marketplace.moodle.com / moodle.org) —
// cannot be shown inside the playground's nested iframe: those sites send
// `X-Frame-Options: sameorigin` (and `frame-ancestors 'self'`), so the browser
// refuses to frame them and logs "Refused to display '…' in a frame". A Service
// Worker never sees these navigations (they target an out-of-scope origin), so
// the only place we can intervene is the same-origin HTML Moodle serves. Force
// cross-origin links to open in a new top-level tab, which is exactly what a
// normal Moodle does anyway — the plugin directory is meant to open in the
// browser, not be embedded. Same-origin links are left untouched so scoped
// in-iframe navigation and Moodle's own JS keep working.
export function markExternalAnchorsBlank(html, origin) {
  return html.replace(/<a\b([^>]*)>/giu, (match, attrs) => {
    // Respect an explicit target the markup already set.
    if (/\btarget\s*=/iu.test(attrs)) {
      return match;
    }
    const hrefMatch = attrs.match(/\bhref\s*=\s*(["'])([^"']*)\1/iu);
    if (!hrefMatch) {
      return match;
    }
    const href = decodeHtmlAttributeEntities(hrefMatch[2]);
    if (!href) {
      return match;
    }
    let absolute;
    try {
      absolute = new URL(href, origin);
    } catch {
      // Relative URLs and unparsable values resolve against `origin`, so a throw
      // here means the value isn't a navigable link — leave it alone.
      return match;
    }
    // Only re-target real cross-origin web links; leave mailto:/tel:/#fragments,
    // and any same-origin (scoped) navigation, exactly as they are.
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return match;
    }
    if (absolute.origin === origin) {
      return match;
    }
    return `<a${attrs} target="_blank" rel="noopener noreferrer">`;
  });
}

export function rewriteHtmlDocument(html, scope) {
  const { origin, scopeId, runtimeId, appBasePath = "/" } = scope;
  const scopedBasePath = getScopedBasePath(scopeId, runtimeId, appBasePath);
  const scopedBase = `${origin}${scopedBasePath}`;
  // Compute the per-document base paths once and thread them through `scope`
  // so rewriteHtmlAttributeUrl doesn't recompute them for every attribute.
  const docScope = { ...scope, scopedBasePath, appBasePath };
  // Moodle pages repeat identical pix/theme URLs dozens of times; memoize the
  // rewritten+escaped output per raw attribute value within this document.
  const memo = new Map();

  let result = html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    // rewriteHtmlAttributeUrl returns a *decoded* URL (entities turned back into
    // raw &, ", <, > characters). Re-encode it for HTML attribute context before
    // interpolating it back between the quotes, otherwise a decoded value
    // containing a quote could close the attribute early and inject HTML into
    // the playground iframe (reflected XSS).
    (match, prefix, rawValue, suffix) => {
      // Fast path: a value that is relative (no leading "/", no "://") and
      // contains none of & < > decodes to itself and re-encodes to itself, so
      // the full decode -> rewrite -> escapeHtml round-trip is the identity.
      // The regex capture already excludes quotes ([^"']*), so escapeHtml has
      // nothing to encode here. Returning `match` unchanged is byte-identical.
      if (
        rawValue === "" ||
        (!rawValue.startsWith("/") &&
          !rawValue.includes("://") &&
          !rawValue.includes("&") &&
          !rawValue.includes("<") &&
          !rawValue.includes(">"))
      ) {
        return match;
      }
      let encoded = memo.get(rawValue);
      if (encoded === undefined) {
        encoded = escapeHtml(rewriteHtmlAttributeUrl(rawValue, docScope));
        memo.set(rawValue, encoded);
      }
      return `${prefix}${encoded}${suffix}`;
    },
  );

  // Rewrite M.cfg.wwwroot in inline <script> blocks so Moodle's JavaScript
  // (AJAX calls, dynamic navigation) uses the scoped URL instead of the bare
  // origin. Without this, POST requests to /lib/ajax/service.php bypass the
  // scoped runtime and hit the static dev server (405 Method Not Allowed).
  // Moodle JSON-escapes forward slashes in its inline JS config, so we must
  // match both escaped (http:\/\/host) and unescaped (http://host) forms.
  const jsonEscapedOrigin = JSON.stringify(origin).slice(1, -1);
  const jsonEscapedBase = JSON.stringify(scopedBase).slice(1, -1);
  // Match JSON-escaped form: "wwwroot":"http:\/\/localhost:8080"
  result = result.replaceAll(
    `"wwwroot":"${jsonEscapedOrigin}"`,
    `"wwwroot":"${jsonEscapedBase}"`,
  );
  // Match unescaped form (if present): "wwwroot":"http://localhost:8080"
  result = result.replaceAll(
    `"wwwroot":"${origin}"`,
    `"wwwroot":"${scopedBase}"`,
  );
  // Also rewrite apibase which some Moodle JS uses for REST API calls
  result = result.replaceAll(
    `"apibase":"${jsonEscapedOrigin}\\/r.php\\/api"`,
    `"apibase":"${jsonEscapedBase}\\/r.php\\/api"`,
  );

  // External links (plugin directory, docs, etc.) can't be framed — open them
  // in a new top-level tab instead of failing with X-Frame-Options.
  result = markExternalAnchorsBlank(result, origin);

  return result;
}
