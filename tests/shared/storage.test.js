import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScopeKey } from "../../src/shared/storage.js";

describe("buildScopeKey", () => {
  it("builds key with prefix, scopeId, and suffix", () => {
    const key = buildScopeKey("main", "state");
    assert.strictEqual(key, "moodle-playground:main:state");
  });

  it("handles custom scopeId", () => {
    const key = buildScopeKey("custom", "blueprint");
    assert.strictEqual(key, "moodle-playground:custom:blueprint");
  });
});
