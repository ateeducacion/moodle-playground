import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeArchivePath } from "../../lib/moodle-loader.js";

describe("sanitizeArchivePath", () => {
  it("passes a normal relative path through unchanged", () => {
    assert.equal(sanitizeArchivePath("lib/setup.php"), "lib/setup.php");
  });

  it("drops '.' and empty segments", () => {
    assert.equal(sanitizeArchivePath("a/./b//c"), "a/b/c");
  });

  it("strips a trailing slash (directory marker)", () => {
    // Callers must detect directory entries BEFORE sanitizing, since the
    // trailing slash is removed here.
    assert.equal(sanitizeArchivePath(".git/"), ".git");
  });

  it("returns null for an empty or dot-only path", () => {
    assert.equal(sanitizeArchivePath(""), null);
    assert.equal(sanitizeArchivePath("./"), null);
  });

  it("throws on a '..' traversal segment", () => {
    assert.throws(
      () => sanitizeArchivePath("../etc/passwd"),
      /path traversal/i,
    );
    assert.throws(() => sanitizeArchivePath("a/../../b"), /path traversal/i);
  });
});
