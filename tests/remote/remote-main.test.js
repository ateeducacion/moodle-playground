import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import { createShellChannel } from "../../src/shared/protocol.js";

// src/remote/main.js boots on import, so every scenario installs a fresh
// happy-dom window plus browser-boundary fakes (Service Worker, Web Locks,
// BroadcastChannel, Worker, IndexedDB, fetch) and imports a cache-busted copy.

const REMOTE_HTML = readFileSync(
  new URL("../../remote.html", import.meta.url),
  "utf8",
);
const PLAYGROUND_CONFIG = JSON.parse(
  readFileSync(
    new URL("../../playground.config.json", import.meta.url),
    "utf8",
  ),
);
const RUNTIME_ID = "php83-moodle53";
const ORIGIN = "http://localhost:8080";
const DEFAULT_BLUEPRINT = { steps: [{ step: "login" }] };

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "indexedDB",
  "BroadcastChannel",
  "Worker",
  "fetch",
  "setInterval",
  "clearInterval",
];
const savedGlobals = Object.fromEntries(
  GLOBAL_KEYS.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);

let importCounter = 0;
let activeHarness = null;

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const schedule = (fn, ms, repeat) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + (ms || 0), every: repeat ? ms : 0 });
    return id;
  };
  const clear = (id) => timers.delete(id);
  return {
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearTimeout: clear,
    clearInterval: clear,
    pending: () => timers.size,
    tick(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!due || timer.at < due[1].at)) {
            due = [id, timer];
          }
        }
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every) {
          timer.at = now + timer.every;
        } else {
          timers.delete(id);
        }
        timer.fn();
      }
      now = target;
    },
  };
}

