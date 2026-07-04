# 0019 — Streaming extraction for tar.zst Moodle core bundles

## Status

Proposed / Experimental (2026-07-04). Branch `experiment/core-bundle-solid-compression`.
Continues ADR 0018. No default behaviour change: ZIP remains the default and fallback.

## Context and Problem

ADR 0018 measured solid-compressed core bundles and found `tar.zst` cuts the download
**~51 %** (70.3 → 34.6 MiB) and drops the hosted-chunk count 3 → 2, booting end-to-end in
Chrome. Its recommendation was **"Defer — lean Adopt for `tar.zst` once peak memory is
bounded."** The blocker: the ADR 0018 prototype decodes the **whole** compressed tar into a
single ~250 MB `Uint8Array`, writes that into MEMFS, and extracts it with `PharData`. That
full-tar materialization is a large peak-memory regression versus the ZIP path (which streams
one entry at a time through libzip) and risks OOM on memory-constrained/mobile browsers.

### Why full-tar materialization is the memory blocker

The uncompressed Moodle tar is **262,742,016 B (≈250 MiB)** — larger than the 74 MiB zip. The
ADR 0018 path holds it **twice** at peak (the decoded `Uint8Array` in the JS heap *and* the
copy written into MEMFS), and the one-shot `zstddec.decode()` additionally peaks ~640 MB RSS
in WASM (measured). ZIP, by contrast, holds only the 74 MB compressed archive plus the growing
tree. So the tar path's peak is several hundred MB above ZIP — the reason ADR 0018 could not
recommend adoption.

## The new streaming architecture

```
fetch/reassemble compressed tar.zst  (cache-first, whole-artifact + per-part SHA-256)
  → zstddec STREAMING decode          (generator yields ~128 KB tar chunks, lazily)
  → incremental USTAR/GNU parser       (StreamingTarParser, bounded buffer)
  → write each file/dir into MEMFS as it is decoded   (raw Emscripten mkdirTree + writeFile)
  → verify file-count parity + required-file asserts
```

The full uncompressed tar is **never materialized**. At any instant the runtime holds only:
a partial ≤512-byte header, the current entry's bytes (bounded by the largest single file),
one decoded ~128 KB chunk, and the pending GNU-longlink name. New code:
`lib/streaming-tar-extract.js` (`StreamingTarParser`, `createDecodedTarStream`,
`extractTarStreamToPhp`); the runtime dispatch lives in `src/runtime/bootstrap.js`.

Decode runs at the extraction site (after `php.refresh()`), where PHP/MEMFS is ready; the
compressed download still overlaps the WASM compile in `startArchiveResolution`.

### How the streaming TAR parser handles each case

* **USTAR prefix/name split** — rejoins `prefix + "/" + name` from the 155- and 100-byte fields.
* **GNU `././@LongLink`** — an 'L'-type entry whose body is the full path (NUL-terminated),
  applied to the next entry.
* **Directories** — typeflag `5` or a trailing-slash name → a `dir` entry (parent creation).
* **Regular files** — typeflag `0`/`\0` → buffered to `size` bytes, then written.
* **Zero padding** — each entry's data is padded to the next 512-byte boundary; the parser
  skips exactly `(512 − size % 512) % 512` bytes.
* **Block alignment** — a byte-exact 512-block state machine tolerant of arbitrarily chunked
  input (headers or file bodies split across chunks).
