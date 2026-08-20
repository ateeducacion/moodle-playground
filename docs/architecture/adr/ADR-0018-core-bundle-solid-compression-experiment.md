# 0018 — Experimental solid compression for Moodle core bundles (tar.zst / tar.br)

## Status

Accepted (2026-07-05). This ADR records the format evaluation; ADR 0019 records the
shipped streaming design.

The experiment concluded in favour of `tar.zst`, and **ADR 0019 made it the sole
core-bundle format**. The ZIP path and its PHP `ZipArchive` extractor were removed
entirely from the core boot: there is **no `?bundle-format=` flag, no
`bundleAlternatives` manifest field, and no ZIP fallback**. The build produces a
single `tar.zst` per branch; the runtime streams it and **fails loud** on a
file-count parity mismatch. (ZIP is still used, unchanged, for untrusted
plugin/blueprint archives via `lib/moodle-loader.js`, and as a build-time
intermediate — see Implementation Notes.)

## Context and Problem

On every cold boot the playground downloads a `moodle-core-*.zip` (deflate), reassembles
`.part-NNN` slices when the zip exceeds Cloudflare Pages' 25 MiB/file cap, verifies SHA-256,
writes the whole zip into MEMFS, and extracts it with PHP `ZipArchive::extractTo()`. Native
extraction was chosen deliberately: the JS paths (fflate `unzipSync`, per-entry
`@php-wasm/stream-compression` `decodeZip`) were too slow / memory-heavy for the ~23k-file
tree and pushed boot past the readiness gate (see `lib/moodle-loader.js` header comments and
ADR 0011).

The ZIP is compressed **per file** with a 32 KiB window, so it cannot exploit the massive
cross-file redundancy in a Moodle tree (thousands of near-identical language files, YUI
builds, vendored SDKs). A **solid** archive (one compression stream over a `tar` of the whole
tree) with a modern codec (zstd / brotli) should shrink the download materially. The open
question this experiment answers: **is the download/boot win large enough to justify the added
extraction complexity, and does it survive real browser and memory constraints?**

Explicitly out of scope as a primary candidate: `zip.zst` / `zip.br` (compressing an
already-compressed zip). Measured here only as secondary data — they gain ~12 % (below).

## Options Considered

* **Keep ZIP** (baseline). Simple, native, proven; largest download.
* **`zip.zst` / `zip.br`** — recompress the zip. Measured **−12 %** only; rejected as primary.
* **`tar.zst`** — solid tar + zstd. Best size/speed balance; needs a zstd decoder in the browser.
* **`tar.br`** — solid tar + brotli. Marginally smallest, but slowest to build and needs a
  brotli WASM decoder that no browser exposes natively.
* **`tar.gz`** — solid tar + gzip. The only solid format decodable natively in **every** browser
  (`DecompressionStream("gzip")`); a useful cross-browser control and a smaller (−27 %) win.

### Extraction mechanism

The PHP WASM binary has `zip` and `phar` but **not** `zstd`/`brotli`, so decompression must
happen in JS; PHP then extracts the resulting `.tar`. Two approaches:

* **(a) decode → full `.tar` in MEMFS → `PharData::extractTo()`.** Reuses proven native
  extraction (fast at any file count), minimal new code. Cost: the **uncompressed** tar
  (~250 MB, larger than the 74 MB zip) sits in the worker heap and MEMFS — a peak-memory
  increase. The ADR 0018 prototype measured (a).
* **(b) streaming JS tar parse writing each entry to MEMFS off the decode stream.** Bounded
  memory, but ~23k JS→WASM writes (the historically slow dimension). **This is the path that
  shipped** (ADR 0019): it resolved (a)'s peak-memory blocker, so the runtime never
  materializes the full tar and needs neither `PharData` nor `phar`/`zip`.

A subtle but decisive finding shaped the tar **format**: PHP `PharData` **ignores PAX `path`
extended headers** and writes long-named files under their truncated 100-byte name, colliding
and **dropping 32 of Moodle's 23,324 files** (measured). Switching the writer to the USTAR
`prefix`/`name` split + GNU `././@LongLink` (both read correctly by PharData, bsdtar and GNU
tar) restores **full 23,324-file parity**. See `scripts/lib/tar-ustar.mjs`.

### Browser decoder (the hard part)

Native `DecompressionStream` support, feature-detected at runtime (never assumed):

