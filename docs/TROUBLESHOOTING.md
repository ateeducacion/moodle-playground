# Troubleshooting

This file is the fast path for debugging the current Moodle-on-wasm SQLite prototype.

For the full migration history and rationale, see [`sqlite-wasm-migration-notes.md`](./sqlite-wasm-migration-notes.md).

## Quick checks

Syntax:

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/php-loader.js
node --check src/remote/main.js
node --check lib/moodle-loader.js
php -l patches/moodle/lib/dml/sqlite3_pdo_moodle_database.php
php -l patches/moodle/lib/ddl/sqlite_sql_generator.php
php -l patches/moodle/lib/classes/encryption.php
```

Bundle and runtime:

```bash
npm run build:worker
npm run bundle
```

## First place to look

If the browser is failing during install or first load, inspect these in order:

1. browser console
2. network requests for `/playground/main/php83-cgi/...`
3. shell progress log
4. `PHP Info` panel

The most useful files for runtime debugging are:

- `src/runtime/bootstrap.js`
- `src/remote/main.js`
- `sw.js`
- `src/runtime/php-compat.js`
- `lib/moodle-loader.js`

## Symptoms

### `TypeError: resolved is not a function`

Likely cause:

- old Moodle XML bootstrap path calling into a wasm-hostile XML callback path

Files:

- `patches/moodle/lib/xmlize.php`
- `patches/moodle/lib/xmldb/xmldb_file.php`

Notes:

- if this happens during schema load, check that the patched `xmldb_file.php` and `xmlize.php` are actually present in the built Moodle source

### Fatal in `sqlite_sql_generator`

Examples:

- signature mismatch with `sql_generator`
- missing `getCreateTempTableSQL`

Files:

- `patches/moodle/lib/ddl/sqlite_sql_generator.php`

Notes:

- this is a Moodle-core compatibility problem, not a wasm routing problem

### Fatal in `sqlite3_pdo_moodle_database`

Examples:

- `is_temptable() on null`
- driver returns `false` when Moodle 5 expects `[]`
- deprecated `reset()` on object

Files:

- `patches/moodle/lib/dml/sqlite3_pdo_moodle_database.php`
- runtime override in `src/runtime/bootstrap.js`

### `Invalid cache store in config` warnings everywhere

Likely cause:

- Moodle cache config paths still execute even though cache is intentionally disabled for the prototype

Files:

- `src/runtime/config-template.js`
- `lib/config-template.js`
- runtime override in `src/runtime/bootstrap.js`

Notes:

- these warnings are suppressed at runtime when `CACHE_DISABLE_ALL` is active
- if they become fatal again, inspect `cache/classes/config.php` and `cache/classes/cache.php`

### `Undefined constant "core\\SODIUM_CRYPTO_SECRETBOX_NONCEBYTES"`

Likely cause:

- `sodium` is now available via `@php-wasm/web` but this error may still appear if the runtime fails to load

Files:

- `patches/moodle/lib/classes/encryption.php`
- runtime override in `src/runtime/bootstrap.js`
- `src/runtime/config-template.js`
- `lib/config-template.js`

Current workaround:

- `rememberusername` is disabled by default
- `core\\encryption` falls back to OpenSSL in this prototype

### `Undefined array key "HTTP_USER_AGENT"`

Likely cause:

- PHP request handler did not expose request headers as standard `HTTP_*` variables

File:

- `src/runtime/php-compat.js`

### `No input file specified.` for `styles_debug.php`, `javascript.php`, `yui_combo.php`

Likely cause:

- scoped URL/request rewriting mismatch between the Service Worker and PHP request handler

Files:

- `sw.js`
- `src/runtime/php-compat.js`
- `src/runtime/php-loader.js`

What to inspect:

- request URL seen by the Service Worker
- forwarded request URL sent to the php worker
- computed `SCRIPT_NAME` and `SCRIPT_FILENAME` in the PHP request handler

### `ERR_TOO_MANY_REDIRECTS` or "Incorrect access detected"

Likely cause:

- `$CFG->wwwroot` built from the wrong base URL
- or scoped redirects losing query parameters

Files:

- `src/runtime/bootstrap.js`
- `php-worker.js`
- `sw.js`
- `src/shared/storage.js`

### `Timed out while waiting for php-worker readiness`

Likely cause:

- bootstrap JS error before `worker-ready`
- stale service worker / stale scope
- bundle load failure

Files:

- `php-worker.js`
- `src/remote/main.js`
- `src/runtime/bootstrap.js`

Immediate actions:

1. hard reload
2. `Reset`
3. check shell log for the last bootstrap step reached

### `PHP worker bridge timed out`

Likely cause:

- the worker is alive but the request handler is blocked
- often follows a fatal in PHP or a very slow/stuck bootstrap

Files:

- `php-worker.js`
- `src/remote/main.js`
- `src/runtime/bootstrap.js`

### White iframe, but URL/title inside Moodle are correct — resolved

This was previously the most visible browser-side issue but has been resolved.
The recovery watchdog in `src/remote/main.js` is still present as a safety net.

If this symptom reappears after changes to routing or bootstrap:

- `src/remote/main.js` — inspect `isFrameDocumentStalled()`, `scheduleFrameRecovery()`
- `sw.js` — check HTML response rewriting
- `src/runtime/php-compat.js` — check `$_SERVER` variable construction

### `RangeError: Array buffer allocation failed` — resolved

This was caused by the VFS loader double-buffering (chunk buffers + full output buffer).
Fixed by preallocating a single destination buffer when `content-length` is known.

If this reappears after changes to the loader, inspect `lib/moodle-loader.js`.

### Warnings like `Undefined property: stdClass::$frontpage`

Likely cause:

- bootstrap path skipped normal config hydration
- missing defaults in generated `config.php` or persisted `config` table

Files:

- `src/runtime/config-template.js`
- `lib/config-template.js`
- `src/runtime/bootstrap.js`

Defaults currently seeded:

- `navcourselimit`
- `enablecompletion`
- `frontpage`
- `frontpageloggedin`
- `frontpagecourselimit`
- `guestloginbutton`
- `rememberusername`
- `auth_instructions`
- `maintenance_enabled`
- `maxbytes`

## If install fails mid-way

Inspect the staged bootstrap messages from `src/runtime/bootstrap.js`:

- `core:start`
- `core:schema-load:start`
- `core:schema-load:done`
- `core:schema-sql:count=...`
- `plugins:start`
- `finalize:start`
- `themes:start`

If failure happens:

- before `core:schema-load:done`
  - inspect XMLDB patches
- during schema SQL execution
  - inspect SQLite DDL generator / DML driver
- during `finalize`
  - inspect config hydration and brittle plugin settings files
- after install, on first real navigation
  - inspect `wwwroot`, redirects, asset URLs, CGI env, and iframe recovery

## Extension reality in this repo

The `@php-wasm/web` PHP 8.3 runtime includes all required extensions built into the WASM binary:

- `dom`, `iconv`, `intl`, `libxml`, `simplexml`, `xml`, `zip`, `mbstring`, `openssl`,
  `sqlite3`, `pdo_sqlite`, `phar`, `curl`, `gd`, `fileinfo`, `sodium`, `xmlreader`, `xmlwriter`

Note: `curl` is available as an extension but actual network requests from WASM are constrained
(uses fetch-based transport, not real sockets). Moodle features depending on outbound HTTP may
still not work fully.
