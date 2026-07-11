# ADR-0022 Browser-side course backup (.mbz) download with progress

* Status: Accepted
* Date: 2026-07-08

## Context and Problem

The `restoreCourse` blueprint step was the dominant cost of provisioning the Adaptable demo
blueprint — ~65% of total time (see issue #249). Per-phase sub-timing added to the restore
PHP showed *why*:

```
download 30395ms (97%) | extract 171ms | precheck 54ms | execute_plan 724ms (2%) | finalize 31ms
```

The actual Moodle restore (`restore_controller`) is ~1s. The 30s was the `.mbz` **download**
performed inside PHP by `download_file_content()`, which runs over WordPress Playground's
`tcpOverFetch` bridge. For a bulk transfer that bridge is dramatically slower than a native
browser `fetch()`: the demo `.mbz` is 20 MB and downloads natively in **~0.8s** but took
**~30s** through PHP (~35× slower). The step also gave no progress feedback during that 30s.

## Options Considered

* **A — Optimize the restore itself** (disable optional data: logs, grade history, comments,
  badges…). Rejected by measurement: `execute_plan` is only ~0.7s, so there is nothing to win.
* **B — Split the restore across multiple `php.run()` calls** to emit progress between phases.
  Complex (resume `restore_controller` across PHP-state resets) and `execute_plan` is one
  blocking call anyway, so it would not show intra-restore progress.
* **C — Download the `.mbz` browser-side with a native streaming `fetch()`**, write it to MEMFS,
  and restore from that local file. The native fetch is ~35× faster *and* exposes streaming
  progress (`Content-Length` + chunked reads) for a real progress bar. Fall back to the
  existing in-PHP download for non-CORS or oversized backups.

## Decision

Chosen: **Option C.** When `restoreCourse` is given a `url`, the handler
(`src/blueprint/steps/moodle-restore.js`) now:

1. Downloads the `.mbz` browser-side via a native streaming `fetch()`, publishing progress
   (`Downloading course backup… N%`) throttled to ~10% increments.
2. Writes the bytes to a MEMFS temp file and restores from that local path
   (`phpRestoreCourse` with `cleanupSource: true`, which `@unlink`s the temp after restore).
3. Falls back to the previous in-PHP `download_file_content()` path when the fast path is not
   applicable: the fetch fails (network/CORS), the body cannot be streamed, or the backup is
   larger than a 50 MB browser budget (memory safety — the PHP path streams straight to MEMFS
   without a large JS buffer).

Restore phase sub-timings are emitted as a `[restore-perf] {json} [/restore-perf]` line
(payload/secret-free) so the breakdown stays observable.

## Consequences

### Positive
* `restoreCourse` for a CORS-accessible backup drops from ~31s to ~3s (≈1s Moodle restore +
  ~1–2s native download). Measured boot total for the Adaptable demo fell from ~72s (avg) to
  ~38s.
* A real, determinate progress bar during the download — the phase that used to be 30s of
  silence.
* No behavior change to the restore itself; large/non-CORS backups keep the memory-safe PHP
  path.

### Negative / Risks
* The fast path buffers the whole backup in JS (≤ 50 MB). Bounded by the budget + fallback.
* The browser fetch is subject to CORS; non-CORS hosts fall back to the (slower) PHP path,
  which already uses the proxy — no regression.

## Implementation Notes

* Changed: `src/blueprint/steps/moodle-restore.js` (`downloadBackupToMemfs` + handler wiring),
  `src/blueprint/php/helpers.js` (`phpRestoreCourse`: phase sub-timings + `cleanupSource`).
* Tests: `tests/blueprint/restore-course.test.js` (browser download, PHP fallback on fetch
  failure, size-cap fallback, progress reporting, sub-timing markers).
* Rebuild the worker after changes (`npm run build-worker`) — this code is bundled into
  `dist/php-worker.bundle.js`.
* Measurement method and the full restore-phase breakdown are recorded in issue #249.

## Review Criteria

Revisit if: (a) backups routinely exceed the 50 MB browser budget (consider streaming chunks
straight to MEMFS instead of buffering); (b) a proxy is needed for the browser download of
non-CORS hosts; or (c) Moodle's restore itself becomes the bottleneck for some backup, which
would reopen Option A.
