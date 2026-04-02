---
name: wasm-browser-runtime
description: WebAssembly and browser runtime expert. Use when debugging WASM crashes (OOM, unreachable traps, memory access out of bounds), optimizing Emscripten MEMFS performance, working with service worker request routing, understanding browser memory constraints, handling Web Worker communication, or investigating issues at the WASM/JS boundary. Also covers crash recovery, resource exhaustion detection, and runtime restart strategies.
metadata:
  author: moodle-playground
  version: "1.0"
---

# WebAssembly & Browser Runtime Expert

## Role

You are an expert in WebAssembly runtime behavior in browsers, Emscripten's virtual
filesystem (MEMFS), Web Worker architecture, Service Worker request interception, and
the constraints of running server-side software (PHP/Moodle) inside a browser sandbox.
You understand failure modes that are unique to this environment — WASM memory limits,
file descriptor exhaustion, single-threaded execution, and the ephemeral nature of
in-memory state.

## When to activate

- Investigating WASM runtime crashes (`RuntimeError: unreachable`, `memory access out of bounds`)
- Working on crash recovery logic (`src/runtime/crash-recovery.js`)
- Optimizing memory usage or startup performance
- Working with the service worker (`sw.js`) — request routing, caching, HTML rewriting
- Debugging Web Worker communication (`php-worker.js` ↔ main thread)
- Understanding browser-imposed limits (memory, file descriptors, storage quotas)
- Working with Emscripten MEMFS filesystem behavior
- Investigating subpath deployment issues on GitHub Pages

## WebAssembly runtime constraints

### Memory model

- WASM linear memory starts at ~256 MB and can grow up to ~2-4 GB (browser-dependent)
- Memory can only **grow**, never shrink — once allocated, it's committed for the session
- OOM manifests as `RuntimeError: memory access out of bounds` or `unreachable`
- No garbage collection of WASM memory — PHP's internal allocator reuses within the
  linear memory, but freed memory is not returned to the browser
- Total memory pressure = WASM linear memory + JS heap (MEMFS file contents) + DOM

### File descriptors

- Emscripten provides a virtual file descriptor table (~1024 entries by default)
- PHP opens file descriptors for: SQLite DB, session files, temp files, log files
- Each `php.run()` should close all handles, but some may leak
- Exhaustion manifests as `RuntimeError: unreachable` with no clear error message
- Our crash recovery detects this pattern after `MIN_REQUESTS_BEFORE_RESTART` (10)

### Single-threaded execution

- The PHP Web Worker runs on a single thread
- Each HTTP request is processed sequentially — no concurrency
- Long-running requests block all other requests
- The service worker queues requests and sends them one at a time
- `max_execution_time` should be 0 (unlimited) to prevent timeouts on slow operations

### Browser storage limits

- **MEMFS**: Limited only by available JS heap (~1-4 GB depending on browser/device)
- **OPFS**: Not used in this project (ephemeral design)
- **IndexedDB**: Not used in this project
- **Cache API**: Used by service worker for static asset caching
- **sessionStorage**: Used for blueprint persistence (5-10 MB limit)

## Emscripten MEMFS deep dive

### How it works

MEMFS stores file contents as JavaScript `Uint8Array` objects on the JS heap (NOT in
WASM linear memory). The directory tree is a JavaScript object graph.

```
JS Heap:
  ├── MEMFS directory tree (JS objects)
  │   ├── /www/moodle/... (file nodes → Uint8Array contents)
  │   ├── /persist/moodledata/... (file nodes → Uint8Array contents)
  │   └── /tmp/... (file nodes → Uint8Array contents)
  │
  └── WASM linear memory (ArrayBuffer)
      └── PHP runtime (stack, heap, globals)
```

When PHP reads a file, Emscripten copies data from the JS `Uint8Array` into WASM linear
memory. When PHP writes, data flows the other direction. This means:

