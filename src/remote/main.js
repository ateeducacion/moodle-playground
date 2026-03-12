import { loadActiveBlueprint } from "../shared/blueprint.js";
import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { buildScopedSitePath } from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import { saveSessionState } from "../shared/storage.js";

const overlayEl = document.querySelector(".remote-boot__card");
const statusEl = document.querySelector("#remote-status");
const frameEl = document.querySelector("#remote-frame");
const SW_RESET_KEY_PREFIX = "moodle-playground:sw-reset";
const CONTROL_RELOAD_KEY_PREFIX = "moodle-playground:remote-sw-controlled";
let phpWorker;
let activePath = "/";
let frameWatchTimer = 0;
let lastAnnouncedFrameHref = "";
let frameRecoveryTimer = 0;
let frameRecoveryAttempted = false;

function normalizeScopeFragment(value) {
  return String(value || "").replace(/[^A-Za-z0-9_]/gu, "_");
}

function setOverlayVisible(isVisible) {
  overlayEl?.classList.toggle("is-hidden", !isVisible);
}

function setRemoteProgress(detail) {
  if (statusEl && detail) {
    statusEl.textContent = detail;
  }
}

function emit(scopeId, message) {
  if (message?.kind === "progress") {
    setRemoteProgress(message.detail);
  }
  if (message?.kind === "error") {
    setRemoteProgress(message.detail);
  }

  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

function buildServiceWorkerVersionToken(bundleVersion, scopeId, runtimeId) {
  const currentUrl = new URL(window.location.href);
  if (currentUrl.searchParams.get("clean") === "1") {
    return `${bundleVersion}:${scopeId}:${runtimeId}:${Date.now()}`;
  }

  return bundleVersion;
}

async function registerRuntimeServiceWorker(scopeId, runtimeId, config) {
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready;
  }

  const swUrl = new URL("../../sw.js", import.meta.url);
  swUrl.searchParams.set("v", buildServiceWorkerVersionToken(config.bundleVersion, scopeId, runtimeId));
  swUrl.searchParams.set("scope", scopeId);
  swUrl.searchParams.set("runtime", runtimeId);

  const registration = await navigator.serviceWorker.register(swUrl, {
    scope: "./",
    type: "module",
    updateViaCache: "none",
  });

  await navigator.serviceWorker.ready;
  return registration;
}

async function deleteIndexedDbDatabase(name) {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function resetRuntimeIndexedDb({ scopeId, runtimeId, includePersistentOverlay = false }) {
  if (!indexedDB.databases) {
    return false;
  }

  const scopeFragment = normalizeScopeFragment(scopeId);
  const runtimeFragment = normalizeScopeFragment(runtimeId);
  const runtimeStorageMarkers = [
    `moodle_${scopeFragment}_${runtimeFragment}`,
    `${scopeFragment}_${runtimeFragment}`,
  ];
  const dbs = await indexedDB.databases();
  let cleared = false;

  for (const db of dbs) {
    const name = db?.name || "";
    if (!name) {
      continue;
    }

    const isCurrentRuntimeDb = runtimeStorageMarkers.some((fragment) => name.includes(fragment));
    const isPersistentOverlay = includePersistentOverlay && (name === "/persist" || name === "/config");

    if (!isCurrentRuntimeDb && !isPersistentOverlay) {
      continue;
    }

    await deleteIndexedDbDatabase(name);
    cleared = true;
  }

  return cleared;
}

async function resetRuntimeCaching(bundleVersion, { scopeId, runtimeId, includePersistentOverlay = false } = {}) {
  const resetKey = `${SW_RESET_KEY_PREFIX}:${bundleVersion}:${scopeId}:${runtimeId}:${includePersistentOverlay ? "full" : "soft"}`;
  if (window.sessionStorage.getItem(resetKey) === "1") {
    return false;
  }

  const currentUrl = new URL(window.location.href);
  const scopeBase = `${currentUrl.origin}${new URL("./", currentUrl).pathname}`;
  const registrations = await navigator.serviceWorker.getRegistrations();
  let cleared = false;

  for (const registration of registrations) {
    if (!registration.scope.startsWith(scopeBase)) {
      continue;
    }

    await registration.unregister();
    cleared = true;
  }

  const cacheNames = await caches.keys();
  for (const cacheName of cacheNames) {
    await caches.delete(cacheName);
    cleared = true;
  }

  if (scopeId && runtimeId) {
    const clearedIndexedDb = await resetRuntimeIndexedDb({
      scopeId,
      runtimeId,
      includePersistentOverlay,
    });
    cleared = cleared || clearedIndexedDb;
  }

  window.sessionStorage.setItem(resetKey, "1");
  return cleared;
}

async function waitForServiceWorkerControl() {
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        reject(new Error("Timed out waiting for service worker control."));
      }, 10000);

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.clearTimeout(timeoutId);
        resolve();
      }, { once: true });
    });
  }
}