| Codec | Chrome 150 | Firefox | Notes |
|-------|:---------:|:-------:|-------|
| gzip / deflate | ✅ | ✅ | universal (spec-standard) |
| zstd | ❌ | ❌ | **absent even in Chrome 150** |
| brotli | ❌ | ❌ | not exposed as a `DecompressionStream` algorithm anywhere |

So `tar.zst` and `tar.br` need a bundled decoder on **all** browsers, not just Firefox. We
evaluated candidates against the real 36 MB → 250 MB windowLog-27 frame:

* **fzstd** (pure JS, 8 KB) — **REJECTED**: it silently corrupts this frame (right size, wrong
  bytes from ~101 MB on), reproduced on Node **and** Bun, on two independent frames. Small
  frames pass, which is exactly the "worked on a small test" trap. Do not use.
* **zstddec** (libzstd → WASM, wasm embedded as base64, ~76 KB, MIT, 856k dl/wk) — **CHOSEN**:
  byte-exact on the frame, ~230 ms decode, self-contained (no separate `.wasm` fetch / CSP
  issue), has a streaming API to cap memory.
* **brotli-dec-wasm** (208 KB) / **brotli-wasm** (1.06 MB) — correct but heavier; brotli's
  frame is barely smaller than zstd's. `tar.br` was therefore measured for **size only** (no
  brotli decoder wired) and not carried forward; only `tar.zst` shipped.

### Build-runtime evaluation (Node 20 vs 24 LTS vs 26 vs Bun)

Compressed **output bytes are runtime-independent** for a fixed algo + level + codec-library
version; the runtime axis is **build speed, codec API availability, and CI risk**:

* **Node 20** (the CI pin *before* this work): `node:zlib` has **no zstd** (added in
  22.15 / 23.8), which is why building `tar.zst` with the native encoder needed a newer
  Node. **Adopting `tar.zst` moved the CI pin to Node 24 LTS** (`.github/workflows/ci.yml`);
  `scripts/build-tar-zst-from-zip.mjs` uses `node:zlib` zstd directly and hard-errors on
  Node < 22.15.
* **Node 24 LTS**: native zstd + brotli; the chosen (and now shipped) build target.
* **Node 26**: native zstd + brotli (used for all local measurements here); a non-LTS Current
  runtime — more risk to pin in production CI.
* **Bun 1.3**: native zstd via `node:zlib`; fast, but a larger toolchain bet.

Build times (Node 26, 250 MB tar): zstd L19 ≈ 47 s, zstd L22 ≈ 75 s, **brotli q11 ≈ 207 s**
(≈4× zstd for ~0.2 % less), gzip L9 ≈ 9 s. Brotli's build cost is a strike against it.

These build-speed and Node-20-no-zstd measurements were taken on the
`experiment/core-bundle-solid-compression` branch. The exploratory build/benchmark
matrix and its scripts were experiment-only and did **not** merge; the shipped build
simply runs `scripts/build-tar-zst-from-zip.mjs` on Node 24 in the normal CI `build` job.

## Decision

**Accepted: adopt `tar.zst` as the sole core-bundle format** (via the ADR 0019 streaming
extractor). The multi-format exploration here (`tar.zst` / `tar.br` / `tar.gz`, secondary
`zip.zst` / `zip.br`) settled the format question decisively in favour of `tar.zst`: best
size/decoder trade, and `zstddec` exposes a true streaming generator that makes
bounded-memory extraction possible. Having settled it, the shipped implementation keeps
**only** `tar.zst` — there is no `?bundle-format=` flag, no `bundleAlternatives` manifest
array, and no ZIP fallback. The build emits one `tar.zst` per branch and the runtime streams
it; a file-count parity mismatch **fails loud** rather than silently falling back. The
`tar.br` and `tar.gz` variants and the full-buffer (`PharData`) extraction path were
measured (below) but **not shipped**.

## Results

Branch `MOODLE_500_STABLE`. Source: **23,324 files, 244.8 MiB** uncompressed; canonical tar
**262,742,016 B**. Storage measured on **Node 26.4.0** (zstd lib 1.5.7, brotli 1.2.0);
runtime measured on **Chrome 150** (local, unthrottled). Modeled download uses
`bytes / 200 KB·s⁻¹` (Fast-3G).

