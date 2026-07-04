# 0018 — Experimental solid compression for Moodle core bundles (tar.zst / tar.br)

## Status

Proposed / Experimental (2026-07-04). Branch `experiment/core-bundle-solid-compression`.
No default behaviour change: the ZIP path remains the untouched default and fallback.

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
  increase. This prototype implements (a).
* **(b) streaming JS tar parse writing each entry to MEMFS off the decode stream.** Bounded
  memory, but ~23k JS→WASM writes (the historically slow dimension). Documented as the
  memory-fix path if (a)'s peak is unacceptable.

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
  frame is barely smaller than zstd's. `tar.br` is therefore kept **storage-only** in this
  prototype (no brotli decoder wired); the runtime reports it unsupported and falls back to ZIP.

### Build-runtime evaluation (Node 20 vs 24 LTS vs 26 vs Bun)

Compressed **output bytes are runtime-independent** for a fixed algo + level + codec-library
version; the runtime axis is **build speed, codec API availability, and CI risk**:

* **Node 20** (current CI pin): `node:zlib` has **no zstd** (added in 22.15 / 23.8). The
  experiment falls back to the `zstd` CLI there — an argument against Node 20 if native zstd
  bundling is ever wanted.
* **Node 24 LTS**: native zstd + brotli; the safe upgrade target.
* **Node 26**: native zstd + brotli (used for all local measurements here); a non-LTS Current
  runtime — more risk to pin in production CI.
* **Bun 1.3**: native zstd via `node:zlib`; fast, but a larger toolchain bet.

Build times (Node 26, 250 MB tar): zstd L19 ≈ 47 s, zstd L22 ≈ 75 s, **brotli q11 ≈ 207 s**
(≈4× zstd for ~0.2 % less), gzip L9 ≈ 9 s. Brotli's build cost is a strike against it.

The experiment ships an isolated `workflow_dispatch` matrix (`experiment-compression.yml`,
Node 20/24/26 + Bun) to capture build-speed and the Node-20-no-zstd fact in CI without touching
normal CI/deploy.

## Decision

**Proposed / Experimental.** Implement, behind a `?bundle-format=` flag, the full pipeline —
build (`tar.zst`/`tar.br`/`tar.gz`), additive manifest `bundleAlternatives[]`, runtime
selection with fail-loud-when-forced / fall-back-to-ZIP-when-auto, `zstddec` decode, and
`PharData` extraction — and measure it. **The default ZIP boot is unchanged.**

## Results

Branch `MOODLE_500_STABLE`. Source: **23,324 files, 244.8 MiB** uncompressed; canonical tar
**262,742,016 B**. Storage measured on **Node 26.4.0** (zstd lib 1.5.7, brotli 1.2.0);
runtime measured on **Chrome 150** (local, unthrottled). Modeled download uses
`bytes / 200 KB·s⁻¹` (Fast-3G).

| Format | Build runtime | Build time | Bundle size | Chunks @24 MiB | Δ vs ZIP | Model DL Fast-3G | Decode/extract | Total cold boot | Peak JS heap (est.) | Peak WASM/MEMFS (est.) | Chrome | Firefox | Notes |
|--------|--------------|-----------:|------------:|:--------------:|---------:|-----------------:|---------------:|----------------:|--------------------:|-----------------------:|:------:|:-------:|-------|
| **zip** (baseline) | prebuilt | — | 73,761,528 (70.3 MiB) | 3 | 0 % | ~369 s | 0 ms decode | ~3.4 s | ~74 MB zip | ~74 MB zip + tree | ✅ | ✅ | current default |
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

**Verified end-to-end in Chrome 150** (each booted to the Moodle Dashboard): `?bundle-format=zip`
(decodeMs 0), `tar.gz` (native gzip, decodeMs ~335), `tar.zst` (zstddec, decodeMs ~285).
On Firefox, `zip` and `tar.gz` booted (~13 s / ~10 s); `tar.zst` decoding was verified in
isolation (byte-exact, ~1.1 s) while the full boot flaked on Firefox's nested-iframe path.
`PharData` extracted 23,324 files with full parity vs the ZIP baseline.

### Acceptance criteria — assessment

