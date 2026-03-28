import { createPhpBridgeChannel, createWorkerRequestId } from "./src/shared/protocol.js";
import { BUILD_VERSION as IMPORTED_BUILD_VERSION } from "./src/generated/build-version.js";

const bridges = new Map();
const pending = new Map();
const clientContexts = new Map();
// Use the imported build version so that when it changes, the SW file's
// import tree changes → the browser detects a new SW → installs + activates
// automatically on page reload. The URL param is a fallback for cache busting.
// Defer self.location access — Firefox module SW may not expose it at evaluation time.
const BUILD_VERSION = IMPORTED_BUILD_VERSION || (() => {
  try { return new URL(self.location.href).searchParams.get("build"); } catch { return null; }
})() || "dev";
const STATIC_CACHE_PREFIX = "moodle-playground-static";
const STATIC_CACHE_NAME = `${STATIC_CACHE_PREFIX}-${BUILD_VERSION}`;

// Cache for scoped runtime static assets (CSS, JS, images, fonts, etc.)
// that would otherwise queue through the serial PHP worker bridge.
// See docs/decisions/0001-sw-level-scoped-static-asset-caching.md
const SCOPED_STATIC_CACHE = `moodle-playground-scoped-static-${BUILD_VERSION}`;
const SCOPED_STATIC_RE = /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|map)$/iu;
// PHP scripts that serve cacheable assets with revision numbers in the URL.
// The revision acts as a natural cache key — when content changes, the URL changes.
// Excludes pluginfile.php and draftfile.php (user content, not cacheable).
const CACHEABLE_PHP_ASSET_RE = /\/(theme\/styles\.php|lib\/javascript\.php|theme\/image\.php|theme\/font\.php)\//u;

function isScopedStaticAsset(requestPath) {
  return SCOPED_STATIC_RE.test(requestPath.split("?")[0]);
}

function isCacheablePhpAsset(requestPath) {
  return CACHEABLE_PHP_ASSET_RE.test(requestPath);
}

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

function getAppBasePath() {
  const scopeUrl = new URL(self.registration.scope);
  const pathname = scopeUrl.pathname;
  return pathname.endsWith("/") ? pathname.slice(0, -1) || "/" : pathname || "/";
}

function stripAppBasePath(pathname) {
  const basePath = getAppBasePath();
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

function withAppBasePath(pathname) {
  const basePath = getAppBasePath();
  if (basePath === "/") {
    return pathname;
  }

  return `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`.replace(/\/{2,}/gu, "/");
}

function isStaticHostPath(pathname) {
  const strippedPathname = stripAppBasePath(pathname);
  return STATIC_PREFIXES.some((prefix) => strippedPathname === prefix || strippedPathname.startsWith(prefix));
}

function isSensitiveStaticPath(pathname) {
  const strippedPathname = stripAppBasePath(pathname);
  return (
    strippedPathname === "/"
    || strippedPathname === "/index.html"
    || strippedPathname === "/remote.html"
    || strippedPathname === "/playground.config.json"
    || strippedPathname === "/assets/build-version.json"
    || strippedPathname === "/src/generated/build-version.js"
    || /^\/assets\/manifests\/[^/]+\.json$/u.test(strippedPathname)
    || strippedPathname.startsWith("/assets/moodle/")
  );
}

function shouldHandleStaticRequest(request, url) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return false;
  }

  const strippedPathname = stripAppBasePath(url.pathname);
  if (strippedPathname === "/sw.js" || strippedPathname === "/dist/sw.bundle.js") {
    return false;
  }

  return isSensitiveStaticPath(url.pathname) || isStaticHostPath(url.pathname);
}

function buildStaticCacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  return url.toString();
}

function buildFreshRequest(request) {
  return new Request(request, {
    cache: "no-store",
  });
}

async function openStaticCache() {
  return caches.open(STATIC_CACHE_NAME);
}

async function cacheStaticResponse(cache, cacheKey, response) {
  if (!response.ok) {
    return;
  }

  try {
    await cache.put(cacheKey, response.clone());
  } catch {
    // CacheStorage is an optimization. Runtime routing must continue without it.
  }
}

async function cacheFirstStaticFetch(request) {
  const cache = await openStaticCache();
  const cacheKey = buildStaticCacheKey(request);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetch(buildFreshRequest(request));
  await cacheStaticResponse(cache, cacheKey, response);
  return response;
}

