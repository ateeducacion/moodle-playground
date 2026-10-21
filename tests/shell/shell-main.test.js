import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import { BUILD_VERSION } from "../../src/generated/build-version.js";
import { SNAPSHOT_VERSION } from "../../src/shared/protocol.js";

// Boots the real shell entry point (src/shell/main.js) against the real
// index.html markup in happy-dom, with the browser boundaries faked: fetch,
// the Service Worker container, BroadcastChannel and the remote frame.

const INDEX_HTML = readFileSync(
  new URL("../../index.html", import.meta.url),
  "utf8",
);
const BODY_HTML = INDEX_HTML.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
const APP_URL = "https://play.example/moodle-playground/";
const SENTRY_DSN = "https://publickey@sentry.example/42";
const DEFAULT_BLUEPRINT = {
  landingPage: "/my/",
  steps: [{ step: "login", username: "admin" }],
};
const BASE_CONFIG = {
  defaultBlueprintUrl: "./assets/blueprints/default.blueprint.json",
  landingPath: "/login/index.php",
  autologin: true,
  opcache: true,
  sentry: { dsn: SENTRY_DSN, environment: "test" },
};

let importCounter = 0;
let current;

class FakeBroadcastChannel {
  static instances = [];

  constructor(name) {
    this.name = name;
    this.listeners = [];
    this.closed = false;
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }

  close() {
    this.closed = true;
  }

  emit(data) {
    for (const listener of this.listeners) listener({ data });
  }
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

// The deadline is wall-clock time, not a count of event-loop turns: blueprint
// encoding gzips on the libuv threadpool, so on a busy machine it outlasts any
// fixed number of turns.
async function waitFor(predicate, message = "condition not met") {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Boot a fresh copy of the shell. Every import gets a cache-busting query so
 * the module's top-level state starts over; its dependencies are shared.
 */
async function bootShell({
  url = APP_URL,
  config = BASE_CONFIG,
  configStatus = 200,
  session = {},
  serviceWorker = "controlled",
  manifest = { release: "5.3.1+ (Build: 20261001)" },
  blueprint = DEFAULT_BLUEPRINT,
  waitForFrame = true,
  clipboard = "granted",
} = {}) {
  const win = new Window({
    url,
    settings: {
      disableIframePageLoading: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      navigation: { disableMainFrameNavigation: true },
    },
  });
  win.document.body.innerHTML = BODY_HTML;
  for (const [key, value] of Object.entries(session)) {
    win.sessionStorage.setItem(key, value);
  }

  const state = {
    win,
    doc: win.document,
    posted: [],
    fetches: [],
    sentry: [],
    swRegistrations: [],
    swListeners: [],
    clipboard: [],
    reloads: 0,
    clicks: [],
  };

  win.location.reload = () => {
    state.reloads += 1;
  };

  const frame = win.document.querySelector("#site-frame");
  state.frame = frame;
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: {
      postMessage(message, origin) {
        state.posted.push({ message, origin });
      },
    },
  });

  const swContainer =
    serviceWorker === "missing"
      ? undefined
      : {
          controller: serviceWorker === "uncontrolled" ? null : {},
          ready: Promise.resolve(),
          async register(scriptUrl, options) {
            state.swRegistrations.push({ url: String(scriptUrl), options });
            if (serviceWorker === "rejected") {
              throw new Error("SecurityError: bad scope");
            }
            return { update: async () => {} };
          },
          addEventListener(type, listener) {
            state.swListeners.push({ type, listener });
          },
        };

  globalThis.window = win;
  globalThis.document = win.document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "node-test",
      ...(swContainer ? { serviceWorker: swContainer } : {}),
      clipboard: {
        writeText: async (text) => {
          if (clipboard === "denied") {
            throw new DOMException(
              "Write permission denied.",
              "NotAllowedError",
            );
          }
          state.clipboard.push(text);
        },
      },
    },
  });
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  FakeBroadcastChannel.instances = [];
  globalThis.fetch = async (input, init = {}) => {
    const href = String(input);
    state.fetches.push({ href, init });
    if (href.startsWith("https://sentry.example/")) {
      const lines = init.body.trim().split("\n");
      state.sentry.push(JSON.parse(lines.at(-1)));
      return new Response("{}");
    }
    if (href.endsWith("/playground.config.json")) {
      return configStatus === 200
        ? jsonResponse(config)
        : new Response("nope", { status: configStatus });
    }
    if (href.includes("default.blueprint.json")) {
      return jsonResponse(blueprint);
    }
    if (href.includes("/assets/manifests/")) {
      if (manifest === null) {
        return new Response("", { status: 500, statusText: "Boom" });
      }
      return init.method === "HEAD"
        ? new Response(null, { status: 200 })
        : jsonResponse(manifest);
    }
    return new Response("not found", { status: 404 });
  };

  win.HTMLAnchorElement.prototype.click = function click() {
    state.clicks.push({ href: this.href, download: this.download });
  };

  state.$ = (selector) => win.document.querySelector(selector);
  state.channel = () => FakeBroadcastChannel.instances.at(-1);
  state.logText = () => state.$("#log-panel").textContent;
  state.frameUrl = () => new URL(frame.getAttribute("src"));

  current = state;
  await import(`../../src/shell/main.js?boot=${++importCounter}`);
  if (waitForFrame) {
    await waitFor(
      () => frame.getAttribute("src"),
      "shell never pointed the frame at the runtime",
    );
  }
  return state;
}

