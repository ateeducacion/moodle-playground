import {
  clearBlueprint,
  parseBlueprint,
  resolveBlueprint,
  saveBlueprint,
  validateBlueprint,
} from "../blueprint/index.js";
import { loadPlaygroundConfig } from "../shared/config.js";
import { resolveRemoteUrl } from "../shared/paths.js";
import { createShellChannel, SNAPSHOT_VERSION } from "../shared/protocol.js";
import { registerVersionedServiceWorker } from "../shared/service-worker-version.js";
import {
  clearScopeSession,
  getOrCreateScopeId,
  loadSessionState,
  saveSessionState,
} from "../shared/storage.js";
import {
  DEFAULT_PHP_VERSION,
  getCompatiblePhpVersions,
  MOODLE_BRANCHES,
  parseQueryParams,
  resolveRuntimeSelection,
  shouldTraceRuntimeSelection,
} from "../shared/version-resolver.js";

const els = {
  addressForm: document.querySelector("#address-form"),
  address: document.querySelector("#address-input"),
  blueprintPanel: document.querySelector("#blueprint-panel"),
  blueprintTab: document.querySelector("#blueprint-tab"),
  blueprintTextarea: document.querySelector("#blueprint-textarea"),
  clearLogs: document.querySelector("#clear-logs-button"),
  copyLogs: document.querySelector("#copy-logs-button"),
  exportButton: document.querySelector("#export-button"),
  importInput: document.querySelector("#import-input"),
  frame: document.querySelector("#site-frame"),
  logPanel: document.querySelector("#log-panel"),
  logsPanel: document.querySelector("#logs-panel"),
  logsTab: document.querySelector("#logs-tab"),
  panelToggle: document.querySelector("#panel-toggle-button"),
  phpInfoFrame: document.querySelector("#phpinfo-frame"),
  phpInfoPanel: document.querySelector("#phpinfo-panel"),
  phpInfoTab: document.querySelector("#phpinfo-tab"),
  refreshPhpInfoButton: document.querySelector("#refresh-phpinfo-button"),
  home: document.querySelector("#home-button"),
  refresh: document.querySelector("#refresh-button"),
  reset: document.querySelector("#reset-button"),
  settingsButton: document.querySelector("#settings-button"),
  settingsPopover: document.querySelector("#settings-popover"),
  settingsOverlay: document.querySelector("#settings-overlay"),
  settingsMoodleVersion: document.querySelector("#settings-moodle-version"),
  settingsPhpVersion: document.querySelector("#settings-php-version"),
  settingsApply: document.querySelector("#settings-apply"),
  settingsCancel: document.querySelector("#settings-cancel"),
  currentMoodleLabel: document.querySelector("#current-moodle-label"),
  currentPhpLabel: document.querySelector("#current-php-label"),
  currentRuntimeLabel: document.querySelector("#current-runtime-label"),
  infoPanel: document.querySelector("#info-panel"),
  infoTab: document.querySelector("#info-tab"),
  sidePanel: document.querySelector("#side-panel"),
  workspace: document.querySelector("#workspace"),
};

const scopeId = getOrCreateScopeId();
let config;
let currentRuntimeId;
let currentPhpVersion = DEFAULT_PHP_VERSION;
let currentMoodleBranch = null;
let currentAddonProxyUrl = null;
let currentPhpCorsProxyUrl = null;
let currentDebugParam = null;
let currentProfileParam = null;
let currentPath = "/";
let channel;
let serviceWorkerReady = null;
let activeBlueprint;
let remoteFrameBooted = false;
let uiLocked = true;
const remoteReloadToken = 0;
let pendingCleanBoot = false;
let latestPhpInfoHtml = "";
// biome-ignore lint/correctness/noUnusedVariables: reserved for future phpinfo capture tracking
let phpInfoCapturePromise = null;
const CONTROL_RELOAD_KEY = `moodle-playground:${scopeId}:sw-controlled`;

function applyRuntimeSelection(selection) {
  currentPhpVersion = selection.phpVersion;
  currentMoodleBranch = selection.moodleBranch;
  currentRuntimeId = selection.runtimeId;
}

function traceRuntimeSelection(stage, detail) {
  if (
    !shouldTraceRuntimeSelection({
      debug: currentDebugParam,
      profile: currentProfileParam,
    })
  ) {
    return;
  }

  appendLog(`[runtime-selection][shell:${stage}] ${detail}`);
}