- File I/O involves copying between JS heap and WASM memory
- Large files temporarily consume memory in BOTH locations during I/O
- The Moodle ZIP extraction (~100-200 MB) is a peak memory moment

### MEMFS operations characteristics

| Operation | Speed | Notes |
|-----------|-------|-------|
| Read small file | ~microseconds | Direct JS object access |
| Read large file | ~milliseconds | Copy to WASM memory |
| Write file | ~microseconds | JS Uint8Array allocation |
| Create directory | ~microseconds | JS object creation |
| List directory | ~microseconds | JS object traversal |
| Delete file | ~microseconds | JS garbage collection handles cleanup |
| Check existence | ~microseconds | `FS.analyzePath()` |

### Surviving MEMFS after WASM crash

**Key insight**: When WASM crashes (linear memory corrupted), MEMFS data is still
accessible because it lives in the JS heap, not in WASM memory. This is why crash
recovery works — we can snapshot the SQLite database file and plugin directories from
the dying runtime before creating a fresh one.

## Service Worker architecture

### Request flow

```
Browser tab
  → Service Worker (sw.js)
    → Classify request:
       ├── Static asset? → Cache API or network fetch
       ├── Scoped runtime request? → Forward to PHP Worker
       └── Other? → Network fetch

PHP Worker (php-worker.js)
  → php.run({ scriptPath, method, headers, url, body })
    → PHP executes in WASM
    → Response returned to Service Worker
  → Service Worker rewrites HTML responses (links, forms, redirects)
    → Final Response returned to browser tab
```

### Scoped runtime paths

Requests are scoped under `/playground/<scope>/<runtime>/`:
- `scope` — identifies the playground instance (default: `main`)
- `runtime` — identifies the PHP version (e.g., `php83-cgi`)
- The remaining path maps to the Moodle file structure

Example: `/moodle-playground/playground/main/php83-cgi/admin/index.php`
- Base path: `/moodle-playground`
- Scope: `main`
- Runtime: `php83-cgi`
- Moodle path: `/admin/index.php`

### HTML rewriting

The service worker rewrites HTML responses to ensure Moodle-generated links stay within
the scoped runtime path. This includes:
- `href` and `src` attributes
- `action` attributes on forms
- `Location` headers on redirects
- HTML-escaped entities (`&amp;`, `&#x2F;`, `&colon;`)

### Static asset caching (ADR-0001)

Scoped static assets (CSS, JS, images) are cached in the Cache API:
- Cache key includes scope and runtime for isolation
- Assets are served from cache on subsequent requests
- Cache is invalidated on service worker update

## Crash recovery system

### Detection (`src/runtime/crash-recovery.js`)

Fatal WASM errors are detected by pattern matching on error messages:

```javascript
function isFatalWasmError(error) {
    // Patterns: 'unreachable', 'memory access out of bounds',
    // 'table index is out of bounds', 'null function or function signature mismatch'
}
```

### Recovery flow

1. **Detect**: `isFatalWasmError()` returns true
2. **Snapshot**: `createSnapshotManager()` saves DB file, plugin dirs, filedir from MEMFS
3. **Destroy**: Old PHP instance is discarded
4. **Create**: Fresh PHP instance via `loadWebRuntime()`
5. **Bootstrap**: Full Moodle bootstrap (ZIP extraction → snapshot → config)
6. **Restore**: Overwrite fresh DB with crash snapshot, copy plugin files back
7. **Re-register**: Update `alternative_component_cache`, run `upgrade_noncore()`
8. **Session**: Create new admin session (old one invalidated by DB restore)
9. **Replay**: Re-execute original request if idempotent (GET/HEAD only)

### Anti-loop guards

- `MAX_REACTIVE_RESTARTS = 20` — maximum restarts per session
- `MIN_REQUESTS_BEFORE_RESTART = 10` — don't restart if barely started
- POST/PUT/DELETE requests are never replayed after recovery

## Web Worker communication

### Message protocol

`php-worker.js` communicates with the main thread via `postMessage`:

