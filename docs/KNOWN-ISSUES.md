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
`patches/shared/lib/classes/encryption.php` handles all encryption needs. The
runtime also downgrades the `admin/environment.xml` sodium check from `required`
to `optional`, so plugin upgrades are no longer blocked by this mismatch.

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
- other patches are applied at boot into MEMFS

Where to continue:

- decide whether each patch should live permanently in:
  - `patches/shared/...`
  - or in runtime-only overrides in `src/runtime/bootstrap.js`

Main files involved:

- `scripts/patch-moodle-source.sh`
- `src/runtime/bootstrap.js`

## ~~4. CACHE_DISABLE_ALL must stay true (admin redirect loop)~~ — resolved

Status:

- **resolved**

There were three interacting issues when enabling MUC (`CACHE_DISABLE_ALL = false`):

1. **Missing cache store admin settings** — cache store plugin settings (`cachestore_apcu`,
   `cachestore_redis`) were not in the database. `any_new_admin_settings()` detected them
   as "new" and redirected to `upgradesettings.php`.
2. **`adminsetuppending` flag** — the CLI installer sets `adminsetuppending = 1` in
   `mdl_config`. With MUC disabled the web admin flow cleared it; with MUC enabled the
   stale flag caused `is_major_upgrade_required()` to redirect all pages to admin.
3. **`moodle_needs_upgrading()` version hash mismatch** — the `allversionshash` computed
   at runtime differs from the snapshot value (component scanning varies in WASM MEMFS).
   This caused `/my/` to redirect to `/admin/index.php` on every request.

Fix:

- **Snapshot generation** (`scripts/generate-install-snapshot.sh`): runs
  `admin_apply_default_settings()` at build time, seeds cache store defaults, clears
  `adminsetuppending`
- **Config normalizer** (`src/runtime/bootstrap.js`): seeds cache store plugin defaults
  and clears `adminsetuppending` on every boot
- **Admin defaults seeder** (`src/runtime/bootstrap.js`): runs
  `admin_apply_default_settings(NULL, false)` with MUC-enabled config after the normalizer
- **Runtime patches** (`src/runtime/bootstrap.js`): `moodle_needs_upgrading()` returns
  `false` (ephemeral runtime, no upgrades possible); `any_new_admin_settings()` returns
  `false` (defaults are seeded at boot)

`CACHE_DISABLE_ALL` and `CACHE_DISABLE_STORES` are now `false` in `config-template.js`.
MUC file-based caches live in MEMFS and persist for the worker session lifetime, making
`cachetemplates` and `langstringcache` effective across requests.

## ~~5. Large readonly bundle still puts pressure on browser memory~~ — resolved

Status:

- **resolved**

The bundle loader in `lib/moodle-loader.js` was reworked to preallocate a single destination
buffer when `content-length` is known and fill it incrementally, eliminating the double-buffer
allocation that previously caused `RangeError: Array buffer allocation failed`. This is no
longer an issue in practice. (The project has since migrated from the custom readonly VFS
overlay to extracting the Moodle ZIP bundle directly into writable MEMFS.)

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
