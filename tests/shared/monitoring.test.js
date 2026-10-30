import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildEnvelope,
  buildEvent,
  captureException,
  captureMessage,
  createMonitoringClient,
  initMonitoring,
  parseDsn,
  parseStackFrames,
  runtimeErrorExtra,
} from "../../src/shared/monitoring.js";

const TEST_DSN = "https://abc123@o111.ingest.de.sentry.io/222";

describe("parseDsn", () => {
  it("parses a hosted sentry.io DSN", () => {
    const parsed = parseDsn(TEST_DSN);
    assert.strictEqual(parsed.publicKey, "abc123");
    assert.strictEqual(parsed.host, "o111.ingest.de.sentry.io");
    assert.strictEqual(parsed.projectId, "222");
    assert.ok(
      parsed.envelopeUrl.startsWith(
        "https://o111.ingest.de.sentry.io/api/222/envelope/?sentry_key=abc123",
      ),
    );
  });

  it("preserves a self-hosted path prefix", () => {
    const parsed = parseDsn("https://key@sentry.example.com/prefix/42");
    assert.strictEqual(parsed.projectId, "42");
    assert.ok(
      parsed.envelopeUrl.startsWith(
        "https://sentry.example.com/prefix/api/42/envelope/",
      ),
    );
  });

  it("returns null for missing or malformed DSNs", () => {
    assert.strictEqual(parseDsn(undefined), null);
    assert.strictEqual(parseDsn(""), null);
    assert.strictEqual(parseDsn("not a url"), null);
    assert.strictEqual(parseDsn("https://host/123"), null);
    assert.strictEqual(parseDsn("https://key@host/not-numeric"), null);
  });
});

describe("parseStackFrames", () => {
  it("parses V8-style stacks and reverses frame order", () => {
    const stack = [
      "TypeError: boom",
      "    at inner (https://example.com/app.js:10:5)",
      "    at outer (https://example.com/app.js:20:15)",
    ].join("\n");
    const frames = parseStackFrames(stack);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].function, "outer");
    assert.strictEqual(frames[1].function, "inner");
    assert.strictEqual(frames[1].lineno, 10);
    assert.strictEqual(frames[1].colno, 5);
    assert.strictEqual(frames[1].filename, "https://example.com/app.js");
  });

  it("parses Firefox/Safari-style stacks", () => {
    const frames = parseStackFrames("fn@https://example.com/app.js:3:7");
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].function, "fn");
    assert.strictEqual(frames[0].lineno, 3);
  });

  it("returns an empty list for missing stacks", () => {
    assert.deepStrictEqual(parseStackFrames(undefined), []);
    assert.deepStrictEqual(parseStackFrames("TypeError: boom"), []);
  });
});

describe("buildEvent", () => {
  it("builds an exception event from an Error", () => {
    const error = new TypeError("boom");
    const event = buildEvent({
      error,
      release: "r1",
      environment: "test",
      tags: { runtime: "php83" },
    });
    assert.match(event.event_id, /^[0-9a-f]{32}$/);
    assert.strictEqual(event.platform, "javascript");
    assert.strictEqual(event.level, "error");
    assert.strictEqual(event.release, "r1");
    assert.strictEqual(event.environment, "test");
    assert.deepStrictEqual(event.tags, { runtime: "php83" });
    const exception = event.exception.values[0];
    assert.strictEqual(exception.type, "TypeError");
    assert.strictEqual(exception.value, "boom");
    assert.ok(exception.stacktrace.frames.length > 0);
  });

  it("builds a message event with the given level", () => {
    const event = buildEvent({ message: "hello", level: "warning" });
    assert.strictEqual(event.level, "warning");
    assert.strictEqual(event.message.formatted, "hello");
    assert.strictEqual(event.exception, undefined);
  });
});

