import { loadBlueprint } from "../blueprint/index.js";
import { getDefaultRuntime, loadPlaygroundConfig } from "../shared/config.js";
import { buildScopedSitePath } from "../shared/paths.js";
import { createShellChannel } from "../shared/protocol.js";
import { registerVersionedServiceWorker } from "../shared/service-worker-version.js";
import { saveSessionState } from "../shared/storage.js";
import { parseRuntimeId } from "../shared/version-resolver.js";

const overlayEl = document.querySelector(".remote-boot__card");
const titleEl = document.querySelector("#remote-title");
const statusEl = document.querySelector("#remote-status");
const progressFillEl = document.querySelector("#progress-fill");
const progressPercentEl = document.querySelector("#progress-percent");
const frameEl = document.querySelector("#remote-frame");
const SW_RESET_KEY_PREFIX = "moodle-playground:sw-reset";
const CONTROL_RELOAD_KEY_PREFIX = "moodle-playground:remote-sw-controlled";
let phpWorker;
let activePath = "/";
let frameWatchTimer = 0;
let lastAnnouncedFrameHref = "";
let frameRecoveryTimer = 0;
let frameRecoveryAttempted = false;
let dotsTimer = 0;
let dotsCount = 0;

function startDotsAnimation() {
  if (dotsTimer) return;
  if (titleEl && !titleEl.querySelector(".dots")) {
    titleEl.innerHTML = `Preparing Moodle Playground<span class="dots"><span>.</span><span>.</span><span>.</span></span>`;
  }
  const dots = titleEl?.querySelectorAll(".dots span");
  if (!dots?.length) return;
  dotsTimer = setInterval(() => {
    dotsCount = (dotsCount + 1) % 4;
    dots.forEach((dot, i) => {
      dot.style.visibility = i < dotsCount ? "visible" : "hidden";
    });
  }, 400);
}

function stopDotsAnimation() {
  if (dotsTimer) {
    clearInterval(dotsTimer);
    dotsTimer = 0;
  }
}

function cleanProgressDetail(detail) {
  if (!detail) return "";
  // Strip leading timing like "[1234ms] " or "[1234ms config] "
  // and trailing timing like " [350ms]"
  return detail
    .replace(/^\[\d+ms[^\]]*\]\s*/u, "")
    .replace(/\s*\[\d+ms\]\s*$/u, "")
    .trim();
}

function normalizeScopeFragment(value) {
  return String(value || "").replace(/[^A-Za-z0-9_]/gu, "_");
}

function setOverlayVisible(isVisible) {
  overlayEl?.classList.toggle("is-hidden", !isVisible);
  if (isVisible) {
    startDotsAnimation();
  } else {
    stopDotsAnimation();
  }
}

function setRemoteProgress(detail, progress) {
  if (statusEl && detail) {
    statusEl.textContent = cleanProgressDetail(detail);
  }
  if (typeof progress === "number") {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (progressFillEl) {
      progressFillEl.style.width = `${pct}%`;
    }
    if (progressPercentEl) {
      progressPercentEl.textContent = `${pct}%`;
    }
  }
}

function emit(scopeId, message) {
  if (message?.kind === "progress") {
    setRemoteProgress(message.detail, message.progress);
  }
  if (message?.kind === "error") {
    setRemoteProgress(message.detail);
  }

  const channel = new BroadcastChannel(createShellChannel(scopeId));
  channel.postMessage(message);
  channel.close();
}

async function registerRuntimeServiceWorker() {
  const registration = await registerVersionedServiceWorker(
    new URL("../../sw.js", import.meta.url),
    {
      scope: "./",
    },
  );
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

async function resetOpfsStorage() {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("moodle-persist", { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function resetRuntimeIndexedDb({
  scopeId,
  runtimeId,
  includePersistentOverlay = false,
}) {
  let cleared = false;

  // Clear OPFS persistent storage (used by @php-wasm/web mount handler)
  if (includePersistentOverlay) {
    const opfsCleared = await resetOpfsStorage();
    cleared = cleared || opfsCleared;
  }

  // Also clear any legacy IndexedDB databases
  if (!indexedDB.databases) {
    return cleared;
  }

  const scopeFragment = normalizeScopeFragment(scopeId);
  const runtimeFragment = normalizeScopeFragment(runtimeId);
  const runtimeStorageMarkers = [
    `moodle_${scopeFragment}_${runtimeFragment}`,
    `${scopeFragment}_${runtimeFragment}`,
  ];
  const dbs = await indexedDB.databases();

  for (const db of dbs) {
    const name = db?.name || "";
    if (!name) {
      continue;
    }

    const isCurrentRuntimeDb = runtimeStorageMarkers.some((fragment) =>
      name.includes(fragment),
    );
    const isPersistentOverlay =
      includePersistentOverlay && (name === "/persist" || name === "/config");

    if (!isCurrentRuntimeDb && !isPersistentOverlay) {
      continue;
    }

    await deleteIndexedDbDatabase(name);
    cleared = true;
  }

  return cleared;
}

async function resetRuntimeStorage({
  scopeId,
  runtimeId,
  includePersistentOverlay = false,
  resetNonce = "",
} = {}) {
  const resetKey = `${SW_RESET_KEY_PREFIX}:${scopeId}:${runtimeId}:${includePersistentOverlay ? "full" : "soft"}:${resetNonce}`;
  if (window.sessionStorage.getItem(resetKey) === "1") {
    return false;
  }

  let cleared = false;

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

      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          window.clearTimeout(timeoutId);
          resolve();
        },
        { once: true },
      );
    });
  }
}

