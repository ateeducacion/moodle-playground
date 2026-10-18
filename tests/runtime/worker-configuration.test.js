import assert from "node:assert/strict";
import { it } from "node:test";

it("does not listen for HTTP on stale URL parameters before worker configuration", async () => {
  const originalSelf = globalThis.self;
  const originalChannel = globalThis.BroadcastChannel;
  const channels = [];
  const messages = [];
  const worker = new EventTarget();
  worker.location = new URL(
    "https://example.test/php-worker.js?scope=stale&runtime=php83-moodle53",
  );
  worker.postMessage = (message) => messages.push(message);
  globalThis.self = worker;
  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
      channels.push(this);
    }
    close() {}
    postMessage() {}
  };
  try {
    await import("../../php-worker.js");
    assert.equal(
      channels.length,
      0,
      "HTTP must wait for authoritative configuration",
    );
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: {
          kind: "configure-blueprint",
          runtimeParams: {
            scopeId: "active",
            runtimeId: "php84-moodle53",
            instanceId: "new",
          },
        },
      }),
    );
    assert.deepEqual(
      channels.map(({ name }) => name),
      ["moodle-playground-php:active"],
    );
    assert.equal(messages.at(-1).kind, "worker-ready");
    assert.equal(messages.at(-1).runtimeId, "php84-moodle53");
  } finally {
    globalThis.self = originalSelf;
    globalThis.BroadcastChannel = originalChannel;
  }
});
