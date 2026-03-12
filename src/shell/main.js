import {
  exportBlueprintPayload,
  parseImportedBlueprintPayload,
  resolveBlueprintForShell,
  saveActiveBlueprint,
} from "../shared/blueprint.js";
import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { resolveRemoteUrl } from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import { clearScopeSession, getOrCreateScopeId, loadSessionState, saveSessionState } from "../shared/storage.js";
import { createProvisioningRuntime } from "../runtime/php-loader.js";

const els = {
  addressForm: document.querySelector("#address-form"),
  address: document.querySelector("#address-input"),
  adminButton: document.querySelector("#admin-button"),
  blueprintPanel: document.querySelector("#blueprint-panel"),
  blueprintTab: document.querySelector("#blueprint-tab"),
  blueprintTextarea: document.querySelector("#blueprint-textarea"),
  clearLogs: document.querySelector("#clear-logs-button"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  frame: document.querySelector("#site-frame"),
  homeButton: document.querySelector("#home-button"),
  logPanel: document.querySelector("#log-panel"),
  logsPanel: document.querySelector("#logs-panel"),
  logsTab: document.querySelector("#logs-tab"),
  panelToggle: document.querySelector("#panel-toggle-button"),
  phpInfoButton: document.querySelector("#phpinfo-button"),
  phpInfoFrame: document.querySelector("#phpinfo-frame"),
  phpInfoPanel: document.querySelector("#phpinfo-panel"),
  phpInfoTab: document.querySelector("#phpinfo-tab"),
  refreshPhpInfoButton: document.querySelector("#refresh-phpinfo-button"),
  refresh: document.querySelector("#refresh-button"),
  reset: document.querySelector("#reset-button"),
  runtime: document.querySelector("#runtime-select"),
  settingsPanel: document.querySelector("#settings-panel"),
  settingsTab: document.querySelector("#settings-tab"),
  sidePanel: document.querySelector("#side-panel"),
  workspace: document.querySelector("#workspace"),
};

const scopeId = getOrCreateScopeId();
let config;
let currentRuntimeId;
let currentPath = "/";
let channel;
let serviceWorkerReady = null;
let activeBlueprint;
let remoteFrameBooted = false;
let uiLocked = true;
let remoteReloadToken = 0;
let pendingCleanBoot = false;
let latestPhpInfoHtml = "";
let phpInfoCapturePromise = null;
const CONTROL_RELOAD_KEY = `moodle-playground:${scopeId}:sw-controlled`;

function isInternalRuntimePath(path) {
  return typeof path === "string" && /^\/__[^/]+\.php(?:[?#].*)?$/u.test(path);
}

function appendLog(message, isError = false) {
  const line = `[${new Date().toISOString()}] ${message}`;
  const span = document.createElement("span");
  span.textContent = `${line}\n`;
  if (isError) {
    span.className = "error";
  }
  els.logPanel.append(span);
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function setUiLocked(locked) {
  uiLocked = locked;
  els.address.disabled = locked;
  els.homeButton.disabled = locked;
  els.adminButton.disabled = locked;
  els.phpInfoButton.disabled = locked;
  els.refreshPhpInfoButton.disabled = locked;
  els.runtime.disabled = locked;
  els.reset.disabled = locked;
  els.exportButton.disabled = locked;
  els.importInput.disabled = locked;
  els.addressForm.classList.toggle("is-disabled", locked);
}

async function ensureRuntimeServiceWorker() {
  if (!config) {
    return;
  }

  const swUrl = new URL("../../sw.js", import.meta.url);
  swUrl.searchParams.set("v", config.bundleVersion);
  swUrl.searchParams.set("scope", scopeId);
  swUrl.searchParams.set("runtime", currentRuntimeId);

  await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    type: "module",
    updateViaCache: "none",
  });
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    const alreadyReloaded = window.sessionStorage.getItem(CONTROL_RELOAD_KEY) === "1";
    if (!alreadyReloaded) {
      window.sessionStorage.setItem(CONTROL_RELOAD_KEY, "1");
      window.location.reload();
      return new Promise(() => {});
    }
  }

  window.sessionStorage.removeItem(CONTROL_RELOAD_KEY);
}

async function updateFrame() {
  if (!serviceWorkerReady) {
    serviceWorkerReady = ensureRuntimeServiceWorker();
  }

  await serviceWorkerReady;
  const url = resolveRemoteUrl(scopeId, currentRuntimeId, currentPath);
  if (pendingCleanBoot) {
    url.searchParams.set("clean", "1");
  }
  if (remoteReloadToken > 0) {
    url.searchParams.set("reload", String(remoteReloadToken));
  }
  remoteFrameBooted = false;
  els.frame.src = url.toString();
  pendingCleanBoot = false;
}

function postToRemote(message) {
  if (!els.frame.contentWindow) {
    return false;
  }

  els.frame.contentWindow.postMessage(message, window.location.origin);
  return true;
}

function navigateWithinRuntime(path) {
  if (uiLocked) {
    return;
  }

  currentPath = path || "/";
  els.address.value = currentPath;
  saveState();

  if (remoteFrameBooted && postToRemote({ kind: "navigate-site", path: currentPath })) {
    appendLog(`Navigating site to ${currentPath}`);
    return;
  }

  void updateFrame();
}

function refreshWithinRuntime() {
  if (remoteFrameBooted && postToRemote({ kind: "refresh-site" })) {
    appendLog(`Refreshing ${currentPath}`);
    return;
  }

  void updateFrame();
}

function restartRuntime() {
  if (uiLocked) {
    return;
  }

  pendingCleanBoot = true;
  remoteReloadToken = Date.now();
  remoteFrameBooted = false;
  serviceWorkerReady = null;
  setUiLocked(true);
  appendLog(`Restarting runtime for ${currentRuntimeId}`);
  els.frame.src = "about:blank";
  void updateFrame();
}

function navigateHome() {
  navigateWithinRuntime("/my/");
}

function navigateAdmin() {
  navigateWithinRuntime("/admin/search.php");
}

function setPhpInfoContent(html = "") {
  latestPhpInfoHtml = typeof html === "string" ? html : "";
  if (!els.phpInfoFrame) {
    return;
  }

  if (!latestPhpInfoHtml) {
    els.phpInfoFrame.srcdoc = `<!doctype html><meta charset="utf-8"><style>
      body{font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;color:#1f2937;background:#fff}
      p{margin:0}
    </style><p>No PHP diagnostics captured yet.</p>`;
    return;
  }

  els.phpInfoFrame.srcdoc = latestPhpInfoHtml;
}

function requestPhpInfoCapture() {
  setActivePanel("phpinfo");
  void capturePhpInfoLocally("manual");
}

async function capturePhpInfoLocally(reason = "manual") {
  if (!config) {
    appendLog("Cannot capture PHP info before the playground configuration is loaded.", true);
    return;
  }

  if (phpInfoCapturePromise) {
    return phpInfoCapturePromise;
  }

  const runtime = config.runtimes.find((entry) => entry.id === currentRuntimeId) || getDefaultRuntime(config);
  appendLog(`Capturing PHP runtime diagnostics for ${runtime.label} (${reason}).`);

  phpInfoCapturePromise = (async () => {
    const php = createProvisioningRuntime(runtime);
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

      const html = output.join("");
      if (!html.trim()) {
        throw new Error("phpinfo() returned no HTML output.");
      }

      setPhpInfoContent(html);
      appendLog(`Captured PHP runtime diagnostics for ${runtime.label}.`);
    } catch (error) {
      const detail = String(error?.stack || error?.message || error);
      const stderr = errors.join("");
      setPhpInfoContent(`<!doctype html><meta charset="utf-8"><pre>${detail}${stderr ? `\n\n${stderr}` : ""}</pre>`);
      appendLog(`PHP info capture failed: ${detail}`, true);
    } finally {
      php.removeEventListener("output", onOutput);
      php.removeEventListener("error", onError);
      phpInfoCapturePromise = null;
    }
  })();

  return phpInfoCapturePromise;
}

