import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createUstarTar,
  normalizeEntries,
  readUstarTar,
  sanitizeArchivePath,
} from "../../scripts/lib/tar-ustar.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const bytes = (s) => new Uint8Array(Buffer.from(s));

describe("tar-ustar normalizeEntries", () => {
  it("drops directory members, sanitizes, and sorts byte-wise", () => {
    const map = {
      "b/second.txt": bytes("2"),
      "a/first.txt": bytes("1"),
      "dir/": bytes(""),
      "z.txt": bytes("z"),
    };
    const entries = normalizeEntries(map);
    assert.deepEqual(
      entries.map((e) => e.name),
      ["a/first.txt", "b/second.txt", "z.txt"],
    );
  });

  it("rejects path-traversal entries", () => {
    const entries = normalizeEntries({
      "../evil": bytes("x"),
      "ok.txt": bytes("y"),
    });
    assert.deepEqual(
      entries.map((e) => e.name),
      ["ok.txt"],
    );
    assert.throws(() => sanitizeArchivePath("a/../../etc/passwd"));
  });
});

describe("tar-ustar createUstarTar", () => {
  const map = {
    "lib/setup.php": bytes("<?php // setup\n"),
    "admin/index.php": bytes("<?php // admin\n"),
    "z-last.txt": bytes("last\n"),
  };

  it("is deterministic (byte-identical + stable sha256 across two builds)", () => {
    const a = createUstarTar(normalizeEntries(map), { mtime: 0 });
    const b = createUstarTar(normalizeEntries(map), { mtime: 0 });
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    assert.equal(sha256(a), sha256(b));
    assert.equal(a.length % 512, 0);
  });

  it("pins metadata (mtime=0, uid=gid=0) in the header", () => {
    const tar = createUstarTar(normalizeEntries(map), { mtime: 0 });
    // First header: bytes 136..148 = mtime octal; 108..116 = uid; 116..124 = gid.
    const header = Buffer.from(tar.buffer, tar.byteOffset, 512);
    const mtime = header.toString("ascii", 136, 147).replace(/\0.*/, "").trim();
    const uid = header.toString("ascii", 108, 115).replace(/\0.*/, "").trim();
    const gid = header.toString("ascii", 116, 123).replace(/\0.*/, "").trim();
    assert.equal(Number.parseInt(mtime, 8), 0);
    assert.equal(Number.parseInt(uid, 8), 0);
    assert.equal(Number.parseInt(gid, 8), 0);
    // Valid USTAR magic at offset 257.
    assert.equal(header.toString("ascii", 257, 262), "ustar");
  });

  it("round-trips file content", () => {
    const entries = normalizeEntries(map);
    const back = readUstarTar(createUstarTar(entries, { mtime: 0 }));
    assert.equal(back.length, entries.length);
    for (let i = 0; i < entries.length; i += 1) {
      assert.equal(back[i].name, entries[i].name);
      assert.ok(Buffer.from(back[i].data).equals(Buffer.from(entries[i].data)));
    }
  });

  it("round-trips long paths via the USTAR prefix/name split", () => {
    // A long path with a "/" that allows prefix<=155, name<=100.
    const longName = `deep/${"segment/".repeat(20)}leaf.txt`;
    assert.ok(longName.length > 100 && longName.length < 255);
    const entries = normalizeEntries({
      [longName]: bytes("deep"),
      "a.txt": bytes("a"),
    });
    const back = readUstarTar(createUstarTar(entries, { mtime: 0 }));
    const deep = back.find((e) => e.name === longName);
    assert.ok(deep, "long path should round-trip via prefix split");
    assert.ok(Buffer.from(deep.data).equals(Buffer.from(bytes("deep"))));
  });

  it("round-trips unsplittable long paths via GNU longlink", () => {
    // A single path component >100 bytes with no usable "/" split -> GNU longlink.
    const longName = `dir/${"x".repeat(150)}.bin`;
    const entries = normalizeEntries({
      [longName]: bytes("gnu"),
      "a.txt": bytes("a"),
    });
    const tar = createUstarTar(entries, { mtime: 0 });
    // The archive must contain a GNU longlink marker for this entry.
    assert.ok(Buffer.from(tar).includes(Buffer.from("././@LongLink")));
    const back = readUstarTar(tar);
    const deep = back.find((e) => e.name === longName);
    assert.ok(deep, "unsplittable path should round-trip via GNU longlink");
    assert.ok(Buffer.from(deep.data).equals(Buffer.from(bytes("gnu"))));
  });
});
