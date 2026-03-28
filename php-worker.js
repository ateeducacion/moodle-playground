import { loadPlaygroundConfig } from "./src/shared/config.js";
import { createPhpBridgeChannel, createShellChannel } from "./src/shared/protocol.js";
import { bootstrapMoodle } from "./src/runtime/bootstrap.js";
import { isFatalWasmError, isEmscriptenNetworkError, isSafeToReplay, formatErrorDetail, createSnapshotManager } from "./src/runtime/crash-recovery.js";
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
// Runtime params are initially read from the worker URL as defaults,
// then overridden by the configure-blueprint message from remote.js.
// This is necessary because the Service Worker caches the worker bundle
// by URL path (stripping query params), so self.location.href may reflect
// stale params from a previously cached response.
let scopeId = workerUrl.searchParams.get("scope");
let selection = resolveRuntimeSelection({
  runtimeId: workerUrl.searchParams.get("runtime"),
  phpVersion: workerUrl.searchParams.get("phpVersion"),
  moodleBranch: workerUrl.searchParams.get("moodleBranch"),
});
let runtimeId = selection.runtimeId;
let phpVersion = selection.phpVersion;
let moodleBranch = selection.moodleBranch;
let debug = workerUrl.searchParams.get("debug") || null;
let profile = workerUrl.searchParams.get("profile") || null;
let bridgeChannel = null;
let runtimeStatePromise = null;
let requestQueue = Promise.resolve();
let activeBlueprint = null;
let activeRuntimeConfig = null;
let activeWebRoot = "/www/moodle";
let phpInfoCapturePromise = null;
let automaticPhpInfoAttempted = false;

// --- Runtime rotation state ---
// The PHP WASM runtime can crash with "memory access out of bounds",
// "unreachable", or resource exhaustion ("No file descriptors available").
//
// Recovery strategy (reactive only, inspired by WordPress Playground):
//   1. Reactive rotation detects fatal WASM errors (isFatalWasmError) and
//      discards the corrupted runtime, then replays idempotent requests once.
//   2. Bootstrap crashes reset the runtime promise so the next request
//      triggers a clean bootstrap on a fresh WASM instance.
//   3. Anti-loop guard: if the runtime crashes before processing
//      MIN_REQUESTS_BEFORE_RESTART requests, it is likely a fundamental bug
//      — do not restart (avoids infinite boot-crash-boot loops).
//
// No preventive rotation is performed. WordPress Playground does not rotate
// preventively either; the correct fix for memory leaks is root-cause, not
// periodic restarts that cost 3-8s each.
const MAX_REACTIVE_RESTARTS = 20;
const MIN_REQUESTS_BEFORE_RESTART = 10;
let requestCount = 0;
let reactiveRestartCount = 0;

// --- DB snapshot for crash recovery state preservation ---
let snapshot = null;

