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

## 1. First render inside the nested iframe is still fragile

Status:

- open

Symptom:

- the inner iframe reaches a valid Moodle URL like `/login/index.php` or `/my/`
- the page title updates correctly
- the document can remain in `readyState = "loading"` with an empty body
- visually, the iframe looks white or blank

Impact:

- high
- this is currently the most visible browser-side issue after a successful bootstrap

Current mitigation:

- `src/remote/main.js` has a watchdog that tries to detect a stalled document and force another navigation

Where to continue:

- `src/remote/main.js`
- inspect `finalizeFrameReady()`, `isFrameDocumentStalled()`, and `scheduleFrameRecovery()`

Notes:

- this is not the same issue as CSS failing to load
- several times the DOM URL/title were correct while the body stayed empty

## 2. PHP extensions — resolved

Status:

- resolved (migrated to `@php-wasm/web`)

The `@php-wasm/web` PHP 8.3 runtime includes all previously-missing extensions
(`curl`, `gd`, `fileinfo`, `sodium`, `xmlreader`, `xmlwriter`) built into the WASM binary.

The OpenSSL fallback patch for `sodium` is kept for compatibility but `sodium` is now
natively available. The patch can be removed once verified in production.

## 3. Runtime still relies on both build-time and boot-time patching

Status:

- open, but expected for now

Impact:

- medium
- increases maintenance cost

Current state:

- some patches are copied into the Moodle source tree during bundle preparation
- other patches are applied at boot into the writable overlay

Where to continue:

- decide whether each patch should live permanently in:
  - `patches/moodle/...`
  - or in runtime-only overrides in `src/runtime/bootstrap.js`

Main files involved:

- `scripts/patch-moodle-source.sh`
- `src/runtime/bootstrap.js`

## 4. CACHE_DISABLE_ALL must stay true (admin redirect loop)

Status:

- open

Symptom:

- When `CACHE_DISABLE_ALL = false`, `admin/index.php` detects new unsaved cache-related
  admin settings and redirects to `admin/index.php?cache=1` on every page load
- Admin section navigation (e.g., clicking "Server") breaks because the redirect
  interrupts the JavaScript admin tree initialization

Impact:

- high (blocks admin navigation)

Current mitigation:

- `CACHE_DISABLE_ALL = true` and `CACHE_DISABLE_STORES = true` remain enabled
- `$CFG->cachetemplates = true` and `$CFG->langstringcache = true` are set but have
  limited effect with MUC disabled (caching only works within a single PHP request)

Where to continue:

- Identify which cache-related admin settings appear when `CACHE_DISABLE_ALL = false`
- Add those settings to `$postinstalldefaults` in `bootstrap.js`
- Once seeded, re-enable `CACHE_DISABLE_ALL = false` for full MUC caching in MEMFS
- The `PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE` constant is still needed

## 5. Large readonly bundle still puts pressure on browser memory

Status:

- mitigated, not fully solved

Symptom:

- large `.vfs.bin` downloads can trigger memory pressure in some sessions

What was already fixed:

- `lib/moodle-loader.js` no longer keeps every chunk and then allocates a second full output buffer when `content-length` is known

What is still true:

- the readonly VFS image is still large
- weaker environments may still struggle

Where to continue:

- `lib/moodle-loader.js`
- bundle generation pipeline
- evaluate smaller bundles or more segmented loading if needed

## 6. Asset routing issues may still recur after changes to SW/CGI logic

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

## 7. The prototype does not yet claim full Moodle parity

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

1. make the first render of the inner Moodle iframe deterministic
2. keep the login/home route rendering without a manual second load
3. verify all newly-available extensions work correctly with Moodle
4. benchmark navigation performance with caching enabled vs disabled
5. consider pre-building a post-install SQLite snapshot to skip CLI provisioning on boot
