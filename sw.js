import { createPhpBridgeChannel, createWorkerRequestId } from "./src/shared/protocol.js";
import { BUILD_VERSION as IMPORTED_BUILD_VERSION } from "./src/generated/build-version.js";
import { buildScopedStaticCacheName, buildStaticCacheName, isStaleAppCacheName } from "./src/shared/cache-names.js";
import * as rw from "./src/shared/sw-url-rewrite.js";
import { buildScopedCacheKey, escapeHtml } from "./src/shared/sw-url-rewrite.js";

const bridges = new Map();
const pending = new Map();
const clientContexts = new Map();
// Use the imported build version so that when it changes, the SW file's
// import tree changes → the browser detects a new SW → installs + activates
// automatically on page reload. The URL param is a fallback for cache busting.
const BUILD_VERSION = IMPORTED_BUILD_VERSION
  || new URL(self.location.href).searchParams.get("build")
  || "dev";
const STATIC_CACHE_NAME = buildStaticCacheName(BUILD_VERSION);

// Cache for scoped runtime static assets (CSS, JS, images, fonts, etc.)
// that would otherwise queue through the serial PHP worker bridge.
// See docs/architecture/adr/ADR-0001-sw-level-scoped-static-asset-caching.md
const SCOPED_STATIC_CACHE = buildScopedStaticCacheName(BUILD_VERSION);
const SCOPED_STATIC_RE = /\.(css|js|mjs|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|map)$/iu;
// PHP scripts that serve cacheable assets with revision numbers in the URL.
// The revision acts as a natural cache key — when content changes, the URL changes.
// Excludes pluginfile.php and draftfile.php (user content, not cacheable).
// Additional patterns (theme/fonts.php, lib/yui.php etc.) added to increase
// the number of Moodle-generated assets that bypass the serial PHP worker
// and use the fast SW-scoped static cache (perf improvement #6).
const CACHEABLE_PHP_ASSET_RE = /\/(theme\/styles\.php|lib\/javascript\.php|lib\/requirejs\.php|theme\/image\.php|theme\/font\.php|theme\/fonts\.php|lib\/yui\.php)\//u;
const INTERNAL_PROXY_PATH = "/__playground_proxy__";
let playgroundConfigPromise;
let addonProxyUrlOverride = null;

function isScopedStaticAsset(requestPath) {
  return SCOPED_STATIC_RE.test(requestPath.split("?")[0]);
}

function isCacheablePhpAsset(requestPath) {
  return CACHEABLE_PHP_ASSET_RE.test(requestPath);
}

function isInternalProxyPath(pathname) {
  return pathname.split("?")[0] === INTERNAL_PROXY_PATH;
}

function getPlaygroundConfigUrl() {
  return new URL("playground.config.json", self.registration.scope);
}

async function loadServiceWorkerConfig() {
  if (!playgroundConfigPromise) {
    playgroundConfigPromise = fetch(getPlaygroundConfigUrl(), {
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Unable to load playground config: ${response.status}`);
      }

      return response.json();
    });
  }

  return playgroundConfigPromise;
}

// self.registration.scope is constant for the Service Worker's lifetime, so
// memoize the parsed base path: every rewrite helper binding below calls
// getAppBasePath, which used to construct a fresh URL on every call.
let cachedAppBasePath = null;
function getAppBasePath() {
  if (cachedAppBasePath !== null) {
    return cachedAppBasePath;
  }
  const scopeUrl = new URL(self.registration.scope);
  const pathname = scopeUrl.pathname;
  cachedAppBasePath = pathname.endsWith("/")
    ? pathname.slice(0, -1) || "/"
    : pathname || "/";
  return cachedAppBasePath;
}

// Bind the pure helpers in src/shared/sw-url-rewrite.js to this worker's base path.
const stripAppBasePath = (pathname) => rw.stripAppBasePath(pathname, getAppBasePath());
const withAppBasePath = (pathname) => rw.withAppBasePath(pathname, getAppBasePath());
const isStaticHostPath = (pathname) => rw.isStaticHostPath(pathname, getAppBasePath());
const isSensitiveStaticPath = (pathname) => rw.isSensitiveStaticPath(pathname, getAppBasePath());
const extractScopedRuntime = (pathname, search = "") => rw.extractScopedRuntime(pathname, search, getAppBasePath());
const rewriteHtmlDocument = (html, scope) => rw.rewriteHtmlDocument(html, { ...scope, appBasePath: getAppBasePath() });

function shouldHandleStaticRequest(request, url) {
  if (!["GET", "HEAD"].includes(request.method)) {
    return false;
  }

  const strippedPathname = stripAppBasePath(url.pathname);
  if (["/sw.js", "/sw.bundle.js", "/dist/sw.bundle.js"].includes(strippedPathname)) {
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
  await Promise.all(
    cacheNames
      .filter((cacheName) => isStaleAppCacheName(cacheName, BUILD_VERSION))
      .map((cacheName) => caches.delete(cacheName)),
  );
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

async function handleInternalProxyRequest(request, sourceUrl) {
  const config = await loadServiceWorkerConfig();
  const proxyBaseUrl = addonProxyUrlOverride || config.addonProxyUrl || "";
  if (!proxyBaseUrl) {
    return buildErrorResponse("No addon proxy configured for the playground runtime.", 502);
  }

  const upstreamUrl = new URL(proxyBaseUrl);
  upstreamUrl.search = sourceUrl.search;

  const init = {
    method: request.method,
    headers: new Headers(request.headers),
    redirect: "follow",
  };

  init.headers.delete("host");

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = await request.clone().arrayBuffer();
  }

  const upstreamResponse = await fetch(upstreamUrl.toString(), init);
  const headers = new Headers(upstreamResponse.headers);
  headers.set("cache-control", "no-store");
  headers.delete("content-length");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.kind === "configure-service-worker") {
    addonProxyUrlOverride = event.data.addonProxyUrl || null;
    return;
  }

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
  // Buffer the request body synchronously, before any await. Firefox neuters
  // event.request.body once this handler yields to the event loop, so reading
  // it later (e.g. after `await resolveScopedRequest()`) can return an empty
  // body for POST/PUT and break form submissions. Cloning leaves event.request
  // intact for the pass-through `fetch(event.request)` / static branches. See
  // ADR 0015.
  const bufferedBody = ["GET", "HEAD"].includes(event.request.method)
    ? null
    : event.request.clone().arrayBuffer().catch(() => null);
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

      // Resolve the body buffered synchronously at the top of the handler
      // (before any yield), so Firefox has not discarded it. `bufferedBody` is
      // null for GET/HEAD and `await null` is null, so no guard is needed. See
      // ADR 0015.
      const earlyBody = await bufferedBody;

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

      if (isInternalProxyPath(pathOnly)) {
        return handleInternalProxyRequest(event.request, forwardedUrl);
      }

      // Serve cached scoped static assets without hitting the PHP worker queue.
      // This avoids serializing CSS/JS/image requests through the BroadcastChannel
      // bridge, significantly improving subsequent page load times.
      if (
        event.request.method === "GET"
        && (isScopedStaticAsset(requestPath) || isCacheablePhpAsset(pathOnly))
      ) {
        const scopedCache = await caches.open(SCOPED_STATIC_CACHE);
        const cacheKey = buildScopedCacheKey(url.origin, scopeId, runtimeId, requestPath);
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
