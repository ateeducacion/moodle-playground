import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateBlueprint } from "../../src/blueprint/schema.js";

describe("validateBlueprint", () => {
  it("validates a correct blueprint", () => {
    const result = validateBlueprint({
      steps: [{ step: "installMoodle" }, { step: "login", username: "admin" }],
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it("rejects non-object input", () => {
    const result = validateBlueprint("not an object");
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors[0].includes("non-null object"));
  });

  it("rejects missing steps", () => {
    const result = validateBlueprint({});
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes("'steps' must be an array")),
    );
  });

  it("rejects unknown step names", () => {
    const result = validateBlueprint({
      steps: [{ step: "nonExistentStep" }],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("unknown step")));
  });

  it("rejects steps without step name", () => {
    const result = validateBlueprint({
      steps: [{ foo: "bar" }],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes("missing or invalid 'step'")),
    );
  });

  it("validates preferredVersions as object", () => {
    const result = validateBlueprint({
      steps: [],
      preferredVersions: "invalid",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("preferredVersions")));
  });

  it("validates constants as object", () => {
    const result = validateBlueprint({
      steps: [],
      constants: [1, 2, 3],
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("constants")));
  });

  it("validates resource descriptors have exactly one type key", () => {
    const result = validateBlueprint({
      steps: [],
      resources: {
        bad: { url: "x", base64: "y" },
      },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("exactly one type key")));
  });

  it("validates resource descriptors have at least one type key", () => {
    const result = validateBlueprint({
      steps: [],
      resources: {
        empty: { name: "test" },
      },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes("missing resource type key")),
    );
  });

  it("validates landingPage starts with /", () => {
    const result = validateBlueprint({
      steps: [],
      landingPage: "my/",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("start with '/'")));
  });

  it("accepts valid landingPage", () => {
    const result = validateBlueprint({
      steps: [],
      landingPage: "/my/",
    });
    assert.strictEqual(result.valid, true);
  });
});