function setActivePanel(panel) {
  const panels = {
    phpinfo: [els.phpInfoPanel, els.phpInfoTab],
    blueprint: [els.blueprintPanel, els.blueprintTab],
    logs: [els.logsPanel, els.logsTab],
    settings: [els.settingsPanel, els.settingsTab],
  };

  for (const [panelName, [panelEl, tabEl]] of Object.entries(panels)) {
    const isActive = panelName === panel;
    panelEl.classList.toggle("is-hidden", !isActive);
    tabEl.classList.toggle("is-active", isActive);
    tabEl.setAttribute("aria-selected", String(isActive));
  }
}

function toggleSidePanel() {
  const collapsed = els.sidePanel.classList.toggle("is-collapsed");
  els.workspace.classList.toggle("is-panel-collapsed", collapsed);
  els.panelToggle.setAttribute("aria-expanded", String(!collapsed));
}

function saveState(extra = {}) {
  saveSessionState(scopeId, {
    scopeId,
    runtimeId: currentRuntimeId,
    path: currentPath,
    ...extra,
  });
}

function exportBlueprint() {
  const payload = exportBlueprintPayload(config, activeBlueprint);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "moodle-playground.blueprint.json";
  link.click();
  URL.revokeObjectURL(url);
}

function updateBlueprintTextarea() {
  if (!config || !activeBlueprint || !els.blueprintTextarea) {
    return;
  }

  els.blueprintTextarea.value = JSON.stringify(exportBlueprintPayload(config, activeBlueprint), null, 2);
  els.blueprintTextarea.scrollTop = 0;
}

