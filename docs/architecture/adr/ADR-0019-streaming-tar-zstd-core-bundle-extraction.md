# 0019 — Streaming extraction for tar.zst Moodle core bundles

## Status

Accepted (2026-07-05). Continues (and supersedes the "keep experimental" verdict of) ADR 0018.
**Amended by [ADR 0020](ADR-0020-preserve-empty-directories-in-tar-bundle.md)** (2026-07-06): the
"files-only (no directory members)" policy below is relaxed — the writer now also emits directory
entries for the few directories that ship empty after the build trim (e.g. `local/`), so Moodle's
empty plugin-type roots survive. `bundle.fileCount` stays files-only, so the parity tripwire is
unchanged.

**`tar.zst` streaming is now the sole core-bundle format.** The ZIP core path and its PHP
`ZipArchive` extractor were removed: there is **no `?bundle-format=` flag, no `bundleAlternatives`
manifest field, and no ZIP fallback**. The build emits one `tar.zst` per branch; the runtime
streams it and a file-count parity mismatch **fails loud** (throws) rather than falling back.
(ZIP is still used, unchanged, for untrusted plugin/blueprint archives via `lib/moodle-loader.js`;
and a `zip` intermediate is produced at build time then discarded — see ADR 0018.)

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

### Why ZIP was removed (no fallback)

With streaming resolving the memory blocker, `tar.zst` beats ZIP on every axis this project
cares about — half the download, one fewer hosted chunk, bounded peak memory, boots on both
Chrome and Firefox — while preserving checksum verification and full file-count parity. Keeping
ZIP as a second, "fallback" path would mean maintaining two extractors, a format-selection
branch, and the manifest/flag plumbing to choose between them, for a path that is strictly worse.
So the ZIP core path and the `ZipArchive` extractor were **removed**: `tar.zst` is the only core
format, decoded and extracted by `lib/streaming-tar-extract.js`. A decode / parse / parity
failure **throws** (fail loud); there is nothing to fall back to, which surfaces a broken bundle
immediately instead of masking it. (The ZIP reader in `lib/moodle-loader.js` stays for untrusted
plugin/blueprint archives — a separate, sandboxed concern.)

### One runtime path

There are no format modes and no `?bundle-format=` flag: the core boot always streams the
`tar.zst` advertised by the manifest. The decoder is chosen from `manifest.bundle.codec`
(`"zstd"` today; `createDecodedTarStream` also handles native `gzip`/`brotli` via
`DecompressionStream`, so a future re-container is a manifest change, not a code change), and an
unknown codec throws.

### Checksums and parity preserved

Whole-artifact + per-part **SHA-256 over the compressed artifact** (reused `verifyBundle` in
`lib/moodle-loader.js`, before decode). **File-count parity**: the streamed file count must
equal the manifest's `bundle.fileCount`, else `src/runtime/bootstrap.js` **throws** (there is
no fallback). **PHP-count** is tracked by the parser (`phpCount` in its returned stats). The
`tar.zst` build itself is guarded by the ZIP-side PHP-parity + required-file tripwires in
`scripts/build-moodle-bundle.sh` before the ZIP is re-containered.

## Results

`MOODLE_500_STABLE`. Storage on Node 26; runtime on Chrome 150 (local, unthrottled); "Model DL
Fast-3G" = `bytes / 1.6 Mbit·s⁻¹`. Peak JS memory for streaming is the measured parser
high-water mark; for full it is the materialized tar.

| Format | Extraction mode | Bundle size | Chunks | Download time (model Fast-3G) | Decode time | Extract/write time | Total cold boot (local) | Peak JS memory | Peak WASM/MEMFS memory | Chrome | Firefox | Verdict |
|--------|----------------|------------:|:------:|-----------------------------:|------------:|-------------------:|------------------------:|---------------:|-----------------------:|:------:|:-------:|---------|
| **zip** | ZipArchive (native) | 70.3 MiB | 3 | ~369 s | 0 ms | ~2 s (in mount) | ~3.4 s (Chrome) / ~13 s (FF) | small (libzip) | ~74 MB + tree | ✅ | ✅ | former baseline — removed from core boot |
| **tar.zst** | **streaming** (ADR 0019) | 34.6 MiB | 2 | **~181 s** | fused | **~3.4 s** | ~2.9–6.4 s (Chrome) / ~10 s (FF) | **~6.6 MiB** | zstd window (~128 MB, tunable) + tree | ✅ | **✅** | **memory blocker resolved; boots on Firefox** |
| tar.zst-full | full buffer (ADR 0018) | 34.6 MiB | 2 | ~181 s | ~224 ms | native PharData | ~2.5–3.1 s (Chrome) | **~250 MiB (full tar)** | ~640 MB RSS + tree | ✅ | **❌¹** | fast on Chrome but **FAILS on Firefox** (OOM/flake) |
| tar.gz | streaming (native gzip) | 51.5 MiB | 3 | ~270 s | fused | ~3.4 s | ~2.9 s (Chrome) / ~9 s (FF) | ~6.6 MiB | small + tree | ✅ | ✅ | cross-browser safe, smaller win |

¹ **Key cross-browser result:** in the same benchmark run, **streaming `tar.zst` booted on
Firefox (~10 s) while the full-buffer `tar.zst-full` FAILED on Firefox** — the ADR 0018
full-tar materialization is not just heavier, it prevents the tar path from booting on Firefox
at all, whereas the bounded streaming path succeeds. (Firefox is ~3× slower than Chrome overall
via the nested-iframe path; `zip` ~13 s, `tar.gz` ~9 s.) Measured on the
`experiment/core-bundle-solid-compression` branch benchmark run.

### Memory comparison (the crux)

