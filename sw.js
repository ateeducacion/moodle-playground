import { MOODLE_BASE_PATH, PHP_BRIDGE_CHANNEL } from "./lib/constants.js";

const bridgeChannel = new BroadcastChannel(PHP_BRIDGE_CHANNEL);
const pendingResponses = new Map();

function buildLoadingResponse(message, status = 503) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Moodle Playground</title><body><pre>${message}</pre></body>`,
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

function deserializeResponse(responseLike) {
  return new Response(responseLike.body, {
    status: responseLike.status,
    statusText: responseLike.statusText,
    headers: responseLike.headers,
  });
}

bridgeChannel.addEventListener("message", (event) => {
  const data = event.data;

  if (!data?.id || !pendingResponses.has(data.id)) {
    return;
  }

  const { resolve, reject, timeoutId } = pendingResponses.get(data.id);
  pendingResponses.delete(data.id);
  clearTimeout(timeoutId);

  if (data.kind === "http-response") {
    resolve(deserializeResponse(data.response));
    return;
  }

  reject(new Error(data.error || "Unknown PHP bridge error"));
});

async function serializeRequest(request) {
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.clone().arrayBuffer(),
  };
}

function requestPhpResponse(request, timeoutMs = 60000) {
  const id = self.crypto.randomUUID();

  return new Promise(async (resolve, reject) => {
    const timeoutId = self.setTimeout(() => {
      pendingResponses.delete(id);
      resolve(buildLoadingResponse("PHP worker bridge timed out.", 504));
    }, timeoutMs);

    pendingResponses.set(id, { resolve, reject, timeoutId });

    try {
      bridgeChannel.postMessage({
        kind: "http-request",
        id,
        request: await serializeRequest(request),
      });
    } catch (error) {
      pendingResponses.delete(id);
      clearTimeout(timeoutId);
      reject(error);
    }
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (!url.pathname.startsWith(MOODLE_BASE_PATH)) {
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await requestPhpResponse(event.request);

      if (response.status >= 400) {
        const body = await response.clone().text().catch(() => "");
        await broadcastToClients({
          kind: "php-response-debug",
          url: event.request.url,
          status: response.status,
          body,
        });
      }

      return response;
    } catch (error) {
      const response = buildLoadingResponse(String(error?.message || error), 500);
      await broadcastToClients({
        kind: "php-response-debug",
        url: event.request.url,
        status: 500,
        body: String(error?.stack || error?.message || error),
      });
      return response;
    }
  })());
});