function isInternalRuntimePath(path) {
  return typeof path === "string" && /^\/__[^/]+\.php(?:[?#].*)?$/u.test(path);
}

const MAX_LOG_ENTRIES = 500;

function appendLog(message, isError = false) {
  const line = `[${new Date().toISOString()}] ${message}`;
  const span = document.createElement("span");
  span.textContent = `${line}\n`;
  if (isError) {
    span.className = "error";
  }
  els.logPanel.append(span);
  // Prune oldest entries to prevent unbounded DOM growth
  while (els.logPanel.childElementCount > MAX_LOG_ENTRIES) {
    els.logPanel.firstElementChild?.remove();
  }
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function setUiLocked(locked) {
  uiLocked = locked;
  els.address.disabled = locked;
  els.refreshPhpInfoButton.disabled = locked;
  els.reset.disabled = locked;
  els.exportButton.disabled = locked;
  els.importInput.disabled = locked;
  els.addressForm.classList.toggle("is-disabled", locked);
}

async function ensureRuntimeServiceWorker() {
  if (!config) {
    return;
  }

  await registerVersionedServiceWorker(
    new URL("../../sw.bundle.js", import.meta.url),
    {
      scope: "./",
    },
  );
  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    const alreadyReloaded =
      window.sessionStorage.getItem(CONTROL_RELOAD_KEY) === "1";
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
    addonProxyUrl: currentAddonProxyUrl,
    phpCorsProxyUrl: currentPhpCorsProxyUrl,
    debug: currentDebugParam,
    profile: currentProfileParam,
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

  if (
    remoteFrameBooted &&
    postToRemote({ kind: "navigate-site", path: currentPath })
  ) {
    appendLog(`Navigating site to ${currentPath}`);
    return;
  }

  void updateFrame();
}

// biome-ignore lint/correctness/noUnusedVariables: called via postToRemote from remote.html
function refreshWithinRuntime() {
  if (remoteFrameBooted && postToRemote({ kind: "refresh-site" })) {
    appendLog(`Refreshing ${currentPath}`);
    return;
  }

  void updateFrame();
}

function setPhpInfoContent(html = "") {
  latestPhpInfoHtml = typeof html === "string" ? html : "";
  if (!els.phpInfoFrame) {
    return;
  }

  if (!latestPhpInfoHtml) {
    els.phpInfoFrame.srcdoc = `<!doctype html><meta charset="utf-8"><style>
      html,body{height:100%}
      body{margin:0;font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;color:#1f2937;background:#fff;box-sizing:border-box}
      p{margin:0}
    </style><p>No PHP diagnostics captured yet.</p>`;
    return;
  }

  const responsivePhpInfoHtml = latestPhpInfoHtml.replace(
    "</head>",
    `<style>
      html,body{height:100%}
      body{margin:0;padding:12px;box-sizing:border-box;overflow:auto;background:#fff;color:#222;font-family:sans-serif}
      .center{width:100%}
      .center table{width:100%;max-width:100%;margin:1em auto;text-align:left}
      table{border-collapse:collapse;border:0;width:100%;max-width:100%;box-shadow:0 1px 3px rgba(0,0,0,.12);table-layout:auto}
      td,th{border:1px solid #666;font-size:75%;vertical-align:baseline;padding:4px 5px}
      th{position:sticky;top:0;background:inherit}
      .e{width:28%;min-width:180px}
      .v{max-width:none;overflow-wrap:anywhere;word-break:break-word}
      hr{width:100%;max-width:100%}
      img{max-width:100%;height:auto}
      pre{white-space:pre-wrap;overflow-wrap:anywhere}
      h1,h2{scroll-margin-top:12px}
    </style></head>`,
  );

  els.phpInfoFrame.srcdoc = responsivePhpInfoHtml;
}

function requestPhpInfoCapture() {
  setActivePanel("phpinfo");
  capturePhpInfoViaWorker("manual");
}

function capturePhpInfoViaWorker(reason = "manual") {
  if (!config) {
    appendLog(
      "Cannot capture PHP info before the playground configuration is loaded.",
      true,
    );
    return;
  }

  appendLog(`Requesting PHP runtime diagnostics (${reason}).`);

  // Send capture request through the site iframe (remote.html), which forwards it to the worker.
  // The worker will respond via BroadcastChannel with a "phpinfo" message.
  if (els.frame?.contentWindow) {
    els.frame.contentWindow.postMessage({ kind: "capture-phpinfo" }, "*");
  } else {
    appendLog("Cannot capture PHP info: remote frame not available.", true);
  }
}

function setActivePanel(panel) {
  const panels = {
    phpinfo: [els.phpInfoPanel, els.phpInfoTab],
    blueprint: [els.blueprintPanel, els.blueprintTab],
    logs: [els.logsPanel, els.logsTab],
    info: [els.infoPanel, els.infoTab],
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
  const payload = activeBlueprint || {};
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "moodle-playground.blueprint.json";
  link.click();
  URL.revokeObjectURL(url);
}

function updateBlueprintTextarea() {
  if (!activeBlueprint || !els.blueprintTextarea) {
    return;
  }

  els.blueprintTextarea.value = JSON.stringify(activeBlueprint, null, 2);
  els.blueprintTextarea.scrollTop = 0;
}

async function importPayload(file) {
  const rawPayload = JSON.parse(await file.text());

  // Check if this is a snapshot payload (old format)
  if (rawPayload?.version === SNAPSHOT_VERSION) {
    applyRuntimeSelection(
      resolveRuntimeSelection({ runtimeId: rawPayload.runtimeId }),
    );
    currentPath = rawPayload.path || "/";
    els.address.value = currentPath;
    saveState({ importedAt: new Date().toISOString() });
    await updateFrame();
    return;
  }

  // Parse and validate as blueprint
  const blueprint = parseBlueprint(rawPayload);
  const validation = validateBlueprint(blueprint);
  if (!validation.valid) {
    appendLog(
      `Blueprint validation errors:\n${validation.errors.join("\n")}`,
      true,
    );
  }

  activeBlueprint = blueprint;
  saveBlueprint(scopeId, activeBlueprint);
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
          currentPath = isInternalRuntimePath(message.path)
            ? currentPath
            : message.path || currentPath;
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
          currentPath = isInternalRuntimePath(message.path)
            ? currentPath
            : message.path || currentPath;
          els.address.value = currentPath;
          saveState();
        }
        break;
      case "navigate":
        currentPath = isInternalRuntimePath(message.path)
          ? currentPath
          : message.path || "/";
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
      case "wasm-network-error":
        appendLog(
          `${message.detail} — This is a known limitation on Firefox and Safari. The page may not render fully.`,
          true,
        );
        break;
      case "phpinfo":
        setPhpInfoContent(message.html || "");
        appendLog(message.detail || "Captured PHP runtime diagnostics.");
        break;
      case "trace":
        appendLog(message.detail || "[trace]");
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
  const branchInfo = MOODLE_BRANCHES.find(
    (b) => b.branch === currentMoodleBranch,
  );
  if (els.currentMoodleLabel) {
    els.currentMoodleLabel.textContent = branchInfo
      ? branchInfo.label
      : currentMoodleBranch;
  }
  if (els.currentPhpLabel) {
    els.currentPhpLabel.textContent = `PHP ${currentPhpVersion}`;
  }
  if (els.currentRuntimeLabel) {
    els.currentRuntimeLabel.textContent = currentRuntimeId;
  }
}

function openSettingsPopover() {
  if (!els.settingsPopover) {
    return;
  }
  populateSettingsModal();
  els.settingsPopover.classList.add("is-open");
  els.settingsOverlay.classList.add("is-open");
  els.settingsOverlay.setAttribute("aria-hidden", "false");
  els.settingsButton.setAttribute("aria-expanded", "true");
  // Focus the first select for keyboard users
  const firstInput = els.settingsPopover.querySelector("select");
  if (firstInput) {
    firstInput.focus();
  }
}

function closeSettingsPopover() {
  if (!els.settingsPopover) {
    return;
  }
  els.settingsPopover.classList.remove("is-open");
  els.settingsOverlay.classList.remove("is-open");
  els.settingsOverlay.setAttribute("aria-hidden", "true");
  els.settingsButton.setAttribute("aria-expanded", "false");
  els.settingsButton.focus();
}

function applySettingsAndReset() {
  const newBranch = els.settingsMoodleVersion?.value;
  const newPhp = els.settingsPhpVersion?.value;
  closeSettingsPopover();

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
  activeBlueprint = await resolveBlueprint({
    scopeId,
    location: window.location,
    defaultBlueprintUrl: config.defaultBlueprintUrl,
  });
  updateBlueprintTextarea();

  // Resolve versions from URL params > blueprint > defaults
  const urlParams = parseQueryParams(window.location);
  const blueprintVersions = {
    php: activeBlueprint?.preferredVersions?.php || null,
    moodle: activeBlueprint?.preferredVersions?.moodle || null,
  };
  const selection = resolveRuntimeSelection({
    php: urlParams.php || blueprintVersions.php,
    phpVersion: urlParams.phpVersion,
    moodle: urlParams.moodle || blueprintVersions.moodle,
    moodleBranch: urlParams.moodleBranch,
  });
  currentDebugParam = urlParams.debug;
  currentProfileParam = urlParams.profile;
  currentAddonProxyUrl = urlParams.addonProxyUrl;
  currentPhpCorsProxyUrl = urlParams.phpCorsProxyUrl;
  applyRuntimeSelection(selection);
  traceRuntimeSelection(
    "resolved",
    `params=${JSON.stringify(urlParams)} -> php=${currentPhpVersion}, moodleBranch=${currentMoodleBranch}, runtimeId=${currentRuntimeId}`,
  );

  const previous = loadSessionState(scopeId);
  const preferredPath =
    activeBlueprint?.landingPage || config.landingPath || "/";
  const shouldBypassSavedLogin =
    config.autologin && previous?.path === "/login";
  const shouldBypassInternalPath = isInternalRuntimePath(previous?.path);

  currentPath =
    shouldBypassSavedLogin || shouldBypassInternalPath
      ? preferredPath
      : previous?.path || preferredPath;
  els.address.value = currentPath;

  updateCurrentVersionLabels();

  // Settings popover event listeners
  if (els.settingsButton) {
    els.settingsButton.addEventListener("click", () => {
      const isOpen = els.settingsPopover?.classList.contains("is-open");
      if (isOpen) {
        closeSettingsPopover();
      } else {
        openSettingsPopover();
      }
    });
  }
  if (els.settingsOverlay) {
    els.settingsOverlay.addEventListener("click", closeSettingsPopover);
  }
  if (els.settingsCancel) {
    els.settingsCancel.addEventListener("click", closeSettingsPopover);
  }
  if (els.settingsApply) {
    els.settingsApply.addEventListener("click", applySettingsAndReset);
  }
  if (els.settingsMoodleVersion) {
    els.settingsMoodleVersion.addEventListener("change", () => {
      updatePhpVersionDropdown(els.settingsMoodleVersion.value);
    });
  }

  // Close popover on Escape
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      els.settingsPopover?.classList.contains("is-open")
    ) {
      closeSettingsPopover();
    }
  });

  bindShellChannel();
  bindServiceWorkerMessages();
  setPhpInfoContent("");
  phpInfoCapturePromise = null;
  setUiLocked(true);
  await updateFrame();
}