function ensureRemoteServiceWorkerControl(scopeId, runtimeId) {
  if (navigator.serviceWorker.controller) {
    window.sessionStorage.removeItem(`${CONTROL_RELOAD_KEY_PREFIX}:${scopeId}:${runtimeId}`);
    return false;
  }

  const key = `${CONTROL_RELOAD_KEY_PREFIX}:${scopeId}:${runtimeId}`;
  if (window.sessionStorage.getItem(key) === "1") {
    return false;
  }

  window.sessionStorage.setItem(key, "1");
  window.location.reload();
  return true;
}

async function waitForPhpWorkerReady(scopeId, runtimeId, worker) {
  await new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Timed out while waiting for php-worker readiness for ${runtimeId}.`));
    }, 15000);

    const onWorkerMessage = (event) => {
      const message = event.data;
      if (message?.kind === "worker-startup-error") {
        window.clearTimeout(timeoutId);
        worker.removeEventListener("message", onWorkerMessage);
        reject(new Error(message.detail || "php-worker failed during startup."));
        return;
      }

      if (message?.kind !== "worker-ready") {
        return;
      }

      if (message.scopeId !== scopeId || message.runtimeId !== runtimeId) {
        return;
      }

      window.clearTimeout(timeoutId);
      worker.removeEventListener("message", onWorkerMessage);
      resolve();
    };

    worker.addEventListener("message", onWorkerMessage);
  });
}

function extractUnscopedPath(locationLike, scopeId, runtimeId) {
  const url = new URL(String(locationLike), window.location.origin);
  const match = url.pathname.match(/\/playground\/([^/]+)\/([^/]+)(\/.*)?$/u);
  if (match && match[1] === scopeId && match[2] === runtimeId) {
    return `${match[3] || "/"}${url.search}${url.hash}`;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function emitNavigation(scopeId, runtimeId, href) {
  emit(scopeId, {
    kind: "navigate",
    path: extractUnscopedPath(href, scopeId, runtimeId),
  });
}

function buildEntryUrl(scopeId, runtimeId, path) {
  return new URL(buildScopedSitePath(scopeId, runtimeId, path), window.location.origin);
}

function finalizeFrameReady(scopeId, runtimeId) {
  let path = activePath;
  let href = buildEntryUrl(scopeId, runtimeId, path).toString();

  try {
    const currentHref = frameEl.contentWindow?.location?.href;
    if (!currentHref || currentHref === "about:blank") {
      return false;
    }
    href = currentHref;
    path = extractUnscopedPath(href, scopeId, runtimeId);
  } catch {
    return false;
  }

  activePath = path;
  setOverlayVisible(false);

  if (href !== lastAnnouncedFrameHref) {
    lastAnnouncedFrameHref = href;
    emit(scopeId, {
      kind: "frame-ready",
      detail: `Iframe loaded for ${runtimeId}.`,
      path,
    });
    emitNavigation(scopeId, runtimeId, href);
  }

  return true;
}

function clearFrameRecoveryTimer() {
  if (!frameRecoveryTimer) {
    return;
  }

  window.clearTimeout(frameRecoveryTimer);
  frameRecoveryTimer = 0;
}

function isFrameDocumentStalled() {
  try {
    const frameWindow = frameEl.contentWindow;
    const frameDocument = frameWindow?.document;
    if (!frameWindow || !frameDocument) {
      return false;
    }

    if (!frameWindow.location.href || frameWindow.location.href === "about:blank") {
      return false;
    }

    const bodyHtml = frameDocument.body?.innerHTML || "";
    return frameDocument.readyState === "loading" && bodyHtml.trim() === "" && Boolean(frameDocument.title);
  } catch {
    return false;
  }
}

function scheduleFrameRecovery(scopeId, runtimeId) {
  clearFrameRecoveryTimer();
  frameRecoveryTimer = window.setTimeout(() => {
    frameRecoveryTimer = 0;

    if (frameRecoveryAttempted || !isFrameDocumentStalled()) {
      return;
    }

    frameRecoveryAttempted = true;
    setRemoteProgress("Recovering a stalled Moodle page load.");
    navigateFrame(scopeId, runtimeId, activePath || "/", { force: true });
  }, 4000);
}

function startFrameWatch(scopeId, runtimeId) {
  if (frameWatchTimer) {
    window.clearInterval(frameWatchTimer);
  }

  scheduleFrameRecovery(scopeId, runtimeId);
  frameWatchTimer = window.setInterval(() => {
    if (finalizeFrameReady(scopeId, runtimeId)) {
      window.clearInterval(frameWatchTimer);
      frameWatchTimer = 0;
    }
  }, 150);
}

function navigateFrame(scopeId, runtimeId, path, { reload = false, force = false } = {}) {
  const entryUrl = buildEntryUrl(scopeId, runtimeId, path);
  const entryHref = entryUrl.toString();

  clearFrameRecoveryTimer();
  activePath = path;
  if (force) {
    lastAnnouncedFrameHref = "";
  }
  setOverlayVisible(true);
  startFrameWatch(scopeId, runtimeId);

  if (reload && frameEl.contentWindow) {
    frameEl.contentWindow.location.reload();
    return;
  }

  if (!force && frameEl.src === entryHref) {
    return;
  }

  if (frameEl.src !== entryHref) {
    frameEl.src = entryHref;
  } else if (frameEl.contentWindow) {
    frameEl.contentWindow.location.href = entryHref;
  }
}

function bindFrameNavigation(scopeId, runtimeId) {
  frameEl.addEventListener("load", () => {
    finalizeFrameReady(scopeId, runtimeId);
  });
}

function bindShellCommands(scopeId, runtimeId) {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    const message = event.data;
    if (message?.kind === "navigate-site") {
      navigateFrame(scopeId, runtimeId, message.path || "/");
      return;
    }

    if (message?.kind === "refresh-site") {
      navigateFrame(scopeId, runtimeId, activePath || "/", { reload: true });
      return;
    }

    if (message?.kind === "capture-phpinfo") {
      phpWorker?.postMessage({
        kind: "capture-phpinfo",
        scopeId,
        runtimeId,
      });
    }
  });
}

async function bootstrapRemote() {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  const requestedRuntimeId = url.searchParams.get("runtime");
  const requestedPath = url.searchParams.get("path") || "/";
  const cleanBoot = url.searchParams.get("clean") === "1";
  activePath = requestedPath;
  const config = await loadPlaygroundConfig();
  const blueprint = loadActiveBlueprint(scopeId);
  const runtime = config.runtimes.find((entry) => entry.id === requestedRuntimeId) || getDefaultRuntime(config);
  setOverlayVisible(true);

  if (await resetRuntimeCaching(config.bundleVersion, {
    scopeId,
    runtimeId: runtime.id,
    includePersistentOverlay: cleanBoot,
  })) {
    window.location.reload();
    return;
  }

  emit(scopeId, {
    kind: "progress",
    title: "Preparing runtime",
    detail: `Registering service worker for ${runtime.label}.`,
    progress: 0.08,
  });

  await registerRuntimeServiceWorker(scopeId, runtime.id, config);
  if (ensureRemoteServiceWorkerControl(scopeId, runtime.id)) {
    return;
  }
  await waitForServiceWorkerControl();
  setRemoteProgress("Service Worker ready and controlling this tab.");

  if (!phpWorker) {
    const workerUrl = new URL("../../php-worker.js", import.meta.url);
    workerUrl.searchParams.set("scope", scopeId);
    workerUrl.searchParams.set("runtime", runtime.id);
    phpWorker = new Worker(workerUrl, { type: "module" });
    phpWorker.addEventListener("error", (event) => {
      const parts = [
        event.message || "php-worker failed before signalling readiness.",
        event.filename ? `file=${event.filename}` : "",
        event.lineno ? `line=${event.lineno}` : "",
        event.colno ? `col=${event.colno}` : "",
      ].filter(Boolean);
      const detail = parts.join(" | ");
      setRemoteProgress(detail);
      emit(scopeId, {
        kind: "error",
        detail,
      });
    });
  }
  const workerReadyPromise = waitForPhpWorkerReady(scopeId, runtime.id, phpWorker);
  phpWorker.postMessage({
    kind: "configure-blueprint",
    blueprint,
  });
  await workerReadyPromise;

  saveSessionState(scopeId, {
    runtimeId: runtime.id,
    path: requestedPath,
  });

  bindShellCommands(scopeId, runtime.id);
  bindFrameNavigation(scopeId, runtime.id);
  navigateFrame(scopeId, runtime.id, requestedPath);
  setRemoteProgress("Runtime host registered. Waiting for the PHP worker to finish bootstrap.");

  emit(scopeId, {
    kind: "progress",
    title: "Runtime host ready",
    detail: "The embedded Moodle iframe is loading.",
    progress: 0.18,
  });
}

bootstrapRemote().catch((error) => {
  const url = new URL(window.location.href);
  const scopeId = url.searchParams.get("scope");
  setOverlayVisible(true);
  setRemoteProgress(String(error?.message || error));
  emit(scopeId, {
    kind: "error",
    detail: String(error?.stack || error?.message || error),
  });
});
