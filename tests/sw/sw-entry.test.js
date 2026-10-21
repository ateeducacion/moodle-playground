// Drives the shipped sw.js through fake Service Worker globals: the module
// registers its install/activate/fetch/message listeners on `self` at import.
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import { BUILD_VERSION } from "../../src/generated/build-version.js";
import {
  buildScopedStaticCacheName,
  buildStaticCacheName,
} from "../../src/shared/cache-names.js";

const ORIGIN = "https://play.test";
const BASE = `${ORIGIN}/moodle-playground`;
const STATIC_CACHE = buildStaticCacheName(BUILD_VERSION);
const SCOPED_CACHE = buildScopedStaticCacheName(BUILD_VERSION);

class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  async match(key) {
    return this.entries.get(String(key))?.clone();
  }
  async put(key, response) {
    this.entries.set(String(key), response);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(key) {
    return this.entries.delete(typeof key === "string" ? key : key.url);
  }
}

const cacheStore = new Map();
const caches = {
  async open(name) {
    if (!cacheStore.has(name)) cacheStore.set(name, new FakeCache());
    return cacheStore.get(name);
  },
  async keys() {
    return [...cacheStore.keys()];
  },
  async delete(name) {
    return cacheStore.delete(name);
  },
};

const channels = [];
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.posted = [];
    this.listeners = [];
    channels.push(this);
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.push(listener);
  }
  postMessage(message) {
    this.posted.push(message);
    this.onPost?.(message);
  }
  deliver(data) {
    for (const listener of this.listeners) listener({ data });
  }
}

const listeners = {};
const posted = [];
let clientList = [];
let fetchImpl;
const fetchCalls = [];
const state = { claimed: 0, skipped: 0, timers: [] };

const self = {
  location: new URL(`${BASE}/sw.bundle.js`),
  registration: { scope: `${BASE}/` },
  addEventListener(type, listener) {
    listeners[type] = listener;
  },
  skipWaiting: async () => {
    state.skipped += 1;
  },
  setTimeout(fn, ms) {
    state.timers.push({ fn, ms });
    return state.timers.length;
  },
  clients: {
    claim: async () => {
      state.claimed += 1;
    },
    get: async (id) => clientList.find((c) => c.id === id) ?? null,
    matchAll: async () => clientList,
  },
};

function bridge(scopeId) {
  return channels.find((c) => c.name === `moodle-playground-php:${scopeId}`);
}

// Answer every bridged PHP request for `scopeId` with `response`.
function answerPhp(scopeId, responseOrFn) {
  const respond = (message) => {
    const reply =
      typeof responseOrFn === "function" ? responseOrFn(message) : responseOrFn;
    if (!reply) return;
    queueMicrotask(() => bridge(scopeId).deliver({ id: message.id, ...reply }));
  };
  const existing = bridge(scopeId);
  if (existing) {
    existing.onPost = respond;
    return;
  }
  pendingAnswers.set(scopeId, respond);
}
const pendingAnswers = new Map();
const OriginalChannel = FakeBroadcastChannel;
class AnsweringChannel extends OriginalChannel {
  constructor(name) {
    super(name);
    const scopeId = name.split(":")[1];
    if (pendingAnswers.has(scopeId)) this.onPost = pendingAnswers.get(scopeId);
  }
}

function makeRequest(url, init = {}, extras = {}) {
  const request = new Request(url, init);
  for (const [key, value] of Object.entries(extras)) {
    Object.defineProperty(request, key, { value });
  }
  return request;
}

async function dispatchFetch(request, { clientId = "" } = {}) {
  const waits = [];
  let responded;
  listeners.fetch({
    request,
    clientId,
    respondWith(promise) {
      responded = promise;
    },
    waitUntil(promise) {
      waits.push(promise);
    },
  });
  if (!responded) return { response: undefined, waits };
  const response = await responded;
  await Promise.all(waits);
  return { response, waits };
}

const htmlReply = (body, extra = {}) => ({
  kind: "http-response",
  response: {
    body,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html; charset=utf-8" },
    ...extra,
  },
});

before(async () => {
  globalThis.self = self;
  globalThis.caches = caches;
  globalThis.BroadcastChannel = AnsweringChannel;
  globalThis.fetch = async (input, init) => {
    fetchCalls.push({ input, init });
    return fetchImpl(input, init);
  };
  await import("../../sw.js");
});

beforeEach(() => {
  cacheStore.clear();
  fetchCalls.length = 0;
  posted.length = 0;
  clientList = [];
  state.timers.length = 0;
  fetchImpl = async () => new Response("network", { status: 200 });
});

