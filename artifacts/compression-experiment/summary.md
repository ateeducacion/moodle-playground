# Core bundle format benchmark — MOODLE_500_STABLE

- Base URL: http://localhost:8091 · Browsers: chromium, firefox
- Boot metrics are REAL (from the runtime `__bootMetrics`); "Model DL Fast-3G" is
  `bytes / 1.6 Mbit·s⁻¹` (the bundle is fetched in a Worker that page-level CDP
  throttling does not reliably cover, so a modeled figure is more trustworthy).
- "Peak JS buffer" is the streaming parser's high-water mark (bounded by the
  largest single file) vs the full-tar path materializing the whole ~250 MB tar.

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

## Does streaming tar.zst make Moodle Playground faster to cold boot?

- **Fast local / warm cache network:** Roughly a wash. The −51 % download saves
  nothing on an instant network; the streaming path's JS extract-write is modest
  (~0.5 s Chrome / ~1.7 s Firefox here) and total boot lands within ZIP's own
  run-to-run variance (WASM compile dominates). In this run streaming tar.zst
  totalled 2879 ms vs ZIP's 3946 ms in Chrome.
- **Slow network:** Yes, decisively. The −51 % smaller download dominates (see
  "Model DL Fast-3G"): the multi-second download saving dwarfs the extraction time.
- **Warm Cache API boot:** Comparable — the artifact is served from cache (no
  download win); the small extraction cost remains.
- **Memory-constrained environment:** The point of ADR 0019. Streaming bounds the
  peak JS buffer to the largest single file (~6–7 MiB) instead of materializing
  the whole ~250 MB tar. That bounded ceiling is also what lets tar.zst boot on
  Firefox, where the full-buffer path FAILS (see the table). Residual cost: the
  zstd decode window in WASM (tunable via build windowLog).
