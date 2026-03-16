import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { substituteConstants } from "../../src/blueprint/constants.js";

describe("substituteConstants", () => {
  it("replaces placeholders in strings", () => {
    const result = substituteConstants("Hello {{NAME}}", { NAME: "World" });
    assert.strictEqual(result, "Hello World");
  });

  it("replaces multiple placeholders", () => {
    const result = substituteConstants("{{A}} and {{B}}", {
      A: "foo",
      B: "bar",
    });
    assert.strictEqual(result, "foo and bar");
  });

  it("walks nested objects", () => {
    const result = substituteConstants(
      { level1: { level2: "{{VAL}}" } },
      { VAL: "deep" },
    );
    assert.deepStrictEqual(result, { level1: { level2: "deep" } });
  });

  it("walks arrays", () => {
    const result = substituteConstants(["{{A}}", "plain", "{{B}}"], {
      A: "1",
      B: "2",
    });
    assert.deepStrictEqual(result, ["1", "plain", "2"]);
  });

  it("leaves missing constants unchanged", () => {
    const result = substituteConstants("{{MISSING}}", {});
    assert.strictEqual(result, "{{MISSING}}");
  });

  it("passes through non-string primitives", () => {
    assert.strictEqual(substituteConstants(42, { X: "y" }), 42);
    assert.strictEqual(substituteConstants(true, {}), true);
    assert.strictEqual(substituteConstants(null, {}), null);
  });

  it("handles null/undefined constants gracefully", () => {
    assert.strictEqual(substituteConstants("{{X}}", null), "{{X}}");
    assert.strictEqual(substituteConstants("{{X}}", undefined), "{{X}}");
  });
});