function submitAddress(shell, value) {
  shell.$("#address-input").value = value;
  shell
    .$("#address-form")
    .dispatchEvent(new shell.win.Event("submit", { cancelable: true }));
}

afterEach(async () => {
  await current?.win.happyDOM.close();
  current = null;
});

describe("shell boot", () => {
  // Runs first: loadPlaygroundConfig() memoizes success for the whole process.
  it("logs a config failure and unlocks the UI", async () => {
    const shell = await bootShell({ configStatus: 503, waitForFrame: false });
    await waitFor(() =>
      shell.logText().includes("Unable to load playground config: 503"),
    );
    assert.ok(shell.$("#log-panel .error"));
    // The UI is unlocked so the user can still act on the failure.
    assert.equal(shell.$("#address-input").disabled, false);
    assert.equal(shell.frame.getAttribute("src"), null);
  });

  it("registers the versioned SW and points the frame at the scoped runtime", async () => {
    const shell = await bootShell({
      url: `${APP_URL}?scope=s1&debug=true&addonProxyUrl=https://p.example/&phpCorsProxyUrl=https://c.example/`,
    });

    assert.equal(shell.swRegistrations.length, 1);
    const swUrl = new URL(shell.swRegistrations[0].url);
    assert.ok(swUrl.pathname.endsWith("/sw.bundle.js"));
    assert.equal(swUrl.searchParams.get("build"), BUILD_VERSION);
    assert.equal(shell.swRegistrations[0].options.scope, "./");

    const frameUrl = shell.frameUrl();
    assert.equal(frameUrl.origin + frameUrl.pathname, `${APP_URL}remote.html`);
    assert.equal(frameUrl.searchParams.get("scope"), "s1");
    assert.equal(frameUrl.searchParams.get("path"), "/my/");
    assert.equal(
      frameUrl.searchParams.get("moodleBranch"),
      "MOODLE_503_STABLE",
    );
    assert.equal(frameUrl.searchParams.get("phpVersion"), "8.3");
    assert.equal(
      frameUrl.searchParams.get("addonProxyUrl"),
      "https://p.example/",
    );
    assert.equal(
      frameUrl.searchParams.get("phpCorsProxyUrl"),
      "https://c.example/",
    );
    assert.equal(frameUrl.searchParams.get("debug"), "true");
    assert.ok(frameUrl.searchParams.get("instance"));
    assert.equal(frameUrl.searchParams.has("clean"), false);

    // The channel name is derived from the scope and the frame instance.
    assert.match(
      shell.channel().name,
      new RegExp(frameUrl.searchParams.get("instance")),
    );

    // The blueprint resolved from the config is shown in the editor.
    assert.deepEqual(
      JSON.parse(shell.$("#blueprint-textarea").value),
      DEFAULT_BLUEPRINT,
    );
    assert.equal(
      shell.win.sessionStorage.getItem("blueprint-source:s1"),
      "default",
    );

    // Info panel.
    assert.equal(shell.$("#address-input").value, "/my/");
    assert.equal(shell.$("#build-id-value").textContent, BUILD_VERSION);
    assert.match(shell.$("#build-id-chip").title, new RegExp(BUILD_VERSION));
    assert.ok(shell.logText().includes(`Playground build ${BUILD_VERSION}`));
    assert.ok(shell.logText().includes("[runtime-selection][shell:resolved]"));
    const branches = [...shell.$("#info-moodle-version").options].map(
      (option) => option.value,
    );
    assert.ok(branches.includes("MOODLE_405_STABLE"));
    assert.equal(shell.$("#info-moodle-version").value, "MOODLE_503_STABLE");
    assert.equal(shell.$("#info-php-version").value, "8.3");
    assert.equal(shell.$("#info-opcache").checked, true);
    assert.ok(shell.$("#runtime-id-value").textContent.length > 0);
    assert.equal(shell.$("#config-status").textContent, "Running");
    assert.ok(shell.$("#config-apply").classList.contains("is-hidden"));
    await waitFor(
      () => shell.$("#moodle-release-value").textContent === "5.3.1",
    );
    assert.equal(
      shell.$("#moodle-release-value").title,
      "5.3.1+ (Build: 20261001)",
    );

    // The UI stays locked until the runtime reports ready.
    assert.equal(shell.$("#address-input").disabled, true);
    assert.equal(shell.$("#run-button").disabled, true);
  });

  it("keeps the release placeholder when the manifest cannot load", async () => {
    const shell = await bootShell({ manifest: null });
    await flush(30);
    assert.equal(shell.$("#moodle-release-value").title, "");
  });

  it("forces a clean boot when the blueprint source changed in this tab", async () => {
    const shell = await bootShell({
      url: `${APP_URL}?scope=s2`,
      session: { "blueprint-source:s2": "https://elsewhere.example/" },
    });
    assert.equal(shell.frameUrl().searchParams.get("clean"), "1");
  });

  it("restores the saved path but skips saved login and internal paths", async () => {
    const restored = await bootShell({
      url: `${APP_URL}?scope=s3`,
      session: {
        "moodle-playground:s3:state": JSON.stringify({
          path: "/course/view.php?id=2",
        }),
      },
    });
    assert.equal(restored.$("#address-input").value, "/course/view.php?id=2");
    await restored.win.happyDOM.close();

    const login = await bootShell({
      url: `${APP_URL}?scope=s4`,
      session: {
        "moodle-playground:s4:state": JSON.stringify({ path: "/login" }),
      },
    });
    assert.equal(login.$("#address-input").value, "/my/");
    await login.win.happyDOM.close();

    const internal = await bootShell({
      url: `${APP_URL}?scope=s5`,
      blueprint: { steps: [] },
      session: {
        "moodle-playground:s5:state": JSON.stringify({
          path: "/__phpinfo.php",
        }),
      },
    });
    assert.equal(internal.$("#address-input").value, "/login/index.php");
  });

  it("reloads once to gain Service Worker control", async () => {
    const shell = await bootShell({
      url: `${APP_URL}?scope=s6`,
      serviceWorker: "uncontrolled",
      waitForFrame: false,
    });
    await waitFor(() => shell.reloads === 1);
    assert.equal(
      shell.win.sessionStorage.getItem("moodle-playground:s6:sw-controlled"),
      "1",
    );
    assert.equal(shell.frame.getAttribute("src"), null);
  });

  it("boots without control after the one reload was already spent", async () => {
    const shell = await bootShell({
      url: `${APP_URL}?scope=s7`,
      serviceWorker: "uncontrolled",
      session: { "moodle-playground:s7:sw-controlled": "1" },
    });
    assert.equal(shell.reloads, 0);
    assert.equal(
      shell.win.sessionStorage.getItem("moodle-playground:s7:sw-controlled"),
      null,
    );
  });

  it("shows a blocking error and a warning when Service Workers are unavailable", async () => {
    const shell = await bootShell({
      serviceWorker: "missing",
      waitForFrame: false,
    });
    await waitFor(() => shell.frame.getAttribute("srcdoc"));
    const srcdoc = shell.frame.getAttribute("srcdoc");
    assert.match(srcdoc, /role="alert"/);
    assert.match(srcdoc, /Service Workers are unavailable/);
    assert.equal(shell.frame.getAttribute("src"), null);
    assert.equal(shell.$("#address-input").disabled, false);
    assert.ok(!shell.$("#logs-panel").classList.contains("is-hidden"));
    assert.equal(shell.$("#logs-tab").getAttribute("aria-selected"), "true");
    await waitFor(() => shell.sentry.length > 0);
    const event = shell.sentry.find(
      (entry) => entry.extra?.source === "service-worker-unsupported",
    );
    assert.equal(event.level, "warning");
  });

  it("captures a rejected registration as an exception", async () => {
    const shell = await bootShell({
      serviceWorker: "rejected",
      waitForFrame: false,
    });
    await waitFor(() => shell.frame.getAttribute("srcdoc"));
    assert.match(
      shell.frame.getAttribute("srcdoc"),
      /Service Worker registration failed/,
    );
    assert.ok(
      shell
        .logText()
        .includes("Service Worker registration failed: SecurityError"),
    );
    await waitFor(() =>
      shell.sentry.some(
        (entry) => entry.extra?.source === "service-worker-registration",
      ),
    );
  });

  it("re-opens a collapsed side panel to show a boot error", async () => {
    const shell = await bootShell({
      serviceWorker: "missing",
      waitForFrame: false,
    });
    // Collapse before the SW check resolves is racy; instead collapse and
    // trigger the next failing boot through Reset.
    await waitFor(() => shell.frame.getAttribute("srcdoc"));
    shell.$("#panel-close-button").click();
    assert.ok(shell.$("#side-panel").classList.contains("is-collapsed"));
    shell.frame.removeAttribute("srcdoc");
    shell.$("#reset-button").click();
    await waitFor(() => shell.frame.getAttribute("srcdoc"));
    assert.ok(!shell.$("#side-panel").classList.contains("is-collapsed"));
    assert.equal(
      shell.$("#panel-toggle-button").getAttribute("aria-expanded"),
      "true",
    );
  });

  it("picks versions from URL params and blueprint preferences", async () => {
    const shell = await bootShell({
      url: `${APP_URL}?moodle=4.5&php=8.2&opcache=0`,
    });
    assert.equal(
      shell.frameUrl().searchParams.get("moodleBranch"),
      "MOODLE_405_STABLE",
    );
    assert.equal(shell.$("#info-moodle-version").value, "MOODLE_405_STABLE");
    assert.equal(shell.$("#info-php-version").value, "8.2");
    assert.equal(shell.$("#info-opcache").checked, false);
    await shell.win.happyDOM.close();

    const fromBlueprint = await bootShell({
      blueprint: {
        preferredVersions: { php: "8.1", moodle: "4.4" },
        steps: [],
      },
    });
    assert.equal(
      fromBlueprint.frameUrl().searchParams.get("moodleBranch"),
      "MOODLE_404_STABLE",
    );
    assert.equal(fromBlueprint.$("#info-php-version").value, "8.1");
  });
});