async function flush(turns = 30) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createHarness({
  params = {},
  controller = true,
  serviceWorker = "default",
  lockAvailable = true,
  databases = [],
  opfs = "ok",
  configResponse = null,
  blueprintResponse = { ok: true, body: DEFAULT_BLUEPRINT },
  sessionItems = {},
} = {}) {
  const clock = createClock();
  const search = new URLSearchParams({
    scope: "s1",
    runtime: RUNTIME_ID,
    path: "/",
    instance: "inst-1",
    ...params,
  });
  const win = new Window({
    url: `${ORIGIN}/remote.html?${search}`,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
  win.document.write(REMOTE_HTML);
  for (const [key, value] of Object.entries(sessionItems)) {
    win.sessionStorage.setItem(key, value);
  }
  win.setTimeout = clock.setTimeout;
  win.clearTimeout = clock.clearTimeout;
  win.setInterval = clock.setInterval;
  win.clearInterval = clock.clearInterval;

  const reloads = [];
  Object.defineProperty(win.location, "reload", {
    configurable: true,
    value: () => reloads.push(win.location.href),
  });

  const frameEl = win.document.querySelector("#remote-frame");
  const frame = { window: null };
  Object.defineProperty(frameEl, "contentWindow", {
    configurable: true,
    get: () => frame.window,
  });

  // BroadcastChannel fake: delivers to every other open channel of the same name.
  const channels = new Set();
  const broadcasts = [];
  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      channels.add(this);
    }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }
    postMessage(data) {
      broadcasts.push({ name: this.name, data });
      for (const channel of channels) {
        if (channel !== this && channel.name === this.name) {
          for (const listener of channel.listeners) listener({ data });
        }
      }
    }
    close() {
      channels.delete(this);
    }
  }

  const workers = [];
  class FakeWorker {
    constructor(url, options) {
      this.url = new URL(String(url));
      this.options = options;
      this.listeners = { message: [], error: [] };
      this.posted = [];
      this.terminated = false;
      workers.push(this);
    }
    addEventListener(type, listener) {
      this.listeners[type].push(listener);
    }
    removeEventListener(type, listener) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
    postMessage(message) {
      this.posted.push(message);
    }
    terminate() {
      this.terminated = true;
    }
    emit(type, data) {
      for (const listener of [...this.listeners[type]]) listener(data);
    }
  }

  const swListeners = [];
  const controllerMessages = [];
  const registrations = [];
  let swContainer;
  if (serviceWorker !== "missing") {
    swContainer = {
      controller: controller
        ? { postMessage: (message) => controllerMessages.push(message) }
        : null,
      ready: Promise.resolve(),
      register: async (url, options) => {
        registrations.push({ url: String(url), options });
        if (serviceWorker === "reject") throw new Error("SecurityError");
        return { update: async () => {} };
      },
      addEventListener: (type, listener) =>
        swListeners.push({ type, listener }),
    };
  }

  const lockReleases = [];
  const removedOpfsEntries = [];
  const navigatorStub = {
    serviceWorker: swContainer,
    locks: {
      request: async (name, _options, callback) => {
        const result = await callback(lockAvailable ? { name } : null);
        lockReleases.push(name);
        return result;
      },
    },
    storage: {
      getDirectory: async () => {
        if (opfs === "fail") throw new Error("no OPFS");
        return {
          removeEntry: async (name, options) => {
            removedOpfsEntries.push({ name, options });
          },
        };
      },
    },
  };

  const deletedDatabases = [];
  const indexedDBStub = {
    databases: databases === null ? undefined : async () => databases,
    deleteDatabase(name) {
      deletedDatabases.push(name);
      const request = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };

  const fetches = [];
  const fetchStub = async (input) => {
    const url = String(input);
    fetches.push(url);
    if (url.endsWith("playground.config.json")) {
      const response = configResponse || { ok: true, body: PLAYGROUND_CONFIG };
      return {
        ok: response.ok,
        status: response.ok ? 200 : 500,
        json: async () => structuredClone(response.body),
      };
    }
    if (blueprintResponse === "throw") throw new TypeError("offline");
    return {
      ok: blueprintResponse.ok,
      status: blueprintResponse.ok ? 200 : 404,
      json: async () => structuredClone(blueprintResponse.body),
    };
  };

  const install = (key, value) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  install("window", win);
  install("document", win.document);
  install("navigator", navigatorStub);
  install("indexedDB", indexedDBStub);
  install("BroadcastChannel", FakeBroadcastChannel);
  install("Worker", FakeWorker);
  install("fetch", fetchStub);
  // The boot-overlay dots animation uses the global interval API.
  install("setInterval", clock.setInterval);
  install("clearInterval", clock.clearInterval);

  const harness = {
    win,
    clock,
    frame,
    frameEl,
    reloads,
    broadcasts,
    workers,
    swListeners,
    controllerMessages,
    registrations,
    lockReleases,
    removedOpfsEntries,
    deletedDatabases,
    fetches,
    get worker() {
      return workers[0];
    },
    shellMessages: () =>
      broadcasts
        .filter(
          (entry) =>
            entry.name === createShellChannel(search.get("scope"), "inst-1"),
        )
        .map((entry) => entry.data),
    status: () => win.document.querySelector("#remote-status").textContent,
    // Fatal boot errors overwrite the status with the full error stack.
    fatalStatus: () =>
      win.document.querySelector("#remote-status").textContent.split("\n")[0],
    percent: () => win.document.querySelector("#progress-percent").textContent,
    overlayHidden: () =>
      win.document
        .querySelector(".remote-boot__card")
        .classList.contains("is-hidden"),
    // A message from the worker side of the shell channel (progress/ready/…).
    workerBroadcast(data) {
      const channel = new FakeBroadcastChannel(
        createShellChannel(search.get("scope"), "inst-1"),
      );
      channel.postMessage(data);
      channel.close();
    },
    postShellCommand(data, origin = ORIGIN) {
      win.dispatchEvent(new win.MessageEvent("message", { data, origin }));
    },
    async boot() {
      importCounter += 1;
      await import(`../../src/remote/main.js?case=${importCounter}`);
      await flush();
    },
  };
  activeHarness = harness;
  return harness;
}

function setFrameDocument(
  harness,
  { path, readyState = "complete", title = "", body = "<p>ok</p>" },
) {
  const href = path
    ? `${ORIGIN}/playground/s1/${RUNTIME_ID}${path}`
    : "about:blank";
  harness.frame.window = {
    location: { href },
    document: { readyState, title, body: { innerHTML: body } },
  };
}

async function bootUntilWorkerReady(harness, readyMessage = {}) {
  await harness.boot();
  harness.worker.emit("message", {
    data: { kind: "worker-ready", scopeId: "s1", ...readyMessage },
  });
  await flush();
}

