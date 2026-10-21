/**
 * Drives the real php-worker.js message/bridge handlers end to end with its
 * runtime boundary (php-loader.js + bootstrap.js) replaced by scriptable fakes
 * (tests/runtime/fixtures/fake-worker-deps.mjs). Covers lazy boot, the static
 * fast path, plugin-install tracking, error responses, crash recovery with
 * snapshot restore, the restart guards and the shell side-channel messages.
 *
 * The worker keeps module-level state, so the tests below run in order and
 * build on each other.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createPhpBridgeChannel } from "../../src/shared/protocol.js";
import {
  getBranchMetadata,
  resolveRuntimeSelection,
} from "../../src/shared/version-resolver.js";

const FAKE_URL = new URL("./fixtures/fake-worker-deps.mjs", import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier === "./src/runtime/php-loader.js" ||
        specifier === "./src/runtime/bootstrap.js") &&
      context.parentURL?.endsWith("/php-worker.js")
    ) {
      return { url: FAKE_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { state } = await import(FAKE_URL);

const PARAMS = {
  scopeId: "s1",
  instanceId: "i1",
  phpVersion: "8.4",
  moodleBranch: "MOODLE_501_STABLE",
  forceCleanBoot: true,
  phpCorsProxyUrl: "https://cors.test/?url=",
  debug: "true",
  profile: "runtime",
  opcache: "0",
};
const SELECTION = resolveRuntimeSelection(PARAMS);
const WEB_ROOT = getBranchMetadata(PARAMS.moodleBranch).webRoot;
const DB_PATH = `/persist/moodledata/moodle_s1_${SELECTION.runtimeId.replace(/[^A-Za-z0-9_]/gu, "_")}.sq3.php`;
const FATAL = "memory access out of bounds";

// --- Worker globals -------------------------------------------------------
const shell = [];
const workerMessages = [];
const waiters = new Map();
let bridge = null;
let bridgeThrows = false;
const bridgeName = createPhpBridgeChannel(PARAMS.scopeId);

globalThis.BroadcastChannel = class extends EventTarget {
  constructor(name) {
    super();
    this.name = name;
    if (name === bridgeName) bridge = this;
  }
  postMessage(message) {
    if (this.name !== bridgeName) {
      shell.push(message);
      return;
    }
    if (bridgeThrows) throw new Error("bridge closed");
    waiters.get(message.id)?.(message.response);
  }
  close() {
    this.closed = true;
  }
};
const worker = new EventTarget();
worker.location = new URL("https://example.test/php-worker.js?scope=stale");
worker.postMessage = (message) => workerMessages.push(message);
globalThis.self = worker;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/playground.config.json")) {
    return new Response(
      readFileSync(new URL("../../playground.config.json", import.meta.url)),
    );
  }
  return new Response("missing", { status: 404 });
};

await import("../../php-worker.js");

// --- Helpers --------------------------------------------------------------
let nextId = 0;
function send(url, { method = "GET", body, ...extra } = {}) {
  nextId += 1;
  const id = `r${nextId}`;
  return new Promise((resolve) => {
    waiters.set(id, (response) => {
      resolve({
        ...response,
        text: new TextDecoder().decode(response.body),
      });
    });
    bridge.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "http-request",
          id,
          request: {
            url: `https://example.test${url}`,
            method,
            headers: {},
            body,
          },
          ...extra,
        },
      }),
    );
  });
}

async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    const found = predicate();
    if (found) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

const shellSince = (start) => shell.slice(start);
const details = (messages) => messages.map((m) => m.detail || m.message || "");

async function warmUp(count) {
  for (let i = 0; i < count; i += 1) await send("/index.php");
}

function failOnce(predicate, error) {
  let failed = false;
  state.handler = (runtime, request) => {
    if (!failed && predicate(request)) {
      failed = true;
      throw error;
    }
    return defaultHandler(runtime, request);
  };
}

let autologin = null;
function defaultHandler(_runtime, request) {
  if (request.url.includes("__playground_autologin")) {
    if (autologin) return autologin();
    return new Response('{"ok":true}', { status: 200 });
  }
  return new Response("ok", { status: 200 });
}

function configure(data) {
  worker.dispatchEvent(new MessageEvent("message", { data }));
}

// --- Tests ----------------------------------------------------------------
describe("php-worker request bridge", () => {
  it("accepts authoritative configuration and captures phpinfo before boot", async () => {
    configure({
      kind: "configure-blueprint",
      runtimeParams: PARAMS,
      blueprint: { landingPage: "/course/view.php?id=2" },
    });
    assert.deepEqual(workerMessages.at(-1), {
      kind: "worker-ready",
      scopeId: "s1",
      runtimeId: SELECTION.runtimeId,
      initialPath: "/course/view.php?id=2",
    });

    // No runtime config yet: the worker loads the playground config itself.
    configure({ kind: "capture-phpinfo" });
    const info = await until(() => shell.find((m) => m.kind === "phpinfo"));
    assert.equal(info.html, "<h1>phpinfo</h1>");
    assert.equal(info.reason, "manual");
    assert.match(
      info.detail,
      /Captured PHP runtime diagnostics \(manual\)\.\nwarning: x/,
    );
    assert.equal(state.provisioning[0].options.phpVersion, "8.4");
  });

  it("boots lazily on the first request with the configured runtime", async () => {
    const start = shell.length;
    const response = await send("/index.php");
    assert.equal(response.status, 200);
    assert.equal(response.text, "ok");

    const [runtime] = state.runtimes;
    assert.equal(runtime.runtimeConfig.corsProxyUrl, PARAMS.phpCorsProxyUrl);
    assert.equal(runtime.runtimeConfig.opcache, false);
    assert.equal(runtime.options.webRoot, WEB_ROOT);
    assert.equal(runtime.options.scopeId, "s1");
    assert.equal(runtime.options.forceCleanBoot, true);
    assert.equal(runtime.options.phpVersion, "8.4");
    assert.equal(runtime.refreshed, true);

    const [boot] = state.bootstrapCalls;
    assert.equal(boot.blueprint.landingPage, "/course/view.php?id=2");
    assert.equal(boot.debug, "true");
    assert.equal(boot.webRoot, WEB_ROOT);

    const messages = shellSince(start);
    assert.ok(
      details(messages).some((d) =>
        d.startsWith("[runtime-selection][worker:resolved]"),
      ),
    );
    const progress = messages
      .filter((m) => m.title === "Bootstrapping Moodle")
      .map((m) => m.progress);
    assert.deepEqual(progress, [0.2, 0.5, 0.5]);
    assert.match(
      messages.find((m) => m.title === "Boot timing summary").detail,
      /Bundle wait \(post-refresh\): 7ms/,
    );
    assert.equal(messages.find((m) => m.kind === "ready").path, "/my/");
  });

  it("serves static hits without queueing and falls back when the fast path throws", async () => {
    const bytes = new TextEncoder().encode("body{}");
    state.staticHit = {
      status: 200,
      headers: { "content-type": "text/css" },
      bytes,
    };
    const before = state.runtimes[0].requests.length;
    const hit = await send("/theme/a.css");
    assert.equal(hit.text, "body{}");
    assert.equal(hit.headers["content-type"], "text/css");
    assert.equal(state.runtimes[0].requests.length, before);

    state.staticHit = () => {
      throw new Error("bad url");
    };
    const queued = await send("/theme/b.css");
    assert.equal(queued.text, "ok");
    assert.equal(state.runtimes[0].requests.length, before + 1);
    state.staticHit = null;
  });

  it("tracks plugins installed through the admin UI", async () => {
    const start = shell.length;
    const redirect = (location) => () =>
      new Response(null, { status: 303, headers: { location } });
    await send(
      "/admin/tool/installaddon/index.php?installzipcomponent=mod_attendance",
    );
    await send("/admin/tool/installaddon/index.php?installzipcomponent=zzz_x");
    await send("/admin/tool/installaddon/index.php");
    let postedBody = null;
    state.handler = async (_runtime, request) => {
      postedBody = await request.text();
      return redirect("/x?installzipcomponent=block_foo")();
    };
    await send("/admin/tool/installaddon/index.php", {
      method: "POST",
      body: "installzip=1",
    });
    assert.equal(postedBody, "installzip=1");
    state.handler = redirect("/x?installzipcomponent=zzz_bar");
    await send("/admin/tool/installaddon/index.php", { method: "POST" });
    state.handler = redirect("/x?other=1");
    await send("/admin/tool/installaddon/index.php", { method: "POST" });
    state.handler = () => new Response(null, { status: 303 });
    await send("/admin/tool/installaddon/index.php", { method: "POST" });
    state.handler = () => new Response("ok", { status: 200 });
    await send("/admin/tool/installaddon/index.php", { method: "POST" });
    state.handler = () => ({
      status: 302,
      statusText: "",
      headers: {
        get() {
          throw new Error("no headers");
        },
        entries: () => [][Symbol.iterator](),
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const odd = await send("/admin/tool/installaddon/index.php", {
      method: "POST",
    });
    assert.equal(odd.status, 302);
    state.handler = null;

    const tracked = details(shellSince(start)).filter((d) =>
      d.includes("tracking installed plugin"),
    );
    assert.deepEqual(tracked, [
      `[snapshot] tracking installed plugin: ${WEB_ROOT}/mod/attendance`,
      `[snapshot] tracking installed plugin: ${WEB_ROOT}/blocks/foo`,
    ]);
  });

  it("answers PHP errors with 500 plus the PHP error_log and network errors with 502", async () => {
    state.handler = () => {
      throw new Error("Undefined index: x");
    };
    state.errorLog = new TextEncoder().encode("PHP Fatal error: y");
    const start = shell.length;
    const broken = await send("/broken.php?sesskey=secret");
    assert.equal(broken.status, 500);
    assert.match(broken.text, /Undefined index: x/);
    assert.match(broken.text, /=== PHP error_log ===\nPHP Fatal error: y/);
    const error = await until(() =>
      shellSince(start).find((m) => m.kind === "error"),
    );
    assert.equal(error.path, "/broken.php");

    state.errorLog = "   ";
    const noLog = await send("/broken.php");
    assert.doesNotMatch(noLog.text, /PHP error_log/);
    state.errorLog = new Error("EACCES");
    const unreadable = await send("/broken.php");
    assert.equal(unreadable.status, 500);
    assert.doesNotMatch(unreadable.text, /PHP error_log/);
    state.errorLog = "";

    state.handler = () => {
      throw Object.assign(new Error("connect failed"), { errno: 23 });
    };
    const net = await send("/repository/x.php");
    assert.equal(net.status, 502);
    assert.match(net.text, /errno 23/);
    assert.equal(shell.at(-1).kind, "wasm-network-error");
    assert.equal(shell.at(-1).path, "/repository/x.php");
    state.handler = null;
  });

  it("replays an idempotent request on a fresh runtime and restores the crashed state", async () => {
    state.rawFiles.set(DB_PATH, new Uint8Array([1, 2, 3]));
    state.rawFiles.set(
      `${WEB_ROOT}/mod/attendance/version.php`,
      new TextEncoder().encode("<?php"),
    );
    state.cacheResetError = new Error("purge failed");
    failOnce((r) => r.url.endsWith("/crash.php"), new Error(FATAL));
    const start = shell.length;

    const response = await send("/crash.php");
    assert.equal(response.status, 200);
    assert.equal(response.text, "ok");
    assert.equal(state.runtimes.length, 2);
    assert.equal(state.cacheResets, 1);

    const fresh = state.runtimes[1];
    assert.match(
      fresh.runs[0],
      new RegExp(
        `playground_refresh_installed_plugin_cache\\('mod_attendance', '${WEB_ROOT}/mod/attendance'\\)`,
      ),
    );
    assert.equal(fresh.writes[0][0], `${WEB_ROOT}/__playground_autologin.php`);
    assert.match(
      fresh.runs.at(-1),
      /@unlink\('.*__playground_autologin\.php'\)/,
    );
    assert.ok(fresh._php.written.includes(DB_PATH));

    const log = details(shellSince(start));
    for (const expected of [
      "[runtime] restart (1/20)",
      "hydrating snapshot before runtime reset",
      `plugin dir not found: ${WEB_ROOT}/blocks/foo`,
      "Purge caches before trusting cached settings.",
      "[snapshot] re-registered plugins after restore",
      "[snapshot] re-created admin session after DB restore",
      "[runtime] replaying request on fresh runtime",
    ]) {
      assert.ok(
        log.some((d) => d.includes(expected)),
        `missing shell message: ${expected}`,
      );
    }
    state.handler = null;
    state.cacheResetError = null;
  });

  it("does not replay a crashed POST and reports a failed recovery boot", async () => {
    await warmUp(10);
    state.flushResult = { ok: false, reason: "quota" };
    state.bootstrapError = new Error("bootstrap failed");
    failOnce((r) => r.method === "POST", new Error(FATAL));
    const start = shell.length;

    const response = await send("/course/edit.php", { method: "POST" });
    assert.equal(response.status, 503);
    assert.match(response.text, /Non-idempotent request was not retried/);
    await until(() =>
      details(shellSince(start)).some((d) =>
        d.startsWith("Runtime recovery failed: Error: bootstrap failed"),
      ),
    );
    const log = details(shellSince(start));
    assert.ok(log.some((d) => d.includes("filedir checkpoint failed")));
    const info = await until(() =>
      shell.find((m) => m.kind === "phpinfo" && m.reason === "bootstrap-error"),
    );
    assert.equal(info.html, "<h1>phpinfo</h1>");
    state.flushResult = { ok: true };
    state.handler = null;
  });

  it("gives up when the replay boot crashes again", async () => {
    // The boot still fails: every warm-up answers 500 but counts as a request.
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await send("/index.php")).status, 500);
    }
    state.bootstrapError = new Error("RuntimeError: unreachable");
    const start = shell.length;
    const response = await send("/index.php");
    assert.equal(response.status, 503);
    assert.match(response.text, /Runtime crashed again on retry/);
    const log = details(shellSince(start));
    assert.ok(log.some((d) => d.includes("no PHP instance available")));
    assert.ok(log.some((d) => d.includes("crash after only 0 requests")));
    state.bootstrapError = null;
  });

  it("does not restart a runtime that crashes during its first requests", async () => {
    await send("/index.php");
    failOnce((r) => r.url.endsWith("/early.php"), new Error(FATAL));
    const response = await send("/early.php");
    assert.equal(response.status, 500);
    assert.match(response.text, /Runtime restart limit reached/);
    assert.ok(shell.at(-1).detail.includes("crash after only"));
    state.handler = null;
  });

  it("stops restarting after the reactive restart limit", async () => {
    // Restarts used so far: replay, POST, failed replay boot. Each restart
    // below restores the snapshot; vary how the restored runtime answers the
    // plugin re-registration and the re-login.
    const start = shell.length;
    const variants = {
      4: () => {
        state.runResult = { text: '{"ok":false}', errors: "PHP Warning: w" };
      },
      5: () => {
        state.runResult = () => {
          throw new Error("run broke");
        };
      },
      6: () => {
        autologin = () => new Response("denied", { status: 403 });
      },
      7: () => {
        autologin = () => {
          throw new Error("login crashed");
        };
      },
    };
    for (let restart = 4; restart <= 20; restart += 1) {
      await warmUp(10);
      variants[restart]?.();
      failOnce((r) => r.url.endsWith("/again.php"), new Error(FATAL));
      assert.equal((await send("/again.php")).status, 200);
      state.runResult = { text: '{"ok":true}', errors: "" };
      autologin = null;
    }
    const log = details(shellSince(start));
    for (const expected of [
      "plugin re-register PHP errors: PHP Warning: w",
      'plugin re-register result: {"ok":false}',
      "plugin re-register failed: run broke",
      "re-login returned unexpected response: denied",
      "re-login failed: login crashed",
    ]) {
      assert.ok(
        log.some((d) => d.includes(expected)),
        `missing shell message: ${expected}`,
      );
    }
    await warmUp(10);
    failOnce((r) => r.url.endsWith("/again.php"), new Error(FATAL));
    const response = await send("/again.php");
    assert.equal(response.status, 500);
    assert.ok(
      details(shell).some((d) => d.includes("restart limit reached (20/20)")),
    );
    state.handler = null;
  });

  it("warns once a long-lived runtime reaches the request high watermark", async () => {
    const start = shell.length;
    const pending = [];
    for (let i = 0; i < 1500; i += 1) pending.push(send("/index.php"));
    await Promise.all(pending);
    const warning = shellSince(start).find((m) => m.kind === "log");
    assert.equal(warning.level, "warn");
    assert.match(warning.message, /Request count reached 1500/);
  });

  it("flushes the journal on request and reports failures", async () => {
    for (const [result, expected] of [
      [{ ok: true }, "Persistence journal flushed."],
      [{ ok: false, reason: "quota" }, "Persistence flush failed: quota"],
      [{ ok: false }, "Persistence flush failed: unknown"],
      [new Error("idb gone"), "Persistence flush failed: Error: idb gone"],
    ]) {
      state.flushResult = result;
      const start = shell.length;
      configure({ kind: "flush-persistence" });
      const flushed = await until(() =>
        shellSince(start).find((m) => m.kind === "persistence-flushed"),
      );
      assert.ok(flushed.detail.startsWith(expected), flushed.detail);
    }
    state.flushResult = { ok: true };
  });

  it("shares one phpinfo capture and reports a failing capture", async () => {
    const before = state.provisioning.length;
    state.phpinfoError = new Error("wasm <load> failed");
    const start = shell.length;
    configure({ kind: "capture-phpinfo" });
    configure({ kind: "capture-phpinfo" });
    const infos = await until(() => {
      const found = shellSince(start).filter((m) => m.kind === "phpinfo");
      return found.length === 2 && found;
    });
    assert.equal(state.provisioning.length, before + 1);
    assert.match(infos[0].detail, /Failed to capture PHP runtime diagnostics/);
    assert.match(infos[0].html, /wasm &lt;load> failed/);
    state.phpinfoError = null;
  });

  it("logs a handler failure instead of wedging the queue", async () => {
    state.handler = () => {
      throw new Error("plain failure");
    };
    bridgeThrows = true;
    const start = shell.length;
    bridge.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "http-request",
          id: "lost",
          request: { url: "https://example.test/x.php", method: "GET" },
        },
      }),
    );
    const failure = await until(() =>
      shellSince(start).find((m) =>
        m.detail?.startsWith("[worker] request handler failed: bridge closed"),
      ),
    );
    assert.ok(failure);
    bridgeThrows = false;
    state.handler = null;
  });

  it("ignores unrelated messages and re-binds the bridge on reconfiguration", async () => {
    const oldBridge = bridge;
    oldBridge.dispatchEvent(
      new MessageEvent("message", { data: { kind: "ping" } }),
    );
    configure({ kind: "unknown" });
    configure({ kind: "configure-blueprint" });
    assert.equal(oldBridge.closed, true);
    assert.notEqual(bridge, oldBridge);
    assert.deepEqual(workerMessages.at(-1), {
      kind: "worker-ready",
      scopeId: "s1",
      runtimeId: SELECTION.runtimeId,
      initialPath: null,
    });
    configure({
      kind: "configure-blueprint",
      runtimeParams: {
        scopeId: "s1",
        phpCorsProxyUrl: "",
        debug: "0",
        profile: "",
      },
    });
    // The runtime is rebuilt with the new params on the next request.
    const runtimesBefore = state.runtimes.length;
    assert.equal((await send("/index.php")).status, 200);
    assert.equal(state.runtimes.length, runtimesBefore + 1);
    assert.equal(
      state.runtimes.at(-1).runtimeConfig.corsProxyUrl,
      "https://github-proxy.exelearning.dev/?url=",
    );
  });
});