describe("shell runtime messages", () => {
  async function readyShell(options) {
    const shell = await bootShell(options);
    shell.channel().emit({ kind: "progress", title: "Boot", detail: "50%" });
    assert.ok(shell.logText().includes("Boot: 50%"));
    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });
    return shell;
  }

  it("unlocks the UI on ready and tracks frame navigations in the address bar", async () => {
    const shell = await readyShell();
    assert.equal(shell.$("#address-input").disabled, false);
    assert.equal(shell.$("#back-button").disabled, true);

    shell.channel().emit({ kind: "frame-ready", path: "/course/" });
    assert.equal(shell.$("#address-input").value, "/course/");
    assert.equal(shell.$("#back-button").disabled, false);

    shell.channel().emit({ kind: "navigate", path: "/admin/" });
    assert.equal(shell.$("#address-input").value, "/admin/");

    // Internal runtime paths never replace the visible path.
    shell.channel().emit({ kind: "navigate", path: "/__phpinfo.php" });
    shell.channel().emit({ kind: "frame-ready", path: "/__probe.php?x=1" });
    assert.equal(shell.$("#address-input").value, "/admin/");

    // State is persisted for reloads.
    const saved = JSON.parse(
      Object.entries(
        Object.fromEntries(
          Object.keys(shell.win.sessionStorage).map((key) => [
            key,
            shell.win.sessionStorage.getItem(key),
          ]),
        ),
      ).find(([key]) => key.endsWith(":state"))[1],
    );
    assert.equal(saved.path, "/admin/");
  });

  it("Back walks the in-shell history and Home/Refresh post to the runtime", async () => {
    const shell = await readyShell();
    shell.channel().emit({ kind: "frame-ready", path: "/course/" });
    shell.channel().emit({ kind: "frame-ready", path: "/admin/" });

    shell.$("#back-button").click();
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/course/",
    });
    assert.equal(shell.posted.at(-1).origin, "https://play.example");
    // The back navigation itself is not pushed onto the stack.
    shell.channel().emit({ kind: "frame-ready", path: "/course/" });
    shell.$("#back-button").click();
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/my/",
    });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });
    assert.equal(shell.$("#back-button").disabled, true);
    const before = shell.posted.length;
    shell.$("#back-button").click();
    assert.equal(shell.posted.length, before);

    shell.$("#home-button").click();
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/",
    });
    assert.ok(shell.logText().includes("Navigating site to /"));

    shell.$("#refresh-button").click();
    assert.deepEqual(shell.posted.at(-1).message, { kind: "refresh-site" });
    assert.ok(shell.logText().includes("Refreshing /"));
  });

  it("address bar navigates within the runtime, ignoring input while locked", async () => {
    const shell = await bootShell();
    submitAddress(shell, "/ignored/");
    assert.equal(shell.posted.length, 0);

    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });
    submitAddress(shell, "/grade/");
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/grade/",
    });
    submitAddress(shell, "");
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/",
    });
  });

  it("reloads the frame when the runtime has not booted yet", async () => {
    const shell = await bootShell();
    shell.channel().emit({ kind: "ready", path: "/my/" });
    const firstInstance = shell.frameUrl().searchParams.get("instance");
    const firstChannel = shell.channel();

    submitAddress(shell, "/grade/");
    await waitFor(
      () => shell.frameUrl().searchParams.get("instance") !== firstInstance,
    );
    assert.equal(shell.frameUrl().searchParams.get("path"), "/grade/");
    assert.equal(firstChannel.closed, true);

    shell.channel().emit({ kind: "ready", path: "/grade/" });
    const secondInstance = shell.frameUrl().searchParams.get("instance");
    shell.$("#refresh-button").click();
    await waitFor(
      () => shell.frameUrl().searchParams.get("instance") !== secondInstance,
    );
    assert.equal(shell.posted.length, 0);
  });

  it("ready after boot re-navigates the frame when the path changed", async () => {
    const shell = await readyShell();
    shell.channel().emit({ kind: "ready", path: "/user/profile.php" });
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "navigate-site",
      path: "/user/profile.php",
    });
    shell.channel().emit({ kind: "ready", path: "/__internal.php" });
    assert.equal(shell.$("#address-input").value, "/user/profile.php");
  });

  it("an error message unlocks the UI, logs, reports and asks for phpinfo", async () => {
    const shell = await bootShell();
    shell.channel().emit({
      kind: "error",
      detail: "PHP fatal error",
      level: "warning",
      source: "php",
      path: "/my/",
    });
    assert.equal(shell.$("#address-input").disabled, false);
    assert.ok(shell.logText().includes("PHP fatal error"));
    assert.ok(!shell.$("#phpinfo-panel").classList.contains("is-hidden"));
    assert.deepEqual(shell.posted.at(-1).message, { kind: "capture-phpinfo" });
    assert.ok(shell.logText().includes("(bootstrap-error)"));
    await waitFor(() =>
      shell.sentry.some(
        (entry) => entry.message?.formatted === "PHP fatal error",
      ),
    );
    const event = shell.sentry.find(
      (entry) => entry.message?.formatted === "PHP fatal error",
    );
    assert.equal(event.level, "warning");
    assert.deepEqual(event.extra, { source: "php", path: "/my/" });

    // Once phpinfo was captured, later errors do not request it again.
    shell.channel().emit({
      kind: "phpinfo",
      html: "<html><head></head><body>PHP 8.3</body></html>",
    });
    const posted = shell.posted.length;
    shell.channel().emit({ kind: "error", detail: "again" });
    assert.equal(shell.posted.length, posted);
  });

  it("renders phpinfo responsively and logs trace / network / flush messages", async () => {
    const shell = await bootShell();
    const phpInfoFrame = shell.$("#phpinfo-frame");
    assert.match(
      phpInfoFrame.getAttribute("srcdoc"),
      /No PHP diagnostics captured yet/,
    );

    shell.channel().emit({
      kind: "phpinfo",
      html: "<html><head><title>x</title></head><body>PHP 8.3</body></html>",
      detail: "Captured!",
    });
    const srcdoc = phpInfoFrame.getAttribute("srcdoc");
    assert.match(
      srcdoc,
      /<style>[\s\S]*table-layout:auto[\s\S]*<\/style><\/head>/,
    );
    assert.match(srcdoc, /PHP 8.3/);
    assert.ok(shell.logText().includes("Captured!"));

    shell.channel().emit({ kind: "phpinfo" });
    assert.match(
      phpInfoFrame.getAttribute("srcdoc"),
      /No PHP diagnostics captured yet/,
    );
    assert.ok(shell.logText().includes("Captured PHP runtime diagnostics."));

    shell.channel().emit({ kind: "trace", detail: "[trace] step" });
    shell.channel().emit({ kind: "trace" });
    shell
      .channel()
      .emit({ kind: "wasm-network-error", detail: "fetch blocked" });
    shell.channel().emit({ kind: "persistence-flushed" });
    shell
      .channel()
      .emit({ kind: "persistence-flushed", detail: "Flushed 3 ops" });
    shell.channel().emit({ kind: "unknown" });
    const log = shell.logText();
    assert.ok(log.includes("[trace] step"));
    assert.ok(log.includes("fetch blocked — This is a known limitation"));
    assert.ok(log.includes("Persistence journal flushed."));
    assert.ok(log.includes("Flushed 3 ops"));
  });

  it("forwards SW debug messages to the log", async () => {
    const shell = await bootShell();
    const { listener } = shell.swListeners.find(
      (entry) => entry.type === "message",
    );
    listener({ data: { kind: "sw-debug", detail: "cache hit" } });
    listener({ data: { kind: "other", detail: "ignored" } });
    listener({ data: null });
    assert.ok(shell.logText().includes("[sw] cache hit"));
    assert.ok(!shell.logText().includes("ignored"));
  });

  it("caps the log at 500 entries", async () => {
    const shell = await bootShell();
    for (let i = 0; i < 520; i++) {
      shell.channel().emit({ kind: "trace", detail: `line ${i}` });
    }
    const panel = shell.$("#log-panel");
    assert.equal(panel.childElementCount, 500);
    assert.ok(panel.lastElementChild.textContent.includes("line 519"));
  });
});