| Path | Peak JS heap (bundle) | Peak WASM/MEMFS |
|------|----------------------:|-----------------|
| ZIP baseline | small (compressed 74 MB handed to libzip) | 74 MB + tree |
| ADR 0018 full-tar prototype | **~250 MiB** (whole tar) | ~640 MB RSS (one-shot zstddec) + tree |
| **ADR 0019 streaming** (shipped) | **~6.6 MiB** (largest single file) | zstd window **~16 MB** (shipped wlog24; was ~128 MB at the wlog27 measured above) + tree |

### Does streaming meet the ADR 0018 memory criterion?

**Yes for the specific blocker: the ~250 MB full-tar materialization is eliminated** — measured
peak JS buffer drops from ~250 MiB to **~6.6 MiB** (bounded by the largest single Moodle file),
with 23,324-file parity. A residual cost remains — `zstddec`'s decode **window** in WASM, which
the decoder must allocate on every client — so streaming's total peak (window + tree) is still
above ZIP's, though far below the full-buffer path.

That window is a **build-time lever** (a smaller `windowLog` trades a little compression ratio
for a smaller client-side decode window), and this ADR takes it: the shipped build uses
**`windowLog = 24` (16 MiB window)** rather than the 27 (128 MiB) measured above. On the
250.6 MiB `MOODLE_500_STABLE` tree that costs **+0.90 % bundle size (34.61 → 34.92 MiB)** for an
**8× smaller decode window (128 → 16 MiB)** that `zstddec` allocates on every Firefox/Safari
client — a clearly worthwhile trade for a browser runtime, and it keeps the bundle at 2 hosted
chunks. See `scripts/build-tar-zst-from-zip.mjs`.

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

**Adopt streaming `tar.zst` as the sole core-bundle format and remove the ZIP core path.**
Streaming resolves the memory blocker that made ADR 0018 defer (peak JS buffer ~250 MiB →
~6.6 MiB), keeps the −51 % download win, adds only a modest extract-write cost (within ZIP's
local boot variance), and — unlike the full-buffer path — actually boots on Firefox. It is a
decisive win on slow networks and roughly a wash on fast ones. Two of the three pre-adoption
items are now settled: the build `windowLog` was lowered to 24 (16 MiB window, above), and ZIP
was removed rather than kept as a fallback (a second, strictly-worse extractor is not worth
maintaining). The remaining follow-ups — a throttled-network + mobile-memory measurement on real
hardware, and optionally batching the per-file MEMFS writes — are optimizations, not blockers,
and are tracked under Review Criteria.

## Consequences

### Positive
* Peak JS buffer bounded to ~6.6 MiB (from ~250 MiB) — the ADR 0018 blocker is gone.
* **Streaming `tar.zst` boots on Firefox, where the full-buffer path fails** — the lower
  memory ceiling is not just theoretical, it makes the tar path viable cross-browser.
* Full 23,324-file parity, checksum verification, and TAR-slip protection preserved.
* One code path: removing the ZIP core extractor deletes the format-selection branch, the flag
  plumbing, and a second extractor to maintain. A parity/decode failure fails loud.
* A reusable, unit-tested streaming tar toolchain shared verbatim with the sibling
  `*-playground` repos.

### Negative / Risks
* Streaming extraction is slower than the native `ZipArchive` mount (JS per-file writes) → a
  small extract-write cost on warm/fast-local boots (within ZIP's own boot variance).
* A residual zstd decode window in WASM (16 MiB at the shipped wlog24) keeps total peak above
  ZIP's, though far below the full-buffer path.
* Adds `zstddec/stream` usage (lazy-imported at the extraction site) and the streaming-parser
  code surface. A malformed/truncated bundle now hard-fails the boot instead of falling back —
  the intended trade (surface a broken bundle immediately), but it removes the safety net.

## Implementation Notes

* `lib/streaming-tar-extract.js` — `createDecodedTarStream` (zstddec streaming, or native
  `DecompressionStream` for gzip/brotli), `extractTarStreamToPhp`, `StreamingTarParser`,
  `sanitizeTarPath`. Copied verbatim into the sibling `*-playground` repos (canonical here).
* `scripts/lib/tar-ustar.mjs` — deterministic USTAR + GNU-longlink writer/reader (also
  canonical; shared verbatim). `scripts/build-tar-zst-from-zip.mjs` re-containers the trimmed
  core ZIP into `tar.zst` (`node:zlib` zstd L19 + LDM, wlog24).
* `src/runtime/bootstrap.js` — the sole extraction path: decode via
  `archive.manifest.bundle.codec` → `createDecodedTarStream` → `extractTarStreamToPhp`, then the
  file-count parity tripwire (throws on mismatch). No format dispatch, no fallback.
* `scripts/generate-manifest.mjs` — records `bundle.format`/`container`/`codec`/`fileCount`;
  `scripts/chunk-bundles.mjs` splits an oversized `tar.zst` into `.part-NNN`; `lib/moodle-loader.js`
  fetches/reassembles/SHA-256-verifies the compressed artifact.
* Requires `npm run build-worker` (loader + extractor are bundled into the worker). Tests:
  `tests/runtime/streaming-tar-extract.test.js`, `tests/scripts/tar-ustar.test.js`.

## Review Criteria

* Confirm the memory/network picture on real hardware: a throttled-network boot and a
  memory-constrained mobile browser. The build already lowered `windowLog` to 24 (16 MiB window);
  reconsider going lower (or higher) if that measurement shows the decode window is still the
  binding constraint.
* Revisit if a browser ships native `DecompressionStream("zstd")` (drops the zstddec window
  concern for that browser).
* Revisit the extraction-speed penalty if the per-file MEMFS write path is optimized (batched
  writes) — it could flip the fast-network verdict.
* Re-measure when the Moodle bundle's largest-file size grows materially (it bounds the peak JS
  buffer).
