import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResourceRegistry } from "../../src/blueprint/resources.js";

describe("ResourceRegistry", () => {
  it("resolves literal string resources", async () => {
    const registry = new ResourceRegistry({
      greeting: { literal: "Hello" },
    });
    const text = await registry.resolveText("@greeting");
    assert.strictEqual(text, "Hello");
  });

  it("resolves literal object resources as JSON", async () => {
    const registry = new ResourceRegistry({
      data: { literal: { key: "value" } },
    });
    const text = await registry.resolveText("@data");
    assert.strictEqual(text, '{"key":"value"}');
  });

  it("resolves base64 resources", async () => {
    const content = "Hello World";
    const b64 = Buffer.from(content).toString("base64");
    const registry = new ResourceRegistry({
      file: { base64: b64 },
    });
    const text = await registry.resolveText("@file");
    assert.strictEqual(text, content);
  });

  it("resolves inline descriptor objects", async () => {
    const registry = new ResourceRegistry({});
    const text = await registry.resolveText({ literal: "inline" });
    assert.strictEqual(text, "inline");
  });

  it("throws on unknown @name reference", async () => {
    const registry = new ResourceRegistry({});
    await assert.rejects(
      () => registry.resolve("@nonexistent"),
      /Unknown resource reference/,
    );
  });

  it("throws on invalid reference type", async () => {
    const registry = new ResourceRegistry({});
    await assert.rejects(
      () => registry.resolve(42),
      /Invalid resource reference/,
    );
  });

  it("resolves data-url resources", async () => {
    const content = "Hello Data URL";
    const b64 = Buffer.from(content).toString("base64");
    const registry = new ResourceRegistry({
      file: { "data-url": `data:text/plain;base64,${b64}` },
    });
    const text = await registry.resolveText("@file");
    assert.strictEqual(text, content);
  });

  it("resolves data-url resources with a charset parameter and base64", async () => {
    const content = "Hi";
    const b64 = Buffer.from(content).toString("base64");
    const registry = new ResourceRegistry({
      file: { "data-url": `data:text/plain;charset=utf-8;base64,${b64}` },
    });
    const text = await registry.resolveText("@file");
    assert.strictEqual(text, content);
  });

  it("resolves data-url resources with a charset parameter without base64", async () => {
    const content = "{}";
    const encoded = encodeURIComponent(content);
    const registry = new ResourceRegistry({
      file: { "data-url": `data:application/json;charset=utf-8,${encoded}` },
    });
    const text = await registry.resolveText("@file");
    assert.strictEqual(text, content);
  });

  it("resolves data-url resources without a media type", async () => {
    const content = "plain payload";
    const encoded = encodeURIComponent(content);
    const registry = new ResourceRegistry({
      file: { "data-url": `data:,${encoded}` },
    });
    const text = await registry.resolveText("@file");
    assert.strictEqual(text, content);
  });

  it("throws on malformed data: URL with no comma", async () => {
    const registry = new ResourceRegistry({
      file: { "data-url": "data:text/plain;base64" },
    });
    await assert.rejects(
      () => registry.resolve("@file"),
      /Malformed data: URL/,
    );
  });

  // ---------------------------------------------------------------------------
  // URL resources: retry transient failures (issue #249)
  // ---------------------------------------------------------------------------

  function okResponse(text) {
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        return new TextEncoder().encode(text).buffer;
      },
    };
  }
  function errResponse(status) {
    return {
      ok: false,
      status,
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
  }

  it("retries a transient network error and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("connection reset");
      return okResponse("recovered");
    };
    const registry = new ResourceRegistry(
      { r: { url: "https://h/x" } },
      { fetchImpl, retryDelayMs: 0 },
    );
    assert.strictEqual(await registry.resolveText("@r"), "recovered");
    assert.strictEqual(calls, 2);
  });

  it("retries a transient 503 and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return calls < 3 ? errResponse(503) : okResponse("ok");
    };
    const registry = new ResourceRegistry(
      { r: { url: "https://h/x" } },
      { fetchImpl, retryDelayMs: 0 },
    );
    assert.strictEqual(await registry.resolveText("@r"), "ok");
    assert.strictEqual(calls, 3);
  });

  it("gives up after the retry budget on a persistent failure", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error("down");
    };
    const registry = new ResourceRegistry(
      { r: { url: "https://h/x" } },
      { fetchImpl, retryAttempts: 3, retryDelayMs: 0 },
    );
    await assert.rejects(() => registry.resolve("@r"));
    assert.strictEqual(calls, 3);
  });

  it("does not retry a permanent 404", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return errResponse(404);
    };
    const registry = new ResourceRegistry(
      { r: { url: "https://h/x" } },
      { fetchImpl, retryAttempts: 3, retryDelayMs: 0 },
    );
    await assert.rejects(() => registry.resolve("@r"), /404/);
    assert.strictEqual(calls, 1);
  });
});
