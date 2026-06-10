# 0011 — Bundle content trim and php.ini / runtime tuning

## Status

Accepted (2026-06).

## Context and Problem

The Moodle core bundle that the playground downloads and extracts into MEMFS on
every cold boot was ~78 MB / ~24,600 files (after the existing `.git`,
`*/tests/*`, `node_modules` exclusions). File **count** matters as much as MB:
MEMFS extraction is per-entry, so trimming dead files speeds both the download
and the in-WASM `ZipArchive::extractTo()` phase. Separately, a code audit found
PHP runtime settings that were either missing (`realpath_cache_*`) or
documented in a misleading way (OPcache shared-memory knobs that are inert
under `opcache.file_cache_only=1`). This ADR records the trim policy and the
tuning changes, and the explicit decisions to NOT pursue several
single-process/concurrency "optimizations".

## Options Considered

* Leave the bundle as-is (only structural exclusions).
* Trim safe, never-loaded files (docs, build/CI/IDE metadata, AMD sources,
  source maps) with build-time tripwires to prevent over-matching.
* Minify PHP (strip comments/whitespace) — rejected: high risk, complex to do
  reliably, breaks stack-trace line numbers, marginal gain vs the targeted
  exclusions.

## Decision

### Bundle exclusions (`scripts/build-moodle-bundle.sh`)

The zip step uses an explicit, commented `set --` allowlist of `-x` patterns.
Groups added on top of the structural exclusions:

* **`*/amd/src/*`** (~845 files / ~13 MB): Moodle serves compiled
  `amd/build/*.min.js`. The dev-mode fallback in `lib/requirejs.php` reads
  `amd/src` ONLY when a module's `.min.js.map` is missing — and every bundled
  `min.js` ships its map (verified across all CI branches). `core_requirejs`
  scans `amd/build` only; `lib/jssourcemap.php` serves the `.map` (which embeds
  `sourcesContent`), so DevTools still shows original sources.
* **Root docs + build/CI/IDE metadata** (~65 files / ~1.1 MB): `UPGRADING.md`,
  `CONTRIBUTING.md`, `README.md`, `INSTALL.txt`, `COPYING.txt`, `TRADEMARK.txt`,
  `Gruntfile.js`, `package.json`, `npm-shrinkwrap.json`, `composer.{json,lock}`,
  `.github/`, `.grunt/`, `.upgradenotes/`, `.esbuild/`, `.jest/`, and lint/IDE
  dotfiles. `security.txt` is deliberately KEPT (servable).
* **Vendor/plugin docs, tree-wide** (~344 files / ~4.6 MB): `README*`,
  `CHANGELOG*`, `CHANGES*`, `AUTHORS*`, `CONTRIBUTING*`, `upgrade.txt`,
  `UPGRADING*`. **`HISTORY*` is forbidden** — it would match real runtime code
  (`mod/wiki/history.php`, `lib/aws-sdk/src/History.php`,
  `question/bank/history/...`).

`*.map` exclusion (~867 files / ~5.7 MB download) is **deferred to ADR 0013**:
while `$CFG->cachejs` is false, `amd/src` XOR `*.map` must remain (removing both
breaks dev-mode JS). Since `amd/src` is already removed here, maps can only go
once cachejs is re-enabled by the RequireJS combined-seed work.

`FILE_COUNT` is now derived from the artifact (`unzip -Z1 | grep -cv '/$'`)
instead of a parallel `find`, so it can never drift from the real exclusion set.

Two build-time **tripwires** fail the build loudly:
1. **PHP-entry parity**: bundled `.php` count must equal the source tree's
   `.php` count minus the two known non-runtime PHP locations
   (`.phpstorm.meta.php`, root `.github/`). Guarantees no doc pattern ever
   swallows runtime PHP.
2. **Presence asserts** (tolerant of the 5.1+ `public/` layout) for
   `lib/requirejs.php`, `lib/behat/lib.php`, `lang/en/moodle.php`.

Exclusions are zip-time only (they never mutate `$MOODLE_DIR`) and run after
snapshot generation in the pipeline ordering, but the files they remove are not
DB-listed plugins, so removal is safe by construction.

### php.ini (`src/runtime/config-template.js`)

* Added `realpath_cache_size = 8M`, `realpath_cache_ttl = 86400`. Every include
  resolves each path component via `lstat` through Emscripten's JS FS; the
  bundle tree is immutable within a session and there is exactly ONE PHP
  process, which self-invalidates its realpath cache on any internal
  unlink/rename. All JS-side FS writes (journal hydration, boot patches) happen
  before the first request, and PHP does not cache negative lookups, so a
  long TTL is safe.
