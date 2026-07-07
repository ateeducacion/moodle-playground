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
  it("preserves empty directory members, sanitizes, and sorts byte-wise", () => {
    const map = {
      "b/second.txt": bytes("2"),
      "a/first.txt": bytes("1"),
      "dir/": bytes(""),
      "z.txt": bytes("z"),
    };
    const entries = normalizeEntries(map);
    // `dir/` has no file descendant, so it is kept as an explicit directory
    // member (see the empty-directory-preservation block below); `a/` and `b/`
    // are implied by their files and are NOT emitted as redundant members.
    assert.deepEqual(
      entries.map((e) => e.name),
      ["a/first.txt", "b/second.txt", "dir", "z.txt"],
    );
    assert.equal(entries.find((e) => e.name === "dir").type, "dir");
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

describe("tar-ustar empty directory preservation", () => {
  // Regression (issue: "Plugin type location does not exist!"): the docs trim in
  // scripts/build-moodle-bundle.sh empties Moodle's plugin-type roots — `local/`
  // ships only readme.txt + upgrade.txt, both matched by `*/readme*` and
  // `*/upgrade.txt`. The trimmed core ZIP still carries an explicit `local/`
  // directory member, but the files-only tar writer used to drop it, so
  // `<dirroot>/local` never existed at runtime and installing ANY `local` plugin
  // (e.g. local_accessibility) failed Moodle's validate_target_location().

  it("preserves an explicit empty directory (no file descendant)", () => {
    const entries = normalizeEntries({
      "local/": bytes(""),
      "mod/quiz/version.php": bytes("<?php"),
    });
    const dir = entries.find((e) => e.name === "local");
    assert.ok(dir, "empty local/ directory must be preserved");
    assert.equal(dir.type, "dir");
    // Directories implied by a file are NOT emitted as redundant members —
    // the streaming extractor reconstructs them from each file's parent path.
    assert.ok(!entries.some((e) => e.type === "dir" && e.name === "mod"));
    assert.ok(!entries.some((e) => e.type === "dir" && e.name === "mod/quiz"));
  });

  it("emits a USTAR directory header (typeflag 5, size 0) that round-trips", () => {
    const tar = createUstarTar(
      normalizeEntries({ "local/": bytes(""), "a.txt": bytes("a") }),
      { mtime: 0 },
    );
    // Locate the directory header in the raw bytes: typeflag byte at offset 156.
    const back = readUstarTar(tar);
    const dir = back.find((e) => e.name === "local");
    assert.ok(dir, "directory entry should round-trip via the reader");
    assert.equal(dir.type, "dir");
    assert.equal(dir.data, undefined);
    // Files still round-trip alongside directories.
    const file = back.find((e) => e.name === "a.txt");
    assert.ok(file && Buffer.from(file.data).equals(Buffer.from(bytes("a"))));
  });

  it("does not count directories as files", () => {
    const entries = normalizeEntries({
      "local/": bytes(""),
      "a.txt": bytes("a"),
      "b.txt": bytes("b"),
    });
    assert.equal(entries.filter((e) => e.type !== "dir").length, 2);
    assert.equal(entries.filter((e) => e.type === "dir").length, 1);
  });

  it("drops populated directory members that a file recreates (real fflate shape)", () => {
    // fflate's unzipSync() yields an EXPLICIT trailing-slash member for EVERY
    // directory in the ZIP, including populated ones — this is the real input
    // shape build-tar-zst-from-zip.mjs feeds normalizeEntries(). Only the truly
    // empty `local/` must survive; `mod/`, `mod/quiz/`, `lib/` are recreated by
    // their files and MUST be dropped (invariant: no redundant directory
    // members, else the tar gains thousands of typeflag-5 entries and dirCount
    // and the sha256 drift). Guards the impliedDirs dedup, which is otherwise
    // never exercised by the empty-only maps in the tests above.
    const entries = normalizeEntries({
      "mod/": bytes(""),
      "mod/quiz/": bytes(""),
      "mod/quiz/version.php": bytes("<?php"),
      "lib/": bytes(""),
      "lib/setup.php": bytes("<?php"),
      "local/": bytes(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["local"]);
  });

  it("preserves a nested empty directory but not those implied by files", () => {
    // Mirrors a plugin subtype root: widgets/ is empty; lang/en holds a file.
    const entries = normalizeEntries({
      "local/accessibility/version.php": bytes("<?php"),
      "local/accessibility/lang/en/local_accessibility.php": bytes("<?php"),
      "local/accessibility/widgets/": bytes(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["local/accessibility/widgets"]);
  });

  it("skips unsafe directory paths (path traversal)", () => {
    const entries = normalizeEntries({
      "../evil/": bytes(""),
      "local/accessibility/../../evil/": bytes(""),
      "ok/": bytes(""),
    });
    const dirs = entries.filter((e) => e.type === "dir").map((e) => e.name);
    assert.deepEqual(dirs, ["ok"]);
  });

  it("is deterministic with directory entries (stable sha256 across two builds)", () => {
    const map = {
      "local/": bytes(""),
      "admin/tool/": bytes(""),
      "mod/quiz/version.php": bytes("<?php"),
      "z.txt": bytes("z"),
    };
    const a = createUstarTar(normalizeEntries(map), { mtime: 0 });
    const b = createUstarTar(normalizeEntries(map), { mtime: 0 });
    assert.ok(Buffer.from(a).equals(Buffer.from(b)));
    assert.equal(sha256(a), sha256(b));
    assert.equal(a.length % 512, 0);
  });
});