async function networkFirstStaticFetch(request) {
  const cache = await openStaticCache();
  const cacheKey = buildStaticCacheKey(request);
  const cached = await cache.match(cacheKey);

  try {
    const response = await fetch(buildFreshRequest(request));
    await cacheStaticResponse(cache, cacheKey, response);
    if (!response.ok && cached) {
      return cached;
    }
    return response;
  } catch (error) {
    if (cached) {
      return cached;
    }

    throw error;
  }
}

async function purgeOldStaticCaches() {
  const cacheNames = await caches.keys();
  const SCOPED_STATIC_PREFIX = "moodle-playground-scoped-static-";
  await Promise.all(
    cacheNames
      .filter((cacheName) =>
        (cacheName.startsWith(`${STATIC_CACHE_PREFIX}-`) && cacheName !== STATIC_CACHE_NAME)
        || (cacheName.startsWith(SCOPED_STATIC_PREFIX) && cacheName !== SCOPED_STATIC_CACHE),
      )
      .map((cacheName) => caches.delete(cacheName)),
  );
}

function escapeHtml(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function buildErrorResponse(message, status = 500) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Moodle Playground Error</title><body><pre>${escapeHtml(message)}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(message);
  }
}

function ensureBridge(scopeId) {
  if (bridges.has(scopeId)) {
    return bridges.get(scopeId);
  }

  const bridge = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  bridge.addEventListener("message", (event) => {
    const message = event.data;
    if (!message?.id || !pending.has(message.id)) {
      return;
    }

    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timeoutId);

    if (message.kind === "http-response") {
      entry.resolve(new Response(message.response.body, {
        status: message.response.status,
        statusText: message.response.statusText,
        headers: message.response.headers,
      }));
      return;
    }

    entry.resolve(buildErrorResponse(message.error || "Unknown PHP worker error."));
  });

  bridges.set(scopeId, bridge);
  return bridge;
}

function extractScopedRuntime(pathname, search = "") {
  const match = stripAppBasePath(pathname).match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (!match) {
    return null;
  }

  return {
    scopeId: match[1],
    runtimeId: match[2],
    requestPath: `${match[3] || "/"}${search}`,
  };
}

async function resolveScopedRequest(event, url) {
  const strippedPathname = stripAppBasePath(url.pathname);
  const direct = extractScopedRuntime(url.pathname, url.search);
  if (direct) {
    return direct;
  }

  if (isStaticHostPath(url.pathname)) {
    return null;
  }

  if (event.request.referrer) {
    const referrerUrl = new URL(event.request.referrer);
    const scopedFromReferrer = extractScopedRuntime(referrerUrl.pathname);
    if (scopedFromReferrer && referrerUrl.origin === url.origin) {
      return {
        scopeId: scopedFromReferrer.scopeId,
        runtimeId: scopedFromReferrer.runtimeId,
        requestPath: `${strippedPathname}${url.search}`,
      };
    }
  }

  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  if (event.clientId && clientContexts.has(event.clientId)) {
    const scoped = clientContexts.get(event.clientId);
    return {
      scopeId: scoped.scopeId,
      runtimeId: scoped.runtimeId,
      requestPath: `${strippedPathname}${url.search}`,
    };
  }

  if (!client) {
    return null;
  }

  const clientUrl = new URL(client.url);
  const scoped = extractScopedRuntime(clientUrl.pathname);
  if (scoped && clientUrl.origin === url.origin) {
    return {
      scopeId: scoped.scopeId,
      runtimeId: scoped.runtimeId,
      requestPath: `${strippedPathname}${url.search}`,
    };
  }

  return null;
}

async function serializeRequest(request) {
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: ["GET", "HEAD"].includes(request.method) ? null : await request.clone().arrayBuffer(),
  };
}

function buildPhpRequest(originalRequest, forwardedUrl, body) {
  const init = {
    method: originalRequest.method,
    headers: new Headers(originalRequest.headers),
    redirect: "follow",
  };

  if (body !== null && body !== undefined) {
    init.body = body;
  }

  return new Request(forwardedUrl.toString(), init);
}

function rewriteScopedLocation(response, { origin, scopeId, runtimeId }) {
  const location = response.headers.get("location");
  if (!location) {
    return response;
  }

  const resolved = new URL(location, origin);
  if (resolved.origin !== origin) {
    return response;
  }

  const scopedPath = withAppBasePath(`/playground/${scopeId}/${runtimeId}${stripAppBasePath(resolved.pathname)}`.replace(/\/{2,}/gu, "/"));
  const headers = new Headers(response.headers);
  headers.set("location", `${scopedPath}${resolved.search}${resolved.hash}`);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getScopedBasePath(scopeId, runtimeId) {
  return withAppBasePath(`/playground/${scopeId}/${runtimeId}`);
}

function decodeHtmlAttributeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&sol;", "/")
    .replaceAll("&colon;", ":");
}

