import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapMoodle } from "./src/runtime/bootstrap.js";
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
  const trackPluginFromRequestDir = (text) => {
    const match = text.match(/\/tmp\/moodle\/requestdir\/[^/\s]+\/[^/\s]+\/[^/\s]+\/([^/\s]+)\//);
    if (!match?.[1]) {
      return;
    }

    const pluginName = match[1];
    let added = false;

    for (const prefix of pluginRoots) {
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
    const bootStart = performance.now();

    const t0 = performance.now();
    const config = await loadPlaygroundConfig();
    const configMs = Math.round(performance.now() - t0);

    const runtime = resolveRuntimeConfig(config, selection);
    activeRuntimeConfig = runtime;
    const branchMeta = moodleBranch ? getBranchMetadata(moodleBranch) : null;
    const webRoot = branchMeta?.webRoot || "/www/moodle";
    traceRuntimeSelection(
      "resolved",
      `runtimeId=${runtimeId} php=${phpVersion} moodleBranch=${moodleBranch} runtimeConfig=${runtime?.id || "null"}`,
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