afterEach(async () => {
  if (activeHarness) {
    await activeHarness.win.happyDOM.abort();
    await activeHarness.win.happyDOM.close();
    activeHarness = null;
  }
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      delete globalThis[key];
    }
  }
});

after(() => {
  // Defensive: nothing should be left on the real event loop.
  assert.equal(activeHarness, null);
});

describe("remote host boot", () => {
  // Runs first: a failed config fetch is not memoized by loadPlaygroundConfig.
  it("reports a config load failure on the overlay and to the shell", async () => {
    const harness = createHarness({ configResponse: { ok: false } });
    await harness.boot();

    assert.equal(
      harness.fatalStatus(),
      "Error: Unable to load playground config: 500",
    );
    assert.equal(harness.overlayHidden(), false);
    const error = harness.shellMessages().find((m) => m.kind === "error");
    assert.match(error.detail, /Unable to load playground config: 500/u);
    assert.equal(harness.workers.length, 0);
  });

  it("boots the worker, navigates the frame and relays readiness", async () => {
    const harness = createHarness({
      params: {
        phpCorsProxyUrl: "https://proxy.test/?url=",
        addonProxyUrl: "https://addons.test/",
        debug: "true",
        profile: "boot",
        opcache: "0",
      },
    });
    await harness.boot();

    // Default blueprint fetched because sessionStorage had none.
    assert.ok(
      harness.fetches.some((url) =>
        url.endsWith("/assets/blueprints/default.blueprint.json"),
      ),
    );
    assert.deepEqual(harness.controllerMessages, [
      {
        kind: "configure-service-worker",
        addonProxyUrl: "https://addons.test/",
      },
    ]);
    assert.match(harness.registrations[0].url, /sw\.bundle\.js\?build=/u);

    const worker = harness.worker;
    assert.equal(worker.options.type, "module");
    assert.equal(worker.url.searchParams.get("scope"), "s1");
    assert.equal(worker.url.searchParams.get("instance"), "inst-1");
    assert.equal(worker.url.searchParams.get("runtime"), RUNTIME_ID);
    assert.equal(worker.url.searchParams.get("phpVersion"), "8.3");
    assert.equal(
      worker.url.searchParams.get("moodleBranch"),
      "MOODLE_503_STABLE",
    );
    assert.equal(
      worker.url.searchParams.get("phpCorsProxyUrl"),
      "https://proxy.test/?url=",
    );
    assert.equal(worker.url.searchParams.get("debug"), "true");
    assert.equal(worker.url.searchParams.get("profile"), "boot");
    assert.equal(worker.url.searchParams.get("opcache"), "0");

    const [configure] = worker.posted;
    assert.equal(configure.kind, "configure-blueprint");
    assert.deepEqual(configure.blueprint, DEFAULT_BLUEPRINT);
    assert.equal(configure.runtimeParams.forceCleanBoot, false);
    assert.equal(configure.runtimeParams.instanceId, "inst-1");

    const traces = harness
      .shellMessages()
      .filter((m) => m.kind === "trace")
      .map((m) => m.detail);
    assert.ok(
      traces.some((d) => d.startsWith("[runtime-selection][remote:resolved]")),
    );
    assert.ok(
      traces.some((d) =>
        d.startsWith("[runtime-selection][remote:worker-url]"),
      ),
    );

    // Readiness for another scope is ignored; the frame is untouched.
    worker.emit("message", { data: { kind: "progress" } });
    worker.emit("message", {
      data: { kind: "worker-ready", scopeId: "other" },
    });
    await flush();
    assert.equal(harness.frameEl.getAttribute("src"), null);

    worker.emit("message", {
      data: { kind: "worker-ready", scopeId: "s1", initialPath: "/my/" },
    });
    await flush();

    // No explicit path was requested, so the worker's landing hint wins.
    assert.equal(
      harness.frameEl.src,
      `${ORIGIN}/playground/s1/${RUNTIME_ID}/my/`,
    );
    assert.equal(harness.status(), "Loading Moodle…");
    assert.equal(harness.percent(), "98%");
    assert.deepEqual(
      JSON.parse(
        harness.win.sessionStorage.getItem("moodle-playground:s1:state"),
      ),
      { runtimeId: RUNTIME_ID, path: "/" },
    );

    // The frame finishes loading: overlay hides and the shell learns the path.
    setFrameDocument(harness, { path: "/my/?lang=en" });
    harness.frameEl.dispatchEvent(new harness.win.Event("load"));
    assert.equal(harness.overlayHidden(), true);
    const ready = harness
      .shellMessages()
      .filter((m) => m.kind === "frame-ready");
    assert.deepEqual(ready, [
      {
        kind: "frame-ready",
        detail: `Iframe loaded for ${RUNTIME_ID}.`,
        path: "/my/?lang=en",
      },
    ]);
    const navigations = harness
      .shellMessages()
      .filter((m) => m.kind === "navigate");
    assert.deepEqual(navigations.at(-1), {
      kind: "navigate",
      path: "/my/?lang=en",
    });

    // A second load of the same document is not announced twice.
    harness.frameEl.dispatchEvent(new harness.win.Event("load"));
    assert.equal(
      harness.shellMessages().filter((m) => m.kind === "frame-ready").length,
      1,
    );
  });

  it("uses the requested deep link and a session blueprint over the worker hint", async () => {
    const stored = { steps: [{ step: "setSiteOption" }] };
    const harness = createHarness({
      params: { path: "/course/view.php?id=2" },
      sessionItems: {
        "moodle-playground:blueprint:s1": JSON.stringify(stored),
      },
    });
    await bootUntilWorkerReady(harness, { initialPath: "/my/" });

    assert.ok(
      !harness.fetches.some((url) => url.includes("default.blueprint.json")),
    );
    assert.deepEqual(harness.worker.posted[0].blueprint, stored);
    assert.equal(
      harness.frameEl.src,
      `${ORIGIN}/playground/s1/${RUNTIME_ID}/course/view.php?id=2`,
    );
  });

  it("falls back to the configured landing path and tolerates a blueprint fetch failure", async () => {
    const harness = createHarness({ blueprintResponse: "throw" });
    await bootUntilWorkerReady(harness);

    assert.equal(harness.worker.posted[0].blueprint, null);
    assert.equal(
      harness.frameEl.src,
      `${ORIGIN}/playground/s1/${RUNTIME_ID}${PLAYGROUND_CONFIG.landingPath}`,
    );
  });

  it("ignores a non-OK default blueprint response", async () => {
    const harness = createHarness({ blueprintResponse: { ok: false } });
    await bootUntilWorkerReady(harness);
    assert.equal(harness.worker.posted[0].blueprint, null);
  });
});

