import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyProxy,
  buildPrFilesApiUrl,
  DEFAULT_OVERLAY_ROOT,
  joinRoot,
  normalizeOverlayManifest,
  normalizeRunUpgrade,
  normalizeStatus,
  overlayNeedsUpgrade,
  validateOverlayPath,
} from "../../src/blueprint/pr-overlay.js";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

// A fake PHP instance that records executed code, file writes, and mkdir calls.
function createMockPhp() {
  const runCalls = [];
  const writes = [];
  const mkdirs = [];
  return {
    runCalls,
    writes,
    mkdirs,
    async run(code) {
      runCalls.push(code);
      return { text: '{"ok":true}', errors: "" };
    },
    async writeFile(path, data) {
      writes.push({ path, data });
    },
    _php: {
      mkdirTree(dir) {
        mkdirs.push(dir);
      },
    },
  };
}

// Stub globalThis.fetch and run `fn`, always restoring the original afterwards.
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function okBytesResponse(bytes) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

describe("validateOverlayPath", () => {
  it("accepts a normal repo-relative path", () => {
    assert.strictEqual(
      validateOverlayPath("lib/classes/example.php"),
      "lib/classes/example.php",
    );
    assert.strictEqual(
      validateOverlayPath("public/course/view.php"),
      "public/course/view.php",
    );
  });

  it("rejects empty, non-string, absolute, and traversal paths", () => {
    assert.throws(() => validateOverlayPath(""), /non-empty/);
    assert.throws(() => validateOverlayPath("   "), /non-empty/);
    assert.throws(() => validateOverlayPath(null), /non-empty/);
    assert.throws(() => validateOverlayPath("/etc/passwd"), /absolute/);
    assert.throws(
      () => validateOverlayPath("../../etc/passwd"),
      /unsafe segment/,
    );
    assert.throws(() => validateOverlayPath("a/../b"), /unsafe segment/);
  });

  it("rejects backslashes, null bytes, control chars, and dot segments", () => {
    assert.throws(() => validateOverlayPath("a\\b"), /backslash/);
    assert.throws(() => validateOverlayPath("a\0b"), /null byte/);
    assert.throws(() => validateOverlayPath("a\tb"), /control/);
    assert.throws(() => validateOverlayPath("./a"), /unsafe segment/);
    assert.throws(() => validateOverlayPath("a//b"), /unsafe segment/);
  });
});

describe("joinRoot", () => {
  it("joins a relative path onto the root", () => {
    assert.strictEqual(
      joinRoot("/www/moodle", "lib/classes/example.php"),
      "/www/moodle/lib/classes/example.php",
    );
  });

  it("never auto-prefixes public/ (path carries it) and strips trailing slash", () => {
    assert.strictEqual(
      joinRoot("/www/moodle/", "public/course/view.php"),
      "/www/moodle/public/course/view.php",
    );
  });

  it("refuses to escape the root", () => {
    assert.throws(
      () => joinRoot("/www/moodle", "../evil.php"),
      /unsafe segment/,
    );
  });
});

describe("normalizeStatus", () => {
  it("maps GitHub statuses to canonical operations", () => {
    assert.strictEqual(normalizeStatus("added"), "added");
    assert.strictEqual(normalizeStatus("modified"), "modified");
    assert.strictEqual(normalizeStatus("changed"), "modified");
    assert.strictEqual(normalizeStatus("copied"), "added");
    assert.strictEqual(normalizeStatus("removed"), "removed");
    assert.strictEqual(normalizeStatus("renamed"), "renamed");
  });

  it("throws on an unsupported status", () => {
    assert.throws(() => normalizeStatus("exploded"), /unsupported file status/);
  });
});

describe("normalizeOverlayManifest", () => {
  it("normalizes added/modified/removed/renamed entries", () => {
    const ops = normalizeOverlayManifest([
      { path: "a.php", status: "added", rawUrl: "https://raw/a", size: 10 },
      { path: "b.php", status: "modified", rawUrl: "https://raw/b" },
      { path: "c.php", status: "removed" },
      {
        path: "new.php",
        previousPath: "old.php",
        status: "renamed",
        rawUrl: "https://raw/new",
      },
    ]);
    assert.strictEqual(ops.length, 4);
    assert.deepStrictEqual(ops[0], {
      path: "a.php",
      status: "added",
      rawUrl: "https://raw/a",
      previousPath: null,
      size: 10,
    });
    assert.strictEqual(ops[2].status, "removed");
    assert.strictEqual(ops[2].rawUrl, null);
    assert.strictEqual(ops[3].previousPath, "old.php");
  });

  it("requires rawUrl for non-removed entries", () => {
    assert.throws(
      () => normalizeOverlayManifest([{ path: "a.php", status: "modified" }]),
      /requires a 'rawUrl'/,
    );
  });

  it("requires previousPath for renamed entries", () => {
    assert.throws(
      () =>
        normalizeOverlayManifest([
          { path: "new.php", status: "renamed", rawUrl: "https://raw/new" },
        ]),
      /no 'previousPath'/,
    );
  });

  it("rejects a non-array and validates every path", () => {
    assert.throws(() => normalizeOverlayManifest("nope"), /must be an array/);
    assert.throws(
      () =>
        normalizeOverlayManifest([
          { path: "../evil.php", status: "added", rawUrl: "x" },
        ]),
      /unsafe segment/,
    );
  });
});

