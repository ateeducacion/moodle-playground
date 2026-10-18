import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  readZipEntries,
  sanitizeArchivePath,
} from "../../lib/moodle-loader.js";

describe("readZipEntries validation", () => {
  const archive = (level = 6) =>
    zipSync(
      {
        "plugin/version.php": strToU8("<?php $plugin->version=1;"),
        "plugin/lib.php": strToU8("<?php echo 'complete';"),
      },
      { level },
    );

  it("reads valid deflated and stored archives", async () => {
    for (const level of [0, 6]) {
      const entries = await readZipEntries(archive(level));
      assert.deepEqual(
        entries.map(({ path }) => path),
        ["plugin/version.php", "plugin/lib.php"],
      );
      assert.match(new TextDecoder().decode(entries[0].data), /version=1/);
    }
  });

  it("accepts a legitimate empty ZIP including its comment", async () => {
    assert.deepEqual(await readZipEntries(zipSync({})), []);
    assert.deepEqual(
      await readZipEntries(zipSync({}, { comment: "Empty fixture" })),
      [],
    );
  });

  it("preserves UTF-8 names, directory entries and archive comments", async () => {
    const entries = await readZipEntries(
      zipSync(
        {
          "folder/": new Uint8Array(),
          "folder/á.php": strToU8("content"),
        },
        { comment: "Archive fixture" },
      ),
    );
    assert.deepEqual(
      entries.map(({ path }) => path),
      ["folder/á.php"],
    );
    assert.equal(new TextDecoder().decode(entries[0].data), "content");
  });

  for (const [label, corrupt] of [
    ["non-ZIP", () => new Uint8Array([1, 2, 3, 4])],
    ["empty input", () => new Uint8Array()],
    ["truncated ending", (bytes) => bytes.slice(0, -1)],
    ["truncated body", (bytes) => bytes.slice(0, 55)],
    [
      "missing ending after a valid first file",
      (bytes) => {
        const end = new DataView(bytes.buffer).getUint32(
          bytes.length - 6,
          true,
        );
        return bytes.slice(0, end);
      },
    ],
    [
      "invalid central directory",
      (bytes) => {
        const directory = new DataView(bytes.buffer).getUint32(
          bytes.length - 6,
          true,
        );
        bytes[directory] = 0;
        return bytes;
      },
    ],
    [
      "wrong entry count",
      (bytes) => {
        bytes[bytes.length - 12]++;
        return bytes;
      },
    ],
    [
      "invalid local checksum",
      (bytes) => {
        bytes[14] ^= 1;
        return bytes;
      },
    ],
    [
      "corrupted stored data",
      (bytes) => {
        const nameLength = new DataView(bytes.buffer).getUint16(26, true);
        bytes[30 + nameLength] ^= 1;
        return bytes;
      },
    ],
    [
      "unknown signature after a valid first file",
      (bytes) => {
        const view = new DataView(bytes.buffer);
        const next =
          30 +
          view.getUint16(26, true) +
          view.getUint16(28, true) +
          view.getUint32(18, true);
        bytes[next] = 0;
        return bytes;
      },
    ],
  ]) {
    it(`rejects ${label} with operation context`, async () => {
      await assert.rejects(
        readZipEntries(corrupt(archive(0)), "unzip fixture.zip"),
        /unzip fixture\.zip: Invalid ZIP/,
      );
    });
  }

  it("wraps decoder errors even when the decoder supplies an empty message", async () => {
    const bytes = archive();
    bytes[30 + new DataView(bytes.buffer).getUint16(26, true)] ^= 255;
    await assert.rejects(
      readZipEntries(bytes, "plugin fixture.zip"),
      /plugin fixture\.zip: Invalid ZIP/,
    );
  });

  it("still discards traversal entries", async () => {
    const entries = await readZipEntries(
      zipSync({
        "../outside.php": strToU8("unsafe"),
        "back\\..\\outside.php": strToU8("unsafe"),
        "safe/file.php": strToU8("safe"),
      }),
    );
    assert.deepEqual(
      entries.map(({ path }) => path),
      ["safe/file.php"],
    );
  });
});

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
