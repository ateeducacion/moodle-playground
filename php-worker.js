import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapMoodle } from "./src/runtime/bootstrap.js";
import { createPhpRuntime, createProvisioningRuntime } from "./src/runtime/php-loader.js";

const workerUrl = new URL(self.location.href);
const scopeId = workerUrl.searchParams.get("scope");
const runtimeId = workerUrl.searchParams.get("runtime");
let bridgeChannel = null;
let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
let activeBlueprint = null;
let activeRuntimeConfig = null;
let phpInfoCapturePromise = null;

function postShell(message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

function respond(payload) {
  bridgeChannel.postMessage(payload);
}

async function capturePhpInfoHtml(runtimeConfig, reason = "manual") {
  if (!runtimeConfig) {
    return {
      detail: "PHP info capture skipped because the runtime configuration is not available yet.",
      html: "",
    };
  }

  if (phpInfoCapturePromise) {
    return phpInfoCapturePromise;
  }

  phpInfoCapturePromise = (async () => {
    const php = createProvisioningRuntime(runtimeConfig);
    const output = [];
    const errors = [];
    const onOutput = (event) => output.push(String(event.detail ?? ""));
    const onError = (event) => errors.push(String(event.detail ?? ""));

    php.addEventListener("output", onOutput);
    php.addEventListener("error", onError);

    try {
      await php.refresh();
      await php.run(`<?php
ob_start();
phpinfo();
$html = ob_get_clean();
echo $html;
`);

      return {
        detail: `Captured PHP runtime diagnostics (${reason}).`,
        html: output.join(""),
        errorOutput: errors.join(""),
      };
    } catch (error) {
      return {
        detail: `Failed to capture PHP runtime diagnostics (${reason}).`,
        html: `<!doctype html><meta charset="utf-8"><pre>${formatErrorDetail(error)}</pre>`,
        errorOutput: errors.join(""),
      };
    } finally {
      php.removeEventListener("output", onOutput);
      php.removeEventListener("error", onError);
      phpInfoCapturePromise = null;
    }
  })();

  return phpInfoCapturePromise;
}

async function publishPhpInfo(runtimeConfig, reason) {
  let resolvedRuntimeConfig = runtimeConfig;
  if (!resolvedRuntimeConfig) {
    const config = await loadPlaygroundConfig();
    resolvedRuntimeConfig = config.runtimes.find((entry) => entry.id === runtimeId) || config.runtimes[0];
    activeRuntimeConfig = resolvedRuntimeConfig;
  }

  const payload = await capturePhpInfoHtml(resolvedRuntimeConfig, reason);
  postShell({
    kind: "phpinfo",
    detail: payload.errorOutput
      ? `${payload.detail}\n${payload.errorOutput}`
      : payload.detail,
    html: payload.html,
    reason,
  });
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
    activeRuntimeConfig = runtime;
    const php = createPhpRuntime(runtime);

    postShell({
      kind: "progress",
      title: "Refreshing PHP runtime",
      detail: `Booting ${runtime.label}.`,
      progress: 0.12,
    });

    await php.refresh();

    const publish = (detail, progress) => {
      postShell({
        kind: "progress",
        title: "Bootstrapping Moodle",
        detail,
        progress,
      });
    };

    let bootstrapState;
    try {
      bootstrapState = await bootstrapMoodle({
        appBaseUrl: new URL("./", self.location.href).toString(),
        config,
        blueprint: activeBlueprint,
        php,
        publish,
        runtimeId,
        scopeId,
        origin: self.location.origin,
      });
    } catch (error) {
      await publishPhpInfo(runtime, "bootstrap-error");
      throw error;
    }

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
      if (event.data?.kind === "capture-phpinfo") {
        void publishPhpInfo(activeRuntimeConfig, "manual");
      }
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
