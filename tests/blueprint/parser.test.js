import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compressBlueprint,
  encodeBlueprintParam,
  parseBlueprint,
  parseBlueprintParam,
} from "../../src/blueprint/parser.js";

describe("parseBlueprint", () => {
  it("passes through plain objects", () => {
    const bp = { steps: [{ step: "login" }] };
    assert.deepStrictEqual(parseBlueprint(bp), bp);
  });

  it("parses JSON strings", () => {
    const json = '{"steps":[{"step":"login"}]}';
    const result = parseBlueprint(json);
    assert.deepStrictEqual(result.steps, [{ step: "login" }]);
  });

  it("parses base64-encoded JSON", () => {
    const obj = { steps: [{ step: "login" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(b64);
    assert.deepStrictEqual(result.steps, [{ step: "login" }]);
  });

  it("parses data: URLs with base64", () => {
    const obj = { steps: [] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(`data:application/json;base64,${b64}`);
    assert.deepStrictEqual(result.steps, []);
  });

  it("parses data: URLs without base64", () => {
    const obj = { steps: [] };
    const encoded = encodeURIComponent(JSON.stringify(obj));
    const result = parseBlueprint(`data:application/json,${encoded}`);
    assert.deepStrictEqual(result.steps, []);
  });

  it("parses data: URLs with a charset parameter and base64", () => {
    const obj = { steps: [{ step: "login" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(
      `data:application/json;charset=utf-8;base64,${b64}`,
    );
    assert.deepStrictEqual(result.steps, [{ step: "login" }]);
  });

  it("parses data: URLs with a charset parameter without base64", () => {
    const obj = { steps: [] };
    const encoded = encodeURIComponent(JSON.stringify(obj));
    const result = parseBlueprint(
      `data:application/json;charset=utf-8,${encoded}`,
    );
    assert.deepStrictEqual(result.steps, []);
  });

  it("throws on null input", () => {
    assert.throws(() => parseBlueprint(null), /null or undefined/);
  });

  it("throws on empty string", () => {
    assert.throws(() => parseBlueprint(""), /empty string/);
  });

  it("throws on invalid JSON string", () => {
    assert.throws(() => parseBlueprint("{invalid"), /Invalid JSON/);
  });

  it("throws on non-object/non-string input", () => {
    assert.throws(() => parseBlueprint(42), /Unsupported/);
  });
});

describe("compressBlueprint / parseBlueprintParam (gzip round-trip)", () => {
  // A repetitive blueprint compresses well — mirrors a real heavy import.
  const heavy = {
    steps: Array.from({ length: 40 }, (_, i) => ({
      step: "setConfig",
      name: `setting_${i}`,
      value: "a repeated value that gzip loves ".repeat(8),
    })),
  };

  it("round-trips a blueprint through gzip+base64url", async () => {
    const encoded = await compressBlueprint(heavy);
    const decoded = await parseBlueprintParam(encoded);
    assert.deepStrictEqual(decoded, heavy);
  });

  it("produces a gzip stream (decoded bytes start with 1f 8b)", async () => {
    const encoded = await compressBlueprint({ steps: [] });
    // base64url → base64 → bytes
    const b64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Buffer.from(b64, "base64");
    assert.strictEqual(bytes[0], 0x1f);
    assert.strictEqual(bytes[1], 0x8b);
  });

  it("is much shorter than plain base64 for a heavy blueprint", async () => {
    const json = JSON.stringify(heavy);
    const plain = Buffer.from(json).toString("base64");
    const gz = await compressBlueprint(heavy);
    assert.ok(
      gz.length < plain.length / 2,
      `expected gzip (${gz.length}) to be < half of base64 (${plain.length})`,
    );
  });

  it("still accepts old plain base64-JSON values (backwards compatible)", async () => {
    const obj = { steps: [{ step: "login" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const decoded = await parseBlueprintParam(b64);
    assert.deepStrictEqual(decoded.steps, [{ step: "login" }]);
  });

  it("falls through to the sync parser for objects, JSON and data: URLs", async () => {
    assert.deepStrictEqual(await parseBlueprintParam({ steps: [] }), {
      steps: [],
    });
    assert.deepStrictEqual(
      (await parseBlueprintParam('{"steps":[{"step":"login"}]}')).steps,
      [{ step: "login" }],
    );
    const b64 = Buffer.from(JSON.stringify({ steps: [] })).toString("base64");
    assert.deepStrictEqual(
      await parseBlueprintParam(`data:application/json;base64,${b64}`),
      { steps: [] },
    );
  });
});

describe("encodeBlueprintParam", () => {
  it("gzip-compresses like compressBlueprint when available", async () => {
    const blueprint = { steps: [{ step: "login" }] };
    const encoded = await encodeBlueprintParam(blueprint);
    assert.strictEqual(encoded, await compressBlueprint(blueprint));
  });

  it("falls back to plain base64url when CompressionStream is unavailable, without throwing", async () => {
    const blueprint = { steps: [{ step: "login" }], note: "café" };
    const original = globalThis.CompressionStream;
    globalThis.CompressionStream = undefined;
    let encoded;
    try {
      encoded = await encodeBlueprintParam(blueprint);
    } finally {
      globalThis.CompressionStream = original;
    }
    assert.doesNotMatch(encoded, /[+/=]/u);
    assert.deepStrictEqual(await parseBlueprintParam(encoded), blueprint);
  });

  it("rejects clearly when the blueprint cannot be JSON-serialized", async () => {
    const circular = {};
    circular.self = circular;
    await assert.rejects(() => encodeBlueprintParam(circular));
  });
});
