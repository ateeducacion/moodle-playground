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
- [Resolved issues log](../.agents/references/resolved-issues.md)

## 1. sodium extension is NOT available in the WASM binary

Status:

- open (upstream limitation)

Impact:

- low — fully mitigated by the OpenSSL fallback patch

The `@php-wasm/web` PHP WASM binary does not include the `sodium` extension.
The OpenSSL fallback patch in `patches/shared/lib/classes/encryption.php` handles
all encryption needs. The runtime also downgrades the `admin/environment.xml` sodium
check from `required` to `optional`, so plugin upgrades are not blocked.

**OPcache** also cannot work in the WASM SAPI (PHP/Emscripten limitation). The
environment check warning for OPcache is expected and harmless.

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

## Current top priority

If continuing work from here, the next priority should be:

1. verify all newly-available extensions work correctly with Moodle
2. benchmark navigation performance with caching enabled vs disabled
3. evaluate spawn handler integration for PHP CLI support (see issue #2)
