import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapMoodle } from "./src/runtime/bootstrap.js";
import { isFatalWasmError, isSafeToReplay, formatErrorDetail } from "./src/runtime/crash-recovery.js";
import { createPhpRuntime, createProvisioningRuntime } from "./src/runtime/php-loader.js";
import {
  getBranchMetadata,
  resolveRuntimeConfig,
  resolveRuntimeSelection,
  shouldTraceRuntimeSelection,
} from "./src/shared/version-resolver.js";

const workerUrl = new URL(self.location.href);
// __APP_ROOT__ is injected by esbuild and points to the project root.
// Falls back to self.location for unbundled contexts.
const appRootUrl = typeof __APP_ROOT__ !== "undefined" ? __APP_ROOT__ : new URL("./", self.location.href).toString();
const scopeId = workerUrl.searchParams.get("scope");
const selection = resolveRuntimeSelection({
  runtimeId: workerUrl.searchParams.get("runtime"),
  phpVersion: workerUrl.searchParams.get("phpVersion"),
  moodleBranch: workerUrl.searchParams.get("moodleBranch"),
});
const runtimeId = selection.runtimeId;
const phpVersion = selection.phpVersion;
const moodleBranch = selection.moodleBranch;
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
// The PHP WASM runtime can crash with "memory access out of bounds",
// "unreachable", or resource exhaustion ("No file descriptors available").
//
// Recovery strategy:
//   1. VFS lazy materialization (lib/vfs-mount.js) reduces memory pressure
//      by deferring file content allocation until read.
//   2. Preventive rotation restarts the runtime every HEAVY_REQUEST_THRESHOLD
//      requests to prevent slow memory leaks from accumulating.
//   3. Reactive rotation detects fatal WASM errors (isFatalWasmError) and
//      discards the corrupted runtime, then replays idempotent requests once.
//   4. Bootstrap crashes reset the runtime promise so the next request
//      triggers a clean bootstrap on a fresh WASM instance.
//
// Preventive and reactive restarts are tracked separately so that healthy
// maintenance rotations do not consume the crash-recovery budget.  Without
// this separation, preventive restarts (every HEAVY_REQUEST_THRESHOLD
// requests) would exhaust MAX_REACTIVE_RESTARTS after only a few page loads,
// leaving the runtime unable to recover from real WASM crashes.
//
// Remaining root-cause limitations:
//   - WebAssembly.Memory cannot be shrunk; once grown, the pages are
//     permanent until the entire module is discarded.
//   - Resource exhaustion (FD limits, /internal/shared/ paths) may indicate
//     upstream @php-wasm issues that rotation can only mitigate, not fix.
const MAX_REACTIVE_RESTARTS = 5;
const MAX_PREVENTIVE_RESTARTS = 20;
const HEAVY_REQUEST_THRESHOLD = 40;
let requestCount = 0;
let reactiveRestartCount = 0;
let preventiveRestartCount = 0;

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