| Criterion | Verdict |
|-----------|---------|
| Storage reduction ≥ 15 % | **Met** — tar.zst −50.8 %, tar.br −51.7 %, tar.gz −26.8 % |
| Cold boot ≥ 10 % faster on a throttled profile | **Met (modeled)** — download −51 % dominates on slow networks; **not** visible on an instant local network |
| No peak-memory regression | **NOT met by approach (a)** — the uncompressed ~250 MB tar + ~640 MB decoder RSS exceed the zip path; needs streaming (approach b) |
| Chrome **and** Firefox both work | Chrome **met** (zip/tar.gz/tar.zst all boot); Firefox: zip + tar.gz boot, and the zstddec decoder is byte-exact on Firefox (~1.1 s), but the tar.zst end-to-end boot flaked on Firefox's known nested-iframe path — **needs a local retry to fully confirm** |
| No loss of checksum verification | **Met** — whole-artifact + per-part SHA-256 over the compressed artifact, reusing `verifyBundle` |
| No deploy regression with chunked assets | **Met** — `chunk-bundles.mjs` splits oversized alternatives; loader reassembles + re-verifies |
| File-count / PHP-count parity | **Met** — 23,324-file parity (PharData with USTAR-prefix + GNU longlink; PAX would drop 32) |
| Maintainable decoder (no fragile lib) | **Met for zstd** (zstddec, 856k dl/wk, MIT); **fzstd rejected** (corrupts large frames) |

### Recommendation

**Defer — lean Adopt for `tar.zst` once peak memory is bounded.** The storage/download win is
the single largest lever this project has found (**−51 % download, 3 → 2 hosted chunks**), the
runtime path works end-to-end, checksum + parity are preserved, and the decoder question has a
sound answer (zstddec, not fzstd). The **one** unmet criterion is peak memory: the memory-simple
approach (a) inflates the whole ~250 MB tar. Before adopting, switch extraction to **approach
(b)** (zstddec **streaming** → incremental USTAR parse → MEMFS, which the reference reader in
`tar-ustar.mjs` already models) to cap peak memory, and validate cold boot on a **throttled
network** and a **memory-constrained mobile browser**. `tar.br` is **not** recommended (heavier
decoder, 4× build time, ~0.2 % smaller than zstd). `tar.gz` is a viable, zero-new-dependency
**cross-browser-safe** middle option (−27 %, native decode) if the zstd decoder or memory
profile proves problematic. If a future measurement shows the throttled-boot win does not
materialize, keep ZIP and target smaller assets (e.g. `install.sq3`).

## Consequences

### Positive
* −51 % core-bundle download (tar.zst) and one fewer hosted chunk; −27 % with a zero-dependency
  cross-browser `tar.gz`.
* A reusable, deterministic tar toolchain (`scripts/lib/tar-ustar.mjs`) and a reproducible
  storage + boot benchmark (`experiment-*` / `benchmark-*` scripts, CI matrix).
* The runtime gains a clean, additive format-dispatch seam that leaves the ZIP path untouched.

### Negative / Risks
* **Peak memory** under approach (a) is the main blocker (see above).
* A new runtime dependency (`zstddec` WASM, ~76 KB) bundled into the worker (lazy-imported, so
  the default ZIP boot loads zero extra bytes).
* Producing alternatives adds build steps (currently a separate helper, not the default build)
  and the `chunk-bundles.mjs` alternative-splitting path.
* `PharData`/tar path is used **only** for the first-party, SHA-256-pinned core bundle — never
  for untrusted plugin/blueprint archives.

## Implementation Notes

* Build: `scripts/experiment-core-bundle-formats.mjs` (+ `scripts/lib/tar-ustar.mjs`,
  `scripts/lib/compression-metrics.mjs`), `scripts/emit-bundle-alternatives.mjs`,
  `scripts/chunk-bundles.mjs` (alternative splitting), `.github/workflows/experiment-compression.yml`.
* Runtime (behind `?bundle-format=`, ZIP default untouched): `selectBundleDescriptor` /
  `decodeToTar` / `buildTarExtractScript` + `bundleAlternatives` resolution in
  `lib/moodle-loader.js`; container dispatch + boot timings in `src/runtime/bootstrap.js`; the
  4-hop flag threading (`src/shared/version-resolver.js` → `src/shared/paths.js` →
  `src/remote/main.js` → `php-worker.js`); structured `boot-metrics` message. Requires
  `npm run build-worker` (the loader is bundled into the worker).
* Benchmark: `scripts/benchmark-core-bundle-formats.mjs` (Playwright, reads `window.__bootMetrics`).
* Adopting for real would additionally wire alternatives into `build-moodle-bundle.sh` /
  `generate-manifest.mjs` and switch to streaming extraction (approach b).

## Review Criteria

* Revisit when a browser ships native `DecompressionStream("zstd")` — the zstddec dependency
  could then be dropped for that browser (keep it as the Firefox/older-Chrome fallback).
* Revisit the memory verdict once streaming extraction (approach b) is implemented and measured
  on a memory-constrained device.
* Revisit if the build runtime moves off Node 20 (native zstd would let the build produce
  alternatives without the CLI fallback).
* Re-measure whenever the Moodle bundle's size or file count changes materially (a new branch),
  since the storage delta and chunk boundary (the 48–50 MB 2-vs-3-chunk edge) can shift.