describe("remote host shell integration", () => {
  it("mirrors worker progress, errors and the authoritative ready path", async () => {
    const harness = createHarness();
    await bootUntilWorkerReady(harness, { initialPath: "/login/index.php" });

    harness.workerBroadcast({
      kind: "progress",
      detail: "[1234ms config] Installing Moodle [350ms]",
      progress: 0.5,
    });
    assert.equal(harness.status(), "Installing Moodle");
    assert.equal(harness.percent(), "50%");
    assert.equal(
      harness.win.document.querySelector("#progress-fill").style.width,
      "50%",
    );

    harness.workerBroadcast({ kind: "progress", progress: 7 });
    assert.equal(harness.percent(), "100%");

    harness.workerBroadcast({ kind: "error", detail: "PHP fatal" });
    assert.equal(harness.status(), "PHP fatal");

    // Ready on the same path: no extra navigation.
    harness.workerBroadcast({
      kind: "ready",
      detail: "Ready",
      path: "/login/index.php",
    });
    assert.equal(harness.status(), "Ready");
    assert.equal(
      harness.frameEl.src,
      `${ORIGIN}/playground/s1/${RUNTIME_ID}/login/index.php`,
    );

    // Ready with a different post-bootstrap path force-navigates the frame.
    harness.workerBroadcast({ kind: "ready", detail: "Ready", path: "/my/" });
    assert.equal(
      harness.frameEl.src,
      `${ORIGIN}/playground/s1/${RUNTIME_ID}/my/`,
    );
    assert.equal(harness.overlayHidden(), false);
  });

  it("handles navigate, refresh, phpinfo and flush commands from the shell", async () => {
    const harness = createHarness();
    await bootUntilWorkerReady(harness, { initialPath: "/my/" });
    const worker = harness.worker;

    harness.postShellCommand(
      { kind: "navigate-site", path: "/admin/" },
      "https://evil.test",
    );
    assert.equal(
      harness.frameEl.src,
      `${ORIGIN}/playground/s1/${RUNTIME_ID}/my/`,
    );

    harness.postShellCommand({ kind: "navigate-site", path: "/admin/" });
    const adminHref = `${ORIGIN}/playground/s1/${RUNTIME_ID}/admin/`;
    assert.equal(harness.frameEl.src, adminHref);

    harness.postShellCommand({ kind: "navigate-site" });
    assert.equal(harness.frameEl.src, `${ORIGIN}/playground/s1/${RUNTIME_ID}/`);
    harness.postShellCommand({ kind: "navigate-site", path: "/admin/" });

    // Navigating to the current URL without force leaves the frame alone.
    setFrameDocument(harness, { path: "/admin/" });
    harness.postShellCommand({ kind: "navigate-site", path: "/admin/" });
    assert.equal(harness.frame.window.location.href, adminHref);

    // Refresh is a forced GET of the active path through the frame window.
    harness.frame.window.location.href = "stale";
    harness.postShellCommand({ kind: "refresh-site" });
    assert.equal(harness.frame.window.location.href, adminHref);

    harness.postShellCommand({ kind: "capture-phpinfo" });
    harness.postShellCommand({ kind: "flush-persistence" });
    harness.postShellCommand({ kind: "unknown" });
    assert.deepEqual(worker.posted.slice(1), [
      { kind: "capture-phpinfo", scopeId: "s1", runtimeId: RUNTIME_ID },
      { kind: "flush-persistence" },
    ]);
  });

  it("finalizes readiness from the frame watch once the document has a body", async () => {
    const harness = createHarness();
    await bootUntilWorkerReady(harness, { initialPath: "/my/" });

    // about:blank and body-less documents are not ready yet.
    setFrameDocument(harness, {});
    harness.clock.tick(150);
    harness.frame.window = {
      location: { href: `${ORIGIN}/playground/s1/${RUNTIME_ID}/my/` },
      document: { readyState: "interactive", title: "", body: null },
    };
    harness.clock.tick(150);
    // A throwing cross-origin frame is treated as not ready.
    harness.frame.window = {
      get location() {
        throw new Error("SecurityError");
      },
    };
    harness.clock.tick(150);
    assert.equal(harness.overlayHidden(), false);

    // Unscoped URLs are reported as-is.
    harness.frame.window = {
      location: { href: `${ORIGIN}/elsewhere/page.php#top` },
      document: { readyState: "complete", title: "", body: { innerHTML: "x" } },
    };
    harness.clock.tick(150);
    assert.equal(harness.overlayHidden(), true);
    assert.deepEqual(
      harness
        .shellMessages()
        .filter((m) => m.kind === "navigate")
        .at(-1),
      { kind: "navigate", path: "/elsewhere/page.php#top" },
    );
  });

  it("re-navigates once when the Moodle page load stalls", async () => {
    const harness = createHarness();
    await bootUntilWorkerReady(harness, { initialPath: "/my/" });
    const entry = `${ORIGIN}/playground/s1/${RUNTIME_ID}/my/`;

    setFrameDocument(harness, {
      path: "/my/",
      readyState: "loading",
      title: "Dashboard",
      body: "  ",
    });
    harness.frame.window.location.href = entry;
    harness.clock.tick(4000);

    assert.equal(harness.status(), "Recovering a stalled Moodle page load.");
    assert.equal(harness.frame.window.location.href, entry);
    assert.equal(harness.overlayHidden(), false);

    // A page that loaded normally is not recovered.
    setFrameDocument(harness, { path: "/my/" });
    harness.postShellCommand({ kind: "refresh-site" });
    harness.frame.window.location.href = "untouched";
    harness.clock.tick(4000);
    assert.equal(harness.frame.window.location.href, "untouched");
  });

  it("surfaces php-worker load errors", async () => {
    const harness = createHarness();
    await harness.boot();

    harness.worker.emit("error", {
      message: "Unexpected token",
      filename: "php-worker.bundle.js",
      lineno: 3,
      colno: 9,
    });
    harness.worker.emit("error", {});

    const errors = harness
      .shellMessages()
      .filter((m) => m.kind === "error")
      .map((m) => m.detail);
    assert.deepEqual(errors, [
      "Unexpected token | file=php-worker.bundle.js | line=3 | col=9",
      "php-worker failed before signalling readiness.",
    ]);
    assert.equal(
      harness.status(),
      "php-worker failed before signalling readiness.",
    );
  });

  it("reports a worker startup error with its stack", async () => {
    const harness = createHarness();
    await harness.boot();
    harness.worker.emit("message", {
      data: { kind: "worker-startup-error", detail: "WASM OOM" },
    });
    await flush();

    assert.equal(harness.fatalStatus(), "Error: WASM OOM");
    const error = harness.shellMessages().find((m) => m.kind === "error");
    assert.match(error.detail, /^Error: WASM OOM\n/u);

    const second = createHarness({ params: { scope: "s9" } });
    await second.boot();
    second.worker.emit("message", { data: { kind: "worker-startup-error" } });
    await flush();
    assert.equal(
      second.fatalStatus(),
      "Error: php-worker failed during startup.",
    );
  });

  it("times out when the php-worker never becomes ready", async () => {
    const harness = createHarness();
    await harness.boot();
    harness.clock.tick(15000);
    await flush();
    assert.equal(
      harness.fatalStatus(),
      `Error: Timed out while waiting for php-worker readiness for ${RUNTIME_ID}.`,
    );
  });
});

