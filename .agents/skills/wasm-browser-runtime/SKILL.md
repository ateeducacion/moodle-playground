---
name: wasm-browser-runtime
description: Debug Moodle Playground WASM memory and crashes, service-worker routing, filesystem journaling, or crash recovery.
metadata:
  author: moodle-playground
  version: "1.0"
---

# WebAssembly & Browser Runtime Expert

## WebAssembly runtime constraints

### Memory model

- The main PHP loader configures WASM linear memory to start at 128 MiB and can grow up to ~2-4 GB (browser-dependent)
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
- **OPFS**: Not used in this project
- **IndexedDB**: Journals mutable `/persist` data for reloads; see `src/runtime/fs-persistence.js`
- **Cache API**: Used by service worker for static asset caching
- **sessionStorage**: Holds the tab scope and blueprint source identity

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
- The Moodle tar.zst extraction (~100-200 MB) is a peak memory moment

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
- `scope` — identifies the playground instance (normally a generated per-tab ID)
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

### Recovery and persistence

Read [ADR 0027](../../../docs/architecture/adr/ADR-0027-selective-crash-recovery-snapshots.md)
and the current `php-worker.js` recovery path when changing snapshots. Recovery
checkpoints pending filedir changes before taking the DB snapshot; on failure it
prefers an older coherent checkpoint. Do not restore a newer DB over older uploads
or reintroduce an unbounded full-filedir copy.

`src/runtime/fs-persistence.js` journals `/persist` to `moodle-fs-journal:<scope>`.
Keep derived `moodledata/{cache,localcache,temp,muc}` out of the journal, normalize
operations before hydration, and restart journaling after clearing for a clean boot.

### Anti-loop guards

- `MAX_REACTIVE_RESTARTS = 20` — maximum restarts per session
- `MIN_REQUESTS_BEFORE_RESTART = 10` — don't restart if barely started
- POST/PUT/DELETE requests are never replayed after recovery

## Worker protocol

Read `php-worker.js` and `src/shared/protocol.js` for actual message shapes and
progress events. Avoid inventing a second protocol from illustrative examples.

## Performance optimization strategies

### Startup time

1. **Pre-built install snapshot**: Skip 3-8s CLI install by loading `install.sq3`
2. **Bundle caching**: Cache API stores the Moodle bundle between page loads
3. **OPcache warming**: PHP OPcache compiles scripts on first access, subsequent requests faster

### Runtime performance

1. **MUC enabled**: Moodle caching framework reduces DB queries after first page load
2. **SQLite pragmas**: `journal_mode=MEMORY`, `synchronous=OFF`, `cache_size=-8000`
3. **Session files in MEMFS**: No I/O latency for session reads/writes
4. **Service worker caching**: Static assets served from Cache API, not re-processed by PHP

### Memory management

1. **Avoid large file operations**: SCORM packages, backups can exhaust memory
2. **Monitor JS heap**: MEMFS file contents + WASM memory should stay under ~2 GB
3. **Restart as recovery**: When memory is exhausted, the only option is a fresh runtime

## Repository-specific pitfalls

### sw.js
- Query strings must survive scoped redirects
- HTML rewriting must keep Moodle links/forms inside the scoped runtime

### crash-recovery.js
- Snapshot filesystem operations use the raw PHP instance (`php._php`), not the
  compat wrapper. Consult the current snapshot manager and ADR 0027 for coverage.
- Plugin registration must refresh `alternative_component_cache` so Moodle can
  discover restored plugins before checking upgrades.
- Preserve restart limits and GET/HEAD-only replay; test the failure path as well
  as successful restoration when changing recovery.

### Service Worker bundling (Firefox)
- Firefox does not support ES module Service Workers (Mozilla Bug 1360870)
- SW is bundled into `sw.bundle.js` (IIFE) at project root, registered as `type: "classic"`
- **The SW bundle MUST live at the project root, not in `dist/`** — a SW's max scope is
  its directory path; Firefox throws `SecurityError` if violated
- Source: `sw.js` → Bundle: `sw.bundle.js` → Built by: `npm run build-worker`

### Outbound request bodies

Use [ADR 0015](../../../docs/architecture/adr/ADR-0015-firefox-request-body-buffering.md)
for Firefox request-body handling. Do not assume all outbound HTTP fails in Firefox;
GET downloads and buffered bodies have supported paths.

## Checklist for runtime-touching changes

- [ ] Could this increase peak memory usage during bootstrap?
- [ ] Does this handle WASM crash scenarios gracefully?
- [ ] Are service worker cache keys properly scoped?
- [ ] Does HTML rewriting preserve query strings and fragments?
- [ ] Is the base path correctly propagated through all layers?
- [ ] Does this work on GitHub Pages subpath deployment?
- [ ] Are Web Worker messages properly serialized (no non-transferable objects)?
- [ ] Is the anti-loop guard still effective after this change?