async function importPayload(file) {
  const imported = parseImportedBlueprintPayload(JSON.parse(await file.text()), config);

  if (imported.type === "snapshot") {
    currentRuntimeId = imported.runtimeId || currentRuntimeId;
    currentPath = imported.path || "/";
    els.address.value = currentPath;
    els.runtime.value = currentRuntimeId;
    saveState({ importedAt: new Date().toISOString() });
    await updateFrame();
    return;
  }

  activeBlueprint = imported.blueprint;
  saveActiveBlueprint(scopeId, activeBlueprint);
  pendingCleanBoot = true;
  currentPath = activeBlueprint.landingPage || config.landingPath || "/";
  els.address.value = currentPath;
  updateBlueprintTextarea();
  saveState({ importedBlueprintAt: new Date().toISOString() });
  await updateFrame();
}

function bindShellChannel() {
  channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.addEventListener("message", (event) => {
    const message = event.data;

    switch (message.kind) {
      case "progress":
        setUiLocked(true);
        appendLog(`${message.title}: ${message.detail}`);
        break;
      case "ready":
        setUiLocked(false);
        {
          const previousPath = currentPath;
          currentPath = isInternalRuntimePath(message.path) ? currentPath : (message.path || currentPath);
          if (remoteFrameBooted && currentPath !== previousPath) {
            postToRemote({ kind: "navigate-site", path: currentPath });
          }
        }
        els.address.value = currentPath;
        saveState({ lastReadyAt: new Date().toISOString() });
        break;
      case "frame-ready":
        remoteFrameBooted = true;
        if (!uiLocked) {
          currentPath = isInternalRuntimePath(message.path) ? currentPath : (message.path || currentPath);
          els.address.value = currentPath;
          saveState();
        }
        break;
      case "navigate":
        currentPath = isInternalRuntimePath(message.path) ? currentPath : (message.path || "/");
        els.address.value = currentPath;
        saveState();
        break;
      case "error":
        remoteFrameBooted = false;
        setUiLocked(false);
        appendLog(message.detail, true);
        if (!latestPhpInfoHtml) {
          setActivePanel("phpinfo");
          void capturePhpInfoLocally("bootstrap-error");
        }
        break;
      case "phpinfo":
        setPhpInfoContent(message.html || "");
        appendLog(message.detail || "Captured PHP runtime diagnostics.");
        break;
      default:
        break;
    }
  });
}