describe("shell panels and toolbar", () => {
  it("switches side-panel tabs and toggles the panel", async () => {
    const shell = await bootShell();
    shell.channel().emit({ kind: "ready", path: "/my/" });
    const tabs = {
      info: ["#info-tab", "#info-panel"],
      logs: ["#logs-tab", "#logs-panel"],
      blueprint: ["#blueprint-tab", "#blueprint-panel"],
      phpinfo: ["#phpinfo-tab", "#phpinfo-panel"],
    };
    for (const [name, [tab]] of Object.entries(tabs)) {
      shell.$(tab).click();
      for (const [other, [otherTab, otherPanel]] of Object.entries(tabs)) {
        const active = other === name;
        assert.equal(
          shell.$(otherPanel).classList.contains("is-hidden"),
          !active,
          `${otherPanel} visibility after clicking ${name}`,
        );
        assert.equal(
          shell.$(otherTab).getAttribute("aria-selected"),
          String(active),
        );
      }
    }
    // The phpinfo tab asks the runtime for diagnostics.
    assert.deepEqual(shell.posted.at(-1).message, { kind: "capture-phpinfo" });
    assert.ok(shell.logText().includes("(tab-click)"));

    shell.$("#refresh-phpinfo-button").click();
    assert.ok(shell.logText().includes("(manual)"));

    const side = shell.$("#side-panel");
    const collapsedBefore = side.classList.contains("is-collapsed");
    shell.$("#panel-toggle-button").click();
    assert.equal(side.classList.contains("is-collapsed"), !collapsedBefore);
    assert.equal(
      shell.$("#workspace").classList.contains("is-panel-collapsed"),
      !collapsedBefore,
    );
    assert.equal(
      shell.$("#panel-toggle-button").getAttribute("aria-expanded"),
      String(collapsedBefore),
    );

    // Close only collapses; it never re-opens a collapsed panel.
    if (!side.classList.contains("is-collapsed")) {
      shell.$("#panel-close-button").click();
    }
    assert.ok(side.classList.contains("is-collapsed"));
    shell.$("#panel-close-button").click();
    assert.ok(side.classList.contains("is-collapsed"));
  });

  it("logs when phpinfo cannot be requested without a frame window", async () => {
    const shell = await bootShell();
    Object.defineProperty(shell.frame, "contentWindow", {
      configurable: true,
      value: null,
    });
    shell.$("#phpinfo-tab").click();
    assert.ok(
      shell
        .logText()
        .includes("Cannot capture PHP info: remote frame not available."),
    );
  });

  it("clears and copies the runtime log", async (t) => {
    const shell = await bootShell();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const copy = shell.$("#copy-logs-button");
    const originalHtml = copy.innerHTML;
    copy.click();
    await waitFor(() => copy.textContent === "✓");
    assert.ok(shell.clipboard[0].includes(`Playground build ${BUILD_VERSION}`));
    t.mock.timers.tick(1200);
    assert.equal(copy.innerHTML, originalHtml);

    shell.$("#clear-logs-button").click();
    assert.equal(shell.logText(), "");
  });

  it("copies the runtime and build IDs from their chips", async (t) => {
    const shell = await bootShell();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const runtimeLabel = shell.$("#runtime-id-value");
    const runtimeId = runtimeLabel.textContent;
    shell.$("#runtime-id-chip").click();
    // The label changes once the clipboard write has settled.
    await waitFor(() => runtimeLabel.textContent === "✓ copied");
    assert.equal(shell.clipboard.at(-1), runtimeId);
    t.mock.timers.tick(1400);
    assert.equal(runtimeLabel.textContent, runtimeId);

    shell.$("#build-id-chip").click();
    await waitFor(() => shell.$("#build-id-value").textContent === "✓ copied");
    assert.equal(shell.clipboard.at(-1), BUILD_VERSION);
    t.mock.timers.tick(1400);
    assert.equal(shell.$("#build-id-value").textContent, BUILD_VERSION);
  });

  it("shows a denied clipboard write as a failed copy, without reporting it", async (t) => {
    const shell = await bootShell({ clipboard: "denied" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const runtimeLabel = shell.$("#runtime-id-value");
    const runtimeId = runtimeLabel.textContent;
    shell.$("#runtime-id-chip").click();
    await waitFor(() => runtimeLabel.textContent === "✗ copy failed");
    t.mock.timers.tick(1400);
    assert.equal(runtimeLabel.textContent, runtimeId);

    const buildLabel = shell.$("#build-id-value");
    shell.$("#build-id-chip").click();
    await waitFor(() => buildLabel.textContent === "✗ copy failed");
    t.mock.timers.tick(1400);
    assert.equal(buildLabel.textContent, BUILD_VERSION);

    const copy = shell.$("#copy-logs-button");
    const originalHtml = copy.innerHTML;
    copy.click();
    await waitFor(() => copy.textContent === "✗");
    t.mock.timers.tick(1200);
    assert.equal(copy.innerHTML, originalHtml);

    // A denied permission is the user's setting, not a bug: nothing reaches
    // Sentry (an unhandled rejection would, and also fails this test file).
    await flush();
    assert.deepEqual(shell.clipboard, []);
    assert.deepEqual(shell.sentry, []);
  });
});

describe("shell configuration panel", () => {
  it("marks a version change dirty and applies it as a fresh-runtime URL", async () => {
    const shell = await bootShell();
    const moodle = shell.$("#info-moodle-version");
    const php = shell.$("#info-php-version");

    moodle.value = "MOODLE_404_STABLE";
    moodle.dispatchEvent(new shell.win.Event("change"));
    // 8.3 is still compatible with 4.4, so the PHP selection is kept.
    assert.deepEqual(
      [...php.options].map((option) => option.value),
      ["8.1", "8.2", "8.3"],
    );
    assert.equal(php.value, "8.3");
    assert.equal(shell.$("#config-status").textContent, "Unsaved");
    assert.ok(!shell.$("#config-warning").classList.contains("is-hidden"));
    assert.ok(shell.$("#config-reload-note").classList.contains("is-hidden"));
    const apply = shell.$("#config-apply");
    assert.ok(!apply.classList.contains("is-hidden"));
    assert.ok(apply.classList.contains("danger"));
    assert.equal(apply.textContent, "Apply & Reset");

    php.value = "8.1";
    php.dispatchEvent(new shell.win.Event("change"));
    apply.click();
    await waitFor(() => shell.win.location.href.includes("php=8.1"));
    const url = new URL(shell.win.location.href);
    assert.equal(url.searchParams.get("moodle"), "4.4");
    assert.equal(url.searchParams.has("moodleBranch"), false);
    assert.equal(url.searchParams.has("opcache"), false);
    // A version change resets the site: no persistence flush is requested.
    assert.equal(shell.posted.length, 0);
  });

  it("falls back to a compatible PHP version when the branch drops the current one", async () => {
    const shell = await bootShell({ url: `${APP_URL}?php=8.4` });
    const moodle = shell.$("#info-moodle-version");
    const php = shell.$("#info-php-version");
    assert.equal(php.value, "8.4");
    moodle.value = "MOODLE_404_STABLE";
    moodle.dispatchEvent(new shell.win.Event("change"));
    assert.equal(php.value, "8.3");

    // Reselecting the running versions clears the dirty state.
    moodle.value = "MOODLE_503_STABLE";
    moodle.dispatchEvent(new shell.win.Event("change"));
    php.value = "8.4";
    php.dispatchEvent(new shell.win.Event("change"));
    assert.equal(shell.$("#config-status").textContent, "Running");
    assert.ok(shell.$("#config-apply").classList.contains("is-hidden"));

    // Apply with nothing changed is a no-op.
    const before = shell.win.location.href;
    shell.$("#config-apply").click();
    await flush();
    assert.equal(shell.win.location.href, before);
  });

  it("an OPcache-only change flushes persistence and reloads the same runtime", async () => {
    const shell = await bootShell({ url: `${APP_URL}?moodle=5.3&php=8.3` });
    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });

    const opcache = shell.$("#info-opcache");
    opcache.checked = false;
    opcache.dispatchEvent(new shell.win.Event("change"));
    const apply = shell.$("#config-apply");
    assert.equal(apply.textContent, "Apply & Reload");
    assert.ok(!apply.classList.contains("danger"));
    assert.ok(shell.$("#config-warning").classList.contains("is-hidden"));
    assert.ok(!shell.$("#config-reload-note").classList.contains("is-hidden"));

    apply.click();
    await waitFor(() => shell.posted.length > 0);
    assert.deepEqual(shell.posted.at(-1).message, {
      kind: "flush-persistence",
    });
    assert.ok(shell.logText().includes("Flushing the persistence journal"));
    // The reload waits for the runtime's acknowledgement.
    await flush();
    assert.ok(!shell.win.location.href.includes("opcache="));
    shell.channel().emit({ kind: "persistence-flushed" });
    await waitFor(() => shell.win.location.href.includes("opcache=0"));
    const url = new URL(shell.win.location.href);
    assert.equal(url.searchParams.get("moodle"), "5.3");
    assert.equal(url.searchParams.get("php"), "8.3");

    // Re-checking the running OPcache state clears the dirty state again.
    opcache.checked = true;
    opcache.dispatchEvent(new shell.win.Event("change"));
    assert.equal(shell.$("#config-status").textContent, "Running");
  });

  it("reloads anyway when the persistence flush times out", async (t) => {
    const shell = await bootShell();
    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opcache = shell.$("#info-opcache");
    opcache.checked = false;
    opcache.dispatchEvent(new shell.win.Event("change"));
    shell.$("#config-apply").click();
    await waitFor(() => shell.posted.length > 0);
    t.mock.timers.tick(60_000);
    await waitFor(() => shell.win.location.href.includes("opcache=0"));
    assert.ok(shell.logText().includes("did not finish in time"));
  });

  it("skips the flush when the remote window is gone", async () => {
    const shell = await bootShell();
    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });
    Object.defineProperty(shell.frame, "contentWindow", {
      configurable: true,
      value: null,
    });
    const opcache = shell.$("#info-opcache");
    opcache.checked = false;
    opcache.dispatchEvent(new shell.win.Event("change"));
    shell.$("#config-apply").click();
    await waitFor(() => shell.win.location.href.includes("opcache=0"));
  });
});