| Format | Build runtime | Build time | Bundle size | Chunks @24 MiB | Δ vs ZIP | Model DL Fast-3G | Decode/extract | Total cold boot | Peak JS heap (est.) | Peak WASM/MEMFS (est.) | Chrome | Firefox | Notes |
|--------|--------------|-----------:|------------:|:--------------:|---------:|-----------------:|---------------:|----------------:|--------------------:|-----------------------:|:------:|:-------:|-------|
| **zip** (baseline) | prebuilt | — | 73,761,528 (70.3 MiB) | 3 | 0 % | ~369 s | 0 ms decode | ~3.4 s | ~74 MB zip | ~74 MB zip + tree | ✅ | ✅ | former default — now removed from core boot |
| tar (uncompressed) | Node 26 | 0.07 s | 262,742,016 | 11 | +256 % | — | — | — | — | — | — | — | intermediate only |
| **tar.zst** (L19+ldm+wlog27) | Node 26 | 47 s | 36,293,491 (34.6 MiB) | **2** | **−50.8 %** | **~181 s** | 285 ms (zstddec) | ~3.8 s | ~250 MB tar + ~640 MB decoder¹ | ~250 MB tar + tree | ✅ | ⚠️² | needs zstddec (no native); decoder verified on FF |
| tar.zst (L22+ldm+wlog27) | Node 26 | 75 s | 35,792,501 (34.1 MiB) | 2 | −51.5 % | ~179 s | — | — | — | — | — | — | +0.7 % for +60 % build time |
| tar.br (q11) | Node 26 | 207 s | 35,641,029 (34.0 MiB) | 2 | −51.7 % | ~178 s | — | — | — | — | storage-only | storage-only | no browser brotli decoder wired |
| **tar.gz** (L9) | Node 26 | 9 s | 54,020,549 (51.5 MiB) | 3 | **−26.8 %** | ~270 s | 335 ms (native gzip) | ~4.2 s | ~250 MB tar | ~250 MB tar + tree | ✅ | ✅ (~10 s) | native decode everywhere |
| zip.zst (L19) | Node 26 | ~40 s | 64,902,390 | 3 | −12.0 % | — | — | — | — | — | — | — | secondary; recompresses a zip |
| zip.br (q11) | Node 26 | ~60 s | 64,606,506 | 3 | −12.4 % | — | — | — | — | — | — | — | secondary |

¹ zstddec one-shot peak RSS on the 250 MB output (measured in the decoder eval); its streaming
API roughly halves this (~366 MB) and is the recommended production path (approach b).
² Firefox: the **zstddec decoder is proven cross-browser** — a standalone Playwright/Firefox run
decoded the real 36 MB frame **byte-exact in ~1.1 s**. But the full `tar.zst` *boot* did not
complete within the harness's 120 s budget on Firefox, consistent with Firefox's known
nested-iframe boot flakiness (the `admin-flows` e2e is skipped in CI for the same reason;
Firefox boots are ~3× slower: zip ~13 s, tar.gz ~10 s here). So the codec works on Firefox;
confirming the end-to-end boot there needs a local retry, not a code change.

**Verified end-to-end in Chrome 150** (each booted to the Moodle Dashboard). These formats
were compared on the experiment branch via a since-removed `?bundle-format=` selector: `zip`
(decodeMs 0), `tar.gz` (native gzip, decodeMs ~335), `tar.zst` (zstddec, decodeMs ~285).
On Firefox, `zip` and `tar.gz` booted (~13 s / ~10 s); `tar.zst` decoding was verified in
isolation (byte-exact, ~1.1 s) while the full boot flaked on Firefox's nested-iframe path.
The ADR 0018 `PharData` probe extracted 23,324 files with full parity vs the ZIP baseline;
the shipped streaming parser (ADR 0019) keeps that same parity.

### Acceptance criteria — assessment

| Criterion | Verdict |
|-----------|---------|
| Storage reduction ≥ 15 % | **Met** — tar.zst −50.8 %, tar.br −51.7 %, tar.gz −26.8 % |
| Cold boot ≥ 10 % faster on a throttled profile | **Met (modeled)** — download −51 % dominates on slow networks; **not** visible on an instant local network |
| No peak-memory regression | **NOT met by approach (a)** — the uncompressed ~250 MB tar + ~640 MB decoder RSS exceed the zip path; needs streaming (approach b) |
| Chrome **and** Firefox both work | Chrome **met** (zip/tar.gz/tar.zst all boot); Firefox: zip + tar.gz boot, and the zstddec decoder is byte-exact on Firefox (~1.1 s), but the tar.zst end-to-end boot flaked on Firefox's known nested-iframe path — **needs a local retry to fully confirm** |
| No loss of checksum verification | **Met** — whole-artifact + per-part SHA-256 over the compressed artifact, reusing `verifyBundle` |
| No deploy regression with chunked assets | **Met** — `chunk-bundles.mjs` splits the oversized `tar.zst` into `.part-NNN`; `lib/moodle-loader.js` reassembles + re-verifies |
| File-count / PHP-count parity | **Met** — 23,324-file parity via USTAR prefix/name split + GNU longlink (read by both the ADR 0018 `PharData` probe and the shipped JS streaming parser; PAX would drop 32) |
| Maintainable decoder (no fragile lib) | **Met for zstd** (zstddec, 856k dl/wk, MIT); **fzstd rejected** (corrupts large frames) |