describe("remote host storage resets", () => {
  it("clears matching runtime databases and OPFS on a clean boot, then reloads", async () => {
    const databases = [
      { name: "/persist" },
      { name: "/config" },
      { name: `moodle_s_x_${RUNTIME_ID.replaceAll("-", "_")}` },
      { name: `s_x_${RUNTIME_ID.replaceAll("-", "_")}-legacy` },
      { name: "unrelated" },
      { name: "" },
      null,
    ];
    const harness = createHarness({
      params: { scope: "s-x", clean: "1", reload: "n1" },
      databases,
    });
    await harness.boot();

    assert.deepEqual(harness.removedOpfsEntries, [
      { name: "moodle-persist", options: { recursive: true } },
    ]);
    assert.deepEqual(harness.deletedDatabases, [
      "/persist",
      "/config",
      "moodle_s_x_php83_moodle53",
      "s_x_php83_moodle53-legacy",
    ]);
    assert.equal(harness.reloads.length, 1);
    assert.equal(harness.workers.length, 0);
    assert.equal(
      harness.win.sessionStorage.getItem(
        `moodle-playground:sw-reset:s-x:${RUNTIME_ID}:full:n1`,
      ),
      "1",
    );
  });

  it("does not repeat a reset already done for this nonce", async () => {
    const harness = createHarness({
      params: { clean: "1", reload: "n1" },
      databases: [{ name: "/persist" }],
      sessionItems: {
        [`moodle-playground:sw-reset:s1:${RUNTIME_ID}:full:n1`]: "1",
      },
    });
    await harness.boot();
    assert.deepEqual(harness.deletedDatabases, []);
    assert.equal(harness.reloads.length, 0);
    assert.equal(harness.workers.length, 1);
  });

  it("keeps booting when nothing was cleared (no OPFS, no databases API)", async () => {
    const harness = createHarness({
      params: { clean: "1" },
      databases: null,
      opfs: "fail",
    });
    await harness.boot();
    assert.equal(harness.reloads.length, 0);
    assert.equal(harness.workers.length, 1);
    assert.equal(harness.worker.posted[0].runtimeParams.forceCleanBoot, true);
  });

  it("soft boot leaves the persistent overlay alone", async () => {
    const harness = createHarness({
      databases: [{ name: "/persist" }, { name: "moodle_s1_php83_moodle53" }],
    });
    await harness.boot();
    assert.deepEqual(harness.removedOpfsEntries, []);
    assert.deepEqual(harness.deletedDatabases, ["moodle_s1_php83_moodle53"]);
    assert.equal(harness.reloads.length, 1);
  });
});

