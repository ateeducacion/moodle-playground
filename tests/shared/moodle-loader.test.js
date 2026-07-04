import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractZipEntries,
  sanitizeArchivePath,
} from "../../lib/moodle-loader.js";
import { strToU8, zipSync } from "../../vendor/fflate.js";

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

describe("extractZipEntries directory handling", () => {
  it("skips directory entries so they do not leak as bare file paths", () => {
    // Regression: sanitizeArchivePath strips trailing slashes, so a directory
    // entry like "moodle/.git/" used to survive as a file ".git", colliding
    // with the real ".git/config" file and breaking extraction with
    // "Not a directory". Directory entries must be skipped before sanitizing.
    const zip = zipSync({
      "moodle/.git/": new Uint8Array(0),
      "moodle/.git/config": strToU8("[core]\n"),
      "moodle/.git/hooks/": new Uint8Array(0),
      "moodle/lib/setup.php": strToU8("<?php\n"),
    });

    const entries = extractZipEntries(zip);
    const paths = entries.map((e) => e.path);

    // The single common leading folder "moodle/" is stripped.
    assert.ok(!paths.includes(".git"), "directory entry leaked as a file");
    assert.ok(
      !paths.includes(".git/hooks"),
      "nested dir entry leaked as a file",
    );
    assert.ok(
      paths.includes(".git/config"),
      "real file inside dir was dropped",
    );
    assert.ok(paths.includes("lib/setup.php"), "regular file was dropped");

    // No extracted file path may also be a parent directory of another path.
    for (const p of paths) {
      for (const q of paths) {
        assert.ok(
          !(q.length > p.length && q.startsWith(`${p}/`)),
          `path "${p}" collides with "${q}" (directory written as a file)`,
        );
      }
    }
  });

  it("rejects ZIP-slip traversal entries while keeping safe files", () => {
    const zip = zipSync({
      "pkg/lib/ok.php": strToU8("<?php\n"),
      "pkg/../../evil.php": strToU8("<?php /* escape */\n"),
    });

    const entries = extractZipEntries(zip);
    const paths = entries.map((e) => e.path);

    assert.ok(
      paths.every((p) => !p.includes("..")),
      "a traversal entry was not stripped",
    );
    assert.ok(
      paths.some((p) => p.endsWith("ok.php")),
      "the safe file should still be extracted",
    );
  });
});
