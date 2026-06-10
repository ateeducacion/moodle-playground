# 0013 — Build-time RequireJS combined-bundle seed (re-enable cachejs)

## Status

Accepted (2026-06).

## Context and Problem

With `$CFG->cachejs = false` (the prior default), Moodle's `lib/requirejs.php`
serves JavaScript in **dev mode**: every AMD module is a separate, uncached
PHP execution. A first page load pulls ~50–120 such requests, all serialized
through the worker's single PHP request queue — the slowest moment of in-session
navigation.

`cachejs = true` (production mode) would collapse that to ONE combined request
per page (`/lib/requirejs.php/<rev>/core/first.js` returns all non-lazy modules).
But enabling it previously failed silently with "No define call for core/first":
`core_requirejs::find_all_amd_modules()` relies on `realpath()` /
`RecursiveDirectoryIterator::getRealPath()`, which is unreliable on the
Emscripten VFS (the same reason this project already patches `code_manager`).
The runtime combine wrote a poisoned-but-existing cache file that
`js_send_cached()` then served.

## Options Considered

* Keep `cachejs = false` (status quo): dozens of serial PHP requests per page.
* Let the runtime build the combine with `cachejs = true`: fails on the
  Emscripten VFS.
* Build the combined bundle at build time (where filesystem iteration is
  reliable), ship it in the localcache seed, and forbid the runtime from ever
  building it.

## Decision

Build the combine at build time and seed it; the WASM runtime never combines.

### Build time

* `scripts/generate-install-snapshot.sh` runs a PHP warmup that replicates
  `requirejs.php`'s production "all non-lazy modules" combine
  (`core_requirejs::find_all_amd_modules()` → strip `sourceMappingURL` →
  `requirejs_fix_define()` → concatenate) and writes it via
  `js_write_cache_file_content()` to `localcache/requirejs/<sha1(1)>`. It
  fail-hards if the file is missing, < 1 MB, or lacks the `core/first` define.
  `requirejs/` is added to the seed tripwire (no build-machine paths) and to the
  `localcache.zip`.
* `scripts/patch-moodle-source.sh` patches `lib/requirejs.php` (two hunks,
  fail-loud needle checks, applied to all CI branches):
  1. Guard the cache-miss **build** branch with `!defined('MOODLE_PLAYGROUND')`,
     so the playground never builds the combine — on a miss it falls through to
     the existing dev-mode single-module serving.
  2. Serve the seeded combine **only for `core/first`**: for any other non-lazy
     module, blank the candidate so it falls through to per-module serving. The
     seed contains only the modules present at build time, so this keeps AMD
     from runtime-installed plugins working (they are served individually).
* `scripts/build-moodle-bundle.sh` probes the seed zip (`unzip -l | grep
  ' requirejs/'`) and passes `--snapshotRequirejs 1`; `generate-manifest.mjs`
  records `manifest.snapshot.requirejs = true`. The flip is keyed off the
  **actually shipped** artifact, so cached pre-warmup seeds and legacy bundles
  keep `cachejs = false`.

### Runtime

`bootstrap.js` passes `requirejsSeeded = Boolean(manifest.snapshot.requirejs)` to
`createMoodleConfigPhp`. When seeded, `config.php` emits:

```php
$CFG->jsrev = 1;
$CFG->cachejs = is_dir($CFG->localcachedir . '/requirejs');
```

* **`jsrev` is pinned to 1** so the URL revision matches the seeded `sha1(1)`
  file. config.php overrides DB config, so `js_reset_all_caches()`'s
  `set_config('jsrev', time())` cannot desync the revision across journaled
  reloads. Bundle JS is immutable per build, so in-session JS cache-busting being
  a no-op is acceptable. (A future feature that mutates JS at runtime — e.g.
  theme designer mode — would need to revisit this.)
* **`is_dir()` self-heals after "Purge all caches"**: a purge wipes
  `localcache/requirejs`, so `cachejs` flips to `false` for the rest of the
  session (per-module dev serving); the next boot re-extracts the seed and
  recovers. (localcache is intentionally never journaled.)

## Consequences

### Positive
* First page load per scope: ONE combined `requirejs.php` request instead of
  ~50–120 serial per-module PHP executions. This is the largest in-session
  navigation win.
* The runtime never runs the broken `find_all_amd_modules` combine.
* Graceful degradation: no seed (legacy/old bundle) → `cachejs = false`, exactly
  today's behavior.

### Negative / Risks
* The `requirejs.php` needles must match across all CI branches; the patch fails
  the build loudly on a mismatch (never ships an unpatched bundle with
  `cachejs = true`), and the manifest flag is derived from the produced seed, so
  a failed branch degrades to `cachejs = false`.
* The `core/first`-only serving rule is **correctness-critical**: without it, a
  plugin installed at runtime would receive the combined bundle (missing its
  define) for every module request and break. Verify with an e2e that installs
  an AMD-bearing plugin.
* `requirejs_fix_define()` is duplicated from `lib/requirejs.php` (it is not an
  autoloadable function); keep it in sync with upstream.
* localcache.zip grows by the combined bundle (~few MB, JS compresses well).

### Why `*.map` is NOT excluded from the bundle

ADR 0011 left the `*.map` exclusion to this ADR, expecting `cachejs = true` to
make maps dead weight. That is true only for the **non-lazy modules in the
seeded combine**. It is NOT safe here:

* **Lazy modules** (`chartjs`, TinyMCE's `codemirror`, `videojs`, …) are excluded
  from the non-lazy combine, so they are always served individually via the
  dev-mode path, which reads the `min.js` **only if its `.map` exists**, else
  falls back to `amd/src`.
* **Runtime-installed plugin** AMD modules and the **post-purge** fallback use
  the same dev-mode path.

Because ADR 0011 already removed `amd/src`, the `.map` files are **required** for
all of the above in normal operation (not just post-purge). The invariant
`amd/src XOR *.map` therefore resolves to: keep `*.map`. The bundle stays at
~73.8 MB (the ADR 0011 trim). Excluding maps would break lazy/plugin module
loading.

## Implementation Notes

* `scripts/generate-install-snapshot.sh`, `scripts/patch-moodle-source.sh`,
  `scripts/build-moodle-bundle.sh`, `scripts/generate-manifest.mjs`.
* `src/runtime/config-template.js` (emission), `src/runtime/bootstrap.js`
  (wiring). Requires `npm run build-worker`.
* `lib/requirejs.php` in the SW cacheable-PHP-asset set (ADR 0011 / sw.js).
* Tests: `tests/runtime/config-template.test.js` (both cachejs emissions).

## Review Criteria

* Re-evaluate `jsrev = 1` pinning if any runtime feature begins mutating JS
  (theme designer mode, runtime recompiles).
* Re-verify the `requirejs.php` needles whenever a Moodle branch is added/bumped
  (the fail-loud patch surfaces drift as a build error).
* Re-test the `core/first`-only rule whenever the AMD loading flow changes
  upstream, and keep `requirejs_fix_define()` in sync.