els.home.addEventListener("click", () => {
  navigateWithinRuntime("/");
});

els.refresh.addEventListener("click", () => {
  navigateWithinRuntime(currentPath);
});

els.panelToggle.addEventListener("click", toggleSidePanel);
els.infoTab.addEventListener("click", () => setActivePanel("info"));
els.logsTab.addEventListener("click", () => setActivePanel("logs"));
els.phpInfoTab.addEventListener("click", () => {
  setActivePanel("phpinfo");
  capturePhpInfoViaWorker("tab-click");
});
els.blueprintTab.addEventListener("click", () => setActivePanel("blueprint"));
els.clearLogs.addEventListener("click", () => {
  els.logPanel.textContent = "";
});
els.copyLogs.addEventListener("click", () => {
  const text = els.logPanel.textContent || "";
  navigator.clipboard.writeText(text).then(() => {
    const original = els.copyLogs.textContent;
    els.copyLogs.textContent = "Copied!";
    setTimeout(() => {
      els.copyLogs.textContent = original;
    }, 1200);
  });
});
els.refreshPhpInfoButton.addEventListener("click", requestPhpInfoCapture);

els.addressForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (uiLocked) {
    return;
  }
  navigateWithinRuntime(els.address.value || "/");
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

els.reset.addEventListener("click", async () => {
  if (uiLocked) {
    return;
  }
  clearScopeSession(scopeId);
  // Clear the imported blueprint unless it was supplied via URL parameter,
  // so a plain reset boots without any previously loaded blueprint.
  const url = new URL(window.location.href);
  if (
    !url.searchParams.has("blueprint") &&
    !url.searchParams.has("blueprint-url")
  ) {
    clearBlueprint(scopeId);
    activeBlueprint = await resolveBlueprint({
      scopeId,
      location: window.location,
      defaultBlueprintUrl: config.defaultBlueprintUrl,
    });
    updateBlueprintTextarea();
  }
  currentPath = activeBlueprint?.landingPage || config.landingPath || "/";
  els.address.value = currentPath;
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