### Recommendation

**Adopt `tar.zst`.** The storage/download win is the single largest lever this project has
found (**−51 % download, 3 → 2 hosted chunks**), checksum + parity are preserved, and the
decoder question has a sound answer (zstddec, not fzstd). The **one** unmet criterion here was
peak memory — approach (a) inflates the whole ~250 MB tar — and **ADR 0019 resolved it** by
switching extraction to **approach (b)** (zstddec **streaming** → incremental USTAR parse →
MEMFS), which caps the peak JS buffer at the largest single file (~6.6 MiB) and, unlike the
full-buffer path, boots on Firefox. Building on that, the ZIP core path was removed and
`tar.zst` became the sole format. `tar.br` was **not** adopted (heavier decoder, 4× build time,
~0.2 % smaller than zstd); `tar.gz` was **not** adopted (only −27 %, and it stays at 3 chunks),
though it remains the zero-dependency cross-browser fallback to reach for if the zstd decoder
ever proves problematic.

## Consequences

### Positive
* −51 % core-bundle download (tar.zst) and one fewer hosted chunk (3 → 2).
* A reusable, deterministic tar toolchain (`scripts/lib/tar-ustar.mjs`) shared verbatim with
  the sibling `*-playground` repos.
* One code path: the core boot always streams `tar.zst`, so there is no format-selection
  branching, no flag threading, and no ZIP/tar divergence to keep in sync.

### Negative / Risks
* A new runtime dependency (`zstddec` WASM, ~76 KB) bundled into the worker (lazy-imported at
  the extraction site).
* The build now needs Node ≥ 22.15 for native `node:zlib` zstd (CI pins Node 24) and a `zip`
  intermediate is still produced then discarded (it remains the source of truth for the
  exclusion list + PHP-parity/required-file tripwires — see `scripts/build-moodle-bundle.sh`).
* The tar core path is used **only** for the first-party, SHA-256-pinned core bundle — never
  for untrusted plugin/blueprint archives, which still use the ZIP path in `lib/moodle-loader.js`.

## Implementation Notes

The shipped design lives in **ADR 0019**; the exploratory multi-format build/benchmark scripts
and the `?bundle-format=` flag prototyped on the experiment branch did **not** merge. As shipped:

* Build: `scripts/build-tar-zst-from-zip.mjs` converts the trimmed, tripwire-verified core ZIP
  into the deterministic `tar.zst` (`scripts/lib/tar-ustar.mjs` for USTAR + GNU longlink;
  `node:zlib` zstd L19 + LDM, windowLog 24). Driven by `scripts/build-moodle-bundle.sh`, which
  discards the ZIP afterwards. `scripts/chunk-bundles.mjs` splits an oversized `tar.zst` into
  `.part-NNN`; `scripts/generate-manifest.mjs` records `bundle.format="tar.zst"`,
  `bundle.container="tar"`, `bundle.codec="zstd"`, `bundle.fileCount`, size + SHA-256.
* Runtime: `lib/streaming-tar-extract.js` (`createDecodedTarStream`, `extractTarStreamToPhp`,
  `StreamingTarParser`, `sanitizeTarPath`) decodes with `zstddec/stream` and writes each entry
  into MEMFS. `src/runtime/bootstrap.js` drives it (`archive.manifest.bundle.codec` → decoder)
  and enforces the file-count parity tripwire (throws on mismatch). `lib/moodle-loader.js`
  fetches/reassembles/verifies the (possibly chunked) compressed artifact. Requires
  `npm run build-worker` (the loader + extractor are bundled into the worker).
* Tests: `tests/scripts/tar-ustar.test.js`, `tests/runtime/streaming-tar-extract.test.js`.

## Review Criteria

* Revisit when a browser ships native `DecompressionStream("zstd")` — the zstddec dependency
  could then be dropped for that browser (keep it as the Firefox/older-Chrome fallback).
