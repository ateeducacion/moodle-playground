# SQLite + php-wasm Migration Notes

This document records the repo-local changes made to run Moodle in WebAssembly PHP with an in-memory SQLite database (MEMFS-backed file) instead of the previous PGlite/PDO-PGlite path.

> **Runtime update (March 2025)**: The PHP runtime was migrated from `seanmorris/php-wasm` (v0.0.9-alpha-32) to WordPress Playground's `@php-wasm/web` + `@php-wasm/universal` (v3.1.11). This replaced 14 vendored packages and a manual extension-loading pipeline with two npm packages. The compatibility wrapper in `src/runtime/php-compat.js` maps the WP Playground API to the interface expected by the existing codebase. All PHP extensions (including previously-missing `curl`, `gd`, `fileinfo`, `sodium`) are now built into the WASM binary.

> **In-memory refactor (March 2026)**: The runtime is now explicitly ephemeral. The SQLite database file lives in Emscripten MEMFS (JavaScript heap) with no durable storage. SQLite pragmas are tuned for in-memory operation (`journal_mode=MEMORY`, `synchronous=OFF`, `temp_store=MEMORY`, `cache_size=-8000`, `locking_mode=EXCLUSIVE`). Moodle caching is fully enabled (file-based caches write to MEMFS). Debug mode defaults to disabled for performance, but the initial level can be seeded at boot and later changed from Moodle administration. All state is lost when the browser tab closes.

It is intentionally pragmatic: it lists what was changed, why it was changed, where the change lives, and which caveats still exist in the prototype.

## Goal

Keep the existing Moodle playground architecture and wasm persistence model, but replace the PGlite-backed database path with Moodle's deprecated SQLite PDO driver.

Constraints followed during the migration:

- keep DB persistence in the writable wasm filesystem
- keep changes localized
- allow local Moodle core patching for the prototype
- avoid redesigning the app

## Resulting runtime model

- readonly Moodle core is mounted at `/www/moodle`
- mutable state lives under `/persist`
- `moodledata` lives at `/persist/moodledata`
- the SQLite database file lives at `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`
- `config.php`, bootstrap helpers, and a few patched PHP files are written into the writable overlay at boot

## Main migration changes

### 1. Replaced the PGlite runtime path with SQLite

What changed:

- removed the active runtime dependency on `@electric-sql/pglite`
- added `php-wasm-sqlite`
- registered `sqlite` as a browser-side shared library

Files:

- `package.json`
- `package-lock.json`
- `scripts/sync-browser-deps.mjs`
- `src/runtime/runtime-registry.js`
- `playground.config.json`
- `src/runtime/php-loader.js`

Current browser-side shared libraries:

- `dom`
- `iconv`
- `intl`
- `libxml`
- `simplexml`
- `xml`
- `zlib`
- `zip`
- `mbstring`
- `openssl`
- `phar`
- `sqlite`

### 2. Switched generated Moodle config to SQLite PDO

What changed:

- `config.php` is generated with:
  - `$CFG->dbtype = 'sqlite3'`
  - `$CFG->dblibrary = 'pdo'`
  - `$CFG->dboptions['file'] = '/persist/moodledata/...sq3.php'`
- config defaults were added to reduce noise during early bootstrap and first render
- `rememberusername` is disabled by default to avoid cookie encryption paths during first boot

Files:

- `src/runtime/config-template.js`
- `lib/config-template.js`

Relevant defaults seeded during this work:

- `navcourselimit`
- `enablecompletion`
- `frontpage`
- `frontpageloggedin`
- `frontpagecourselimit`
- `guestloginbutton`
- `rememberusername`
- `auth_instructions`
- `maintenance_enabled`

### 3. Restored Moodle's deprecated SQLite PDO driver and missing historical files

Restored patch files:

- `patches/moodle/lib/dml/sqlite3_pdo_moodle_database.php`
- `patches/moodle/lib/ddl/sqlite_sql_generator.php`

Additional historical compatibility patches needed by Moodle 5.0 in this prototype:

- `patches/moodle/lib/xmlize.php`
- `patches/moodle/lib/xmldb/xmldb_file.php`
- `patches/moodle/lib/classes/encryption.php`

Patch copier:

- `scripts/patch-moodle-source.sh`

Why these extra files were needed:

- `sqlite_sql_generator.php`
  - the old generator signature did not match current `sql_generator`
  - the current prototype needs a temp-table compatible implementation
- `xmlize.php` / `xmldb_file.php`
  - the wasm runtime was fragile around the original XML parser callback path
  - XMLDB loading was patched to avoid getting stuck before schema generation
- `encryption.php`
  - current Moodle assumes `sodium` is always present
  - this wasm runtime does not currently ship `sodium`
  - a local OpenSSL fallback was restored so login/session-related encryption can work in the prototype

## Runtime bootstrap changes

The browser bootstrap now does more than just write `config.php`.

Main file:

- `src/runtime/bootstrap.js`

What it does now:

- mounts the readonly VFS bundle
- writes runtime files such as:
  - `/www/moodle/config.php`
  - `/www/moodle/__install_database.php`
  - `/www/moodle/__config_normalizer.php`
  - SQLite probe scripts
