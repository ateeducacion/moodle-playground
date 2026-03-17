import assert from "node:assert/strict";
import { describe, it } from "node:test";

// resolveBlueprint depends on window/fetch — test the parser-level fallback path
import { parseBlueprint } from "../../src/blueprint/parser.js";

describe("resolver: parseBlueprint integration", () => {
  it("parses inline JSON from what ?blueprint= would provide", () => {
    const json = '{"steps":[{"step":"login","username":"admin"}]}';
    const result = parseBlueprint(json);
    assert.deepStrictEqual(result.steps[0].step, "login");
  });

  it("parses base64 from what ?blueprint= would provide", () => {
    const obj = { steps: [{ step: "installMoodle" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(b64);
    assert.strictEqual(result.steps[0].step, "installMoodle");
  });

  it("parses data: URL from what ?blueprint= would provide", () => {
    const obj = { steps: [{ step: "login" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(`data:application/json;base64,${b64}`);
    assert.strictEqual(result.steps[0].step, "login");
  });
});