describe("overlayNeedsUpgrade", () => {
  it("returns true for version and db upgrade files", () => {
    assert.ok(overlayNeedsUpgrade([{ path: "version.php" }]));
    assert.ok(overlayNeedsUpgrade([{ path: "public/version.php" }]));
    assert.ok(overlayNeedsUpgrade([{ path: "lib/db/upgrade.php" }]));
    assert.ok(overlayNeedsUpgrade([{ path: "mod/quiz/db/install.xml" }]));
    assert.ok(overlayNeedsUpgrade(["lib/db/install.php"]));
  });

  it("returns false for ordinary code changes", () => {
    assert.ok(!overlayNeedsUpgrade([{ path: "lib/classes/example.php" }]));
    assert.ok(!overlayNeedsUpgrade([{ path: "lib/version.php" }])); // not core/public version.php
    assert.ok(!overlayNeedsUpgrade([]));
  });
});

describe("normalizeRunUpgrade", () => {
  it("defaults to auto and accepts off/on/auto plus aliases", () => {
    assert.strictEqual(normalizeRunUpgrade(undefined), "auto");
    assert.strictEqual(normalizeRunUpgrade(""), "auto");
    assert.strictEqual(normalizeRunUpgrade("auto"), "auto");
    assert.strictEqual(normalizeRunUpgrade("off"), "off");
    assert.strictEqual(normalizeRunUpgrade("false"), "off");
    assert.strictEqual(normalizeRunUpgrade("on"), "on");
    assert.strictEqual(normalizeRunUpgrade("true"), "on");
  });

  it("throws on an invalid value", () => {
    assert.throws(() => normalizeRunUpgrade("maybe"), /invalid runUpgrade/);
  });
});

describe("buildPrFilesApiUrl / applyProxy", () => {
  it("builds a paginated PR files API URL", () => {
    assert.strictEqual(
      buildPrFilesApiUrl("moodle/moodle", 1234),
      "https://api.github.com/repos/moodle/moodle/pulls/1234/files?per_page=100&page=1",
    );
    assert.strictEqual(
      buildPrFilesApiUrl("moodle/moodle", 1234, { page: 3 }),
      "https://api.github.com/repos/moodle/moodle/pulls/1234/files?per_page=100&page=3",
    );
  });

  it("rejects a malformed repo or pr", () => {
    assert.throws(() => buildPrFilesApiUrl("not-a-repo", 1), /invalid repo/);
    assert.throws(() => buildPrFilesApiUrl("a/b", 0), /invalid pr/);
  });

  it("passes URLs through unchanged without a proxy and wraps with one", () => {
    assert.strictEqual(applyProxy("https://raw/x", ""), "https://raw/x");
    assert.strictEqual(
      applyProxy("https://raw/x", "https://proxy.dev/"),
      "https://proxy.dev/?url=https%3A%2F%2Fraw%2Fx",
    );
  });
});

describe("deleteFile / deleteFiles steps", () => {
  it("deleteFile runs an idempotent unlink", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("deleteFile");
    await handler({ path: "/www/moodle/lib/old.php" }, { php });
    assert.match(php.runCalls[0], /@unlink/);
    assert.match(php.runCalls[0], /\/www\/moodle\/lib\/old\.php/);
  });

  it("deleteFile rejects a missing path", async () => {
    const handler = getStepHandler("deleteFile");
    await assert.rejects(
      () => handler({}, { php: createMockPhp() }),
      /required/,
    );
  });

  it("deleteFiles accepts string and object entries", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("deleteFiles");
    await handler(
      { files: ["/www/moodle/a.php", { path: "/www/moodle/b.php" }] },
      { php },
    );
    assert.strictEqual(php.runCalls.length, 2);
    assert.match(php.runCalls[0], /a\.php/);
    assert.match(php.runCalls[1], /b\.php/);
  });

  it("deleteFiles rejects a non-array", async () => {
    const handler = getStepHandler("deleteFiles");
    await assert.rejects(
      () => handler({ files: "nope" }, { php: createMockPhp() }),
      /must be an array/,
    );
  });
});

