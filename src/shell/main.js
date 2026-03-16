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
import {
  MOODLE_BRANCHES,
  DEFAULT_PHP_VERSION,
  buildRuntimeId,
  getCompatiblePhpVersions,
  parseQueryParams,
  resolveVersions,
  resolveMoodleBranch,
} from "../shared/version-resolver.js";

const els = {
  addressForm: document.querySelector("#address-form"),
  address: document.querySelector("#address-input"),
  adminButton: document.querySelector("#admin-button"),
  blueprintPanel: document.querySelector("#blueprint-panel"),
  blueprintTab: document.querySelector("#blueprint-tab"),
  blueprintTextarea: document.querySelector("#blueprint-textarea"),
  clearLogs: document.querySelector("#clear-logs-button"),
  copyLogs: document.querySelector("#copy-logs-button"),
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
  settingsButton: document.querySelector("#settings-button"),
  settingsModal: document.querySelector("#settings-modal"),
  settingsMoodleVersion: document.querySelector("#settings-moodle-version"),
  settingsPhpVersion: document.querySelector("#settings-php-version"),
  settingsApply: document.querySelector("#settings-apply"),
  settingsCancel: document.querySelector("#settings-cancel"),
  currentMoodleLabel: document.querySelector("#current-moodle-label"),
  currentPhpLabel: document.querySelector("#current-php-label"),
  settingsPanel: document.querySelector("#settings-panel"),
  settingsTab: document.querySelector("#settings-tab"),
  sidePanel: document.querySelector("#side-panel"),
  workspace: document.querySelector("#workspace"),
};

const scopeId = getOrCreateScopeId();
let config;
let currentRuntimeId;
let currentPhpVersion = DEFAULT_PHP_VERSION;
let currentMoodleBranch = null;
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
  const url = resolveRemoteUrl(scopeId, currentRuntimeId, currentPath, {
    phpVersion: currentPhpVersion,
    moodleBranch: currentMoodleBranch,
  });
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
  capturePhpInfoViaWorker("manual");
}

