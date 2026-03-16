import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBlueprint } from "../../src/blueprint/parser.js";

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