describe("shell blueprint import, export and reset", () => {
  function setImportFile(shell, contents) {
    const input = shell.$("#import-input");
    const file = new shell.win.File([contents], "bp.json", {
      type: "application/json",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new shell.win.Event("change"));
    return input;
  }

  it("exports the current blueprint as a JSON download", async () => {
    const shell = await bootShell();
    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.$("#export-button").click();
    assert.equal(shell.clicks.length, 1);
    assert.equal(shell.clicks[0].download, "moodle-playground.blueprint.json");
    assert.match(shell.clicks[0].href, /^blob:/);
  });

  it("refuses to export an invalid blueprint", async () => {
    const shell = await bootShell();
    shell.channel().emit({ kind: "ready", path: "/my/" });
    const textarea = shell.$("#blueprint-textarea");
    textarea.value = "{";
    textarea.dispatchEvent(new shell.win.Event("input"));
    shell.$("#export-button").click();
    assert.equal(shell.clicks.length, 0);
    assert.ok(
      shell.logText().includes("Cannot export blueprint: Invalid JSON"),
    );
  });

  it("imports a blueprint by encoding it into the URL", async () => {
    const shell = await bootShell({
      url: `${APP_URL}?blueprint-url=https://x.example/bp.json`,
    });
    const imported = { steps: [{ step: "login", username: "teacher" }] };
    const input = setImportFile(shell, JSON.stringify(imported));
    await waitFor(() => shell.win.location.href.includes("blueprint="));
    const url = new URL(shell.win.location.href);
    assert.equal(url.searchParams.has("blueprint-url"), false);
    assert.equal(input.value, "");
  });

  it("logs validation errors for an invalid imported blueprint but still loads it", async () => {
    const shell = await bootShell();
    setImportFile(shell, JSON.stringify({ steps: [{ step: "nope" }] }));
    await waitFor(() => shell.win.location.href.includes("blueprint="));
    assert.ok(shell.logText().includes("Blueprint validation errors:"));
  });

  it("restores a snapshot payload into the current runtime", async () => {
    const shell = await bootShell();
    const instance = shell.frameUrl().searchParams.get("instance");
    setImportFile(
      shell,
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        runtimeId: "php83-moodle53",
        path: "/admin/",
      }),
    );
    await waitFor(
      () => shell.frameUrl().searchParams.get("instance") !== instance,
    );
    assert.equal(shell.frameUrl().searchParams.get("path"), "/admin/");
    assert.equal(shell.$("#address-input").value, "/admin/");

    setImportFile(
      shell,
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        runtimeId: "php83-moodle53",
      }),
    );
    await waitFor(() => shell.frameUrl().searchParams.get("path") === "/");
  });

  it("logs an unreadable import and ignores an empty selection", async () => {
    const shell = await bootShell();
    const input = setImportFile(shell, "not json");
    await waitFor(() => shell.$("#log-panel .error"));
    assert.equal(input.value, "");

    const errors = shell.$("#log-panel").querySelectorAll(".error").length;
    Object.defineProperty(input, "files", { configurable: true, value: [] });
    input.dispatchEvent(new shell.win.Event("change"));
    await flush();
    assert.equal(
      shell.$("#log-panel").querySelectorAll(".error").length,
      errors,
    );
  });

  it("Reset re-resolves the default blueprint and boots clean", async () => {
    const shell = await bootShell({ url: `${APP_URL}?scope=r1` });
    shell.$("#reset-button").click();
    // Locked UI ignores Reset.
    await flush();
    assert.notEqual(shell.frameUrl().searchParams.get("clean"), "1");

    shell.channel().emit({ kind: "ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/my/" });
    shell.channel().emit({ kind: "frame-ready", path: "/course/" });
    shell.channel().emit({
      kind: "phpinfo",
      html: "<html><head></head><body>info</body></html>",
    });
    shell.win.sessionStorage.setItem("moodle-playground:r1:state", "{}");
    shell.$("#reset-button").click();
    await waitFor(() => shell.frameUrl().searchParams.get("clean") === "1");
    assert.equal(shell.frameUrl().searchParams.get("path"), "/my/");
    assert.equal(shell.$("#address-input").value, "/my/");
    assert.equal(shell.$("#back-button").disabled, true);
    assert.match(
      shell.$("#phpinfo-frame").getAttribute("srcdoc"),
      /No PHP diagnostics captured yet/,
    );
    // The SW registration is checked again for the new boot.
    assert.equal(shell.swRegistrations.length, 2);
  });

  it("Reset keeps an explicit ?blueprint= source instead of re-fetching", async () => {
    const { encodeBlueprintParam } = await import(
      "../../src/blueprint/parser.js"
    );
    const inline = { landingPage: "/inline/", steps: [] };
    const shell = await bootShell({
      url: `${APP_URL}?scope=r2&blueprint=${encodeURIComponent(await encodeBlueprintParam(inline))}`,
    });
    assert.equal(shell.$("#address-input").value, "/inline/");
    shell.channel().emit({ kind: "ready", path: "/inline/" });
    const blueprintFetches = () =>
      shell.fetches.filter((entry) => entry.href.includes("default.blueprint"))
        .length;
    const before = blueprintFetches();
    shell.$("#reset-button").click();
    await waitFor(() => shell.frameUrl().searchParams.get("clean") === "1");
    assert.equal(blueprintFetches(), before);
    assert.equal(
      JSON.parse(
        shell.win.sessionStorage.getItem("moodle-playground:blueprint:r2"),
      ).landingPage,
      "/inline/",
    );
  });

  it("re-saves the shell identity when Moodle clears sessionStorage", async () => {
    const shell = await bootShell({ url: `${APP_URL}?scope=k1` });
    shell.win.sessionStorage.clear();

    // Events for other keys or other storage areas are ignored.
    shell.win.dispatchEvent(
      new shell.win.StorageEvent("storage", {
        key: "x",
        storageArea: shell.win.sessionStorage,
      }),
    );
    shell.win.dispatchEvent(
      new shell.win.StorageEvent("storage", {
        key: null,
        storageArea: shell.win.localStorage,
      }),
    );
    assert.equal(shell.win.sessionStorage.length, 0);

    shell.win.dispatchEvent(
      new shell.win.StorageEvent("storage", {
        key: null,
        storageArea: shell.win.sessionStorage,
      }),
    );
    const storage = shell.win.sessionStorage;
    assert.equal(storage.getItem("moodle-playground:active"), "k1");
    assert.equal(storage.getItem("blueprint-source:k1"), "default");
    assert.ok(storage.getItem("moodle-playground:blueprint:k1"));
    assert.equal(
      JSON.parse(storage.getItem("moodle-playground:k1:state")).path,
      "/my/",
    );
  });
});