function ensureRemoteServiceWorkerControl(scopeId, runtimeId) {
  if (navigator.serviceWorker.controller) {
    window.sessionStorage.removeItem(
      `${CONTROL_RELOAD_KEY_PREFIX}:${scopeId}:${runtimeId}`,
    );
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
      reject(
        new Error(
          `Timed out while waiting for php-worker readiness for ${runtimeId}.`,
        ),
      );
    }, 15000);

    const onWorkerMessage = (event) => {
      const message = event.data;
      if (message?.kind === "worker-startup-error") {
        window.clearTimeout(timeoutId);
        worker.removeEventListener("message", onWorkerMessage);
        reject(
          new Error(message.detail || "php-worker failed during startup."),
        );
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
  return new URL(
    buildScopedSitePath(scopeId, runtimeId, path),
    window.location.origin,
  );
}

function finalizeFrameReady(scopeId, runtimeId) {
  let path = activePath;
  let href = buildEntryUrl(scopeId, runtimeId, path).toString();
  let frameDocument = null;

  try {
    const frameWindow = frameEl.contentWindow;
    const currentHref = frameWindow?.location?.href;
    if (!currentHref || currentHref === "about:blank") {
      return false;
    }
    frameDocument = frameWindow?.document || null;
    if (!frameDocument?.body || isFrameDocumentStalled()) {
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

    if (
      !frameWindow.location.href ||
      frameWindow.location.href === "about:blank"
    ) {
      return false;
    }

    const bodyHtml = frameDocument.body?.innerHTML || "";
    return (
      frameDocument.readyState === "loading" &&
      bodyHtml.trim() === "" &&
      Boolean(frameDocument.title)
    );
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

function navigateFrame(
  scopeId,
  runtimeId,
  path,
  { reload = false, force = false } = {},
) {
  const entryUrl = buildEntryUrl(scopeId, runtimeId, path);
  const entryHref = entryUrl.toString();

  clearFrameRecoveryTimer();
  frameRecoveryAttempted = false;
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
  const resetNonce = url.searchParams.get("reload") || "";
  const phpVersion = url.searchParams.get("phpVersion") || null;
  const moodleBranch = url.searchParams.get("moodleBranch") || null;
  activePath = requestedPath;
  const config = await loadPlaygroundConfig();
  const blueprint = loadBlueprint(scopeId);
  let runtime = config.runtimes.find(
    (entry) => entry.id === requestedRuntimeId,
  );
  if (!runtime) {
    const parsed = parseRuntimeId(requestedRuntimeId);
    if (parsed) {
      runtime = config.runtimes.find((entry) => {
        const entryParsed = parseRuntimeId(entry.id);
        return (
          entryParsed &&
          entryParsed.phpVersion === parsed.phpVersion &&
          entryParsed.moodleBranch === parsed.moodleBranch
        );
      });
    }
    if (!runtime) {
      runtime = getDefaultRuntime(config);
    }
  }
  setOverlayVisible(true);

  if (
    await resetRuntimeStorage({
      scopeId,
      runtimeId: runtime.id,
      includePersistentOverlay: cleanBoot,
      resetNonce,
    })
  ) {
    window.location.reload();
    return;
  }

  emit(scopeId, {
    kind: "progress",
    title: "Preparing runtime",
    detail: `Registering service worker for ${runtime.label}.`,
    progress: 0.08,
  });

  await registerRuntimeServiceWorker();
  if (ensureRemoteServiceWorkerControl(scopeId, runtime.id)) {
    return;
  }
  await waitForServiceWorkerControl();
  setRemoteProgress("Service Worker ready and controlling this tab.");

  if (!phpWorker) {
    const workerUrl = new URL(
      "../../dist/php-worker.bundle.js",
      import.meta.url,
    );
    workerUrl.searchParams.set("scope", scopeId);
    workerUrl.searchParams.set("runtime", runtime.id);
    if (phpVersion) {
      workerUrl.searchParams.set("phpVersion", phpVersion);
    }
    if (moodleBranch) {
      workerUrl.searchParams.set("moodleBranch", moodleBranch);
    }
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
  // Listen to the shell channel so we can pick up bootstrap progress
  // messages from the worker and display them on the loading overlay.
  let readyNavigated = false;
  const shellChannel = new BroadcastChannel(createShellChannel(scopeId));
  shellChannel.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.kind === "progress") {
      setRemoteProgress(msg.detail, msg.progress);
    }
    if (msg?.kind === "error") {
      setRemoteProgress(msg.detail);
    }
    if (msg?.kind === "ready") {
      setRemoteProgress(msg.detail, 1);
      // If bootstrap returns a readyPath (e.g. "/my/" after auto-login),
      // override the stale path from the URL so we don't navigate to
      // a previous session's install.php or other outdated path.
      if (msg.path && msg.path !== activePath) {
        activePath = msg.path;
        readyNavigated = true;
        navigateFrame(scopeId, runtime.id, activePath, { force: true });
      }
    }
  });

  const workerReadyPromise = waitForPhpWorkerReady(
    scopeId,
    runtime.id,
    phpWorker,
  );
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
  // Navigate to the requested path only if the ready handler hasn't
  // already navigated to a fresh readyPath from bootstrap. This avoids
  // a wasted PHP request to a stale path from a previous session.
  if (!readyNavigated) {
    navigateFrame(scopeId, runtime.id, activePath);
  }
  setRemoteProgress("Loading Moodle…", 0.98);
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
