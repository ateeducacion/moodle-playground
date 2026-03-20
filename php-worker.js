import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapMoodle } from "./src/runtime/bootstrap.js";
import { createPhpRuntime, createProvisioningRuntime } from "./src/runtime/php-loader.js";
import { getBranchMetadata } from "./src/shared/version-resolver.js";

const workerUrl = new URL(self.location.href);
// __APP_ROOT__ is injected by esbuild and points to the project root.
// Falls back to self.location for unbundled contexts.
const appRootUrl = typeof __APP_ROOT__ !== "undefined" ? __APP_ROOT__ : new URL("./", self.location.href).toString();
const scopeId = workerUrl.searchParams.get("scope");
const runtimeId = workerUrl.searchParams.get("runtime");
const phpVersion = workerUrl.searchParams.get("phpVersion") || null;
const moodleBranch = workerUrl.searchParams.get("moodleBranch") || null;
const debug = workerUrl.searchParams.get("debug") || null;
const profile = workerUrl.searchParams.get("profile") || null;
let bridgeChannel = null;
let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
let activeBlueprint = null;
let activeRuntimeConfig = null;
let phpInfoCapturePromise = null;
let automaticPhpInfoAttempted = false;

// --- Runtime rotation state ---
const MAX_RESTARTS = 3;
const HEAVY_REQUEST_THRESHOLD = 20;
let requestCount = 0;
let restartCount = 0;