describe("buildEnvelope", () => {
  it("serializes header, item header, and event", () => {
    const event = buildEvent({ message: "hi" });
    const lines = buildEnvelope(event, TEST_DSN).trimEnd().split("\n");
    assert.strictEqual(lines.length, 3);
    const header = JSON.parse(lines[0]);
    assert.strictEqual(header.event_id, event.event_id);
    assert.strictEqual(header.dsn, TEST_DSN);
    assert.deepStrictEqual(JSON.parse(lines[1]), { type: "event" });
    assert.strictEqual(JSON.parse(lines[2]).message.formatted, "hi");
  });
});

function createCapturingFetch() {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ ok: true });
  };
  return { calls, fetchImpl };
}

describe("createMonitoringClient", () => {
  it("is a safe no-op without a DSN", () => {
    const client = createMonitoringClient({});
    assert.strictEqual(client.enabled, false);
    client.captureException(new Error("boom"));
    client.captureMessage("hello");
  });

  it("posts envelopes to the DSN ingest endpoint", () => {
    const { calls, fetchImpl } = createCapturingFetch();
    const client = createMonitoringClient({ dsn: TEST_DSN, fetchImpl });
    assert.strictEqual(client.enabled, true);
    client.captureException(new Error("boom"));
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes("/api/222/envelope/"));
    assert.strictEqual(calls[0].options.method, "POST");
    assert.ok(calls[0].options.body.includes('"boom"'));
  });

  it("deduplicates identical events", () => {
    const { calls, fetchImpl } = createCapturingFetch();
    const client = createMonitoringClient({ dsn: TEST_DSN, fetchImpl });
    client.captureMessage("same", "error");
    client.captureMessage("same", "error");
    client.captureMessage("different", "error");
    assert.strictEqual(calls.length, 2);
  });

  it("stops after maxEvents", () => {
    const { calls, fetchImpl } = createCapturingFetch();
    const client = createMonitoringClient({
      dsn: TEST_DSN,
      fetchImpl,
      maxEvents: 2,
    });
    client.captureMessage("one");
    client.captureMessage("two");
    client.captureMessage("three");
    assert.strictEqual(calls.length, 2);
  });

  it("normalizes non-Error values", () => {
    const { calls, fetchImpl } = createCapturingFetch();
    const client = createMonitoringClient({ dsn: TEST_DSN, fetchImpl });
    client.captureException("string failure");
    assert.ok(calls[0].options.body.includes("string failure"));
  });

  it("swallows delivery failures", () => {
    const client = createMonitoringClient({
      dsn: TEST_DSN,
      fetchImpl: () => {
        throw new Error("network down");
      },
    });
    client.captureException(new Error("boom"));
    client.captureMessage("still fine");
  });
});

describe("initMonitoring", () => {
  it("hooks global error and unhandledrejection handlers", () => {
    const { calls, fetchImpl } = createCapturingFetch();
    const handlers = new Map();
    const scope = {
      addEventListener: (name, handler) => handlers.set(name, handler),
    };
    initMonitoring({ dsn: TEST_DSN, fetchImpl, scope });
    assert.ok(handlers.has("error"));
    assert.ok(handlers.has("unhandledrejection"));
    handlers.get("error")({ error: new Error("uncaught") });
    handlers.get("unhandledrejection")({ reason: new Error("rejected") });
    assert.strictEqual(calls.length, 2);
  });

  it("does not install handlers when disabled", () => {
    const handlers = new Map();
    const scope = {
      addEventListener: (name, handler) => handlers.set(name, handler),
    };
    const client = initMonitoring({ scope });
    assert.strictEqual(client.enabled, false);
    assert.strictEqual(handlers.size, 0);
  });
});