* Streaming extraction (approach b) shipped in ADR 0019; the remaining follow-up is measuring
  the (now windowLog-24) zstd decode window on a memory-constrained mobile browser and a
  throttled network — tracked in ADR 0019's Review Criteria.
* The build now runs on Node 24 with native `node:zlib` zstd (no CLI fallback); revisit the
  build codec/level/window if the Moodle tree's cross-file redundancy shifts materially.
* Re-measure whenever the Moodle bundle's size or file count changes materially (a new branch),
  since the storage delta and chunk boundary (the 48–50 MB 2-vs-3-chunk edge) can shift.

## Appendix A — Raw runtime boot benchmark (browser harness)

Preserved verbatim from the experiment branch `experiment/core-bundle-solid-compression`
(commit `7620303`, 2026-07-04), file `artifacts/compression-experiment/summary.md`. That
branch was deleted on 2026-08-20 once its conclusions had shipped; the table is kept here so
the ADR stays self-contained. This appendix only adds evidence — nothing above it is changed.

Unlike the storage table in *Results* (measured on Node + Chrome), these are **real runtime
boot metrics from the browser harness**, captured on both engines.

- Base URL `http://localhost:8091` · Browsers: chromium, firefox.
- Boot metrics are REAL (runtime `__bootMetrics`). "Model DL Fast-3G" is
  `bytes / 1.6 Mbit·s⁻¹` — the bundle is fetched in a Worker that page-level CDP throttling
  does not reliably cover, so a modeled figure is more trustworthy.
- "Peak JS buffer" is the streaming parser's high-water mark (bounded by the largest single
  file) vs the full-tar path materializing the whole ~250 MB tar.

| Browser | Format | Mode | Size | Δ vs ZIP | Chunks | Decode ms | Extract-write ms | Cold total ms | Warm total ms | Peak JS buffer | Model DL Fast-3G ms | OK |
|---------|--------|------|------|----------|--------|-----------|------------------|---------------|---------------|----------------|---------------------|----|
| chromium | zip | zip | 70.3 MiB | 0% | 3 | 0 | 0 | 3946 | 3172 | — | 368808 | ✅ |
| chromium | tar.zst | streaming | 34.6 MiB | -50.8% | 2 | 0 | 526 | 2879 | 2356 | 6.6 MiB | 181467 | ✅ |
| chromium | tar.zst-full | full | 34.6 MiB | -50.8% | 2 | 195 | 0 | 3122 | 2667 | ~251 MiB (full tar) | 181467 | ✅ |
| chromium | tar.gz | streaming | 51.5 MiB | -26.76% | 3 | 0 | 583 | 2899 | 2621 | 6.6 MiB | 270103 | ✅ |
| firefox | zip | zip | 70.3 MiB | 0% | 3 | 0 | 0 | 13267 | 12567 | — | 368808 | ✅ |
| firefox | tar.zst | streaming | 34.6 MiB | -50.8% | 2 | 0 | 1663 | 9985 | 8834 | 6.6 MiB | 181467 | ✅ |
| firefox | tar.zst-full | — | 34.6 MiB | -50.8% | 2 | — | — | — | — | — | 181467 | ❌ |
| firefox | tar.gz | streaming | 51.5 MiB | -26.76% | 3 | 0 | 913 | 9118 | 7765 | 6.6 MiB | 270103 | ✅ |

### What this run answers

* **It closes the Firefox question left open in *Results* footnote ².** That footnote records
  that the `tar.zst` *boot* did not complete inside the harness's 120 s budget on Firefox, and
  that confirming it "needs a local retry, not a code change". This run is that retry:
  **streaming `tar.zst` boots on Firefox in 9985 ms cold / 8834 ms warm (✅)**, while the
  **full-buffer `tar.zst-full` path FAILS there (❌)**. The earlier non-completion was the
  full-buffer path, not the codec.
* **It is the direct measured justification for ADR 0019.** Streaming bounds the peak JS buffer
  to the largest single file (~6.6 MiB) instead of materializing the whole ~250 MB tar — and
  that bounded ceiling is precisely what lets `tar.zst` boot on Firefox at all.
* **Cold-boot effect depends entirely on the network.** On a fast/warm-cache network it is
  roughly a wash (WASM compile dominates; 2879 ms vs ZIP's 3946 ms in Chrome, within
  run-to-run variance). On a slow network the −51 % download dominates decisively — compare
  "Model DL Fast-3G": ~181 s vs ~369 s.