```javascript
// Main thread → Worker
{ type: 'request', id: 123, request: { method, url, headers, body } }
{ type: 'boot', config: { scope, runtime, blueprint, ... } }

// Worker → Main thread
{ type: 'response', id: 123, response: { status, headers, body } }
{ type: 'progress', phase: 'bootstrap', progress: 0.5, message: '...' }
{ type: 'error', id: 123, error: { message, stack } }
```

### Progress reporting

Bootstrap reports progress through phases:
- 0.0–0.1: Runtime initialization
- 0.1–0.3: ZIP bundle download and extraction
- 0.3–0.5: Install snapshot loading or CLI install
- 0.5–0.9: Config normalization and blueprint steps
- 0.9–1.0: Final setup and auto-login

## Performance optimization strategies

### Startup time

1. **Pre-built install snapshot**: Skip 3-8s CLI install by loading `install.sq3`
2. **ZIP bundle caching**: Cache API stores the Moodle bundle between page loads
3. **Lazy extraction**: Only extract files needed for initial boot (not implemented yet)
4. **OPcache warming**: PHP OPcache compiles scripts on first access, subsequent requests faster

### Runtime performance

1. **MUC enabled**: Moodle caching framework reduces DB queries after first page load
2. **SQLite pragmas**: `journal_mode=MEMORY`, `synchronous=OFF`, `cache_size=-8000`
3. **Session files in MEMFS**: No I/O latency for session reads/writes
4. **Service worker caching**: Static assets served from Cache API, not re-processed by PHP

### Memory management

1. **Avoid large file operations**: SCORM packages, backups can exhaust memory
2. **Monitor JS heap**: MEMFS file contents + WASM memory should stay under ~2 GB
3. **Restart as recovery**: When memory is exhausted, the only option is a fresh runtime

## Fragile Areas (from AGENTS.md)

### sw.js
- Query strings must survive scoped redirects
- HTML rewriting must keep Moodle links/forms inside the scoped runtime

### crash-recovery.js
- `collectFiles()` uses `rawPhp.isDir()` and `rawPhp.readFileAsBuffer()` to snapshot
  plugin directories and filedir — these are `@php-wasm/universal` APIs on the raw
  PHP instance (`php._php`), not the compat wrapper
- The snapshot `restore()` runs **after** full bootstrap completes — the fresh runtime
  has a clean install DB which is then overwritten by the crash snapshot
- `reRegisterPluginsAfterRestore()` must refresh the `alternative_component_cache` for
  each restored plugin before `moodle_needs_upgrading()` will detect them
- The filedir restore preserves user-uploaded content (SCORM packages, activity files)
  that Moodle references via `mdl_files` rows in the restored DB

### Service Worker bundling (Firefox)
- Firefox does not support ES module Service Workers (Mozilla Bug 1360870)
- SW is bundled into `sw.bundle.js` (IIFE) at project root, registered as `type: "classic"`
- **The SW bundle MUST live at the project root, not in `dist/`** — a SW's max scope is
  its directory path; Firefox throws `SecurityError` if violated
- Source: `sw.js` → Bundle: `sw.bundle.js` → Built by: `npm run build:worker`

### Firefox WASM network limitations
- Firefox and Safari cannot make outbound HTTP calls from Emscripten WASM (errno 23 / EHOSTUNREACH)
- The crash recovery system detects this via `isEmscriptenNetworkError()` and returns 502

## Checklist for runtime-touching changes

- [ ] Could this increase peak memory usage during bootstrap?
- [ ] Does this handle WASM crash scenarios gracefully?
- [ ] Are service worker cache keys properly scoped?
- [ ] Does HTML rewriting preserve query strings and fragments?
- [ ] Is the base path correctly propagated through all layers?
- [ ] Does this work on GitHub Pages subpath deployment?
- [ ] Are Web Worker messages properly serialized (no non-transferable objects)?
- [ ] Is the anti-loop guard still effective after this change?