describe("runtimeErrorExtra", () => {
  it("defaults the source and forwards the failing request path", () => {
    assert.deepStrictEqual(
      runtimeErrorExtra({ detail: "x", path: "/admin/" }),
      {
        source: "runtime",
        path: "/admin/",
      },
    );
  });

  it("keeps an explicit source and omits a missing path", () => {
    assert.deepStrictEqual(runtimeErrorExtra({ source: "service-worker" }), {
      source: "service-worker",
    });
  });

  it("forwards the runtime heap size and request count (#405)", () => {
    assert.deepStrictEqual(
      runtimeErrorExtra({
        detail: "PHP.run() failed with exit code 255.",
        path: "/r.php/core/esm/1793302377/@moodle/lms/core/config",
        requests: 47,
        heapBytes: 1073741824,
      }),
      {
        source: "runtime",
        path: "/r.php/core/esm/1793302377/@moodle/lms/core/config",
        requests: 47,
        heapBytes: 1073741824,
      },
    );
  });

  it("omits the heap fields when the worker could not read them", () => {
    assert.deepStrictEqual(
      runtimeErrorExtra({ detail: "x", requests: null, heapBytes: null }),
      { source: "runtime" },
    );
  });

  it("keeps a zero request count, which is not the same as missing", () => {
    assert.deepStrictEqual(runtimeErrorExtra({ detail: "x", requests: 0 }), {
      source: "runtime",
      requests: 0,
    });
  });
});

describe("monitoring environment and request context", () => {
  const descriptors = Object.fromEntries(
    ["location", "navigator", "crypto"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  const set = (key, value) =>
    Object.defineProperty(globalThis, key, { value, configurable: true });
  afterEach(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  it("tags local hosts as development and attaches the page URL and user agent", () => {
    for (const hostname of ["localhost", "127.0.0.1", "box.local"]) {
      set("location", { hostname, href: `http://${hostname}/` });
      set("navigator", { userAgent: "UA/1" });
      const event = buildEvent({ message: "m" });
      assert.equal(event.environment, "development", hostname);
      assert.deepEqual(event.request, {
        url: `http://${hostname}/`,
        headers: { "User-Agent": "UA/1" },
      });
    }
    set("location", { hostname: "app.test", href: "https://app.test/" });
    set("navigator", {});
    const event = buildEvent({ message: "m" });
    assert.equal(event.environment, "production");
    assert.equal(event.request.headers, undefined);
  });

  it("generates a 32-hex event id without crypto.randomUUID", () => {
    set("crypto", {});
    assert.match(buildEvent({ message: "m" }).event_id, /^[0-9a-f]{32}$/);
  });

  it("names an error without a name and caps parsed stack frames", () => {
    const stack = Array.from(
      { length: 60 },
      (_, i) => `at f${i} (app.js:${i + 1}:1)`,
    ).join("\n");
    assert.equal(parseStackFrames(stack).length, 50);
    const event = buildEvent({ error: { message: "plain" } });
    assert.equal(event.exception.values[0].type, "Error");
    assert.equal(event.exception.values[0].value, "plain");
  });
});

describe("module-level capture helpers", () => {
  it("routes through the initialized client and reports window error messages", () => {
    const calls = [];
    const handlers = new Map();
    initMonitoring({
      dsn: TEST_DSN,
      fetchImpl: (_url, options) => {
        calls.push(JSON.parse(options.body.split("\n")[2]));
        return Promise.resolve();
      },
      scope: { addEventListener: (name, h) => handlers.set(name, h) },
    });
    captureException(new Error("direct"));
    captureMessage("hello", "warning", { k: 1 });
    handlers.get("error")({ message: "Script error." });
    handlers.get("error")({});
    handlers.get("unhandledrejection")(undefined);
    assert.deepEqual(
      calls.map((e) => e.exception?.values[0].value ?? e.message.formatted),
      ["direct", "hello", "Script error.", "Unhandled rejection"],
    );
    assert.equal(calls[1].level, "warning");
    assert.deepEqual(calls[2].extra, { source: "window.onerror" });
  });

  it("never throws when building the event fails", () => {
    const client = createMonitoringClient({
      dsn: TEST_DSN,
      fetchImpl: () => {},
    });
    const hostile = {
      toString() {
        throw new Error("no string");
      },
    };
    assert.doesNotThrow(() => client.captureException(hostile));
    assert.doesNotThrow(() => client.captureMessage(hostile));
  });
});
