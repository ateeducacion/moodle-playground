import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunkCountFor,
  MAX_FILE,
  MIB,
  PART_SIZE,
  parseCliVersion,
  ratioAndDeltas,
} from "../../scripts/lib/compression-metrics.mjs";

describe("chunkCountFor", () => {
  it("returns 1 for anything at or below the 25 MiB per-file cap", () => {
    assert.equal(chunkCountFor(0), 1);
    assert.equal(chunkCountFor(MAX_FILE), 1);
    assert.equal(chunkCountFor(MAX_FILE - 1), 1);
  });

  it("splits into 24 MiB parts only above the cap", () => {
    assert.equal(chunkCountFor(MAX_FILE + 1), 2); // 25 MiB + 1 -> 2 parts of 24 MiB
    assert.equal(chunkCountFor(2 * PART_SIZE), 2); // exactly 48 MiB -> 2
    assert.equal(chunkCountFor(2 * PART_SIZE + 1), 3);
  });

  it("matches the current 73,761,528-byte baseline zip -> 3 parts", () => {
    assert.equal(chunkCountFor(73_761_528), 3);
  });

  it("shows the 2-vs-3 boundary a smaller candidate can cross", () => {
    assert.equal(chunkCountFor(50 * MIB), 3); // 50 MiB still 3 parts
    assert.equal(chunkCountFor(48 * MIB), 2); // 48 MiB drops to 2
  });

  it("guards against invalid input", () => {
    assert.equal(chunkCountFor(-1), 0);
    assert.equal(chunkCountFor(Number.NaN), 0);
  });
});

describe("ratioAndDeltas", () => {
  it("computes ratio vs tar and signed deltas vs zip", () => {
    const r = ratioAndDeltas(50, 250, 74);
    assert.equal(r.compressionRatioVsTar, 5);
    assert.equal(r.sizeDeltaVsZipBytes, -24); // smaller than zip
    assert.equal(
      r.sizeDeltaVsZipPercent,
      Math.round(((100 * -24) / 74) * 100) / 100,
    );
  });

  it("marks a candidate larger than zip with positive deltas", () => {
    const r = ratioAndDeltas(80, 250, 74);
    assert.equal(r.sizeDeltaVsZipBytes, 6);
    assert.ok(r.sizeDeltaVsZipPercent > 0);
  });

  it("guards division by zero", () => {
    const r = ratioAndDeltas(50, 0, 0);
    assert.equal(r.compressionRatioVsTar, null);
    assert.equal(r.sizeDeltaVsZipPercent, null);
  });
});

describe("parseCliVersion", () => {
  it("extracts versions from real CLI banners", () => {
    assert.equal(
      parseCliVersion("*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***"),
      "1.5.7",
    );
    assert.equal(parseCliVersion("brotli 1.2.0"), "1.2.0");
    assert.equal(parseCliVersion("bsdtar 3.5.3 - libarchive 3.7.4"), "3.5.3");
  });

  it("returns null when no version token is present", () => {
    assert.equal(parseCliVersion("no version here"), null);
    assert.equal(parseCliVersion(""), null);
  });
});