- patches a few Moodle PHP sources in-place at runtime
- loads a pre-built install snapshot (`assets/moodle/snapshot/install.sq3`) to skip CLI install
- falls back to staged CLI-like provisioning if the snapshot is unavailable
- normalizes persisted config values after install

Important runtime-local overrides added during debugging:

- cache config warnings are suppressed when `CACHE_DISABLE_ALL` is active
- the deprecated SQLite driver is patched in-place to handle current PHP/Moodle behavior
- `lib/classes/encryption.php` is patched in-place to add the OpenSSL fallback
- plugin settings files with brittle `$ADMIN->locate(...)` assumptions are patched so install does not abort
- install/finalize logic hydrates `$CFG` from database-backed config during the special bootstrap path

## Service Worker and routing fixes

Main files:

- `sw.js`
- `src/remote/main.js`
- `src/shared/storage.js`
- `php-worker.js`

What changed:

- the scope was made stable (`main`) instead of random UUIDs by default
- `$CFG->wwwroot` is built from the actual app base URL, not from the scoped runtime path
- scoped redirects preserve query strings
- shell/remote navigation was hardened to avoid cross-origin-style access errors on iframe location inspection
- the remote host now tries to recover from the first-render iframe stall that sometimes leaves the inner Moodle document in `loading` with an empty body

Known symptom this was addressing:

- the iframe would navigate to a valid Moodle URL such as `/login/index.php` or `/my/`
- the inner document title changed correctly
- but the body stayed empty and the user saw a white iframe

This area is improved but still the most fragile part of the prototype.

## php-cgi bridge fixes

Main file:

- `vendor/php-cgi-wasm/PhpCgiBase.js`

What changed:

- incoming HTTP headers are now exported into CGI environment variables
- this includes `HTTP_USER_AGENT`, `HTTP_ACCEPT_LANGUAGE`, and similar headers
- `CONTENT_TYPE` and `CONTENT_LENGTH` are exported correctly too

This was needed because Moodle reads normal CGI server variables and emitted warnings when they were missing.

## Readonly bundle loading fix

Main file:

- `lib/moodle-loader.js`

Problem:

- the readonly VFS image is large
- the old `fetchWithProgress()` implementation kept all chunks and then allocated a second full buffer
- that doubled peak memory and could fail with `RangeError: Array buffer allocation failed`

Fix:

- when `content-length` is known, the loader now preallocates a single `Uint8Array` and writes chunks into it directly

## Current patch inventory

These files contain the long-lived Moodle-side prototype patches:

- `patches/moodle/lib/dml/sqlite3_pdo_moodle_database.php`
- `patches/moodle/lib/ddl/sqlite_sql_generator.php`
- `patches/moodle/lib/xmlize.php`
- `patches/moodle/lib/xmldb/xmldb_file.php`
- `patches/moodle/lib/classes/encryption.php`

These files contain runtime-only overrides and bootstrap workarounds:

- `src/runtime/bootstrap.js`
- `src/runtime/config-template.js`
- `lib/config-template.js`
- `src/remote/main.js`
- `sw.js`
- `vendor/php-cgi-wasm/PhpCgiBase.js`
- `lib/moodle-loader.js`

## Required extension status

Built into PHP or already satisfied in the runtime path:

- `ctype`
- `dom`
- `iconv`
- `intl`
- `json`
- `mbstring`
- `pcre`
- `simplexml`
- `spl`
- `xml`
- `zip`
- `pdo`
- `pdo_sqlite`
- `sqlite3`
- `openssl`

Still missing as shipped wasm shared libraries in this repo:

- `curl`
- `gd`
- `fileinfo`
- `sodium`

Prototype workaround currently in place:

- `sodium`
  - worked around by patching `core\\encryption` to use OpenSSL fallback

Not yet solved at the wasm build level:

- `curl`
- `gd`
- `fileinfo`

## Known caveats

- first render inside the nested iframe can still be less reliable than a normal browser-backed PHP stack
- the project currently relies on both:
  - source-level Moodle patching at bundle build time
  - runtime patching during bootstrap
- some Moodle pages still assume extensions or environment details that are not present in stock `php-wasm`
- full parity with a normal Moodle PHP environment is not yet claimed

## Practical verification checklist

Syntax checks:

```bash
node --check src/runtime/bootstrap.js
node --check src/runtime/config-template.js
node --check lib/config-template.js
node --check src/remote/main.js
node --check sw.js
node --check lib/moodle-loader.js
php -l patches/moodle/lib/classes/encryption.php
php -l patches/moodle/lib/dml/sqlite3_pdo_moodle_database.php
php -l patches/moodle/lib/ddl/sqlite_sql_generator.php
```

Bundle patching:

```bash
./scripts/patch-moodle-source.sh /path/to/extracted/moodle
```

Manual browser checks:

- first boot install path
- reload with persisted DB
- login page render
- navigation to `/my/`
- theme CSS and JS asset loading
- no fatal on missing `HTTP_USER_AGENT`
- no fatal on missing `sodium`

## Why this file exists

This repo accumulated several small but necessary prototype fixes while moving Moodle from PGlite to SQLite-on-wasm. They are easy to lose track of when only looking at the final code. This file is the maintained checklist of those changes and should be updated when any of the bootstrap patches, Moodle core patches, or runtime assumptions change.
