# Known Issues

This file lists the currently known open issues in the SQLite + @php-wasm/web prototype.

It is intentionally short:

- what is still broken or fragile
- current impact
- current workaround
- where to continue

For historical context, see:

- [`sqlite-wasm-migration-notes.md`](./sqlite-wasm-migration-notes.md)
- [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
- [Resolved issues log](https://github.com/ateeducacion/moodle-playground/blob/main/.agents/references/resolved-issues.md)

## 1. sodium extension is NOT available in the WASM binary

Status:

- open (upstream limitation)

Impact:

- low — fully mitigated by the OpenSSL fallback patch

The `@php-wasm/web` PHP WASM binary does not include the `sodium` extension.
The OpenSSL fallback patch in `patches/shared/lib/classes/encryption.php` handles
all encryption needs. The runtime also downgrades the `admin/environment.xml` sodium
check from `required` to `optional`, so plugin upgrades are not blocked.

**OPcache** is configured in file-cache-only mode but does not start under the
`wasm` SAPI on PHP 8.3/8.4 (php-src rejects the SAPI name before reading the
configuration). **PHP 8.5 removed that whitelist**, so with Moodle `main` + PHP 8.5
the file cache is live. `opcache_reset()`/`opcache_invalidate()` are no-ops in this
mode; the runtime therefore validates timestamps (`opcache.validate_timestamps=1`,
whole-second mtimes, default 2 s `file_update_protection`) and blacklists
`/internal/eval.php`, the path every `php.run({ code })` reuses
([ADR-0038](architecture/adr/ADR-0038-opcache-file-cache-timestamp-validation.md)).
A rewrite that preserves the original mtime is the remaining blind spot; blueprint
plugin/overlay restores additionally delete the on-disk cache. On PHP 8.3/8.4 the
cache can be started with the experimental `?opcache=1` parameter (or
`"opcache": true` in `playground.config.json`), which reports the whitelisted
`uwsgi` SAPI name to PHP
([ADR-0039](architecture/adr/ADR-0039-experimental-opcache-via-sapi-name.md));
it is off by default while it soaks. The info panel's "OPcache file cache"
checkbox sets the same parameter and reloads the same runtime and scope, so the
journaled data is kept ("Apply & Reload", not a reset;
[ADR-0040](architecture/adr/ADR-0040-opcache-panel-toggle.md)). phpinfo keeps
showing the SAPI's pretty name (`PHP WASM SAPI (JSPI)`) either way; the row that
proves the cache is live is `Opcode Caching: Up and Running`.

### JavaScript seeds after upgrades and purges

Moodle now retains its own `jsrev`. New seeds publish `snapshot.jsrev`; old sha1(1)
seeds or a changed DB revision use the existing per-module fallback rather than
serving old code under a new revision. Purging localcache can make navigation
slower. Rebuild assets to get a matching seed; never relabel the old combine.
See [ADR-0033](architecture/adr/ADR-0033-moodle-owned-javascript-revisions.md).

`cachejs` stays enabled after a purge when the seed is advertised. Without a
matching combine, the patched `requirejs.php` serves AMD modules individually
under the valid revision, and ESM stays public/immutable. The first page after a
purge is still slower (per-module AMD, theme CSS compiled in WASM).

### Persisted blueprint replay

New instances checkpoint successful provisioning in SQLite. Reload skips durable
mutations and arbitrary PHP/POST, restores declared volatile files and saved
overlay artifacts, downloads plugin/theme ZIPs again, and recreates login. Legacy instances without checkpoints
and incomplete provisioning are not automatically replayed. Their unknown volatile
artifacts may require an explicit rebuild (back up retained data first). Arbitrary
runtime code/plugin edits in `/www` are still volatile; this is not a general core
persistence layer. The checkpoint stores the SHA-256 of each installed plugin/theme
archive; on reload a changed archive is extracted only when its `version.php` is
newer than the persisted version (the log warns and Moodle asks the admin to
upgrade). After a manual plugin upgrade the downloaded ZIP is older than the
database and is skipped with a warning; Reset Playground installs the current
archive. Failed downloads are retried and reported with the archive URL. See
[ADR-0035](architecture/adr/ADR-0035-blueprint-reload-checkpoints.md) and
[ADR-0037](architecture/adr/ADR-0037-blueprint-archive-hash-verification-on-reload.md).

An unfinished plugin can restore its saved code without rerunning registration;
the incomplete step remains a warning/error. Completed plugins removed through
Moodle are not resurrected if their installed-version record is absent. Legacy
sites without an exact saved artifact still need explicit recovery, not an
automatic download from a potentially changed URL.

Plugin/overlay restores clear MUC and both on-disk hook registries without
bumping JS/theme revisions. `applyPrOverlay` with `purgeCaches:false` opts out:
callbacks or strings warmed before restoration can then remain stale.

Live crash recovery clears MUC after restoring the database and before re-login,
without changing JS/theme revisions, so bootstrap's old cached configuration is
not served against the recovered DB. This does not guarantee recovery from every
real memory-corruption or out-of-memory failure.

## 2. PHP CLI / proc_open is not available in the WASM runtime

Status:

- open (upstream limitation, solution identified)

Impact:

- medium — prevents background job dispatch, CLI-based module operations, and any
  Moodle functionality that relies on `exec()` or `proc_open()`

Moodle uses PHP CLI execution for scheduled tasks (`admin/cli/cron.php`), plugin
management operations, and various admin tools. In the WASM runtime, `proc_open()`
and `exec()` are not functional because there is no native process spawning.

WordPress Playground solved this in `@php-wasm/universal` v3.x with the **spawn
handler** API (`php.setSpawnHandler()`), which intercepts `proc_open()` calls at
the WASM level and runs PHP scripts in-process via `php.run()`. The API is available
in our `@php-wasm/web` dependency but not yet wired up.

The Omeka S Playground tracks the same limitation:
[ateeducacion/omeka-s-playground#30](https://github.com/ateeducacion/omeka-s-playground/issues/30)

Where to continue:

- Register a spawn handler in `src/runtime/php-loader.js` during runtime creation
- Intercept `php` commands and run them in the same WASM instance via `php.run()`
- Add an allowlist for permitted commands (security)
- Evaluate whether scheduled tasks can run via the spawn handler

## 3. Runtime still relies on both build-time and boot-time patching

Status:

- open, but expected for now

Impact:

- medium
- increases maintenance cost

Current state:

- some patches are copied into the Moodle source tree during bundle preparation
- other patches are applied at boot into MEMFS

Where to continue:

- decide whether each patch should live permanently in:
  - `patches/shared/...`
  - or in runtime-only overrides in `src/runtime/bootstrap.js`

Main files involved:

- `scripts/patch-moodle-source.sh`
- `src/runtime/bootstrap.js`

## 4. Asset routing issues may still recur after changes to SW/CGI logic

Status:

- fragile area

Typical symptom:

- `styles_debug.php`
- `javascript.php`
- `yui_combo.php`
- 404 with `No input file specified.`

Impact:

- high when it happens, because pages look unstyled and JS boot breaks

Where to continue:

- `sw.js`
- `src/runtime/php-compat.js`
- `src/runtime/php-loader.js`

Notes:

- current good sessions in Chrome showed these endpoints returning `200`
- this area should still be treated as sensitive whenever routing code changes

## 5. The prototype does not yet claim full Moodle parity

Status:

- expected limitation

Meaning:

- install path works much better than at the start of the migration
- navigation works further than before
- but this is still a prototype, not a drop-in replacement for a normal Moodle PHP environment

Examples:

- brittle plugin settings pages during install had to be guarded
- some config values must be seeded manually
- extension assumptions from Moodle core still need local accommodation

## 6. Production code that require_once()s files under tests/

Status:

- mlbackend_python case: resolved (patched)
- other references: latent (open, low impact)

Impact:

- low — the active case is fixed; the remaining references are unreachable in
  the playground

Background:

- the core bundle excludes every `*/tests/*` directory (ADR 0011) to halve the
  download. A few Moodle 5.0+ production files violate the "runtime never reads
  test code" assumption by `require_once()`-ing files under `tests/`.

Current state:

- **Fixed:** `lib/mlbackend/python/classes/processor.php` required the analytics
  test trait `core_analytics\tests\mlbackend_helper_trait`, which made
  `/admin/plugins.php` (and analytics admin pages) fatal. Patched in
  `scripts/patch-moodle-source.sh` (drop the require, inline the one method used).
  See ADR 0014.
- **Latent (not patched):** `cache/classes/factory.php` →
  `cache/tests/fixtures/lib.php` (test-mode only) and the `tool_generator` /
  `tool_behat` Behat data generators →
  `lib/tests/behat/…`, `admin/tests/behat/…`, `course/tests/behat/…`. These code
  paths are only reached under Behat/PHPUnit, never in the playground.

Where to continue:

- if a new Moodle branch fatals on a different `…/tests/…` require, add a
  build-time detector in `scripts/build-moodle-bundle.sh` (grep production PHP
  for `require/include` of `tests/…\.php`, assert each is present in the zip via
  a suffix match). See ADR 0014 Review Criteria.

Main files involved:

- `scripts/patch-moodle-source.sh`
- `scripts/build-moodle-bundle.sh`
- `docs/architecture/adr/ADR-0014-production-require-of-tests-files-patch.md`

## Current top priority

If continuing work from here, the next priority should be:

1. verify all newly-available extensions work correctly with Moodle
2. benchmark navigation performance with caching enabled vs disabled
3. evaluate spawn handler integration for PHP CLI support (see issue #2)
