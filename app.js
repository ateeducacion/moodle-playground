import {
  DEFAULT_BOOT_OPTIONS,
  MOODLE_BASE_PATH,
  OPTIONAL_EXTENSION_NOTES,
  SERVICE_WORKER_URL,
} from "./lib/constants.js";
import { createDirectProbe } from "./lib/php-runtime.js";
import { onMessage, sendMessageFor } from "./lib/runtime-imports.js";

const ENABLE_DIRECT_PHP_PROBE = false;

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

function handleWorkerMessage(event) {
  onMessage(event);

  const { data } = event;

  if (!data || typeof data !== "object") {
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
    appendLog(
      `Bootstrap ready. Entry URL: ${data.entryUrl} (version=${data.moodleVersion}, manifest=${data.moodleManifestUrl}, bundle=${data.moodleBundleUrl}, script=${data.resolvedScriptPath})`,
    );

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

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("This browser does not support Service Workers.");
  }

  navigator.serviceWorker.addEventListener("message", handleWorkerMessage);
  navigator.serviceWorker.startMessages?.();

  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
    scope: "./",
    type: "module",
  });

  await navigator.serviceWorker.ready;

  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  }

  appendLog(`Service Worker ready: ${registration.scope}`);
  return registration;
}

async function maybeRunProbe() {
  if (!ENABLE_DIRECT_PHP_PROBE) {
    return;
  }

  appendLog("Running optional direct PhpWeb probe.");
  const probe = await createDirectProbe();
  appendLog(probe.output.trim());
}

async function bootstrapMoodle() {
  const sendMessage = sendMessageFor(SERVICE_WORKER_URL);
  const origin = window.location.origin;

  elements.startButton.disabled = true;
  elements.openButton.setAttribute("aria-disabled", "true");
  elements.previewFrame.removeAttribute("src");

  setRuntimePill("Bootstrapping");
  setPhase("bootstrap", "Requesting Moodle bootstrap in the Service Worker.");
  setProgress(0.01);
  appendLog("Bootstrapping Moodle.");

  const result = await sendMessage("bootstrapMoodle", [
    {
      ...DEFAULT_BOOT_OPTIONS,
      origin,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  ]);

  if (!result?.ok) {
    elements.startButton.disabled = false;
    throw new Error(result?.message || "Bootstrap failed.");
  }

  appendLog(
    `Worker resolved version=${result.moodleVersion} using ${result.moodleManifestUrl} and ${result.moodleBundleUrl} at ${result.resolvedScriptPath}`,
  );
  setReady(result.entryUrl || `${MOODLE_BASE_PATH}/install.php`);
}

async function restoreWorkerState() {
  const sendMessage = sendMessageFor(SERVICE_WORKER_URL);
  const state = await sendMessage("getBootState", []);

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

  const restored = await restoreWorkerState();

  if (!restored) {
    setPhase("idle", "Ready to download Moodle and mount it into the PHP VFS.");
    setProgress(0);
    setRuntimePill("Idle");
    appendLog("Click Bootstrap Moodle to start the first install.");
  }

  elements.startButton.addEventListener("click", async () => {
    try {
      await bootstrapMoodle();
    } catch (error) {
      elements.startButton.disabled = false;
      setRuntimePill("Error", true);
      setPhase("error", "Bootstrap failed.");
      appendLog(String(error?.stack || error?.message || error), "error");
    }
  });
}

main().catch((error) => {
  setRuntimePill("Fatal", true);
  setPhase("fatal", "The app failed to start.");
  appendLog(String(error?.stack || error?.message || error), "error");
});