* **Path traversal / absolute / `..`** — `sanitizeTarPath()` normalizes `\`→`/`, **throws** on
  a leading `/` (absolute) or any `..` segment, and drops empty/`.` segments — no TAR-slip.
* **Truncation** — a half-read entry at end-of-stream throws (fail loud).

### Why `tar.zst` remains the preferred candidate

Unchanged from ADR 0018 and reconfirmed here: `tar.br` is ~0.2 % smaller but ~4× slower to
build and needs a heavier brotli WASM decoder; `tar.gz` is only −27 % (its 54 MB frame stays
at 3 chunks); `zip.zst`/`zip.br` gain only ~12 %. `tar.zst` is the best size/decoder trade —
and `zstddec` exposes a true streaming generator, which is what makes bounded-memory
extraction possible.

### Why ZIP remains default and fallback

The ZIP + `ZipArchive` path is untouched, is the fastest to extract (native, no JS decode),
and needs no extra dependency. Streaming tar is opt-in via `?bundle-format=`; a non-forced tar
failure (decode / extract / parity) falls back to ZIP at the extraction site.

### Runtime modes

`?bundle-format=zip` (default) · `tar.zst` (streaming, ADR 0019) · `tar.gz` (streaming, native
gzip) · `auto` (smallest streaming-capable alt → `tar.zst`; else ZIP) · `tar.zst-full`
(ADR 0018 full-buffer path, benchmark-only, **not eligible for adoption**). Forced formats fail
loud; `auto` logs and falls back to ZIP.

### Checksums and parity preserved

Whole-artifact + per-part **SHA-256 over the compressed artifact** (reused `verifyBundle`,
before decode). **File-count parity**: the streamed file count must equal the manifest's
`fileCount` (else throw → ZIP fallback for non-forced). **PHP-count** is tracked
(`phpCount`, surfaced in metrics). **Required-file asserts** after extraction:
`lib/requirejs.php`, `lib/behat/lib.php`, `lang/en/moodle.php` (each tolerant of the 5.1+
`public/` layout).

## Results

`MOODLE_500_STABLE`. Storage on Node 26; runtime on Chrome 150 (local, unthrottled); "Model DL
Fast-3G" = `bytes / 1.6 Mbit·s⁻¹`. Peak JS memory for streaming is the measured parser
high-water mark; for full it is the materialized tar.

| Format | Extraction mode | Bundle size | Chunks | Download time (model Fast-3G) | Decode time | Extract/write time | Total cold boot (local) | Peak JS memory | Peak WASM/MEMFS memory | Chrome | Firefox | Verdict |
|--------|----------------|------------:|:------:|-----------------------------:|------------:|-------------------:|------------------------:|---------------:|-----------------------:|:------:|:-------:|---------|
| **zip** | ZipArchive (native) | 70.3 MiB | 3 | ~369 s | 0 ms | ~2 s (in mount) | ~3.4 s (Chrome) / ~13 s (FF) | small (libzip) | ~74 MB + tree | ✅ | ✅ | default + fallback |
| **tar.zst** | **streaming** (ADR 0019) | 34.6 MiB | 2 | **~181 s** | fused | **~3.4 s** | ~2.9–6.4 s (Chrome) / ~10 s (FF) | **~6.6 MiB** | zstd window (~128 MB, tunable) + tree | ✅ | **✅** | **memory blocker resolved; boots on Firefox** |
| tar.zst-full | full buffer (ADR 0018) | 34.6 MiB | 2 | ~181 s | ~224 ms | native PharData | ~2.5–3.1 s (Chrome) | **~250 MiB (full tar)** | ~640 MB RSS + tree | ✅ | **❌¹** | fast on Chrome but **FAILS on Firefox** (OOM/flake) |
| tar.gz | streaming (native gzip) | 51.5 MiB | 3 | ~270 s | fused | ~3.4 s | ~2.9 s (Chrome) / ~9 s (FF) | ~6.6 MiB | small + tree | ✅ | ✅ | cross-browser safe, smaller win |

¹ **Key cross-browser result:** in the same benchmark run, **streaming `tar.zst` booted on
Firefox (~10 s) while the full-buffer `tar.zst-full` FAILED on Firefox** — the ADR 0018
full-tar materialization is not just heavier, it prevents the tar path from booting on Firefox
at all, whereas the bounded streaming path succeeds. (Firefox is ~3× slower than Chrome overall
via the nested-iframe path; `zip` ~13 s, `tar.gz` ~9 s.) See
`artifacts/compression-experiment/summary.md`.

### Memory comparison (the crux)

| Path | Peak JS heap (bundle) | Peak WASM/MEMFS |
|------|----------------------:|-----------------|
| ZIP baseline | small (compressed 74 MB handed to libzip) | 74 MB + tree |
| ADR 0018 full-tar prototype | **~250 MiB** (whole tar) | ~640 MB RSS (one-shot zstddec) + tree |
| **ADR 0019 streaming** | **~6.6 MiB** (largest single file) | zstd window ~128 MB (wlog27, tunable) + tree |

### Does streaming meet the ADR 0018 memory criterion?

**Yes for the specific blocker: the ~250 MB full-tar materialization is eliminated** — measured
peak JS buffer drops from ~250 MiB to **~6.6 MiB** (bounded by the largest single Moodle file),
with 23,324-file parity. A residual cost remains — `zstddec`'s decode **window** in WASM
(~128 MB at the build's `windowLog=27`) — so streaming's total peak (window + tree) is still
above ZIP's, though far below the full-buffer path. That window is a **build-time lever**
(smaller `windowLog` trades a little ratio for lower decode memory) and is the recommended next
measurement before adoption.

### Does streaming make cold boot faster?

Measured extract-write cost of the streaming path is **modest**: ~0.5 s (Chrome) / ~1.7 s
(Firefox) warm, up to ~3.4 s on a fully cold WASM run. Total boot is noisy (WASM compile
dominates and is cached across contexts) — in the benchmark run streaming `tar.zst` totalled
**2.9 s in Chrome vs ZIP's 3.9 s**, i.e. *within run-to-run noise of ZIP*, not the regression an
early single cold run suggested.

* **Fast local / warm-cache network:** Roughly a wash. The download saving is invisible on an
  instant network; the extra JS extract-write is small and lands within ZIP's own variance.
* **Slow network:** Faster, decisively — the −51 % smaller download (modeled ~181 s vs ~369 s on
  Fast-3G) dwarfs the ≤ ~1.7 s extra extraction.
* **Warm Cache API boot:** Comparable — the artifact is served from cache (no download win), the
  small extraction cost remains (Chrome warm ~2.4 s vs ZIP ~3.2 s in the run).
* **Memory-constrained:** The win — bounded peak JS buffer (~6.6 MiB) instead of a ~250 MB
  spike, which is also **what lets `tar.zst` boot on Firefox at all** (the full-buffer path
  fails there).

## Decision

**Keep experimental — but the case for `tar.zst` is now stronger than ADR 0018.** Streaming
resolves the memory blocker (the reason adoption was deferred), keeps the −51 % download win,
adds only a modest extract-write cost (within ZIP's local boot variance), and — unlike the
full-buffer path — actually boots on Firefox. It is a decisive win on slow networks and roughly
a wash on fast ones. Before flipping the default: (1) measure a smaller build `windowLog` to
bring the WASM decode window nearer ZIP's footprint; (2) confirm the throttled-network win and a
mobile-memory ceiling on real hardware; (3) optionally batch the per-file MEMFS writes. ZIP
stays default until those land.

## Consequences

### Positive
* Peak JS buffer bounded to ~6.6 MiB (from ~250 MiB) — the ADR 0018 blocker is gone.
* **Streaming `tar.zst` boots on Firefox, where the full-buffer path fails** — the lower
  memory ceiling is not just theoretical, it makes the tar path viable cross-browser.
* Full 23,324-file parity, checksum verification, and TAR-slip protection preserved.
* A reusable, unit-tested streaming tar toolchain; `auto` and forced modes with ZIP fallback.

### Negative / Risks
* Streaming extraction is slower than native ZipArchive/PharData (JS per-file writes) → net
  cold-boot regression on fast local networks.
* Residual zstd decode window in WASM (~128 MB at wlog27) keeps total peak above ZIP.
* Adds `zstddec/stream` usage (already bundled) and a larger runtime code surface behind the flag.

## Implementation Notes

* `lib/streaming-tar-extract.js` — `StreamingTarParser`, `createDecodedTarStream`,
  `extractTarStreamToPhp`, `sanitizeTarPath`.
* `lib/moodle-loader.js` — `selectBundleDescriptor` extraction modes (`streaming`/`full`,
  `-full` suffix), `streamingSupported`, streaming returns compressed bytes (no decode).
* `src/runtime/bootstrap.js` — extraction dispatch (zip / streaming / full), parity +
  required-file asserts, site-level ZIP fallback, `archive.extractionMeta`.
* `php-worker.js` — structured `boot-metrics` gains `extractionMode`, `decodedBytes`,
  `fileCount`, `directoryCount`, `phpCount`, `maxBufferedBytes`, `extractWriteMs`.
* Requires `npm run build-worker`. Tests: `tests/runtime/streaming-tar-extract.test.js`,
  updated `tests/runtime/bundle-format.test.js`. Benchmark:
  `scripts/benchmark-core-bundle-formats.mjs` (adds `tar.zst-full` + memory columns).

## Review Criteria

* Revisit adoption after measuring a smaller-`windowLog` build (memory vs ratio) and a real
  throttled-network + mobile boot.
* Revisit if a browser ships native `DecompressionStream("zstd")` (drops the zstddec window
  concern for that browser).
* Revisit the extraction-speed penalty if the per-file MEMFS write path is optimized (batched
  writes) — it could flip the fast-network verdict.
* Re-measure when the Moodle bundle's largest-file size grows materially (it bounds the peak JS
  buffer).