describe("remote host service worker control", () => {
  it("reloads once to gain Service Worker control", async () => {
    const harness = createHarness({ controller: false });
    await harness.boot();
    assert.equal(harness.reloads.length, 1);
    assert.equal(
      harness.win.sessionStorage.getItem(
        `moodle-playground:remote-sw-controlled:s1:${RUNTIME_ID}`,
      ),
      "1",
    );
    assert.equal(harness.workers.length, 0);
  });

  it("waits for controllerchange after the reload instead of looping", async () => {
    const harness = createHarness({
      controller: false,
      sessionItems: {
        [`moodle-playground:remote-sw-controlled:s1:${RUNTIME_ID}`]: "1",
      },
    });
    await harness.boot();
    assert.equal(harness.reloads.length, 0);
    assert.equal(harness.workers.length, 0);

    const change = harness.swListeners.find(
      (l) => l.type === "controllerchange",
    );
    change.listener();
    await flush();
    // Still no controller to configure, but boot continues to the worker.
    assert.deepEqual(harness.controllerMessages, []);
    assert.equal(
      harness.status(),
      "Service Worker ready and controlling this tab.",
    );
    assert.equal(harness.workers.length, 1);
  });

  it("clears the reload marker once the page is controlled", async () => {
    const key = `moodle-playground:remote-sw-controlled:s1:${RUNTIME_ID}`;
    const harness = createHarness({ sessionItems: { [key]: "1" } });
    await harness.boot();
    assert.equal(harness.win.sessionStorage.getItem(key), null);
  });

  it("fails with a timeout when control never arrives", async () => {
    const harness = createHarness({
      controller: false,
      sessionItems: {
        [`moodle-playground:remote-sw-controlled:s1:${RUNTIME_ID}`]: "1",
      },
    });
    await harness.boot();
    harness.clock.tick(10000);
    await flush();
    assert.equal(
      harness.fatalStatus(),
      "Error: Timed out waiting for service worker control.",
    );
  });

  it("reports a missing Service Worker API as a warning", async () => {
    const harness = createHarness({ serviceWorker: "missing" });
    await harness.boot();
    const error = harness.shellMessages().find((m) => m.kind === "error");
    assert.equal(error.level, "warning");
    assert.equal(error.source, "service-worker-unsupported");
    assert.match(error.detail, /Service Workers are unavailable/u);
    assert.equal(harness.overlayHidden(), false);
    assert.equal(harness.workers.length, 0);
  });

  it("reports a rejected registration as an error", async () => {
    const harness = createHarness({ serviceWorker: "reject" });
    await harness.boot();
    const error = harness.shellMessages().find((m) => m.kind === "error");
    assert.deepEqual(error, {
      kind: "error",
      detail: "Service Worker registration failed: SecurityError",
      level: "error",
      source: "service-worker-registration",
    });
    assert.equal(
      harness.status(),
      "Service Worker registration failed: SecurityError",
    );
  });
});

