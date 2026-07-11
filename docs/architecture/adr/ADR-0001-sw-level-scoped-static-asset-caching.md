# ADR-0001 Service Worker-level caching for scoped static assets

* Status: Accepted
* Date: 2026-03-27

## Context and Problem

In Moodle Playground, every scoped request (`/playground/{scope}/{runtime}/...`) is
forwarded to the PHP worker via BroadcastChannel and enters a **serial queue**. This
includes truly static files (CSS, JS, images, fonts) and PHP-generated cacheable assets
(`styles.php`, `javascript.php`, `image.php`, `font.php`).

A typical Moodle page triggers 20-40 asset requests. Because the PHP worker processes
requests sequentially, static assets compete with page renders for queue time. Each
round-trip through the BroadcastChannel bridge + MEMFS read costs ~5-20ms, and these
add up to 100-400ms of pure queue overhead per page navigation.

The facturascripts-playground project solved this same problem by caching scoped static
asset responses at the Service Worker level using the Cache API. We evaluated adopting
the same approach for Moodle.

## Options Considered

* **Option 1: Do nothing** — Keep all scoped requests going through the PHP worker.
  Simple but leaves significant performance on the table for subsequent page loads.

* **Option 2: Cache only truly static files (non-`.php`)** — Intercept GET requests
  to files with known static extensions (`.css`, `.js`, `.png`, `.woff2`, etc.) at the
  SW level. Cache after first fetch, serve from cache on subsequent requests.

* **Option 3: Cache static files + PHP-generated cacheable assets** — Extend Option 2
  to also cache responses from Moodle's asset-serving PHP scripts (`styles.php`,
  `javascript.php`, `image.php`, `font.php`) which produce deterministic output keyed
  by revision numbers in the URL path.

## Decision

**Option 3**: Cache both truly static files and PHP-generated cacheable assets at the
Service Worker level.

Rationale:
1. PHP-generated assets represent the majority of asset weight (combined CSS via
   `styles.php` can be 200-500KB; combined JS via `javascript.php` is similar).
2. Moodle's revision-number URL scheme (`/theme/styles.php/boost/{rev}/all`) provides
   natural cache invalidation — when theme caches are purged, the revision changes and
   URLs miss the cache automatically.
3. The implementation cost of Level 2 over Level 1 is minimal (one additional regex
   check in the same code path).

### Exclusions
- `pluginfile.php` and `draftfile.php` are **never cached** — they serve user-uploaded
  content where the URL can stay the same while content changes.
- POST/PUT/DELETE requests are never cached.
- HTML responses (`text/html`) are never cached — they require URL rewriting.

## Consequences

### Positive
* **Unblocks the serial PHP queue** — Static assets no longer compete with page renders.
* **Instant cache hits** — Cache API serves responses in ~1ms vs ~5-20ms per asset
  through the BroadcastChannel bridge, and they're serialized.
* **Survives crash recovery** — Cache API is browser storage, independent of WASM heap.
  After a worker crash + restart, cached assets are still available instantly.
* **No additional WASM memory** — Cache API uses browser storage, not JS heap.
* **Natural invalidation** — PHP asset URLs contain revision numbers; new revisions
  produce new URLs that miss the cache.

### Negative / Risks
* **Stale cache after runtime reset** — If the Moodle core changes between sessions
  (e.g., different bundle version), cached assets from the previous session could be
  stale. Mitigated by clearing the scoped cache on SW activation (new build version)
  and on explicit `clear-scoped-static-cache` messages.
* **Disk usage** — Cached assets consume browser storage. Estimated <5MB for a typical
  Moodle session. Negligible for modern browsers.
* **Added complexity in SW** — The fetch handler gains a new code path. Kept simple by
  reusing the existing `forwardToPhpWorker` on cache miss.

## Implementation Notes

### Files modified
- `sw.js` — Added `SCOPED_STATIC_CACHE`, `isScopedStaticAsset()`,
  `isCacheablePhpAsset()`, and a cache-first branch in the scoped fetch handler.
  Added `clear-scoped-static-cache` message listener. Added cache purge on activation.

### Cache key strategy
- For truly static files: the `requestPath` (scope-stripped) is used as the cache key,
  anchored to the origin. This means the same `/lib/jquery/jquery.min.js` is shared
  across scopes (the file content is identical since it comes from the same MEMFS bundle).
- For PHP-generated assets: the full `requestPath` including the revision number is the
  key. Different revisions produce different cache entries.

### Cache lifecycle
1. **New SW version (activation)** — All old static caches are purged via
   `purgeOldStaticCaches()`. The scoped static cache is also cleared.
2. **Worker crash/restart** — Worker can send `clear-scoped-static-cache` via
   BroadcastChannel if the runtime is rebuilt from scratch.
3. **Natural expiry** — PHP asset URLs change revision numbers when Moodle's theme
   cache is purged. Old entries become unreachable (dead entries cleaned on next SW
   activation).

## Review Criteria

- If Moodle Playground adds support for multiple simultaneous Moodle versions in the
  same browser session, the cache key strategy may need per-version namespacing.
- If `pluginfile.php` URLs are made content-addressable (hash in URL), they could be
  added to the cacheable set.
- If the Cache API causes storage quota issues on resource-constrained devices, consider
  adding a size limit or LRU eviction.