function rewriteHtmlAttributeUrl(rawValue, { origin, scopeId, runtimeId }) {
  const decodedValue = decodeHtmlAttributeEntities(rawValue);
  const scopedBasePath = getScopedBasePath(scopeId, runtimeId);
  const appBasePath = getAppBasePath();

  if (!decodedValue) {
    return decodedValue;
  }

  if (
    decodedValue.startsWith("#")
    || decodedValue.startsWith("javascript:")
    || decodedValue.startsWith("data:")
    || decodedValue.startsWith("mailto:")
    || decodedValue.startsWith("tel:")
    || decodedValue.startsWith("//")
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
    if (absolute.pathname.startsWith(`${scopedBasePath}/`) || absolute.pathname === scopedBasePath) {
      return absolutePath;
    }

    if (isStaticHostPath(absolute.pathname)) {
      return absolutePath;
    }

    if (!absolute.pathname.startsWith("/")) {
      return decodedValue;
    }

    if (
      appBasePath !== "/"
      && absolute.pathname !== appBasePath
      && !absolute.pathname.startsWith(`${appBasePath}/`)
    ) {
      return decodedValue;
    }

    const runtimePath = `${stripAppBasePath(absolute.pathname)}${absolute.search}${absolute.hash}`;
    return `${scopedBasePath}${runtimePath.startsWith("/") ? runtimePath : `/${runtimePath}`}`.replace(/\/{2,}/gu, "/");
  } catch {
    return decodedValue;
  }
}

