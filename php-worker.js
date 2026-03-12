import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapMoodle } from "./src/runtime/bootstrap.js";
import { createPhpRuntime } from "./src/runtime/php-loader.js";

const workerUrl = new URL(self.location.href);
const scopeId = workerUrl.searchParams.get("scope");
const runtimeId = workerUrl.searchParams.get("runtime");
let bridgeChannel = null;
let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
let activeBlueprint = null;

function postShell(message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

function respond(payload) {
  bridgeChannel.postMessage(payload);
}

function serializeResponse(response) {
  return response.arrayBuffer().then((body) => ({
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  }));
}

function deserializeRequest(requestLike) {
  const init = {
    method: requestLike.method,
    headers: requestLike.headers,
  };

  if (!["GET", "HEAD"].includes(requestLike.method) && requestLike.body) {
    init.body = requestLike.body;
  }

  return new Request(requestLike.url, init);
}

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

function formatErrorDetail(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return String(error.stack || error.message || error);
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

async function getRuntimeState() {
  if (runtimeStatePromise) {
    return runtimeStatePromise;
  }

  runtimeStatePromise = (async () => {
    const config = await loadPlaygroundConfig();
    const runtime = config.runtimes.find((entry) => entry.id === runtimeId) || config.runtimes[0];
    const php = createPhpRuntime(runtime);

    postShell({
      kind: "progress",
      title: "Refreshing PHP runtime",
      detail: `Booting ${runtime.label}.`,
      progress: 0.12,
    });

    php.refresh();
    await php.binary;

    const publish = (detail, progress) => {
      postShell({
        kind: "progress",
        title: "Bootstrapping Moodle",
        detail,
        progress,
      });
    };

    const bootstrapState = await bootstrapMoodle({
      config,
      blueprint: activeBlueprint,
      php,
      publish,
      runtimeId,
      scopeId,
      origin: self.location.origin,
    });

    postShell({
      kind: "ready",
      detail: `Moodle bootstrapped for ${runtime.label}.`,
      path: bootstrapState.readyPath || activeBlueprint?.landingPage || config.landingPath,
    });

    return { php };
  })();

  return runtimeStatePromise;
}

function installBridgeListener() {
  bridgeChannel.addEventListener("message", (event) => {
    const data = event.data;

    if (data?.kind !== "http-request") {
      return;
    }

    requestQueue = requestQueue.then(async () => {
      try {
        const state = await getRuntimeState();
        const response = await state.php.request(deserializeRequest(data.request));
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
      } catch (error) {
        const detail = formatErrorDetail(error);
        const response = buildLoadingResponse(detail, 500);
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
        postShell({
          kind: "error",
          detail,
        });
      }
    });
  });
}

function installMessageListener() {
  self.addEventListener("message", (event) => {
    if (event.data?.kind !== "configure-blueprint") {
      return;
    }

    activeBlueprint = event.data.blueprint || null;

    self.postMessage({
      kind: "worker-ready",
      scopeId,
      runtimeId,
    });
  });
}

function signalWorkerReady() {
  respond({
    kind: "worker-ready",
    scopeId,
    runtimeId,
  });

  self.postMessage({
    kind: "worker-ready",
    scopeId,
    runtimeId,
  });
}

try {
  bridgeChannel = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  installBridgeListener();
  installMessageListener();
  signalWorkerReady();
} catch (error) {
  self.postMessage({
    kind: "worker-startup-error",
    scopeId,
    runtimeId,
    detail: formatErrorDetail(error),
  });
  throw error;
}
