import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import {
  createDecodedTarStream,
  extractTarStreamToPhp,
  StreamingTarParser,
  sanitizeTarPath,
} from "../../lib/streaming-tar-extract.js";
import {
  createUstarTar,
  normalizeEntries,
} from "../../scripts/lib/tar-ustar.mjs";

const BLOCK = 512;
const enc = (s) => new TextEncoder().encode(s);

// Minimal raw tar builder so tests can craft dirs, absolute paths, etc. without
// depending on the production writer.
function rawTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const h = Buffer.alloc(BLOCK);
    Buffer.from(e.name, "utf8").copy(h, 0, 0, 100);
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    const data = e.data ? Buffer.from(e.data) : Buffer.alloc(0);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h.write(e.type || "0", 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += h[i];
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(h);
    if (data.length) {
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks
  return Buffer.concat(chunks);
}

function collect(tar, chunkSize) {
  const entries = [];
  const parser = new StreamingTarParser({ onEntry: (e) => entries.push(e) });
  if (chunkSize) {
    for (let i = 0; i < tar.length; i += chunkSize) {
      parser.push(tar.subarray(i, Math.min(i + chunkSize, tar.length)));
    }
  } else {
    parser.push(tar);
  }
  const stats = parser.end();
  return { entries, stats, parser };
}

describe("sanitizeTarPath", () => {
  it("rejects absolute paths and .. traversal, normalizes separators", () => {
    assert.throws(() => sanitizeTarPath("/etc/passwd"), /absolute/);
    assert.throws(() => sanitizeTarPath("a/../../etc"), /traversal/);
    assert.equal(sanitizeTarPath("a\\b\\c.txt"), "a/b/c.txt");
    assert.equal(sanitizeTarPath("./a/./b"), "a/b");
    assert.equal(sanitizeTarPath(""), "");
  });
});

describe("StreamingTarParser", () => {
  it("1. parses a directory entry followed by a file", () => {
    const tar = rawTar([
      { name: "somedir/", type: "5" },
      { name: "somedir/a.txt", data: enc("hello") },
    ]);
    const { entries, stats } = collect(tar);
    assert.equal(stats.dirCount, 1);
    assert.equal(stats.fileCount, 1);
    assert.deepEqual(entries[0], { type: "dir", path: "somedir" });
    assert.equal(entries[1].path, "somedir/a.txt");
    assert.equal(Buffer.from(entries[1].data).toString(), "hello");
  });

  it("2. reassembles a file split across multiple chunks", () => {
    const body = "x".repeat(1500); // > 2 blocks
    const tar = rawTar([{ name: "big.txt", data: enc(body) }]);
    const { entries } = collect(tar, 13); // tiny, unaligned chunks
    assert.equal(entries.length, 1);
    assert.equal(Buffer.from(entries[0].data).toString(), body);
  });

  it("3. handles a header split across chunks", () => {
    const tar = rawTar([{ name: "a.txt", data: enc("data") }]);
    // Feed 100 bytes (mid-header), then the rest.
    const parser = new StreamingTarParser({ onEntry: () => {} });
    parser.push(tar.subarray(0, 100));
    parser.push(tar.subarray(100));
    const stats = parser.end();
    assert.equal(stats.fileCount, 1);
  });

  it("4. resolves a GNU longlink path", () => {
    const longName = `dir/${"x".repeat(150)}.bin`;
    const tar = Buffer.from(
      createUstarTar(
        normalizeEntries({ [longName]: enc("gnu"), "a.txt": enc("a") }),
      ),
    );
    assert.ok(tar.includes(Buffer.from("././@LongLink")));
    const { entries } = collect(tar, 200);
    const found = entries.find((e) => e.path === longName);
    assert.ok(found, "GNU longlink path should resolve");
    assert.equal(Buffer.from(found.data).toString(), "gnu");
  });

  it("5. resolves a USTAR prefix/name long path", () => {
    const longName = `deep/${"segment/".repeat(20)}leaf.txt`;
    assert.ok(longName.length > 100 && longName.length < 255);
    const tar = Buffer.from(
      createUstarTar(normalizeEntries({ [longName]: enc("deep") })),
    );
    const { entries } = collect(tar, 64);
    assert.equal(entries[0].path, longName);
    assert.equal(Buffer.from(entries[0].data).toString(), "deep");
  });

  it("6. honors padding and the two-zero-block EOF", () => {
    const tar = rawTar([
      { name: "a.txt", data: enc("ab") }, // 2 bytes -> 510 padding
      { name: "b.txt", data: enc("c") },
    ]);
    const { entries, stats } = collect(tar, 7);
    assert.equal(stats.fileCount, 2);
    assert.equal(entries[0].path, "a.txt");
    assert.equal(entries[1].path, "b.txt");
  });

  it("7. rejects an absolute-path entry", () => {
    const tar = rawTar([{ name: "/etc/evil", data: enc("x") }]);
    assert.throws(() => collect(tar), /absolute/);
  });

  it("8. rejects a .. traversal entry", () => {
    const tar = rawTar([{ name: "a/../../etc/evil", data: enc("x") }]);
    assert.throws(() => collect(tar), /traversal/);
  });

  it("9. preserves the file count across many entries", () => {
    const map = {};
    for (let i = 0; i < 250; i += 1)
      map[`d${i % 7}/file-${i}.txt`] = enc(`content-${i}`);
    const tar = Buffer.from(createUstarTar(normalizeEntries(map)));
    const { stats } = collect(tar, 137);
    assert.equal(stats.fileCount, 250);
  });

  it("10. never buffers the whole archive (bounded maxBuffered)", () => {
    const map = {};
    for (let i = 0; i < 400; i += 1) map[`f${i}.bin`] = enc("y".repeat(2000));
    const tar = Buffer.from(createUstarTar(normalizeEntries(map)));
    const { stats } = collect(tar, 97);
    // Peak buffer must be a tiny fraction of the archive (bounded by one entry
    // + a chunk), NOT the whole multi-hundred-KB tar.
    assert.ok(
      stats.maxBuffered < tar.length / 4,
      `maxBuffered ${stats.maxBuffered} vs tar ${tar.length}`,
    );
    assert.ok(stats.maxBuffered < 20_000);
  });

  it("counts .php files (phpCount) for the parity tripwire", () => {
    const tar = Buffer.from(
      createUstarTar(
        normalizeEntries({
          "lib/x.php": enc("<?php"),
          "a.txt": enc("t"),
          "b.php": enc("<?php"),
        }),
      ),
    );
    const { stats } = collect(tar);
    assert.equal(stats.phpCount, 2);
  });

  it("throws on a truncated stream (half-read entry)", () => {
    const tar = rawTar([{ name: "a.txt", data: enc("x".repeat(1000)) }]);
    const parser = new StreamingTarParser({ onEntry: () => {} });
    parser.push(tar.subarray(0, 512 + 400)); // header + partial data
    assert.throws(() => parser.end(), /Truncated/);
  });

  it("11. surfaces an empty directory written by createUstarTar", () => {
    // End-to-end regression for the tar.zst core bundle: an empty plugin-type
    // root such as `local/` must survive the production writer -> streaming
    // extractor path (see tar-ustar.test.js for the writer-side assertions).
    const tar = Buffer.from(
      createUstarTar(
        normalizeEntries({ "local/": enc(""), "a.txt": enc("a") }),
      ),
    );
    const { entries, stats } = collect(tar, 64);
    assert.equal(stats.dirCount, 1);
    const dir = entries.find((e) => e.type === "dir" && e.path === "local");
    assert.ok(dir, "empty local/ directory must survive writer -> extractor");
  });
});

describe("extractTarStreamToPhp", () => {
  it("creates an empty directory on the filesystem via mkdirTree", async () => {
    const tar = Buffer.from(
      createUstarTar(
        normalizeEntries({
          "local/": enc(""),
          "mod/quiz/version.php": enc("<?php"),
        }),
      ),
    );
    const mkdirs = [];
    const writes = [];
    const fakePhp = {
      _php: {
        mkdirTree: (d) => mkdirs.push(d),
        writeFile: (p) => writes.push(p),
      },
    };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(tar);
        controller.close();
      },
    });
    const stats = await extractTarStreamToPhp(stream, fakePhp, "/www/moodle");
    // The empty plugin-type root is materialized even though it holds no file.
    assert.ok(
      mkdirs.includes("/www/moodle/local"),
      `expected /www/moodle/local to be created; got ${JSON.stringify(mkdirs)}`,
    );
    assert.ok(writes.includes("/www/moodle/mod/quiz/version.php"));
    assert.equal(stats.dirCount, 1);
    assert.equal(stats.fileCount, 1);
  });
});

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("createDecodedTarStream", () => {
  const tar = rawTar([{ name: "a.txt", data: "hello" }]);

  it("decodes gzip natively", async () => {
    const decoded = await readAll(
      await createDecodedTarStream(zlib.gzipSync(tar), "gzip"),
    );
    assert.deepEqual(decoded, tar);
  });

  it("falls back to the bundled zstd decoder when the platform lacks one", {
    skip: typeof zlib.zstdCompressSync !== "function",
  }, async () => {
    const compressed = new Uint8Array(zlib.zstdCompressSync(tar));
    const decoded = await readAll(
      await createDecodedTarStream(compressed, "zstd"),
    );
    assert.deepEqual(decoded, tar);
  });

  it("rejects a codec without any decoder", async () => {
    await assert.rejects(
      createDecodedTarStream(new Uint8Array(1), "lzma"),
      /No streaming decoder available for codec "lzma"/,
    );
  });
});

describe("tar parsing edge cases", () => {
  it("reads space-padded octal sizes and zero-length files", () => {
    const tar = rawTar([{ name: "empty.txt" }, { name: "b.txt", data: "xy" }]);
    // Rewrite b.txt's size field space-padded on both sides (old tar writers).
    const header = tar.subarray(BLOCK, BLOCK * 2);
    header.write("        2  \0", 124, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const { entries } = collect(tar);
    assert.deepEqual(
      entries.map((e) => [e.path, e.data?.length ?? 0]),
      [
        ["empty.txt", 0],
        ["b.txt", 2],
      ],
    );
  });
});

describe("extractTarStreamToPhp progress", () => {
  it("reports progress every 1000 files", async () => {
    const tar = rawTar(
      Array.from({ length: 1000 }, (_, i) => ({ name: `f${i}`, data: "x" })),
    );
    const events = [];
    await extractTarStreamToPhp(
      new Blob([tar]).stream(),
      { _php: { mkdirTree() {}, writeFile() {} } },
      "/www/",
      { onProgress: (e) => events.push(e) },
    );
    assert.deepEqual(events, [{ fileCount: 1000, bytes: 1000 }]);
  });
});
