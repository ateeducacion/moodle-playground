# Core bundle format experiment — MOODLE_500_STABLE

- Generated: 2026-07-04T15:02:47.480Z
- Runtime: node v26.4.0
- Host: Apple M5 × 10, 24 GiB, darwin 25.4.0 arm64
- Source: 23324 files, 233.42 MiB uncompressed
- Baseline zip: 70.34 MiB (73761528 bytes), 3 chunk(s) at 24 MiB
- Codec support (this runtime): zstd=true (1.5.7), brotli=true (1.2.0)

| Format | Level | Size | Bytes | Δ vs ZIP | Chunks@24MiB | Build time | Engine/lib |
|--------|-------|------|-------|----------|--------------|------------|------------|
| tar.br | q11+lgwin24 | 33.99 MiB | 35641029 | -51.68% | 2 | 206318 ms | js/1.2.0 |
| tar.zst-l22 | 22+ldm+wlog27 | 34.13 MiB | 35792501 | -51.48% | 2 | 75106 ms | js/1.5.7 |
| tar.zst | 19+ldm+wlog27 | 34.61 MiB | 36293491 | -50.8% | 2 | 46864 ms | js/1.5.7 |
| tar.gz | 9 | 51.52 MiB | 54020549 | -26.76% | 3 | 9421 ms | js/1.2.12 |
| zip.br | q11 | 61.61 MiB | 64606506 | -12.41% | 3 | 119546 ms | js/1.2.0 |
| zip.zst | 19 | 61.90 MiB | 64902390 | -12.01% | 3 | 8647 ms | js/1.5.7 |
| zip | deflate | 70.34 MiB | 73761528 | 0% | 3 | — | prebuilt/? |
| tar | none | 250.57 MiB | 262742016 | +256.2% | 11 | 71 ms | node/? |

_Δ vs ZIP negative = smaller than the current ZIP bundle. Chunks column is the hosted
file count after chunk-bundles.mjs (split only when > 25 MiB, into 24 MiB parts)._
