# PHP Process Manager & rotatePHPRuntime Evaluation

## What rotatePHPRuntime does

`rotatePHPRuntime` (from `@php-wasm/universal`) is a thin helper that calls
`php.enableRuntimeRotation({ recreateRuntime, maxRequests })` on a PHP instance.
It sets up *proactive* rotation: after a configurable number of requests
(default 400), the PHP runtime is automatically discarded and a fresh one is
created by calling the user-supplied `recreateRuntime()` callback.

The underlying machinery consists of three methods on the `PHP` class:

| Method | Purpose |
|--------|---------|
| `enableRuntimeRotation(opts)` | Marks the instance for rotation; stores `recreateRuntime` callback and `maxRequests` threshold |
| `rotateRuntime()` | Calls `recreateRuntime()` then delegates to `hotSwapPHPRuntime()` |
| `hotSwapPHPRuntime(newRuntime)` | Copies MEMFS nodes from the old Emscripten instance to the new one, restores mount handlers and CWD, then calls `this.exit()` on the old runtime |

The key mechanic in `hotSwapPHPRuntime` is a **live MEMFS copy**: it walks the
top-level directories of the old filesystem and calls `copyMEMFSNodes(oldFS,
newFS, path)` for each. This means the entire in-memory filesystem — including
the SQLite database file, plugin files, and moodledata — is transferred to the
new runtime automatically.

## What PHPProcessManager does

`PHPProcessManager` is a concurrency pool. It maintains up to `maxPhpInstances`
(default 2) live PHP instances. Callers call `acquirePHPInstance()` to get a
`{ php, reap }` pair and must call `reap()` when done to return the instance to
the idle pool. If all instances are busy, callers wait on a semaphore with a
30 s timeout (raises `MaxPhpInstancesError` on expiry).

It is designed for **WordPress Playground's request-per-instance concurrency
model**, where multiple simultaneous HTTP requests may each need a dedicated PHP
process. It does not handle crash recovery itself.

## Fit with our crash recovery model

Our crash recovery model (in `src/runtime/crash-recovery.js` and
`php-worker.js`) is:

1. Detect a fatal WASM error during request handling.
2. **Snapshot** the DB file and tracked plugin files from MEMFS *before*
   destroying the crashed runtime (MEMFS lives in JS heap and remains readable
   even when WASM linear memory is corrupted).
3. Null out `runtimeStatePromise` so the next request triggers a full
   `bootstrapMoodle()` on a fresh runtime.
4. **Restore** the DB and plugin files onto the fresh runtime after bootstrap.
5. Re-register plugins via Moodle's upgrade runner.
6. Replay safe (GET/HEAD) requests once.

### Why rotatePHPRuntime/hotSwapPHPRuntime does NOT fit

`hotSwapPHPRuntime` performs a **live MEMFS copy** from old to new runtime.
This approach assumes the old Emscripten FS object is still functional — which
is true for *proactive* rotation (scheduled after N healthy requests) but is
explicitly **not** true after a fatal WASM crash.

Our crash scenario is:
- WASM linear memory is corrupted (OOM, `unreachable`, etc.)
- The Emscripten FS object may be in an inconsistent state
- `copyMEMFSNodes` would walk the old FS and copy data — this risks copying
  a corrupt or partially-written SQLite database page

Our snapshot model deliberately reads the DB at the **JS buffer level**
(`readFileAsBuffer`) rather than copying MEMFS nodes, because MEMFS lives in JS
heap (survives WASM corruption) while WASM-side FS metadata may not.

Additionally:
- `hotSwapPHPRuntime` does not run `bootstrapMoodle()`. Our recovery depends on
  bootstrap to re-initialize Moodle's config, cache stores, and session state.
- `rotatePHPRuntime` enables *proactive* rotation after N requests — a different
  concern from *reactive* crash recovery.
- `PHPProcessManager`'s pool model assumes a `phpFactory` that produces clean
  instances; it has no hook for post-crash snapshot restoration.

### What could be adopted

The **proactive rotation** concept from `rotatePHPRuntime` is genuinely useful:
rotating the PHP runtime after N requests (e.g. 400) prevents slow memory leaks
from accumulating to the point of a crash. This is orthogonal to crash recovery
and could be layered on top.

If adopted, proactive rotation would call our `resetRuntime()` path (not
`hotSwapPHPRuntime`) so that Moodle's full bootstrap runs on the fresh runtime
and cache/session state is properly initialized. The snapshot save/restore would
be triggered as normal.

`PHPProcessManager` is not applicable: Moodle Playground uses a single PHP
instance per scope/worker (one request at a time), so a concurrency pool adds
complexity without benefit.

## Recommendation

**Skip `rotatePHPRuntime` and `PHPProcessManager` for now.**

- Our reactive crash recovery (`resetRuntime` + snapshot) is the right model
  for WASM crashes. `hotSwapPHPRuntime` cannot safely copy from a crashed FS.
- `PHPProcessManager` addresses multi-instance concurrency we do not need.

**Consider adopting proactive rotation as a future enhancement:**
- After N healthy requests, trigger a clean `resetRuntime()` (our existing path)
  rather than `hotSwapPHPRuntime`.
- This would prevent gradual WASM memory leaks from causing crashes in long
  sessions.
- Implementation would be a counter in `php-worker.js`'s request handler, not
  a call to `rotatePHPRuntime`.