function capturePhpInfoViaWorker(reason = "manual") {
  if (!config) {
    appendLog("Cannot capture PHP info before the playground configuration is loaded.", true);
    return;
  }

  appendLog(`Requesting PHP runtime diagnostics (${reason}).`);

  // Send capture request to the remote iframe, which forwards it to the worker.
  // The worker will respond via BroadcastChannel with a "phpinfo" message.
  const remoteFrame = document.querySelector("#remote-frame");
  if (remoteFrame?.contentWindow) {
    remoteFrame.contentWindow.postMessage({ kind: "capture-phpinfo" }, "*");
  } else {
    appendLog("Cannot capture PHP info: remote frame not available.", true);
  }
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
          capturePhpInfoViaWorker("bootstrap-error");
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

function populateSettingsModal() {
  if (!els.settingsMoodleVersion || !els.settingsPhpVersion) {
    return;
  }

  // Populate Moodle version dropdown
  els.settingsMoodleVersion.innerHTML = "";
  for (const branch of MOODLE_BRANCHES) {
    const option = document.createElement("option");
    option.value = branch.branch;
    option.textContent = branch.label;
    els.settingsMoodleVersion.append(option);
  }
  els.settingsMoodleVersion.value = currentMoodleBranch;

  // Populate PHP version dropdown based on selected Moodle branch
  updatePhpVersionDropdown(currentMoodleBranch);
  els.settingsPhpVersion.value = currentPhpVersion;
}

function updatePhpVersionDropdown(branch) {
  if (!els.settingsPhpVersion) {
    return;
  }

  const compatibleVersions = getCompatiblePhpVersions(branch);
  const previousValue = els.settingsPhpVersion.value;
  els.settingsPhpVersion.innerHTML = "";
  for (const version of compatibleVersions) {
    const option = document.createElement("option");
    option.value = version;
    option.textContent = `PHP ${version}`;
    els.settingsPhpVersion.append(option);
  }

  // Keep current selection if still compatible, otherwise fall back
  if (compatibleVersions.includes(previousValue)) {
    els.settingsPhpVersion.value = previousValue;
  } else if (compatibleVersions.includes(DEFAULT_PHP_VERSION)) {
    els.settingsPhpVersion.value = DEFAULT_PHP_VERSION;
  } else {
    els.settingsPhpVersion.value = compatibleVersions[0];
  }
}

function updateCurrentVersionLabels() {
  const branchInfo = MOODLE_BRANCHES.find((b) => b.branch === currentMoodleBranch);
  if (els.currentMoodleLabel) {
    els.currentMoodleLabel.textContent = branchInfo ? branchInfo.label : currentMoodleBranch;
  }
  if (els.currentPhpLabel) {
    els.currentPhpLabel.textContent = `PHP ${currentPhpVersion}`;
  }
}

function openSettingsModal() {
  if (!els.settingsModal) {
    return;
  }
  populateSettingsModal();
  els.settingsModal.showModal();
}

function closeSettingsModal() {
  if (!els.settingsModal) {
    return;
  }
  els.settingsModal.close();
}

function applySettingsAndReset() {
  const newBranch = els.settingsMoodleVersion?.value;
  const newPhp = els.settingsPhpVersion?.value;
  closeSettingsModal();

  if (newBranch === currentMoodleBranch && newPhp === currentPhpVersion) {
    return;
  }

  // Update URL params and reload
  const url = new URL(window.location.href);
  url.searchParams.set("php", newPhp);
  const branchInfo = MOODLE_BRANCHES.find((b) => b.branch === newBranch);
  url.searchParams.set("moodle", branchInfo ? branchInfo.version : newBranch);
  url.searchParams.delete("moodleBranch");
  window.location.href = url.toString();
}

async function main() {
  config = await loadPlaygroundConfig();
  activeBlueprint = await resolveBlueprintForShell(scopeId, config);
  updateBlueprintTextarea();

  // Resolve versions from URL params > blueprint > defaults
  const urlParams = parseQueryParams(window.location);
  const blueprintVersions = {
    php: activeBlueprint?.preferredVersions?.php || null,
    moodle: activeBlueprint?.preferredVersions?.moodle || null,
  };
  const resolved = resolveVersions({
    php: urlParams.php || blueprintVersions.php,
    moodle: urlParams.moodle || blueprintVersions.moodle,
    moodleBranch: urlParams.moodleBranch,
  });
  currentPhpVersion = resolved.phpVersion;
  currentMoodleBranch = resolved.moodleBranch;
  currentRuntimeId = buildRuntimeId(currentPhpVersion, currentMoodleBranch);

  const previous = loadSessionState(scopeId);
  const preferredPath = activeBlueprint?.landingPage || config.landingPath || "/";
  const shouldBypassSavedLogin = config.autologin && previous?.path === "/login";
  const shouldBypassInternalPath = isInternalRuntimePath(previous?.path);

  currentPath = (shouldBypassSavedLogin || shouldBypassInternalPath)
    ? preferredPath
    : (previous?.path || preferredPath);
  els.address.value = currentPath;

  // Populate runtime dropdown from config (backward compat) + current resolved
  for (const runtime of config.runtimes) {
    const option = document.createElement("option");
    option.value = runtime.id;
    option.textContent = runtime.label;
    els.runtime.append(option);
  }
  // If current runtimeId isn't in the legacy dropdown, add it
  if (!Array.from(els.runtime.options).some((opt) => opt.value === currentRuntimeId)) {
    const branchInfo = MOODLE_BRANCHES.find((b) => b.branch === currentMoodleBranch);
    const option = document.createElement("option");
    option.value = currentRuntimeId;
    option.textContent = `PHP ${currentPhpVersion} / ${branchInfo ? branchInfo.label : currentMoodleBranch}`;
    els.runtime.append(option);
  }
  els.runtime.value = currentRuntimeId;
  updateCurrentVersionLabels();

  // Settings modal event listeners
  if (els.settingsButton) {
    els.settingsButton.addEventListener("click", openSettingsModal);
  }
  if (els.settingsCancel) {
    els.settingsCancel.addEventListener("click", closeSettingsModal);
  }
  if (els.settingsApply) {
    els.settingsApply.addEventListener("click", applySettingsAndReset);
  }
  if (els.settingsMoodleVersion) {
    els.settingsMoodleVersion.addEventListener("change", () => {
      updatePhpVersionDropdown(els.settingsMoodleVersion.value);
    });
  }

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
els.copyLogs.addEventListener("click", () => {
  const text = els.logPanel.textContent || "";
  navigator.clipboard.writeText(text).then(() => {
    const original = els.copyLogs.textContent;
    els.copyLogs.textContent = "Copied!";
    setTimeout(() => { els.copyLogs.textContent = original; }, 1200);
  });
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
