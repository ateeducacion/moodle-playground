# 0012 — Static-file fast path bypassing the serial PHP request queue

## Status

Accepted (2026-06).

## Context and Problem

The PHP worker (`php-worker.js`) processes every scoped request through a single
serial promise chain (`requestQueue`). This is correct for PHP execution — the
WASM runtime is single-threaded and `php.run()` resets state — but it also
serializes requests for **static** files (theme CSS/JS, images, fonts) that are
served by a plain MEMFS read (`php.readFileAsBuffer`) with no `php.run()` at all
(`php-compat.js` request() static branch). On first navigation a Moodle page
pulls dozens of such assets; each waited behind every preceding request in the
queue, even though answering it is a synchronous memory read.

The SW already has a scoped-static Cache API layer (ADR 0001) that absorbs
repeat visits, but the first request per asset per scope (and anything not yet
cached) still queued through PHP.

## Options Considered

* Leave everything serialized (status quo).
* Add a static fast path in the worker that answers non-`.php` GETs from MEMFS
  immediately, before entering the queue.
* Rework the SW↔worker transport to use transferable `ArrayBuffer`s via a
  `MessagePort` to cut the body-copy cost.

## Decision

### Static fast path (implemented)

`wrapPhpInstance` exposes a synchronous `serveStaticSync(urlPath)` that mirrors
the static branch of `request()` (reuses `resolveScriptPath` / `isPhpScript` /
`getMimeType`). It returns `{status, headers, bytes}` on a hit, or `null` when
the caller must fall back to the queued path: the target is a `.php` script
(including `.php/PATH_INFO` routes), a path traversal, or the file is missing.

`php-worker.js` keeps a `readyPhp` reference (set when boot completes, cleared on
`resetRuntime` and on a boot error). In `installBridgeListener`, for a `GET`
with `readyPhp` set, it calls `serveStaticSync` and — on a hit — responds
immediately, bypassing both the queue AND the redundant `Response→arrayBuffer`
copy of `serializeResponse`. `requestCount` and `detectPluginInstall` are
intentionally skipped (both are PHP-execution concerns). `HEAD`/`POST` keep
queueing.

This intentionally relaxes the "single serial promise chain" invariant for
**read-only MEMFS GETs only**. It is safe because `readFileAsBuffer` is a
pure-JS Emscripten MEMFS read (no WASM re-entry) and the worker is
single-threaded, so a read is atomic with respect to PHP writes even while a
`php.run()` is suspended (asyncify/JSPI). `moodledata` is not URL-addressable
(`resolveScriptPath` only maps under `webRoot`), so dataroot files never take
this path. Returning `null` (not 404) on a miss preserves today's semantics for
boot races and files that appear mid-install.

### Transferables / MessagePort transport (DEFERRED)

Every response body crosses the BroadcastChannel via structured clone (a copy),
and `serializeResponse` first does `response.arrayBuffer()` (another copy). For
typical Moodle responses (HTML 50–300 KB, JSON a few KB) that is well under
1–2 ms — dwarfed by 50–500 ms PHP execution. A `MessagePort`/transferable
rework would add real failure modes the current design avoids (the SW can be
killed at any time; ports die silently and need a client-mediated re-handshake;
per-scope bridge bookkeeping must be reworked; Safari/Firefox MessagePort-in-SW
behaviour is historically quirky). The only realistic beneficiaries are
multi-MB downloads (course backups, large `pluginfile` media), which are rare
and tolerate +10–30 ms. The fast path above already elides the extra copy for
statics.

**Decision: defer.** Re-open only if measured p95 bridge overhead for dynamic
responses exceeds ~5 ms (instrument behind the existing debug/profile flag
before committing to the rework).

## Consequences

### Positive
* Static assets no longer wait behind PHP page renders in the queue on first
  navigation — the slowest moment today. They are answered by a synchronous
  MEMFS read and skip one body copy.
* No change to PHP-execution accounting, plugin-install detection, or crash
  recovery (fast-path hits don't touch `requestCount`).

### Negative / Risks
* The fast path reads MEMFS while a `php.run()` may be suspended. Safe under
  @php-wasm 3.1.38's single-threaded MEMFS model, but it is an implementation
  detail — every call is wrapped in try/catch with fallback to the queue, and
  `readyPhp` is cleared on reset / boot error.
* A future change that makes MEMFS reads non-atomic (threads, SharedArrayBuffer
  FS) would invalidate the safety argument — revisit then.

## Implementation Notes

* `src/runtime/php-compat.js`: `serveStaticSync` on the wrapped instance.
* `php-worker.js`: `readyPhp` lifecycle + fast-path branch in
  `installBridgeListener`. Requires `npm run build-worker`.
* Tests: `tests/runtime/serve-static-sync.test.js`.

## Review Criteria

* Revisit the deferred transport rework if profiling shows p95 dynamic-response
  bridge overhead > ~5 ms, or if large-media downloads become a common path.
* Revisit the fast-path safety argument if the runtime gains a threaded or
  shared-memory filesystem.
