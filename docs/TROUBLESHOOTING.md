# Troubleshooting

This file is the fast path for debugging the current Moodle-on-wasm SQLite prototype.

For the full migration history and rationale, see [`sqlite-wasm-migration-notes.md`](./sqlite-wasm-migration-notes.md).

## Quick checks

Runtime debug mode in the browser:

```text
http://localhost:8080/?debug=true
```

Use this first when debugging runtime/bootstrap issues. It forces Moodle
developer debug mode and enables PHP `display_errors` for the booted session.
Accepted values include `true`, `developer`, `normal`, `minimal`, and `0`.

Syntax:

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/php-loader.js
node --check src/remote/main.js
node --check lib/moodle-loader.js
php -l patches/shared/lib/dml/sqlite3_pdo_moodle_database.php
php -l patches/shared/lib/ddl/sqlite_sql_generator.php
php -l patches/shared/lib/classes/encryption.php
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
5. rerun with `?debug=true` if the page is hiding PHP/Moodle errors

The most useful files for runtime debugging are:

- `src/runtime/bootstrap.js`
- `src/remote/main.js`
- `sw.js`
- `src/runtime/php-compat.js`
- `lib/moodle-loader.js`

## Symptoms

### `TypeError: resolved is not a function`

Likely cause:

- malformed or unreadable `install.xml`
- a regression in the XML/runtime path outside the current common patch set

Notes:

- if this happens during schema load, inspect the `install.xml` file first and re-run the XMLDB load checks against the current unpatched Moodle sources

### Fatal in `sqlite_sql_generator`

Examples:

- signature mismatch with `sql_generator`
- missing `getCreateTempTableSQL`

Files:

- `patches/shared/lib/ddl/sqlite_sql_generator.php`

Notes:

- this is a Moodle-core compatibility problem, not a wasm routing problem

### Fatal in `sqlite3_pdo_moodle_database`

Examples:

- `is_temptable() on null`
- driver returns `false` when Moodle 5 expects `[]`
- deprecated `reset()` on object

Files:

- `patches/shared/lib/dml/sqlite3_pdo_moodle_database.php`
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

- the current WASM runtime does not ship `sodium`
- some Moodle paths still assume sodium-first encryption unless the local fallback patch is active

Files:

- `patches/shared/lib/classes/encryption.php`
- runtime override in `src/runtime/bootstrap.js`
- `src/runtime/config-template.js`
- `lib/config-template.js`

Current workaround:

- `rememberusername` is disabled by default
- `core\\encryption` falls back to OpenSSL in this prototype
- `admin/environment.xml` is downgraded at runtime so upgrades are not blocked by the missing extension

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
4. retry with `?debug=true` to surface hidden PHP/bootstrap errors

### Outbound HTTPS from PHP behaves differently depending on the target

Likely cause:

- `tcpOverFetch` is active, but not every HTTPS destination behaves the same
- the configured `phpCorsProxyUrl` fallback does work for the non-TLS path;
  `tests/e2e/php-networking.spec.mjs` covers an HTTP request that fails direct
  and succeeds through the configured proxy
- direct HTTPS now works for the real eXeLearning GitHub releases feed and the
  real tested release ZIP asset (`v4.0.0-beta3`)
- direct HTTPS now works for a CORS-open external URL such as
  `raw.githubusercontent.com`
- direct HTTPS to a self-signed local HTTPS server still fails before fallback;
  the browser-side fetch performed by the runtime does not trust that local
  certificate
- the same-origin proxy path is still available if a plugin wants a stable,
  explicit playground-only contract

What the tests currently prove:

- `tests/e2e/php-networking.spec.mjs`
  - same-origin proxy path works
  - configured `phpCorsProxyUrl` fallback works for HTTP requests
  - direct HTTPS works for a CORS-open external URL
  - direct HTTPS works for the eXeLearning GitHub feed
  - direct HTTPS works for the eXeLearning GitHub release ZIP asset
  - direct HTTPS to a self-signed local HTTPS server still fails
- `tests/runtime/tcp-over-fetch-certificates.test.js`
  - the generated CA parses as a CA in OpenSSL
  - a runtime-style leaf signed by that CA verifies in OpenSSL
  - the upstream ASN.1 encoder still mis-encodes explicit `keyUsage` and SAN IP
    extensions (`IP Address:<invalid>`, unexpected key usage), so the runtime
    must avoid those extensions until upstream is fixed

What is supported:

- direct PHP requests to trusted external HTTPS origins, including the tested
  CORS-open `raw.githubusercontent.com` URL
- direct PHP requests to the tested eXeLearning GitHub feed and release ZIP URLs
- `phpCorsProxyUrl` as the browser-side fallback for PHP networking
- `MOODLE_PLAYGROUND_PROXY_URL` as an explicit same-origin PHP networking
  endpoint when a plugin prefers a stable playground-only proxy contract
- the same-origin proxy endpoint is validated by
  `tests/e2e/php-networking.spec.mjs`

Files:

- `src/runtime/php-loader.js`
- `sw.js`
- `src/runtime/config-template.js`
- `tests/e2e/php-networking.spec.mjs`

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

This was caused by the bundle loader double-buffering (chunk buffers + full output buffer).
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
  `sqlite3`, `pdo_sqlite`, `phar`, `curl`, `gd`, `fileinfo`, `xmlreader`, `xmlwriter`

Note: `sodium` is not available in this runtime; the repository relies on the OpenSSL fallback
patches documented elsewhere. Also note that `curl` is available as an extension but actual
network requests from WASM are constrained (uses fetch-based transport, not real sockets). When
`playground.config.json` defines `phpCorsProxyUrl`, the runtime can use that proxy as the
browser-side fallback for outbound PHP HTTP(S) traffic through `@php-wasm/web` TCP-over-fetch.
This is separate from `addonProxyUrl`, which is used for browser-side ZIP/plugin downloads and
for the explicit same-origin Service Worker proxy endpoint. If outbound requests still fail,
verify the configured PHP CORS proxy supports general HTTP(S) proxying, not just ZIP downloads.
