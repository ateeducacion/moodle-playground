import { createPhpBridgeChannel, createWorkerRequestId } from "./src/shared/protocol.js";

const bridges = new Map();
const pending = new Map();
const clientContexts = new Map();
const STATIC_PREFIXES = [
  "/assets/",
  "/src/",
  "/vendor/",
  "/php-worker.js",
  "/sw.js",
  "/remote.html",
  "/index.html",
  "/playground.config.json",
  "/favicon.ico",
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

function buildErrorResponse(message, status = 500) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Moodle Playground Error</title><body><pre>${message}</pre></body>`,
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

  if (STATIC_PREFIXES.some((prefix) => strippedPathname === prefix || strippedPathname.startsWith(prefix))) {
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
  if (!scoped || clientUrl.origin !== url.origin) {
    return null;
  }

  return {
    scopeId: scoped.scopeId,
    runtimeId: scoped.runtimeId,
    requestPath: `${strippedPathname}${url.search}`,
  };
}

async function serializeRequest(request) {
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: ["GET", "HEAD"].includes(request.method) ? null : await request.clone().arrayBuffer(),
  };
}

function buildPhpRequest(originalRequest, forwardedUrl) {
  const init = {
    method: originalRequest.method,
    headers: new Headers(originalRequest.headers),
    redirect: "follow",
  };

  if (!["GET", "HEAD"].includes(originalRequest.method)) {
    init.body = originalRequest.body;
    init.duplex = "half";
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

  try {
    const absolute = new URL(decodedValue, origin);
    if (absolute.origin !== origin) {
      return decodedValue;
    }

    const absolutePath = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    if (absolute.pathname.startsWith(`${scopedBasePath}/`) || absolute.pathname === scopedBasePath) {
      return absolutePath;
    }

    if (appBasePath !== "/" && (absolute.pathname === appBasePath || absolute.pathname.startsWith(`${appBasePath}/`))) {
      return absolutePath;
    }

    if (!absolute.pathname.startsWith("/")) {
      return decodedValue;
    }

    return `${scopedBasePath}${absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`}`.replace(/\/{2,}/gu, "/");
  } catch {
    return decodedValue;
  }
}

function rewriteHtmlDocument(html, scope) {
  return html.replace(
    /((?:href|src|action|data-[\w-]*url|data-url|data-action)=["'])([^"']*)(["'])/giu,
    (match, prefix, rawValue, suffix) => `${prefix}${rewriteHtmlAttributeUrl(rawValue, scope)}${suffix}`,
  );
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

function forwardToPhpWorker({ request, scopeId }) {
  const bridge = ensureBridge(scopeId);
  const id = createWorkerRequestId();

  return new Promise(async (resolve) => {
    const timeoutId = self.setTimeout(() => {
      pending.delete(id);
      resolve(buildErrorResponse("PHP worker bridge timed out.", 504));
    }, 180000);

    pending.set(id, { resolve, timeoutId });

    bridge.postMessage({
      kind: "http-request",
      id,
      request: await serializeRequest(request),
    });
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) {
      return fetch(event.request);
    }

    const scopedRequest = await resolveScopedRequest(event, url);
    if (!scopedRequest) {
      return fetch(event.request);
    }

    const { scopeId, runtimeId, requestPath } = scopedRequest;
    if (event.clientId) {
      clientContexts.set(event.clientId, { scopeId, runtimeId });
    }

    const directScoped = extractScopedRuntime(url.pathname, url.search);
    if (!directScoped && event.request.mode === "navigate" && event.request.method === "GET") {
      return Response.redirect(buildScopedUrl(url, scopedRequest), 302);
    }

    const forwardedUrl = new URL(requestPath, `${url.origin}/`);

    await broadcastToClients({
      kind: "sw-debug",
      detail: `Intercepting ${event.request.method} ${url.pathname}`,
    });

    const response = await forwardToPhpWorker({
      request: buildPhpRequest(event.request, forwardedUrl),
      runtimeId,
      scopeId,
    }).catch((error) => buildErrorResponse(String(error?.stack || error?.message || error)));

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
  })());
});
