# Architecture

## Runtime flow

```text
index.html
  → src/shell/main.js
     → remote.html
        → src/remote/main.js
           → sw.js
              → dist/php-worker.bundle.js
                 → src/runtime/php-loader.js
                 → src/runtime/php-compat.js
                 → src/runtime/bootstrap.js
```

## PHP runtime

The PHP runtime is provided by WordPress Playground's `@php-wasm/web` and `@php-wasm/universal` packages. The compatibility wrapper in `src/runtime/php-compat.js` maps the WP Playground API to the interface expected by the rest of the codebase.

The PHP WASM binary (available for versions 8.1 through 8.5, default 8.3) includes all required extensions built-in: `sqlite3`, `pdo_sqlite`, `dom`, `simplexml`, `xml`, `mbstring`, `openssl`, `intl`, `iconv`, `zlib`, `zip`, `phar`, `curl`, `gd`, `fileinfo`, `xmlreader`, `xmlwriter`.

!!! note
    `sodium` is **not** available in the WASM binary. The OpenSSL fallback patch handles all encryption needs.
    The runtime also downgrades Moodle's environment check for `sodium` so upgrades are not blocked.

## Storage model

The runtime is **fully ephemeral**. All mutable state lives in Emscripten's MEMFS (JavaScript heap memory). Nothing is persisted to OPFS, IndexedDB, or any other durable browser storage. Closing the tab destroys all state.

| Path | Type | Description |
|------|------|-------------|
| `/www/moodle` | MEMFS | Moodle core extracted from ZIP bundle into writable MEMFS |
| `/persist/moodledata` | MEMFS | Mutable data directory |
| `/persist/moodledata/moodle_*.sq3.php` | MEMFS | SQLite database file |
| `/persist/config` | MEMFS | Config and install markers |
| `/tmp/moodle` | MEMFS | Temp files and sessions |

The SQLite database uses in-memory-optimized pragmas: `journal_mode=MEMORY`, `synchronous=OFF`, `temp_store=MEMORY`, `cache_size=-8000`, `locking_mode=EXCLUSIVE`.

## Base path handling

The URL base path must be consistent across the entire stack for subpath deployments (e.g., GitHub Pages at `/moodle-playground`):

1. `esbuild.worker.mjs` injects `__APP_ROOT__`
2. `php-worker.js` passes it as `appRootUrl` → `bootstrapMoodle({ appBaseUrl })`
3. `bootstrap.js` builds `$CFG->wwwroot` from the app base URL
4. `php-loader.js` passes the absolute URL to `wrapPhpInstance()`
5. `php-compat.js` extracts the URL base path and prepends it to `SCRIPT_NAME`, `PHP_SELF`, `REQUEST_URI`

## Service worker

`sw.js` handles three responsibilities:

1. **Static hosting** — serves app files from the base path
2. **Scoped runtime routing** — routes `/playground/<scope>/<runtime>/...` requests to the PHP worker
3. **HTML rewriting** — rewrites Moodle-generated links and redirects for the correct subpath

## Install snapshot

A pre-built install snapshot (`assets/moodle/snapshot/install.sq3`) is generated at build time by `scripts/generate-install-snapshot.sh`. At runtime, `bootstrap.js` fetches this snapshot and writes it to MEMFS, then updates `wwwroot` in `mdl_config` to match the deployment URL. This eliminates the 3-8s CLI install phase.

## Moodle patches

Some patches are applied at build time (copied into the Moodle source before ZIP bundling), others at runtime (written into MEMFS at boot):

**Build-time patches**:

- `patches/shared/` — canonical shared patch root
- `patches/moodle/` — legacy fallback root used only if `patches/shared/` is absent
- `patches/<branch>/` — optional per-branch overrides copied relative to the source root

- `lib/dml/sqlite3_pdo_moodle_database.php` — restored deprecated SQLite PDO driver
- `lib/ddl/sqlite_sql_generator.php` — DDL generator for SQLite
- `lib/classes/encryption.php` — OpenSSL fallback (no sodium)

For shared patches, `patch-moodle-source.sh` detects whether the Moodle source tree uses
the legacy root layout or the newer `public/` layout and writes the files to the correct
destination automatically. Branch-specific overrides should mirror the actual source-root
path they target, including `public/` when needed.

**Runtime patches** (`bootstrap.js`):

- `cache/classes/config.php` — cache config suppression
- `lib/classes/component.php` — component compatibility
- `lib/adminlib.php` — admin settings guard
