# ADR-0004 OPcache tuning and runtime UX defaults for WASM

* Status: Accepted
* Date: 2026-03-27

## Context and Problem

Two separate but related runtime issues affected the playground experience:

**Performance**: PHP in WASM was recompiling every script on every request. In a native
server, OPcache stores compiled bytecode between requests. The `@php-wasm/web` runtime
includes OPcache support, but it was not configured. Each Moodle page load executes
50-100+ PHP files — recompilation on every request adds measurable overhead.

**UX distraction**: Moodle's user tours (interactive guided walkthroughs) activate on
first visit to the dashboard, course listing, and course pages. In a playground context,
these tours cover the UI and require dismissal clicks, which is confusing for users who
are exploring or demoing features — not learning the Moodle UI for the first time.

## Options Considered

### OPcache
* **Option 1: Do nothing** — Accept the recompilation overhead. Simple but wasteful.
* **Option 2: Enable OPcache with file-based cache** — Configure OPcache to store
  compiled bytecode in a MEMFS directory. Since the Moodle source tree is readonly within
  a session (extracted from ZIP at boot), timestamp validation can be disabled for maximum
  performance. The cache directory is ephemeral (MEMFS), matching the runtime model.

### User tours
* **Option 1: Patch tour PHP files at build time** — Remove or disable tour definitions in
  the Moodle source. Fragile — tours change between versions and the patch would need
  maintenance per branch.
* **Option 2: Disable tours via SQL at boot time** — After the install snapshot is loaded,
  run `UPDATE {tool_usertours_tours} SET enabled = 0`. Simple, version-agnostic, and
  gracefully handles the case where the table doesn't exist (wrapped in try/catch).

## Decision

**OPcache: Option 2** — Enable OPcache with file-based caching in MEMFS.

**User tours: Option 2** — Disable via SQL at boot time.

### OPcache configuration
```ini
opcache.enable = 1
opcache.file_cache = /internal/shared/opcache
opcache.file_cache_only = 1
opcache.max_accelerated_files = 10000
opcache.memory_consumption = 128
opcache.interned_strings_buffer = 32
opcache.validate_timestamps = 0
opcache.file_cache_consistency_checks = 0
```

Key choices:
- `file_cache_only = 1` — Use only the file cache (stored in MEMFS), not shared memory.
  This avoids SHM-related issues in WASM.
- `validate_timestamps = 0` — The Moodle bundle is immutable within a session. No need
  to stat files for changes.
- `file_cache_consistency_checks = 0` — Skip checksum verification on cached bytecode.
  The MEMFS cache can't be corrupted by external processes.
- `max_accelerated_files = 10000` — Moodle has thousands of PHP files.

## Consequences

### Positive
* **Faster page loads** — Scripts are compiled once, reused across requests within a session.
  Second page loads are noticeably faster.
* **Cleaner playground UX** — No tour popups covering the interface on first visit.
* **Version-agnostic** — Both changes work across all supported Moodle branches without
  branch-specific patches.
* **Graceful failures** — Tour disable is wrapped in try/catch. OPcache config is applied
  via `setPhpIniEntries()` — if the extension isn't available, settings are ignored.

### Negative / Risks
* **OPcache memory** — Compiled bytecode consumes JS heap memory (via MEMFS). Estimated
  10-30MB for a full Moodle session. Acceptable given the performance benefit.
* **No OPcache invalidation** — If runtime patches modify PHP files after boot, OPcache
  will serve the pre-patch version. Currently mitigated because runtime patches are applied
  before the first request. If this changes, `opcache_invalidate()` calls would be needed.
* **User tours disabled unconditionally** — Users who want to see tours for testing/demo
  purposes cannot re-enable them via the playground UI. Acceptable trade-off since the
  playground is for exploration, not Moodle onboarding.

## Implementation Notes

### Files modified
- `src/runtime/config-template.js` — Added OPcache php.ini entries to `createPhpIniEntries()`.
- `src/runtime/php-loader.js` — Creates `/internal/shared/opcache` directory via
  `FS.mkdirTree()` during runtime initialization.
- `src/runtime/bootstrap.js` — Added `UPDATE {tool_usertours_tours} SET enabled = 0`
  query in the post-install config normalization block, wrapped in try/catch.

## Review Criteria

- If `@php-wasm/web` changes OPcache support or shared memory semantics, review the
  `file_cache_only` setting.
- If Moodle versions add new tours that are relevant for playground demos (unlikely),
  consider making tour disabling configurable via blueprint `runtime` options.
- If OPcache memory consumption becomes a problem on resource-constrained devices,
  consider reducing `max_accelerated_files` or `memory_consumption`.
