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

## ~~1. First render inside the nested iframe is still fragile~~ — resolved

Status:

- **resolved**

This was previously the most visible issue — the inner iframe would reach a valid Moodle URL
but the document body remained empty (white screen). The watchdog recovery logic in
`src/remote/main.js` and improvements to the boot sequence have resolved this.

The recovery code (`isFrameDocumentStalled()`, `scheduleFrameRecovery()`) is still present
as a safety net but is no longer triggered during normal operation.

## 2. PHP extensions — mostly resolved

Status:

- mostly resolved (migrated to `@php-wasm/web`)

The `@php-wasm/web` PHP 8.3 runtime includes most previously-missing extensions
(`curl`, `gd`, `fileinfo`, `xmlreader`, `xmlwriter`) built into the WASM binary.

**sodium is NOT available** in the WASM binary. The OpenSSL fallback patch in
`patches/moodle/lib/classes/encryption.php` handles all encryption needs. The
Moodle environment check will show sodium as missing — this is cosmetic only.

**OPcache cannot work** in the WASM SAPI. This is a PHP/Emscripten limitation,
not something that can be fixed in this project. The environment check warning
for OPcache is expected and harmless.

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

## ~~5. Large readonly bundle still puts pressure on browser memory~~ — resolved

Status:

- **resolved**

The VFS loader in `lib/moodle-loader.js` was reworked to preallocate a single destination
buffer when `content-length` is known and fill it incrementally, eliminating the double-buffer
allocation that previously caused `RangeError: Array buffer allocation failed`. This is no
longer an issue in practice.

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

1. ~~make the first render of the inner Moodle iframe deterministic~~ — **resolved**
2. ~~keep the login/home route rendering without a manual second load~~ — **resolved**
3. verify all newly-available extensions work correctly with Moodle
4. benchmark navigation performance with caching enabled vs disabled
5. ~~consider pre-building a post-install SQLite snapshot to skip CLI provisioning on boot~~ — **implemented**: `scripts/generate-install-snapshot.sh` creates a snapshot at build time; `bootstrap.js` loads it at runtime, falling back to the full CLI install if the snapshot is unavailable