function bindServiceWorkerMessages() {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.kind === "sw-debug") {
      appendLog(`[sw] ${message.detail}`);
    }
  });
}

async function main() {
  config = await loadPlaygroundConfig();
  activeBlueprint = await resolveBlueprintForShell(scopeId, config);
  updateBlueprintTextarea();
  const previous = loadSessionState(scopeId);
  const defaultRuntime = getDefaultRuntime(config);
  const preferredPath = activeBlueprint?.landingPage || config.landingPath || "/";
  const shouldBypassSavedLogin = config.autologin && previous?.path === "/login";
  const shouldBypassInternalPath = isInternalRuntimePath(previous?.path);

  currentRuntimeId = previous?.runtimeId || defaultRuntime.id;
  currentPath = (shouldBypassSavedLogin || shouldBypassInternalPath)
    ? preferredPath
    : (previous?.path || preferredPath);
  els.address.value = currentPath;

  for (const runtime of config.runtimes) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = runtime.label;
    els.runtime.append(option);
  }
  els.runtime.value = currentRuntimeId;

  bindShellChannel();
  bindServiceWorkerMessages();
  setPhpInfoContent("");
  phpInfoCapturePromise = null;
  setUiLocked(true);
  await updateFrame();
}

els.refresh.addEventListener("click", () => {
  restartRuntime();
});

els.homeButton.addEventListener("click", navigateHome);
els.adminButton.addEventListener("click", navigateAdmin);
els.panelToggle.addEventListener("click", toggleSidePanel);
els.settingsTab.addEventListener("click", () => setActivePanel("settings"));
els.logsTab.addEventListener("click", () => setActivePanel("logs"));
els.phpInfoTab.addEventListener("click", () => setActivePanel("phpinfo"));
els.blueprintTab.addEventListener("click", () => setActivePanel("blueprint"));
els.clearLogs.addEventListener("click", () => {
  els.logPanel.textContent = "";
});
els.phpInfoButton.addEventListener("click", requestPhpInfoCapture);
els.refreshPhpInfoButton.addEventListener("click", requestPhpInfoCapture);

els.addressForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (uiLocked) {
    return;
  }
  navigateWithinRuntime(els.address.value || "/");
});

els.runtime.addEventListener("change", () => {
  if (uiLocked) {
    return;
  }
  currentRuntimeId = els.runtime.value;
  remoteFrameBooted = false;
  setPhpInfoContent("");
  phpInfoCapturePromise = null;
  appendLog(`Switching runtime to ${currentRuntimeId}`);
  saveState({ switchedAt: new Date().toISOString() });
  serviceWorkerReady = null;
  void updateFrame();
});

els.exportButton.addEventListener("click", exportBlueprint);
els.importInput.addEventListener("change", async () => {
  const file = els.importInput.files?.[0];
  if (!file) {
    return;
  }

  try {
    await importPayload(file);
  } catch (error) {
    appendLog(String(error?.stack || error?.message || error), true);
  } finally {
    els.importInput.value = "";
  }
});

els.reset.addEventListener("click", () => {
  if (uiLocked) {
    return;
  }
  clearScopeSession(scopeId);
  pendingCleanBoot = true;
  remoteFrameBooted = false;
  serviceWorkerReady = null;
  setPhpInfoContent("");
  phpInfoCapturePromise = null;
  void updateFrame();
});

main().catch((error) => {
  setUiLocked(false);
  appendLog(String(error?.stack || error?.message || error), true);
});
