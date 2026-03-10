import {
  DEFAULT_BOOT_OPTIONS,
  MOODLE_BASE_PATH,
  OPTIONAL_EXTENSION_NOTES,
  PHP_WORKER_URL,
  SERVICE_WORKER_URL,
} from "./lib/constants.js";

const ENABLE_DIRECT_PHP_PROBE = false;
const phpWorker = new Worker(new URL(PHP_WORKER_URL, window.location.href), { type: "module" });
const pendingWorkerCalls = new Map();

const elements = {
  log: document.querySelector("#log"),
  openButton: document.querySelector("#open-button"),
  phase: document.querySelector("#phase"),
  previewCaption: document.querySelector("#preview-caption"),
  previewFrame: document.querySelector("#preview-frame"),
  progress: document.querySelector("#progress"),
  runtimePill: document.querySelector("#runtime-pill"),
  startButton: document.querySelector("#start-button"),
  statusText: document.querySelector("#status-text"),
};

function appendLog(message, level = "info") {
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

  if (level === "error") {
    line.className = "error";
  }

  elements.log.append(line);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function formatError(error) {
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

function setPhase(phase, text) {
  elements.phase.textContent = phase;
  elements.statusText.textContent = text;
}

function setProgress(value) {
  elements.progress.value = Math.max(0, Math.min(1, value));
}

function setRuntimePill(label, isError = false) {
  elements.runtimePill.textContent = label;
  elements.runtimePill.classList.toggle("error", isError);
}

function setReady(entryUrl) {
  const href = new URL(entryUrl, window.location.origin).toString();
  elements.openButton.href = href;
  elements.openButton.setAttribute("aria-disabled", "false");
  elements.previewFrame.src = href;
  elements.previewCaption.textContent = `Previewing ${href}`;
  elements.startButton.disabled = false;
  setRuntimePill("Ready");
}

function monitorWorker(registration) {
  const worker = registration.installing || registration.waiting || registration.active;

  if (!worker) {
    appendLog("Service Worker registered without an installing worker yet.");
    return;
  }

  appendLog(`Service Worker state: ${worker.state}`);
  worker.addEventListener("statechange", () => {
    appendLog(`Service Worker state: ${worker.state}`);

    if (worker.state === "redundant") {
      setRuntimePill("Error", true);
      setPhase("error", "Service Worker became redundant.");
    }
  });
}

function handleWorkerMessage(event) {
  const { data } = event;

  if (!data || typeof data !== "object") {
    return;
  }

  if (data.kind === "rpc-result" && pendingWorkerCalls.has(data.id)) {
    const { resolve } = pendingWorkerCalls.get(data.id);
    pendingWorkerCalls.delete(data.id);
    resolve(data.result);
    return;
  }

  if (data.kind === "rpc-error" && pendingWorkerCalls.has(data.id)) {
    const { reject } = pendingWorkerCalls.get(data.id);
    pendingWorkerCalls.delete(data.id);
    reject(new Error(formatError(data.error)));
    return;
  }

  if (data.kind === "bootstrap-progress") {
    setPhase(data.phase, data.detail);
    setProgress(typeof data.progress === "number" ? data.progress : 0);
    appendLog(data.detail);
    return;
  }

  if (data.kind === "bootstrap-ready") {
    setPhase("ready", "Moodle bootstrap completed.");
    setProgress(1);
    setReady(data.entryUrl);
    appendLog(`Bootstrap ready. Entry URL: ${data.entryUrl}`);
    if (data.manifest?.release) {
      appendLog(`Resolved Moodle release ${data.manifest.release} from ${data.sourceKind}.`);
    } else {
      appendLog(`Bootstrap source: ${data.sourceKind || "unknown"}.`);
    }

    for (const note of data.notes || OPTIONAL_EXTENSION_NOTES) {
      appendLog(note);
    }

    return;
  }

  if (data.kind === "bootstrap-error") {
    elements.startButton.disabled = false;
    setRuntimePill("Error", true);
    setPhase("error", "Bootstrap failed.");
    appendLog(data.error, "error");
  }
}

phpWorker.addEventListener("message", handleWorkerMessage);
navigator.serviceWorker?.addEventListener("message", (event) => {
  const data = event.data;

  if (!data || data.kind !== "php-response-debug") {
    return;
  }

  appendLog(`PHP response ${data.status} for ${data.url}`, data.status >= 500 ? "error" : "info");

  if (data.body) {
    appendLog(data.body.slice(0, 4000), data.status >= 500 ? "error" : "info");
  }
});

function callPhpWorker(action, params = null) {
  const id = window.crypto.randomUUID();

  return new Promise((resolve, reject) => {
    pendingWorkerCalls.set(id, { resolve, reject });
    phpWorker.postMessage({ id, action, params });
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support Service Workers.");
  }

  const registrations = await navigator.serviceWorker.getRegistrations();

  for (const existing of registrations) {
    if (!existing.active?.scriptURL?.includes("/sw.js")) {
      continue;
    }

    appendLog(`Unregistering previous Service Worker: ${existing.scope}`);
    await existing.unregister();
  }

  const swUrl = new URL(SERVICE_WORKER_URL, window.location.href);
  swUrl.searchParams.set("ts", String(Date.now()));

  const registration = await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    type: "module",
    updateViaCache: "none",
  });

  monitorWorker(registration);
  appendLog(`Service Worker ready: ${registration.scope}`);
  return registration;
}

async function maybeRunProbe() {
  if (!ENABLE_DIRECT_PHP_PROBE) {
    return;
  }

  appendLog("Running optional direct PhpWeb probe.");
  const { createDirectProbe } = await import("./lib/php-runtime.js");
  const probe = await createDirectProbe();
  appendLog(probe.output.trim());
}

async function bootstrapMoodle() {
  const origin = window.location.origin;

  elements.startButton.disabled = true;
  elements.openButton.setAttribute("aria-disabled", "true");
  elements.previewFrame.removeAttribute("src");

  setRuntimePill("Bootstrapping");
  setPhase("bootstrap", "Requesting Moodle bootstrap in the dedicated PHP worker.");
  setProgress(0.01);
  appendLog("Bootstrapping Moodle.");

  const result = await callPhpWorker("bootstrapMoodle", {
    ...DEFAULT_BOOT_OPTIONS,
    origin,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });

  if (!result?.ok) {
    elements.startButton.disabled = false;
    throw new Error(result?.message || "Bootstrap failed.");
  }

  setReady(result.entryUrl || `${MOODLE_BASE_PATH}/install.php`);
}

async function restoreWorkerState() {
  const state = await callPhpWorker("getBootState");

  if (state?.ready) {
    setPhase("ready", "Moodle was already bootstrapped in the active worker.");
    setProgress(1);
    setReady(state.entryUrl);
    appendLog(`Existing worker state restored: ${state.entryUrl}`);
    return true;
  }

  return false;
}

async function main() {
  setPhase("startup", "Registering Service Worker.");
  setRuntimePill("Starting");
  appendLog("Moodle Playground boot sequence started.");

  await registerServiceWorker();
  await maybeRunProbe();
  setPhase("idle", "Ready to resolve the Moodle manifest and mount the cached bundle into the PHP VFS.");
  setProgress(0);
  setRuntimePill("Idle");
  appendLog("Service Worker re-registered for this session.");
  appendLog("PHP runtime moved to a dedicated worker for compatibility.");
  appendLog("Click Bootstrap Moodle to fetch the manifest and mount the Moodle bundle.");

  elements.startButton.addEventListener("click", async () => {
    try {
      await bootstrapMoodle();
    } catch (error) {
      elements.startButton.disabled = false;
      setRuntimePill("Error", true);
      setPhase("error", "Bootstrap failed.");
      appendLog(formatError(error), "error");
    }
  });
}

main().catch((error) => {
  setRuntimePill("Fatal", true);
  setPhase("fatal", "The app failed to start.");
  appendLog(formatError(error), "error");
});
