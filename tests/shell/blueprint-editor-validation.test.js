import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlueprintValidationResult,
  escapeHtml,
  getInitialBlueprintCode,
  highlightJson,
} from "../../src/shell/blueprint-editor-core.js";

const valid = () => ({ valid: true, errors: [] });

describe("blueprint editor edge cases", () => {
  it("keeps unparseable seed text instead of discarding it", () => {
    assert.equal(getInitialBlueprintCode('{"steps": ['), '{"steps": [');
    assert.equal(getInitialBlueprintCode(42), "");
  });

  it("highlights nothing for non-string input and escapes non-strings to empty", () => {
    assert.equal(highlightJson(undefined), "");
    assert.equal(escapeHtml(5), "");
  });

  it("reports a parseBlueprint failure as a JSON-stage error", () => {
    const result = createBlueprintValidationResult('{"steps": 1}', {
      parseBlueprint: () => {
        throw new Error("steps must be an array");
      },
      validateBlueprint: () => assert.fail("must not validate"),
    });
    assert.deepEqual(result, {
      valid: false,
      stage: "json",
      message: "Invalid JSON: steps must be an array",
      errors: [],
      blueprint: null,
    });
  });

  it("uses a generic message when the schema reports no details", () => {
    for (const errors of [undefined, []]) {
      const result = createBlueprintValidationResult("{}", {
        parseBlueprint: (json) => json,
        validateBlueprint: () => ({ valid: false, errors }),
      });
      assert.equal(result.stage, "schema");
      assert.equal(result.message, "Blueprint schema is invalid.");
    }
    const many = createBlueprintValidationResult("{}", {
      parseBlueprint: (json) => json,
      validateBlueprint: () => ({ valid: false, errors: ["a", "b"] }),
    });
    assert.equal(many.message, "Blueprint is invalid (2 issues): a");
    assert.deepEqual(many.errors, ["a", "b"]);
  });

  it("counts zero steps when the blueprint has no steps array", () => {
    const result = createBlueprintValidationResult("{}", {
      parseBlueprint: (json) => json,
      validateBlueprint: valid,
    });
    assert.equal(result.message, "✓ Valid blueprint · 0 steps");
    assert.equal(
      createBlueprintValidationResult('{"steps":[{}]}', {
        parseBlueprint: (json) => json,
        validateBlueprint: valid,
      }).message,
      "✓ Valid blueprint · 1 step",
    );
  });

  it("rejects non-string editor content as empty", () => {
    const result = createBlueprintValidationResult(null, {});
    assert.equal(result.message, "Blueprint cannot be empty.");
  });
});
