import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decoderSupported,
  nativeDecoderSupported,
  selectBundleDescriptor,
  streamingSupported,
} from "../../lib/moodle-loader.js";

// A manifest as normalizeManifest would leave it (urls resolved). We only need
// the fields selectBundleDescriptor reads.
function manifest(alternatives) {
  return {
    release: "5.0-test",
    bundle: {
      format: "zip",
      url: "https://example.test/moodle-core.zip",
      sha256: "a".repeat(64),
      size: 73_000_000,
      fileCount: 23_324,
    },
    bundleAlternatives: alternatives,
  };
}

const ALTS = [
  {
    format: "tar.zst",
    container: "tar",
    codec: "zstd",
    url: "u/z",
    sha256: "b".repeat(64),
    size: 36_000_000,
    uncompressedSize: 262_000_000,
    fileCount: 23_324,
  },
  {
    format: "tar.gz",
    container: "tar",
    codec: "gzip",
    url: "u/g",
    sha256: "c".repeat(64),
    size: 54_000_000,
    uncompressedSize: 262_000_000,
    fileCount: 23_324,
  },
];

describe("selectBundleDescriptor", () => {
  it("defaults to the ZIP descriptor (no/zip request)", () => {
    for (const req of [null, undefined, "zip", ""]) {
      const d = selectBundleDescriptor(manifest(ALTS), req);
      assert.equal(d.container, "zip");
      assert.equal(d.format, "zip");
      assert.equal(d.forced, false);
    }
  });

  it("returns a forced STREAMING tar descriptor for an explicit format", () => {
    // gzip decodes natively everywhere (incl. Node), so this is stable.
    const d = selectBundleDescriptor(manifest(ALTS), "tar.gz");
    assert.equal(d.container, "tar");
    assert.equal(d.codec, "gzip");
    assert.equal(d.forced, true);
    assert.equal(d.extraction, "streaming");
    assert.equal(d.uncompressedSize, 262_000_000);
  });

  it("selects the FULL (ADR 0018) path for a '-full' suffix", () => {
    const d = selectBundleDescriptor(manifest(ALTS), "tar.zst-full");
    assert.equal(d.format, "tar.zst");
    assert.equal(d.requestedFormat, "tar.zst-full");
    assert.equal(d.extraction, "full");
    assert.equal(d.forced, true);
  });

  it("throws (fail loud) for a forced format not in the manifest", () => {
    assert.throws(
      () => selectBundleDescriptor(manifest(ALTS), "tar.xyz"),
      /not in manifest/,
    );
  });

  it("throws (fail loud) for a forced format whose codec cannot be decoded", () => {
    const m = manifest([
      {
        format: "tar.lzma",
        container: "tar",
        codec: "lzma",
        url: "u/l",
        sha256: "d".repeat(64),
        size: 1,
      },
    ]);
    assert.throws(() => selectBundleDescriptor(m, "tar.lzma"), /cannot decode/);
  });

  it("auto picks the first STREAMING-capable alternative (tar.zst) over ZIP", () => {
    // zstd streams via zstddec, so auto prefers the smaller tar.zst (listed first).
    const d = selectBundleDescriptor(manifest(ALTS), "auto");
    assert.equal(d.container, "tar");
    assert.equal(d.codec, "zstd");
    assert.equal(d.extraction, "streaming");
    assert.equal(d.forced, false);
  });

  it("auto falls back to ZIP when no alternative is decodable", () => {
    const m = manifest([
      {
        format: "tar.lzma",
        container: "tar",
        codec: "lzma",
        url: "u/l",
        sha256: "d".repeat(64),
        size: 1,
      },
    ]);
    const d = selectBundleDescriptor(m, "auto");
    assert.equal(d.container, "zip");
  });
});

describe("decoder feature detection", () => {
  it("reports gzip as universally decodable", () => {
    assert.equal(nativeDecoderSupported("gzip"), true);
    assert.equal(decoderSupported("gzip"), true);
  });

  it("treats zstd as supported via the bundled zstddec (WASM) fallback", () => {
    // Even where DecompressionStream('zstd') is absent, zstddec covers it.
    assert.equal(decoderSupported("zstd"), true);
  });

  it("reports zstd and gzip as STREAMING-capable", () => {
    // zstddec has a streaming generator; gzip streams natively.
    assert.equal(streamingSupported("zstd"), true);
    assert.equal(streamingSupported("gzip"), true);
    assert.equal(streamingSupported("lzma"), false);
  });
});
