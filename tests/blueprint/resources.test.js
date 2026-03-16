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
});