function traceRuntimeSelection(stage, detail) {
  if (!shouldTraceRuntimeSelection({ debug, profile })) {
    return;
  }

  postShell({
    kind: "trace",
    detail: `[runtime-selection][worker:${stage}] ${detail}`,
  });
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
    resolvedRuntimeConfig = resolveRuntimeConfig(config, selection);
    if (!resolvedRuntimeConfig) {
      throw new Error("Unable to resolve a runtime configuration.");
    }
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

function resetRuntime(reason, kind = "reactive") {
  const isPreventive = kind === "preventive";
  const count = isPreventive ? preventiveRestartCount : reactiveRestartCount;
  const limit = isPreventive ? MAX_PREVENTIVE_RESTARTS : MAX_REACTIVE_RESTARTS;

  if (count >= limit) {
    postShell({
      kind: "error",
      detail: `[runtime] ${kind} restart limit reached (${count}/${limit}), not restarting. Reason: ${reason}`,
    });
    return false;
  }

  if (isPreventive) {
    preventiveRestartCount += 1;
  } else {
    reactiveRestartCount += 1;
  }
  requestCount = 0;
  runtimeStatePromise = null;
  phpInfoCapturePromise = null;
  automaticPhpInfoAttempted = false;
  activeRuntimeConfig = null;

  const total = preventiveRestartCount + reactiveRestartCount;
  postShell({
    kind: "progress",
    title: "Runtime rotation",
    detail: `[runtime] ${kind} restart (${count + 1}/${limit}, total=${total}): ${reason}`,
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

    const runtime = resolveRuntimeConfig(config, selection);
    if (!runtime) {
      throw new Error("Unable to resolve a runtime configuration.");
    }
    activeRuntimeConfig = runtime;
    const branchMeta = moodleBranch ? getBranchMetadata(moodleBranch) : null;
    const webRoot = branchMeta?.webRoot || "/www/moodle";
    traceRuntimeSelection(
      "resolved",
      `runtimeId=${runtimeId} php=${phpVersion} moodleBranch=${moodleBranch} runtimeConfig=${runtime.id}`,
    );
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
        profile,
        webRoot,
      });
    } catch (error) {
      if (!automaticPhpInfoAttempted) {
        automaticPhpInfoAttempted = true;
        void publishPhpInfo(runtime, "bootstrap-error");
      }

      // Clear the cached runtimeStatePromise so the next caller of
      // getRuntimeState() creates a fresh runtime instead of re-throwing
      // this cached rejection.  The actual restart-count bookkeeping and
      // retry decision live in the bridge listener (installBridgeListener),
      // not here, to avoid double-counting restarts.
      runtimeStatePromise = null;

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

/**
 * Execute a single HTTP request against the PHP runtime, returning the
 * Response object.  Throws on fatal errors.
 */
async function executePhpRequest(state, serializedRequest) {
  return state.php.request(deserializeRequest(serializedRequest));
}

function installBridgeListener() {
  bridgeChannel.addEventListener("message", (event) => {
    const data = event.data;

    if (data?.kind !== "http-request") {
      return;
    }

    requestQueue = requestQueue.then(async () => {
      // Safety net: if this request was externally re-dispatched with
      // _retried=true, skip the auto-retry path to prevent loops.
      // In the current implementation, retry happens in-handler (below),
      // so this is always false — but it guards against future changes.
      const isRetry = Boolean(data._retried);

      try {
        // Preventive rotation: restart runtime once the request threshold is reached.
        // requestQueue ensures sequential processing, so no concurrent race conditions.
        // resetRuntime resets requestCount to 0, so this only fires once per cycle.
        requestCount += 1;
        if (requestCount >= HEAVY_REQUEST_THRESHOLD && preventiveRestartCount < MAX_PREVENTIVE_RESTARTS) {
          resetRuntime(`preventive rotation after ${requestCount} requests`, "preventive");
        }

        const state = await getRuntimeState();
        const response = await executePhpRequest(state, data.request);
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
      } catch (error) {
        if (!isFatalWasmError(error)) {
          // Non-fatal error: return 500 without runtime rotation.
          const detail = formatErrorDetail(error);
          const response = buildLoadingResponse(detail, 500);
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(response),
          });
          postShell({ kind: "error", detail });
          return;
        }

        // --- Fatal WASM error path ---
        const didReset = resetRuntime(`fatal WASM error: ${error.message}`);

        // If we already retried this request, or the request is not
        // idempotent, or we hit the restart limit — give up.
        if (isRetry || !isSafeToReplay(data.request) || !didReset) {
          const detail = formatErrorDetail(error);
          const status = didReset || isRetry ? 503 : 500;
          const message = isRetry
            ? `Runtime crashed again on retry. Manual reload required.\n\n${detail}`
            : !isSafeToReplay(data.request)
              ? `Runtime restarting after crash. Non-idempotent request was not retried.\n\n${detail}`
              : `Runtime restart limit reached.\n\n${detail}`;
          const response = buildLoadingResponse(message, status);
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(response),
          });
          return;
        }

        // Automatic retry: boot a fresh runtime and replay the safe request.
        postShell({
          kind: "progress",
          title: "Crash recovery",
          detail: "[runtime] replaying request on fresh runtime…",
          progress: 0.02,
        });

        try {
          const freshState = await getRuntimeState();
          const retryResponse = await executePhpRequest(freshState, data.request);
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(retryResponse),
          });
        } catch (retryError) {
          // The retry itself failed — report but don't loop.
          if (isFatalWasmError(retryError)) {
            resetRuntime(`fatal WASM error on retry: ${retryError.message}`);
          }
          const detail = formatErrorDetail(retryError);
          const response = buildLoadingResponse(
            `Runtime crashed again on retry. Manual reload required.\n\n${detail}`,
            503,
          );
          respond({
            kind: "http-response",
            id: data.id,
            response: await serializeResponse(response),
          });
        }
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