describe("sw.js lifecycle", () => {
  it("skips waiting on install", async () => {
    let waited;
    listeners.install({ waitUntil: (p) => (waited = p) });
    await waited;
    assert.equal(state.skipped, 1);
  });

  it("claims clients and purges stale app caches on activate", async () => {
    for (const name of [
      STATIC_CACHE,
      SCOPED_CACHE,
      "moodle-playground-static-old",
      "moodle-playground-bundles-v1",
      "unrelated-app-cache",
    ]) {
      await caches.open(name);
    }
    let waited;
    listeners.activate({ waitUntil: (p) => (waited = p) });
    await waited;
    assert.equal(state.claimed, 1);
    assert.deepEqual(
      [...cacheStore.keys()].sort(),
      [SCOPED_CACHE, STATIC_CACHE, "unrelated-app-cache"].sort(),
    );
  });

  it("still activates when deleting the bundle cache throws", async () => {
    const original = caches.delete;
    caches.delete = async (name) => {
      if (name === "moodle-playground-bundles-v1") throw new Error("boom");
      return original(name);
    };
    let waited;
    listeners.activate({ waitUntil: (p) => (waited = p) });
    await assert.doesNotReject(waited);
    caches.delete = original;
  });
});

describe("sw.js messages", () => {
  it("retries loading the playground config after a failure", async () => {
    let attempts = 0;
    fetchImpl = async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("", { status: 500 })
        : Response.json({});
    };
    const url = `${BASE}/playground/sM/rM/__playground_proxy__?url=y`;
    // A failed proxy request renders the error page instead of rejecting
    // respondWith() (#380).
    const failed = await dispatchFetch(makeRequest(url));
    assert.equal(failed.response.status, 500);
    assert.match(
      await failed.response.text(),
      /Unable to load playground config: 500/,
    );

    const { response } = await dispatchFetch(makeRequest(url));
    assert.equal(attempts, 2);
    assert.equal(response.status, 502);
    assert.match(await response.text(), /No addon proxy configured/);
    assert.equal(String(fetchCalls[0].input), `${BASE}/playground.config.json`);
    assert.equal(fetchCalls[0].init.cache, "no-store");
  });

  it("clears the scoped static cache on request", async () => {
    await caches.open(SCOPED_CACHE);
    listeners.message({ data: { kind: "clear-scoped-static-cache" } });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cacheStore.has(SCOPED_CACHE), false);
  });

  it("only accepts an addon proxy override from the remote host page", async () => {
    fetchImpl = async () =>
      new Response("proxied", {
        status: 201,
        headers: { "content-length": "7" },
      });
    const proxyRequest = () =>
      makeRequest(`${BASE}/playground/s1/r1/__playground_proxy__?url=x`, {
        method: "POST",
        body: "payload",
        headers: { host: "play.test", "x-test": "1" },
      });

    listeners.message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://evil.test/p",
      },
      source: { url: `${BASE}/playground/s1/r1/course/view.php` },
    });
    listeners.message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://evil.test/p",
      },
      source: { url: "not a url" },
    });
    let { response } = await dispatchFetch(proxyRequest());
    assert.equal(response.status, 502);
    assert.equal(fetchCalls.length, 0);

    listeners.message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://proxy.test/dl",
      },
      source: { url: `${BASE}/remote.html?scope=s1` },
    });
    ({ response } = await dispatchFetch(proxyRequest()));
    assert.equal(response.status, 201);
    assert.equal(await response.text(), "proxied");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("content-length"), false);
    const [upstream] = fetchCalls;
    assert.equal(upstream.input, "https://proxy.test/dl?url=x");
    assert.equal(upstream.init.method, "POST");
    assert.equal(upstream.init.headers.get("x-test"), "1");
    assert.equal(new TextDecoder().decode(upstream.init.body), "payload");

    // Clearing the override falls back to the (empty) config value.
    listeners.message({
      data: { kind: "configure-service-worker", addonProxyUrl: "" },
      source: { url: `${BASE}/remote.html` },
    });
    ({ response } = await dispatchFetch(proxyRequest()));
    assert.equal(response.status, 502);
  });

  it("ignores a remote.html outside the app base path (#379)", async () => {
    fetchImpl = async () => new Response("proxied");
    // Same origin, but the origin root, not /moodle-playground/remote.html.
    listeners.message({
      data: {
        kind: "configure-service-worker",
        addonProxyUrl: "https://evil.test/p",
      },
      source: { url: `${ORIGIN}/remote.html` },
    });
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/playground/s1/r1/__playground_proxy__?url=x`),
    );
    // Reset the override in case the message was (wrongly) accepted.
    listeners.message({
      data: { kind: "configure-service-worker", addonProxyUrl: "" },
      source: { url: `${BASE}/remote.html` },
    });
    // No proxy override was installed, so nothing was proxied.
    assert.equal(response.status, 502);
    assert.match(await response.text(), /No addon proxy configured/);
  });
});

describe("sw.js fetch routing", () => {
  it("ignores cross-origin requests other than moodle.org", async () => {
    const { response } = await dispatchFetch(
      makeRequest("https://cdn.test/x.js"),
    );
    assert.equal(response, undefined);
  });

  it("replaces moodle.org frames with a friendly notice", async () => {
    const { response } = await dispatchFetch(
      makeRequest("https://moodle.org/plugins/"),
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Moodle Plugin Directory unavailable/);
    assert.equal(fetchCalls.length, 0);
  });

  it("passes unscoped, non-static requests straight to the network", async () => {
    const request = makeRequest(`${BASE}/README.md`);
    const { response } = await dispatchFetch(request);
    assert.equal(await response.text(), "network");
    assert.equal(fetchCalls[0].input, request);
  });

  it("never caches non-GET requests to static paths", async () => {
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/index.html`, { method: "POST", body: "x" }),
    );
    assert.equal(await response.text(), "network");
    assert.equal(cacheStore.size, 0);
  });

  it("does not cache the service worker script itself", async () => {
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/sw.bundle.js`),
    );
    assert.equal(await response.text(), "network");
    assert.equal(cacheStore.size, 0);
  });

  it("serves static host assets cache-first, ignoring the query string", async () => {
    fetchImpl = async () => new Response("bundle-v1");
    let { response } = await dispatchFetch(
      makeRequest(`${BASE}/dist/php-worker.bundle.js?v=1`),
    );
    assert.equal(await response.text(), "bundle-v1");
    const key = `${BASE}/dist/php-worker.bundle.js`;
    assert.ok(cacheStore.get(STATIC_CACHE).entries.has(key));
    assert.equal(fetchCalls[0].input.cache, "no-store");

    fetchImpl = async () => new Response("bundle-v2");
    ({ response } = await dispatchFetch(
      makeRequest(`${BASE}/dist/php-worker.bundle.js?v=2`),
    ));
    assert.equal(await response.text(), "bundle-v1");
    assert.equal(fetchCalls.length, 1);
  });

  it("serves sensitive files network-first with a cached fallback", async () => {
    const url = `${BASE}/playground.config.json`;
    fetchImpl = async () => new Response("fresh-1");
    let { response } = await dispatchFetch(makeRequest(url));
    assert.equal(await response.text(), "fresh-1");

    fetchImpl = async () => new Response("fresh-2");
    ({ response } = await dispatchFetch(makeRequest(url)));
    assert.equal(await response.text(), "fresh-2");

    fetchImpl = async () => new Response("down", { status: 503 });
    ({ response } = await dispatchFetch(makeRequest(url)));
    assert.equal(await response.text(), "fresh-2");

    fetchImpl = async () => {
      throw new TypeError("offline");
    };
    ({ response } = await dispatchFetch(makeRequest(url)));
    assert.equal(await response.text(), "fresh-2");
  });

  it("renders the error page when an uncached static file is unreachable", async () => {
    fetchImpl = async () => {
      throw new TypeError("offline");
    };
    // Network-first (sensitive) and cache-first static fetches both end in
    // the HTML error page, not a browser network error (#380).
    for (const path of ["/index.html", "/dist/php-worker.bundle.js"]) {
      const { response } = await dispatchFetch(makeRequest(`${BASE}${path}`));
      assert.equal(response.status, 500, path);
      assert.match(await response.text(), /offline/, path);
    }
  });

  it("renders unexpected handler failures as an escaped error page", async () => {
    const original = self.clients.get;
    self.clients.get = async () => {
      throw new Error("clients <gone>");
    };
    const { response } = await dispatchFetch(makeRequest(`${BASE}/foo.php`), {
      clientId: "broken",
    });
    self.clients.get = original;
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /clients &lt;gone&gt;/);
  });

  it("forwards scoped requests to the PHP bridge and rewrites HTML and Location", async () => {
    answerPhp("sA", (message) => {
      if (message.request.url.endsWith("/login/index.php")) {
        return {
          kind: "http-response",
          response: {
            body: "",
            status: 303,
            statusText: "See Other",
            headers: { location: "/my/?x=1#top" },
          },
        };
      }
      return htmlReply(
        '<a href="/moodle-playground/course/view.php?id=2">c</a>',
        {
          headers: { "content-type": "text/html", "content-length": "40" },
        },
      );
    });
    const page = await dispatchFetch(
      makeRequest(`${BASE}/playground/sA/rA/index.php?x=1`),
      { clientId: "c1" },
    );
    const sent = bridge("sA").posted[0];
    assert.equal(sent.kind, "http-request");
    assert.equal(sent.request.method, "GET");
    assert.equal(sent.request.url, `${ORIGIN}/index.php?x=1`);
    assert.equal(page.response.headers.has("content-length"), false);
    assert.match(
      await page.response.text(),
      /href="\/moodle-playground\/playground\/sA\/rA\/course\/view\.php\?id=2"/,
    );

    clientList = [{ id: "w1", postMessage: (m) => posted.push(m) }];
    const redirect = await dispatchFetch(
      makeRequest(`${BASE}/playground/sA/rA/login/index.php`, {
        redirect: "manual",
      }),
    );
    assert.equal(redirect.response.status, 303);
    assert.equal(
      redirect.response.headers.get("location"),
      "/moodle-playground/playground/sA/rA/my/?x=1#top",
    );
    assert.match(
      posted[0].detail,
      /Redirect 303 from \/login\/index\.php → Location: \/my\//,
    );
  });

  it("leaves cross-origin redirects and non-HTML bodies untouched", async () => {
    answerPhp("sB", (message) =>
      message.request.url.endsWith("/out.php")
        ? {
            kind: "http-response",
            response: {
              body: "",
              status: 302,
              statusText: "Found",
              headers: { location: "https://other.test/x" },
            },
          }
        : {
            kind: "http-response",
            response: {
              body: '{"a":"/x"}',
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
            },
          },
    );
    const out = await dispatchFetch(
      makeRequest(`${BASE}/playground/sB/rB/out.php`),
    );
    assert.equal(out.response.headers.get("location"), "https://other.test/x");
    const json = await dispatchFetch(
      makeRequest(`${BASE}/playground/sB/rB/ajax.php`),
    );
    assert.equal(await json.response.text(), '{"a":"/x"}');
  });

  it("buffers POST bodies and forwards them to PHP", async () => {
    answerPhp("sC", htmlReply("ok"));
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/playground/sC/rC/login/index.php`, {
        method: "POST",
        body: "username=admin",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    assert.equal(await response.text(), "ok");
    const sent = bridge("sC").posted[0].request;
    assert.equal(sent.method, "POST");
    assert.equal(new TextDecoder().decode(sent.body), "username=admin");
    assert.equal(
      sent.headers["content-type"],
      "application/x-www-form-urlencoded",
    );
  });

  it("turns PHP worker errors into escaped error pages", async () => {
    answerPhp("sD", { kind: "http-error", error: "Fatal <boom>" });
    let { response } = await dispatchFetch(
      makeRequest(`${BASE}/playground/sD/rD/x.php`),
    );
    assert.equal(response.status, 500);
    assert.match(await response.text(), /Fatal &lt;boom&gt;/);

    answerPhp("sD", { kind: "http-error" });
    ({ response } = await dispatchFetch(
      makeRequest(`${BASE}/playground/sD/rD/y.php`),
    ));
    assert.match(await response.text(), /Unknown PHP worker error\./);
  });

  it("ignores bridge messages for unknown requests and times out stalled ones", async () => {
    answerPhp("sE", () => null);
    bridge("sE")?.deliver({});
    const pendingFetch = (async () => {
      const result = dispatchFetch(
        makeRequest(`${BASE}/playground/sE/rE/slow.php`),
      );
      return result;
    })();
    await new Promise((r) => setTimeout(r, 10));
    // Unknown id and missing id are ignored; the request stays pending.
    bridge("sE").deliver({ id: "nope", kind: "http-response" });
    bridge("sE").deliver(null);
    const timer = state.timers.find((t) => t.ms === 300000);
    assert.ok(timer);
    timer.fn();
    const { response } = await pendingFetch;
    assert.equal(response.status, 504);
    assert.match(await response.text(), /PHP worker bridge timed out\./);
  });

  it("resolves unscoped subresources from a scoped referrer", async () => {
    answerPhp("sF", htmlReply("from referrer"));
    const { response } = await dispatchFetch(
      makeRequest(
        `${BASE}/lib/ajax/service.php?info=x`,
        {},
        {
          referrer: `${BASE}/playground/sF/rF/course/view.php`,
        },
      ),
    );
    assert.equal(await response.text(), "from referrer");
    assert.equal(
      bridge("sF").posted[0].request.url,
      `${ORIGIN}/lib/ajax/service.php?info=x`,
    );
  });

  it("redirects unscoped navigations into the client's scope", async () => {
    clientList = [{ id: "nav1", url: `${BASE}/playground/sG/rG/my/` }];
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/course/view.php?id=3`, {}, { mode: "navigate" }),
      { clientId: "nav1" },
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      `${BASE}/playground/sG/rG/course/view.php?id=3`,
    );
  });

  it("remembers a client's scope after its first scoped request", async () => {
    answerPhp("sH", htmlReply("remembered"));
    await dispatchFetch(makeRequest(`${BASE}/playground/sH/rH/`), {
      clientId: "known",
    });
    // The client is gone from clients.get(), but its context is cached.
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/pluginfile.php/1/x`),
      {
        clientId: "known",
      },
    );
    assert.equal(await response.text(), "remembered");
  });

  it("falls back to the network for clients outside any scope", async () => {
    clientList = [{ id: "plain", url: `${BASE}/other/page` }];
    const { response } = await dispatchFetch(makeRequest(`${BASE}/foo.php`), {
      clientId: "plain",
    });
    assert.equal(await response.text(), "network");
  });

  it("caches scoped static assets outside the PHP queue", async () => {
    let served = 0;
    answerPhp("sI", () => {
      served += 1;
      return {
        kind: "http-response",
        response: {
          body: "body{}",
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/css" },
        },
      };
    });
    const url = `${BASE}/playground/sI/rI/theme/boost/style/moodle.css`;
    const first = await dispatchFetch(makeRequest(url));
    assert.equal(await first.response.text(), "body{}");
    await new Promise((r) => setTimeout(r, 0));
    const key = `${ORIGIN}/playground/sI/rI/theme/boost/style/moodle.css`;
    assert.ok(cacheStore.get(SCOPED_CACHE).entries.has(key));

    const second = await dispatchFetch(makeRequest(url));
    assert.equal(await second.response.text(), "body{}");
    assert.equal(served, 1);
  });

  it("does not cache uncacheable scoped asset responses", async () => {
    answerPhp("sJ", {
      kind: "http-response",
      response: {
        body: "nope",
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/css" },
      },
    });
    const { response } = await dispatchFetch(
      makeRequest(`${BASE}/playground/sJ/rJ/missing.css`),
    );
    assert.equal(response.status, 404);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cacheStore.get(SCOPED_CACHE).entries.size, 0);
  });

  it("evicts the oldest scoped assets beyond 300 entries", async () => {
    const scoped = await caches.open(SCOPED_CACHE);
    for (let i = 0; i < 300; i += 1) {
      await scoped.put(`${ORIGIN}/old/${i}`, new Response("x"));
    }
    answerPhp("sK", {
      kind: "http-response",
      response: {
        body: "img",
        status: 200,
        statusText: "OK",
        headers: { "content-type": "image/png" },
      },
    });
    await dispatchFetch(makeRequest(`${BASE}/playground/sK/rK/pix/a.png`));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(scoped.entries.size, 300);
    assert.equal(scoped.entries.has(`${ORIGIN}/old/0`), false);
    assert.ok(scoped.entries.has(`${ORIGIN}/playground/sK/rK/pix/a.png`));
  });

  it("prunes remembered contexts of closed clients beyond 50 entries", async () => {
    answerPhp("sL", htmlReply("ok"));
    clientList = [{ id: "live-0" }];
    for (let i = 0; i < 52; i += 1) {
      await dispatchFetch(makeRequest(`${BASE}/playground/sL/rL/p${i}.php`), {
        clientId: `live-${i}`,
      });
    }
    // live-1 was pruned (not an active window), so its unscoped request falls
    // through to the network; live-0 is still active and keeps its scope.
    clientList = [];
    const pruned = await dispatchFetch(makeRequest(`${BASE}/x.php`), {
      clientId: "live-1",
    });
    assert.equal(await pruned.response.text(), "network");
    const kept = await dispatchFetch(makeRequest(`${BASE}/x.php`), {
      clientId: "live-0",
    });
    assert.equal(await kept.response.text(), "ok");
  });
});