function rewriteHtmlDocument(html, scope) {
  const { origin, scopeId, runtimeId } = scope;
  const scopedBase = `${origin}${getScopedBasePath(scopeId, runtimeId)}`;

  let result = html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    (match, prefix, rawValue, suffix) => `${prefix}${rewriteHtmlAttributeUrl(rawValue, scope)}${suffix}`,
  );

  // Rewrite M.cfg.wwwroot in inline <script> blocks so Moodle's JavaScript
  // (AJAX calls, dynamic navigation) uses the scoped URL instead of the bare
  // origin. Without this, POST requests to /lib/ajax/service.php bypass the
  // scoped runtime and hit the static dev server (405 Method Not Allowed).
  // Moodle JSON-escapes forward slashes in its inline JS config, so we must
  // match both escaped (http:\/\/host) and unescaped (http://host) forms.
  const jsonEscapedOrigin = origin.replace(/\//gu, "\\/");
  const jsonEscapedBase = scopedBase.replace(/\//gu, "\\/");
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

  return result;
}

async function rewriteScopedHtmlResponse(response, scope) {
  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
    return response;
  }

  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");

  return new Response(rewriteHtmlDocument(html, scope), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildScopedUrl(url, { scopeId, runtimeId, requestPath }) {
  const scopedPath = withAppBasePath(
    `/playground/${scopeId}/${runtimeId}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`
      .replace(/\/{2,}/gu, "/"),
  );
  return new URL(`${scopedPath}`, url.origin);
}

async function forwardToPhpWorker({ request, scopeId }) {
  const bridge = ensureBridge(scopeId);
  const id = createWorkerRequestId();
  const serialized = await serializeRequest(request);

  return new Promise((resolve) => {
    const timeoutId = self.setTimeout(() => {
      pending.delete(id);
      resolve(buildErrorResponse("PHP worker bridge timed out.", 504));
    }, 300000);

    pending.set(id, { resolve, timeoutId });
    bridge.postMessage({ kind: "http-request", id, request: serialized });
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.kind === "clear-scoped-static-cache") {
    caches.delete(SCOPED_STATIC_CACHE).catch(() => {});
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await purgeOldStaticCaches();
    // Clear the bundle cache so stale ZIPs from a previous build don't
    // cause checksum mismatches. The next boot re-downloads the correct bundle.
    try {
      await caches.delete("moodle-playground-bundles-v1");
    } catch {}
  })());
});

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    try {
      const url = new URL(event.request.url);
      if (url.origin !== self.location.origin) {
        // Block moodle.org iframe loads (plugin directory) — the remote
        // server sets X-Frame-Options: sameorigin which causes console
        // errors. Return a friendly notice instead.
        if (url.hostname === "moodle.org" || url.hostname === "www.moodle.org") {
          return new Response(
            `<!doctype html><meta charset="utf-8"><style>
              body{font:14px/1.5 system-ui,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f8f9fa;color:#333;text-align:center;padding:16px}
              .box{max-width:420px}
              h3{margin:0 0 8px}
              p{margin:0 0 12px;color:#555}
              code{background:#e9ecef;padding:2px 6px;border-radius:4px;font-size:13px}
            </style>
            <div class="box">
              <h3>Moodle Plugin Directory unavailable</h3>
              <p>The external plugin directory at moodle.org cannot be loaded inside the playground iframe.</p>
              <p>To install plugins, use the <code>installMoodlePlugin</code> blueprint step with a direct GitHub ZIP URL.</p>
            </div>`,
            {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }
        return fetch(event.request);
      }

      const scopedRequest = await resolveScopedRequest(event, url);
      if (!scopedRequest) {
        if (shouldHandleStaticRequest(event.request, url)) {
          if (isSensitiveStaticPath(url.pathname)) {
            return networkFirstStaticFetch(event.request);
          }

          return cacheFirstStaticFetch(event.request);
        }

        return fetch(event.request);
      }

      // Read POST body immediately, before any async operations.
      // Firefox's Service Worker may discard the request body after
      // the handler yields to the event loop.
      const earlyBody = !["GET", "HEAD"].includes(event.request.method)
        ? await event.request.arrayBuffer()
        : null;

      const { scopeId, runtimeId, requestPath } = scopedRequest;
      if (event.clientId) {
        clientContexts.set(event.clientId, { scopeId, runtimeId });
      }

      // Prune stale clientContexts entries periodically
      if (clientContexts.size > 50) {
        const activeClients = await self.clients.matchAll({ type: "window" });
        const activeIds = new Set(activeClients.map((c) => c.id));
        for (const cid of clientContexts.keys()) {
          if (!activeIds.has(cid)) clientContexts.delete(cid);
        }
      }

      const directScoped = extractScopedRuntime(url.pathname, url.search);
      if (!directScoped && event.request.mode === "navigate" && event.request.method === "GET") {
        return Response.redirect(buildScopedUrl(url, scopedRequest), 302);
      }

      const forwardedUrl = new URL(requestPath, `${url.origin}/`);
      const pathOnly = requestPath.split("?")[0];

      // Serve cached scoped static assets without hitting the PHP worker queue.
      // This avoids serializing CSS/JS/image requests through the BroadcastChannel
      // bridge, significantly improving subsequent page load times.
      if (
        event.request.method === "GET"
        && (isScopedStaticAsset(requestPath) || isCacheablePhpAsset(pathOnly))
      ) {
        const scopedCache = await caches.open(SCOPED_STATIC_CACHE);
        const cacheKey = new URL(requestPath, url.origin).toString();
        const cached = await scopedCache.match(cacheKey);
        if (cached) {
          return cached;
        }

        // Cache miss — forward to worker, then cache successful non-HTML responses.
        const fresh = await forwardToPhpWorker({
          request: buildPhpRequest(event.request, forwardedUrl, earlyBody),
          runtimeId,
          scopeId,
        }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));

        if (fresh.ok) {
          const contentType = fresh.headers.get("content-type") || "";
          // Never cache HTML responses — they need URL rewriting and are dynamic.
          if (!/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
            scopedCache.put(cacheKey, fresh.clone()).catch(() => {});
            // Evict oldest entries when cache grows too large
            scopedCache.keys().then((keys) => {
              if (keys.length > 300) {
                for (let i = 0; i < keys.length - 300; i++) {
                  scopedCache.delete(keys[i]).catch(() => {});
                }
              }
            }).catch(() => {});
          }
        }
        return fresh;
      }

      const response = await forwardToPhpWorker({
        request: buildPhpRequest(event.request, forwardedUrl, earlyBody),
        runtimeId,
        scopeId,
      }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));

      if (response.status >= 300 && response.status < 400) {
        await broadcastToClients({
          kind: "sw-debug",
          detail: `Redirect ${response.status} from ${requestPath} → Location: ${response.headers.get("location") || "(none)"}`,
        });
      }

      const locationScopedResponse = rewriteScopedLocation(response, {
        origin: url.origin,
        scopeId,
        runtimeId,
      });
      return rewriteScopedHtmlResponse(locationScopedResponse, {
        origin: url.origin,
        scopeId,
        runtimeId,
      });
    } catch (err) {
      return buildErrorResponse(String(err?.stack || err?.message || err));
    }
  })());
});