function normalizeProfileFlags(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function installVfsTraceHook() {
  const flags = normalizeProfileFlags(profile);
  if (!flags.has("vfs") && !flags.has("vfs-plugins")) {
    return;
  }

  const branchMeta = moodleBranch ? getBranchMetadata(moodleBranch) : null;
  const webRoot = branchMeta?.webRoot || "/www/moodle";
  const pluginRoots = [
    `${webRoot}/mod/`,
    `${webRoot}/blocks/`,
    `${webRoot}/theme/`,
    `${webRoot}/local/`,
    `${webRoot}/report/`,
    `${webRoot}/auth/`,
    `${webRoot}/filter/`,
    `${webRoot}/grade/export/`,
    `${webRoot}/grade/import/`,
    `${webRoot}/grade/report/`,
    `${webRoot}/message/output/`,
    `${webRoot}/admin/tool/`,
    `${webRoot}/user/profile/field/`,
    `${webRoot}/mod/quiz/report/`,
    `${webRoot}/plagiarism/`,
    `${webRoot}/portfolio/`,
    `${webRoot}/repository/`,
    `${webRoot}/search/`,
    `${webRoot}/reportbuilder/source/`,
    `${webRoot}/payment/gateway/`,
    `${webRoot}/enrol/`,
    `${webRoot}/mod/assign/feedback/`,
    `${webRoot}/mod/assign/submission/`,
    `${webRoot}/mod/quiz/accessrule/`,
    `${webRoot}/mod/workshop/allocation/`,
    `${webRoot}/mod/workshop/assessment/`,
    `${webRoot}/mod/workshop/form/`,
    `${webRoot}/question/type/`,
    `${webRoot}/question/behaviour/`,
    `${webRoot}/question/format/`,
    `${webRoot}/lib/editor/`,
    `${webRoot}/lib/editor/tiny/plugins/`,
    `${webRoot}/lib/editor/atto/plugins/`,
    `${webRoot}/lib/editor/tinymce/plugins/`,
    `${webRoot}/availability/condition/`,
    `${webRoot}/mod/data/field/`,
    `${webRoot}/mod/data/preset/`,
    `${webRoot}/mod/scorm/report/`,
    `${webRoot}/mod/lti/source/`,
    `${webRoot}/contentbank/contenttype/`,
    `${webRoot}/course/format/`,
    `${webRoot}/customfield/field/`,
    `${webRoot}/analytics/indicator/`,
    `${webRoot}/ai/provider/`,
    `${webRoot}/ai/placement/`,
    `${webRoot}/cache/lock/`,
    `${webRoot}/cache/stores/`,
    `${webRoot}/search/engine/`,
    `${webRoot}/local/cache/`,
    `${webRoot}/admin/tool/log/store/`,
  ];
  const requestDirPrefix = "/tmp/moodle/requestdir/";
  const trackedPluginPaths = new Set();
  const TRACKED_PLUGIN_LIMIT = 200;
  const trackPluginFromRequestDir = (text) => {
    if (trackedPluginPaths.size >= TRACKED_PLUGIN_LIMIT) {
      return;
    }

    const match = text.match(/\/tmp\/moodle\/requestdir\/[^/\s]+\/[^/\s]+\/[^/\s]+\/([^/\s]+)\//);
    if (!match?.[1]) {
      return;
    }

    const pluginName = match[1];
    let added = false;

    for (const prefix of pluginRoots) {
      if (trackedPluginPaths.size >= TRACKED_PLUGIN_LIMIT) {
        break;
      }
      const candidate = `${prefix}${pluginName}`;
      if (!trackedPluginPaths.has(candidate)) {
        trackedPluginPaths.add(candidate);
        added = true;
      }
    }

    if (added) {
      postShell({
        kind: "trace",
        detail: `[vfs] tracking plugin path candidates for ${pluginName}`,
      });
    }
  };
  let traceCount = 0;
  let traceDropped = false;
  const TRACE_LIMIT = 10000;

  globalThis.__moodleFsDebugHook = (detail) => {
    const text = String(detail || "");
    if (flags.has("vfs-plugins")) {
      if (text.includes(requestDirPrefix)) {
        trackPluginFromRequestDir(text);
      }

      const matchesTrackedPlugin = [...trackedPluginPaths].some(
        (prefix) => text.includes(prefix) || text.includes(`${prefix}/`),
      );
      const matchesInstallScratch =
        text.includes(requestDirPrefix) ||
        text.includes("/_temp_") ||
        text.includes("cross-mount rename");

      if (!matchesTrackedPlugin && !matchesInstallScratch) {
        return;
      }
    }

    if (traceCount >= TRACE_LIMIT) {
      if (!traceDropped) {
        traceDropped = true;
        postShell({
          kind: "trace",
          detail: `[vfs] trace limit reached (${TRACE_LIMIT}); suppressing further VFS logs`,
        });
      }
      return;
    }

    traceCount += 1;
    postShell({
      kind: "trace",
      detail: `[vfs] ${text}`,
    });
  };

  postShell({
    kind: "trace",
    detail: `[vfs] tracing enabled with profile=${profile}`,
  });
}

installVfsTraceHook();

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
    const php = createProvisioningRuntime(runtimeConfig, { phpVersion });

    try {
      await php.refresh();
      const response = await php.run(`<?php
ob_start();
phpinfo();
$html = ob_get_clean();
echo $html;
`);

      return {
        detail: `Captured PHP runtime diagnostics (${reason}).`,
        html: response.text || "",
        errorOutput: response.errors || "",
      };
    } catch (error) {
      return {
        detail: `Failed to capture PHP runtime diagnostics (${reason}).`,
        html: `<!doctype html><meta charset="utf-8"><pre>${formatErrorDetail(error)}</pre>`,
        errorOutput: "",
      };
    } finally {
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

function isFatalWasmError(error) {
  if (!error) {
    return false;
  }

  const message = String(error.message || error);
  return (
    error instanceof WebAssembly.RuntimeError ||
    message.includes("memory access out of bounds") ||
    message.includes("unreachable") ||
    message.includes("RuntimeError")
  );
}

function resetRuntime(reason) {
  if (restartCount >= MAX_RESTARTS) {
    postShell({
      kind: "error",
      detail: `[runtime] restart limit reached (${MAX_RESTARTS}), not restarting. Reason: ${reason}`,
    });
    return false;
  }

  restartCount += 1;
  requestCount = 0;
  runtimeStatePromise = null;
  phpInfoCapturePromise = null;
  automaticPhpInfoAttempted = false;

  postShell({
    kind: "progress",
    title: "Runtime rotation",
    detail: `[runtime] restarting (${restartCount}/${MAX_RESTARTS}): ${reason}`,
    progress: 0.01,
  });

  return true;
}

async function getRuntimeState() {
  if (runtimeStatePromise) {
    return runtimeStatePromise;
  }

  runtimeStatePromise = (async () => {
    const bootStart = performance.now();

    const t0 = performance.now();
    const config = await loadPlaygroundConfig();
    const configMs = Math.round(performance.now() - t0);

    const runtime = config.runtimes.find((entry) => entry.id === runtimeId) || config.runtimes[0];
    activeRuntimeConfig = runtime;
    const branchMeta = moodleBranch ? getBranchMetadata(moodleBranch) : null;
    const webRoot = branchMeta?.webRoot || "/www/moodle";
    const php = createPhpRuntime(runtime, { appBaseUrl: appRootUrl, phpVersion, webRoot });

    postShell({
      kind: "progress",
      title: "Refreshing PHP runtime",
      detail: `[${configMs}ms config] Booting PHP ${phpVersion || "8.3"}${branchMeta ? ` + ${branchMeta.label}` : ""}.`,
      progress: 0.12,
    });

    const t1 = performance.now();
    await php.refresh();
    const refreshMs = Math.round(performance.now() - t1);

    postShell({
      kind: "progress",
      title: "Refreshing PHP runtime",
      detail: `[${refreshMs}ms refresh] PHP runtime ready.`,
      progress: 0.14,
    });

    const publish = (detail, progress) => {
      const elapsed = Math.round(performance.now() - bootStart);
      postShell({
        kind: "progress",
        title: "Bootstrapping Moodle",
        detail: `[${elapsed}ms] ${detail}`,
        progress,
      });
    };

    const t2 = performance.now();
    let bootstrapState;
    try {
      bootstrapState = await bootstrapMoodle({
        appBaseUrl: appRootUrl,
        config,
        blueprint: activeBlueprint,
        debug,
        php,
        publish,
        runtimeId,
        scopeId,
        origin: self.location.origin,
        moodleBranch,
        webRoot,
      });
    } catch (error) {
      if (!automaticPhpInfoAttempted) {
        automaticPhpInfoAttempted = true;
        void publishPhpInfo(runtime, "bootstrap-error");
      }

      // Attempt runtime rotation on fatal WASM errors during bootstrap.
      // Clear the runtimeStatePromise so the next request creates a fresh
      // runtime instead of re-throwing the cached rejection.
      if (isFatalWasmError(error)) {
        resetRuntime(`fatal WASM error during bootstrap: ${error.message}`);
      }

      throw error;
    }
    const bootstrapMs = Math.round(performance.now() - t2);

    const totalMs = Math.round(performance.now() - bootStart);
    postShell({
      kind: "progress",
      title: "Boot timing summary",
      detail: `Config: ${configMs}ms | PHP refresh: ${refreshMs}ms | Bootstrap: ${bootstrapMs}ms | Total: ${totalMs}ms`,
      progress: 0.95,
    });

    postShell({
      kind: "ready",
      detail: `Moodle bootstrapped for PHP ${phpVersion || "8.3"}${branchMeta ? ` + ${branchMeta.label}` : ""}. [${totalMs}ms total]`,
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
        // Preventive rotation: restart runtime once the request threshold is reached.
        // requestQueue ensures sequential processing, so no concurrent race conditions.
        requestCount += 1;
        if (requestCount >= HEAVY_REQUEST_THRESHOLD && restartCount < MAX_RESTARTS) {
          resetRuntime(`preventive rotation after ${requestCount} requests`);
          // Fall through to getRuntimeState() which will create a fresh runtime.
          // If resetRuntime() returned false (restart limit), we proceed with
          // the existing runtime to serve the request best-effort.
        }

        const state = await getRuntimeState();
        const response = await state.php.request(deserializeRequest(data.request));
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
      } catch (error) {
        // Reactive rotation: restart on fatal WASM errors
        if (isFatalWasmError(error) && resetRuntime(`fatal WASM error: ${error.message}`)) {
          const detail = formatErrorDetail(error);
          const response = buildLoadingResponse(
            `Runtime restarting after crash. Please retry.\n\n${detail}`,
            503,
          );
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(response),
          });
          return;
        }

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