describe("purgeMoodleCaches step", () => {
  it("runs a script that purges caches and resets components", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("purgeMoodleCaches");
    await handler({}, { php });
    const code = php.runCalls[0];
    assert.match(code, /purge_all_caches/);
    assert.match(code, /core_component::reset/);
    assert.match(code, /opcache_reset/);
    assert.match(code, /allversionshash/);
  });
});

describe("applyPrOverlay step", () => {
  it("writes added/modified files, deletes removed, and renames", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("applyPrOverlay");
    const bytes = new Uint8Array([1, 2, 3]);

    await withFetch(
      async () => okBytesResponse(bytes),
      () =>
        handler(
          {
            root: DEFAULT_OVERLAY_ROOT,
            runUpgrade: "off",
            files: [
              {
                path: "lib/a.php",
                status: "modified",
                rawUrl: "https://raw/a",
              },
              { path: "lib/old.php", status: "removed" },
              {
                path: "lib/new.php",
                previousPath: "lib/prev.php",
                status: "renamed",
                rawUrl: "https://raw/new",
              },
            ],
          },
          { php },
        ),
    );

    // Two writes (modified + renamed-new), both under the overlay root.
    assert.deepStrictEqual(
      php.writes.map((w) => w.path),
      ["/www/moodle/lib/a.php", "/www/moodle/lib/new.php"],
    );
    // Parent directories created for each written file.
    assert.ok(php.mkdirs.includes("/www/moodle/lib"));
    // Removed + renamed-previous both unlinked.
    const unlinks = php.runCalls.filter((c) => c.includes("@unlink"));
    assert.ok(unlinks.some((c) => c.includes("lib/old.php")));
    assert.ok(unlinks.some((c) => c.includes("lib/prev.php")));
    // Caches purged after overlay.
    assert.ok(php.runCalls.some((c) => c.includes("purge_all_caches")));
    // runUpgrade=off: no upgrade run.
    assert.ok(!php.runCalls.some((c) => c.includes("upgrade_noncore")));
  });

  it("runs the upgrade automatically when version.php changes", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("applyPrOverlay");
    await withFetch(
      async () => okBytesResponse(new Uint8Array([1])),
      () =>
        handler(
          {
            runUpgrade: "auto",
            files: [
              {
                path: "version.php",
                status: "modified",
                rawUrl: "https://raw/v",
              },
            ],
          },
          { php },
        ),
    );
    assert.ok(php.runCalls.some((c) => c.includes("upgrade_noncore")));
  });

  it("does not run the upgrade in auto mode for ordinary changes", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("applyPrOverlay");
    await withFetch(
      async () => okBytesResponse(new Uint8Array([1])),
      () =>
        handler(
          {
            runUpgrade: "auto",
            files: [
              {
                path: "lib/x.php",
                status: "modified",
                rawUrl: "https://raw/x",
              },
            ],
          },
          { php },
        ),
    );
    assert.ok(!php.runCalls.some((c) => c.includes("upgrade_noncore")));
  });

  it("enforces the maxFiles cap", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("applyPrOverlay");
    await assert.rejects(
      () =>
        handler(
          {
            maxFiles: 1,
            runUpgrade: "off",
            files: [
              { path: "a.php", status: "modified", rawUrl: "https://raw/a" },
              { path: "b.php", status: "modified", rawUrl: "https://raw/b" },
            ],
          },
          { php },
        ),
      /exceed maxFiles/,
    );
  });

  it("requires a files manifest or repo+pr", async () => {
    const handler = getStepHandler("applyPrOverlay");
    await assert.rejects(
      () => handler({}, { php: createMockPhp() }),
      /provide a 'files' manifest/,
    );
  });

  it("skips a single failing file instead of aborting the whole overlay", async () => {
    const php = createMockPhp();
    const handler = getStepHandler("applyPrOverlay");
    // First fetch fails (e.g. 404 from a force-pushed SHA), second succeeds.
    let call = 0;
    await withFetch(
      async () => {
        call++;
        if (call === 1) return { ok: false, status: 404 };
        return okBytesResponse(new Uint8Array([1, 2]));
      },
      () =>
        handler(
          {
            runUpgrade: "off",
            files: [
              {
                path: "lib/bad.php",
                status: "modified",
                rawUrl: "https://raw/bad",
              },
              {
                path: "lib/good.php",
                status: "modified",
                rawUrl: "https://raw/good",
              },
            ],
          },
          { php },
        ),
    );
    // The good file is still written even though the bad one failed.
    assert.deepStrictEqual(
      php.writes.map((w) => w.path),
      ["/www/moodle/lib/good.php"],
    );
  });
});