function postShell(message) {
  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

snapshot = createSnapshotManager({ postShell });

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

/**
 * Build the DB file path from scope and runtime IDs.
 */
function buildDbPath() {
  const scope = String(scopeId || "default").replace(/[^A-Za-z0-9_]/gu, "_");
  const runtime = String(runtimeId || "php").replace(/[^A-Za-z0-9_]/gu, "_");
  return `/persist/moodledata/moodle_${scope}_${runtime}.sq3.php`;
}

/**
 * Frankenstyle plugin type → directory mapping under the webroot.
 * Used to resolve plugin file paths from Moodle's installzipcomponent param.
 */
const PLUGIN_TYPE_DIRS = {
  mod: "mod",
  block: "blocks",
  local: "local",
  theme: "theme",
  auth: "auth",
  enrol: "enrol",
  filter: "filter",
  format: "course/format",
  report: "report",
  tool: "admin/tool",
  editor: "lib/editor",
  atto: "lib/editor/atto/plugins",
  tiny: "lib/editor/tiny/plugins",
  qtype: "question/type",
  qbehaviour: "question/behaviour",
  gradeexport: "grade/export",
  gradeimport: "grade/import",
  gradereport: "grade/report",
  repository: "repository",
  plagiarism: "plagiarism",
  availability: "availability/condition",
  calendartype: "calendar/type",
  message: "message/output",
  profilefield: "user/profile/field",
  datafield: "mod/data/field",
  assignsubmission: "mod/assign/submission",
  assignfeedback: "mod/assign/feedback",
  booktool: "mod/book/tool",
  quizaccess: "mod/quiz/accessrule",
  ltisource: "mod/lti/source",
  workshopform: "mod/workshop/form",
  workshopallocation: "mod/workshop/allocation",
  workshopeval: "mod/workshop/eval",
  contenttype: "contentbank/contenttype",
  customfield: "customfield/field",
  media: "media/player",
  paygw: "payment/gateway",
  qbank: "question/bank",
  search: "search/engine",
  aiprovider: "ai/provider",
  aiplacement: "ai/placement",
};

/**
 * Detect plugin installations from HTTP responses.
 * When Moodle's native install addon UI succeeds, it redirects with
 * installzipcomponent=TYPE_NAME in the URL. We extract the plugin type
 * and name to track its directory for crash recovery.
 *
 * @param {object} serializedRequest - The original request
 * @param {Response} response - The PHP response
 * @param {string} webRoot - The Moodle webroot path (e.g. "/www/moodle")
 */
function detectPluginInstall(serializedRequest, response, webRoot) {
  const url = serializedRequest.url || "";
  if (!url.includes("/admin/tool/installaddon/")) return;

  // Strategy 1: Check GET requests to installaddon that have installzipcomponent
  // (this is the redirect target after a successful plugin upload)
  if (url.includes("installzipcomponent=")) {
    const match = url.match(/installzipcomponent=([a-z]+)_([a-z0-9_]+)/i);
    if (match) {
      const pluginType = match[1];
      const pluginName = match[2];
      const typeDir = PLUGIN_TYPE_DIRS[pluginType];
      if (typeDir) {
        snapshot.trackPluginDir(`${webRoot}/${typeDir}/${pluginName}`);
      }
    }
    return;
  }

  // Strategy 2: Check POST redirects with Location header containing installzipcomponent
  const method = String(serializedRequest.method || "").toUpperCase();
  if (method !== "POST") return;
  const status = response.status || 0;
  if (status < 300 || status >= 400) return;

  let location = "";
  try {
    if (response.headers?.get) {
      location = response.headers.get("location") || "";
    }
  } catch {
    // Headers might not be available
  }
  if (!location) return;

  const match = location.match(/installzipcomponent=([a-z]+)_([a-z0-9_]+)/i);
  if (!match) return;

  const pluginType = match[1];
  const pluginName = match[2];
  const typeDir = PLUGIN_TYPE_DIRS[pluginType];
  if (!typeDir) return;

  const pluginDir = `${webRoot}/${typeDir}/${pluginName}`;
  snapshot.trackPluginDir(pluginDir);
}

/**
 * Re-create the admin session after DB snapshot restore.
 * The restore overwrites the DB file (which contains the session table),
 * invalidating the auto-login session that bootstrap just created.
 * This creates a fresh session on top of the restored DB state.
 */
async function reLoginAfterRestore(php, webRoot) {
  const AUTO_LOGIN_PATH = `${webRoot}/__playground_autologin.php`;
  try {
    const autoLoginPhp = [
      "<?php",
      "define('NO_OUTPUT_BUFFERING', true);",
      "require(__DIR__ . '/config.php');",
      "$admin = get_admin();",
      "complete_user_login($admin);",
      "echo json_encode(['ok' => true, 'user' => $admin->username]);",
    ].join("\n");
    await php.writeFile(
      AUTO_LOGIN_PATH,
      new TextEncoder().encode(autoLoginPhp),
    );
    const loginResponse = await php.request(
      new Request("http://localhost:8080/__playground_autologin.php"),
    );
    const loginText = await loginResponse.text();
    if (loginResponse.status === 200 && loginText.includes('"ok"')) {
      postShell({
        kind: "trace",
        detail: "[snapshot] re-created admin session after DB restore",
      });
    } else {
      postShell({
        kind: "error",
        detail: `[snapshot] re-login returned unexpected response: ${loginText.slice(0, 200)}`,
      });
    }
  } catch (err) {
    postShell({
      kind: "error",
      detail: `[snapshot] re-login failed: ${err.message}`,
    });
  }
  try {
    await php.run(`<?php @unlink('${AUTO_LOGIN_PATH}');`);
  } catch {
    /* non-fatal */
  }
}

/**
 * After restoring plugin files onto a fresh runtime, Moodle's component cache
 * doesn't know about them. Reset the cache and run the upgrade so the plugins
 * are discovered and registered.
 */
async function reRegisterPluginsAfterRestore(php, webRoot, restoredPluginDirs = []) {
  try {
    // Build PHP code to refresh the component cache for each restored plugin
    const webRootPrefix = webRoot.endsWith("/") ? webRoot : `${webRoot}/`;
    const refreshCalls = restoredPluginDirs
      .map((dir) => {
        if (!dir.startsWith(webRootPrefix)) return "";
        const relPath = dir.slice(webRootPrefix.length);
        const pluginName = relPath.split("/").pop();
        const typeDir = relPath.slice(0, relPath.lastIndexOf("/"));
        const pluginType = Object.entries(PLUGIN_TYPE_DIRS).find(
          ([, d]) => d === typeDir,
        )?.[0];
        if (!pluginType || !pluginName) return "";
        const safeDir = dir.replaceAll("'", "\\'");
        return `\\core_component::playground_refresh_installed_plugin_cache('${pluginType}_${pluginName}', '${safeDir}');`;
      })
      .filter(Boolean)
      .join("\n");

    const code = `<?php
define('CLI_SCRIPT', true);
require('${webRoot}/config.php');
require_once($CFG->libdir . '/upgradelib.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/adminlib.php');

${refreshCalls}
\\core_component::reset();
if (function_exists('purge_all_caches')) {
    purge_all_caches();
}
set_config('allversionshash', '');

try {
    if (moodle_needs_upgrading()) {
        upgrade_noncore(true);
    }
    echo json_encode(['ok' => true]);
} catch (\\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}
`;
    const result = await php.run(code);
    const text = result?.text || "";
    const errors = result?.errors || "";
    if (errors) {
      postShell({
        kind: "trace",
        detail: `[snapshot] plugin re-register PHP errors: ${errors.slice(0, 300)}`,
      });
    }
    if (text.includes('"ok":true')) {
      postShell({
        kind: "trace",
        detail: "[snapshot] re-registered plugins after restore",
      });
    } else {
      postShell({
        kind: "trace",
        detail: `[snapshot] plugin re-register result: ${text.slice(0, 200)}`,
      });
    }
  } catch (err) {
    postShell({
      kind: "error",
      detail: `[snapshot] plugin re-register failed: ${err.message}`,
    });
  }
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

function escapeHtml(str) {
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function buildLoadingResponse(message, status = 503) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Moodle Playground</title><body><pre>${escapeHtml(message)}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function resetRuntime(reason) {
  if (reactiveRestartCount >= MAX_REACTIVE_RESTARTS) {
    postShell({
      kind: "error",
      detail: `[runtime] restart limit reached (${reactiveRestartCount}/${MAX_REACTIVE_RESTARTS}), not restarting. Reason: ${reason}`,
    });
    return false;
  }

  if (requestCount < MIN_REQUESTS_BEFORE_RESTART) {
    postShell({
      kind: "error",
      detail: `[runtime] crash after only ${requestCount} requests (minimum ${MIN_REQUESTS_BEFORE_RESTART}), likely a fundamental bug — not restarting. Reason: ${reason}`,
    });
    return false;
  }

  reactiveRestartCount += 1;
  requestCount = 0;
  runtimeStatePromise = null;
  phpInfoCapturePromise = null;
  automaticPhpInfoAttempted = false;
  activeRuntimeConfig = null;

  postShell({
    kind: "progress",
    title: "Runtime rotation",
    detail: `[runtime] restart (${reactiveRestartCount}/${MAX_REACTIVE_RESTARTS}): ${reason}`,
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
    activeWebRoot = webRoot;
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
        onPluginInstalled: (dirPath) => snapshot.trackPluginDir(dirPath),
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

    // Restore saved DB snapshot if recovering from a crash.
    // This overwrites the fresh install snapshot with the pre-crash DB
    // that contains all courses, users, and config changes.
    if (snapshot.hasPendingRestore) {
      const restoreResult = await snapshot.restore(php);
      // If plugin files were restored, re-register them with Moodle
      // (reset component cache + run upgrade) before re-login.
      if (restoreResult?.pluginsRestored) {
        await reRegisterPluginsAfterRestore(php, webRoot, restoreResult.restoredPluginDirs);
      }
      // The restore overwrites the DB, invalidating the auto-login session
      // that bootstrap just created. Re-create it on the restored DB.
      if (restoreResult?.restored) {
        await reLoginAfterRestore(php, webRoot);
      }
    }

    postShell({
      kind: "ready",
      detail: `Moodle bootstrapped for PHP ${phpVersion || "8.3"}${branchMeta ? ` + ${branchMeta.label}` : ""}. [${totalMs}ms total]`,
      path: bootstrapState.readyPath || activeBlueprint?.landingPage || config.landingPath || "/",
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

/** Send an error page back through the bridge channel. */
async function respondError(id, message, status) {
  const response = buildLoadingResponse(message, status);
  respond({
    kind: "http-response",
    id,
    response: await serializeResponse(response),
  });
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
        requestCount += 1;
        const state = await getRuntimeState();
        const response = await executePhpRequest(state, data.request);
        // Detect plugin installations from Moodle's native admin UI
        detectPluginInstall(data.request, response, activeWebRoot);
        respond({
          kind: "http-response",
          id: data.id,
          response: await serializeResponse(response),
        });
      } catch (error) {
        // Emscripten network errors (Firefox/Safari): outbound curl calls
        // in WASM cannot reach external hosts. Notify the shell with a
        // user-friendly warning instead of crashing the runtime.
        if (isEmscriptenNetworkError(error)) {
          const requestUrl = data.request?.url || "";
          const pagePath = new URL(requestUrl, "http://localhost").pathname || "/";
          postShell({
            kind: "wasm-network-error",
            detail: `Page "${pagePath}" failed — a network call could not complete in this browser's WebAssembly runtime.`,
            path: pagePath,
          });
          await respondError(data.id, `Network call failed in WebAssembly runtime (errno 23). This is a known limitation on Firefox and Safari.`, 502);
          return;
        }

        if (!isFatalWasmError(error)) {
          // Non-fatal error: return 500 without runtime rotation.
          const detail = formatErrorDetail(error);
          await respondError(data.id, detail, 500);
          postShell({ kind: "error", detail });
          return;
        }

        // --- Fatal WASM error path ---
        // Save the DB file before destroying the runtime.
        // MEMFS lives in JS heap so readFileAsBuffer works even with
        // a corrupted WASM linear memory.
        try {
          const currentState = await runtimeStatePromise;
          if (currentState?.php?._php) {
            postShell({
              kind: "trace",
              detail: `[runtime] hydrating snapshot before runtime reset (dbPath=${buildDbPath()})`,
            });
            await snapshot.hydrate(currentState.php, buildDbPath());
          } else {
            postShell({
              kind: "trace",
              detail: `[runtime] no PHP instance available for snapshot hydration`,
            });
          }
        } catch (hydrateErr) {
          postShell({
            kind: "error",
            detail: `[runtime] snapshot hydration failed: ${hydrateErr.message}`,
          });
        }

        const didReset = resetRuntime(`fatal WASM error: ${error.message}`);
        const canReplay = isSafeToReplay(data.request);

        // If we already retried this request, or the request is not
        // idempotent, or we hit the restart limit — give up.
        if (isRetry || !canReplay || !didReset) {
          const detail = formatErrorDetail(error);
          const status = didReset || isRetry ? 503 : 500;
          const message = isRetry
            ? `Runtime crashed again on retry. Manual reload required.\n\n${detail}`
            : !canReplay
              ? `Runtime restarting after crash. Non-idempotent request was not retried.\n\n${detail}`
              : `Runtime restart limit reached.\n\n${detail}`;
          await respondError(data.id, message, status);
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
          await respondError(
            data.id,
            `Runtime crashed again on retry. Manual reload required.\n\n${detail}`,
            503,
          );
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

    // Override URL-derived runtime params with authoritative values
    // from remote.js, which has the correct user-selected runtime.
    const params = event.data.runtimeParams;
    if (params) {
      if (params.scopeId !== undefined) scopeId = params.scopeId;
      selection = resolveRuntimeSelection({
        runtimeId: params.runtimeId,
        phpVersion: params.phpVersion,
        moodleBranch: params.moodleBranch,
      });
      runtimeId = selection.runtimeId;
      phpVersion = selection.phpVersion;
      moodleBranch = selection.moodleBranch;
      if (params.debug !== undefined) debug = params.debug;
      if (params.profile !== undefined) profile = params.profile;
      // Reset any cached runtime state so it boots with the new params
      runtimeStatePromise = null;
      // Recreate bridge channel if scopeId changed
      if (params.scopeId !== undefined && bridgeChannel) {
        bridgeChannel.close();
        bridgeChannel = new BroadcastChannel(createPhpBridgeChannel(scopeId));
        installBridgeListener();
      }
    }

    activeBlueprint = event.data.blueprint || null;

    self.postMessage({
      kind: "worker-ready",
      scopeId,
      runtimeId,
    });
  });
}

try {
  bridgeChannel = new BroadcastChannel(createPhpBridgeChannel(scopeId));
  installBridgeListener();
  installMessageListener();
  // Do not signal readiness here — wait for configure-blueprint message
  // which carries authoritative runtime params from remote.js.
} catch (error) {
  self.postMessage({
    kind: "worker-startup-error",
    scopeId,
    runtimeId,
    detail: formatErrorDetail(error),
  });
  throw error;
}
