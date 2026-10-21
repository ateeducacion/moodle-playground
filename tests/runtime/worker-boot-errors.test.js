import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

// Drive the real php-worker.js through its bridge channel. Boot fails at the
// first step (loading playground.config.json), which runs before bootstrapMoodle.
const originals = {
  self: globalThis.self,
  BroadcastChannel: globalThis.BroadcastChannel,
  fetch: globalThis.fetch,
};
let workerCount = 0;

afterEach(() => Object.assign(globalThis, originals));

async function startWorker(fetchImpl) {
  const responses = new Map();
  let bridge = null;
  const worker = new EventTarget();
  worker.location = new URL("https://example.test/php-worker.js");
  worker.postMessage = () => {};
  globalThis.self = worker;
  globalThis.fetch = fetchImpl;
  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      if (name.startsWith("moodle-playground-php:")) bridge = this;
    }
    close() {}
    postMessage(message) {
      if (this === bridge && message.kind === "http-response") {
        responses.set(message.id, message.response);
      }
    }
  };
  workerCount += 1;
  await import(`../../php-worker.js?worker=${workerCount}`);
  worker.dispatchEvent(
    new MessageEvent("message", {
      data: {
        kind: "configure-blueprint",
        runtimeParams: { scopeId: "test", runtimeId: "php83-moodle53" },
      },
    }),
  );

  let nextId = 0;
  return async function request(method = "GET") {
    const id = ++nextId;
    bridge.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "http-request",
          id,
          request: { method, url: "https://example.test/", headers: {} },
        },
      }),
    );
    while (!responses.has(id)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const response = responses.get(id);
    return new TextDecoder().decode(response.body);
  };
}

it("retries the boot after a step before bootstrapMoodle() fails (#373)", async () => {
  let calls = 0;
  const request = await startWorker(async () => {
    calls += 1;
    throw new Error(`config unavailable #${calls}`);
  });

  assert.match(await request(), /config unavailable #1/u);
  assert.match(await request(), /config unavailable #2/u);
});

it("reports an early crash, not a restart limit, when the restart is declined (#373)", async () => {
  const request = await startWorker(async () => {
    throw new Error("memory access out of bounds");
  });

  const body = await request();
  assert.doesNotMatch(body, /restart limit reached/u);
  assert.match(body, /crashed after only 1 request/u);
  // A non-idempotent request must not claim a restart that was declined.
  const post = await request("POST");
  assert.doesNotMatch(post, /Runtime restarting after crash/u);
  assert.match(post, /crashed after only 2 request/u);
});

it("reports the restart limit once MAX_REACTIVE_RESTARTS is reached (#373)", async () => {
  const request = await startWorker(async () => {
    throw new Error("memory access out of bounds");
  });

  let body = "";
  for (let i = 0; i < 300 && !/restart limit reached/u.test(body); i += 1) {
    body = await request();
  }
  assert.match(body, /Runtime restart limit reached \(20\/20\)/u);
});