describe("remote host page lifecycle", () => {
  it("refuses a scope already owned by another tab", async () => {
    const harness = createHarness({ lockAvailable: false });
    await harness.boot();
    assert.match(harness.status(), /already open in another tab/u);
    assert.equal(harness.workers.length, 0);
  });

  it("terminates the worker and releases the scope on pagehide", async () => {
    const harness = createHarness();
    await bootUntilWorkerReady(harness, { initialPath: "/my/" });
    assert.deepEqual(harness.lockReleases, []);

    harness.win.dispatchEvent(new harness.win.Event("pagehide"));
    await flush();
    assert.equal(harness.worker.terminated, true);
    assert.deepEqual(harness.lockReleases, ["moodle-playground-owner:s1"]);
  });

  it("stops before starting a worker when hidden during boot", async () => {
    const harness = createHarness();
    importCounter += 1;
    const loading = import(`../../src/remote/main.js?case=${importCounter}`);
    await loading;
    // The lock callback has not resolved yet; leave the page immediately.
    harness.win.dispatchEvent(new harness.win.Event("pagehide"));
    await flush();
    assert.equal(harness.workers.length, 0);
    assert.deepEqual(harness.lockReleases, ["moodle-playground-owner:s1"]);
  });

  it("reloads when restored from the back/forward cache", async () => {
    const harness = createHarness();
    await harness.boot();
    const restored = new harness.win.Event("pageshow");
    restored.persisted = true;
    harness.win.dispatchEvent(restored);
    harness.win.dispatchEvent(new harness.win.Event("pageshow"));
    assert.equal(harness.reloads.length, 1);
  });
});
