import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinBasePath } from "../../src/shared/paths.js";

describe("joinBasePath", () => {
  it("joins base and path", () => {
    assert.strictEqual(joinBasePath("/base/", "path"), "/base/path");
  });

  it("handles base without trailing slash", () => {
    assert.strictEqual(joinBasePath("/base", "path"), "/base/path");
  });

  it("handles path with leading slash", () => {
    assert.strictEqual(joinBasePath("/base/", "/path"), "/base/path");
  });

  it("handles root base", () => {
    assert.strictEqual(joinBasePath("/", "path"), "/path");
  });

  it("deduplicates multiple slashes", () => {
    assert.strictEqual(joinBasePath("/base//", "//path"), "/base/path");
  });

  it("handles empty path", () => {
    assert.strictEqual(joinBasePath("/base/", ""), "/base/");
  });
});