* Corrected the OPcache comment: with `opcache.file_cache_only=1` OPcache
  allocates NO shared-memory segment, so `max_accelerated_files`,
  `memory_consumption` and `interned_strings_buffer` are **inert**. They are
  kept (with `max_accelerated_files` bumped to `20000`, above Moodle's ~15k
  bundled PHP files) only as future-proofing should `file_cache_only` ever be
  revisited. This amends the rationale of ADR 0004.

### Rejected (recorded so they are not re-proposed)

* **`$CFG->langlist = 'en'`**: would permanently filter
  `get_list_of_translations()`, hiding any pack installed at runtime by the
  blueprint `installLanguagePack` step (ADR 0006) and breaking a
  `setDefault:'es'` blueprint. Zero measurable gain (the lang dir is a trivial
  MEMFS scan; `langmenu=0` is already seeded).
* **`$CFG->enable_read_only_sessions` / `READ_ONLY_SESSION`**: solves session
  write-lock contention between CONCURRENT requests. The playground has one PHP
  instance behind a strictly serial request queue (`php-worker.js`) — contention
  is structurally zero — and sessions live in MEMFS where a write costs
  microseconds. Pure downside (RO-marked scripts that mutate `$SESSION` start
  logging errors; the auto-login bootstrap becomes a new thing to keep
  compatible).
* **Alternative session handler**: files-on-MEMFS is already memory-backed and
  optimal; a DB handler routes session I/O through SQLite (slower).

### `@php-wasm` upgrade 3.1.36 → 3.1.38

Between the two tags there are exactly two `packages/php-wasm` commits:
`a2b8d3d3` ("[Web] Decline TLS session resumption for shared curl handles") —
a pure fix on the `tcpOverFetch` HTTPS path the playground uses for langpack and
plugin downloads — and `ccade0bd` (XDebug CDP, CLI-only, not consumed here).
3.1.37 was an empty version bump. No API changes touch `php-loader.js`,
`php-compat.js` or `fs-persistence.js`. Decision: **GO**.

## Consequences

### Positive
* MOODLE_500_STABLE bundle: ~78 MB → ~73.8 MB, ~24,600 → ~23,324 files
  (measured), with the same numbers proportionally across branches. Less to
  download, decompress and write into MEMFS on every cold boot.
* Realpath cache cuts repeated path-walk syscalls on the hot include path.
* The misleading OPcache comment no longer implies the SHM knobs do anything.
* The TLS fix makes repeated outbound HTTPS from PHP reliable.

### Negative / Risks
* `zip -x` over-matching is the main correctness risk; mitigated by the
  PHP-parity tripwire + presence asserts (build fails, never ships). New
  patterns require a per-branch audit and must never include `HISTORY*`.
* DevTools step-debugging of core AMD modules now shows minified source mapped
  back via the `.map` (full original source preserved); only `amd/src` raw files
  are gone.
* The `@php-wasm` TLS change must be exercised (langpack/plugin install) before
  release — a regression surfaces as OpenSSL handshake errors inside PHP curl,
  which `moodle-language.js` would mask as a soft failure.

## Implementation Notes

* `scripts/build-moodle-bundle.sh`: exclusion allowlist, `FILE_COUNT` from zip,
  tripwires.
* `src/runtime/config-template.js`: realpath cache + OPcache comment/bump.
  Requires `npm run build-worker` (config-template.js is bundled into the
  worker).
* `package.json` / `package-lock.json`: `@php-wasm/*` ^3.1.38; `npm install`
  then `npm run build-worker`.
* New unit tests in `tests/runtime/config-template.test.js` (ini keys) and
  `tests/shared/moodle-loader-asset-cache.test.js` (the Cache API helper added
  for the boot work).

## Review Criteria

* Revisit the exclusion list whenever a new Moodle branch is added to CI (the
  tripwires will fail loudly if a pattern over-matches on the new branch).
* Revisit `opcache.file_cache_only` if WASM ever gains a usable shared-memory
  OPcache — at which point the inert knobs become live.
* Revisit `realpath_cache_ttl` if any future feature deletes MEMFS files from
  the JS side between requests (stale positive realpath entries could surface).
* Revisit the langlist/read-only-session rejections if the runtime ever moves
  off a single serial PHP instance.
