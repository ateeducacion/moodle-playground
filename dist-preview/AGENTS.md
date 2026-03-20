<!--
MAINTENANCE: Update this file when:
- Adding/removing npm scripts in package.json or targets in Makefile
- Changing the runtime flow (shell, remote host, service worker, php worker)
- Modifying the Moodle bundle format, manifest schema, or storage model
- Changing deployment assumptions for GitHub Pages or other static hosting
- Adding new conventions for blueprints, extensions, or persistent state
-->

# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

Moodle Playground runs a Moodle site entirely in the browser using WebAssembly.
It follows the same product shape as `omeka-s-playground`:

1. Shell UI: `index.html` and `src/shell/main.js`
2. Runtime host: `remote.html` and `src/remote/main.js`
3. Request routing: `sw.js` and `php-worker.js`
4. PHP/Moodle runtime: `src/runtime/*` + generated assets under `assets/moodle/`

The readonly Moodle core is loaded from a prebuilt VFS bundle while mutable state lives
in Emscripten MEMFS (in-memory). The runtime is fully ephemeral — all state is lost when
the browser tab closes or the page is reloaded.

## Build System

This project uses npm, esbuild, and a small Makefile workflow.

### Requirements

- Node.js 18+
- npm
- Python 3
- Git
- PHP 8.3 with `pdo_sqlite` for `make up-local`

### Common Commands

```bash
npm install
npm run build:worker
npm run bundle

make prepare
make prepare-dev
make prepare-dev-pretty
make prepare-all
make bundle
make bundle-all
make bundle-all-pretty
make serve
make up
make up-local
```

`make up-local` starts a native `php -S` Moodle using the patched checkout in
`.cache/moodle/<branch>`. It respects `BRANCH=...` and isolates local SQLite state per branch
under `.cache/local/<branch>/`, so switching between `MOODLE_500_STABLE` and `main` does not
reuse the same database or `moodledata`. For `main`, the script serves the `public/` docroot
automatically.

### Generated Assets

- `assets/moodle/`: readonly runtime bundle files (`.vfs.bin`, index, optional zip)
- `assets/moodle/snapshot/`: pre-built install snapshot (`install.sq3`)
- `assets/manifests/`: generated bundle manifests
- `dist/`: esbuild output (php-worker bundle, WASM files, ICU data)

Do not hand-edit generated bundle artifacts unless the task is specifically about the build output.

### Worker Bundling

The PHP worker (`php-worker.js`) is bundled with esbuild into `dist/php-worker.bundle.js`.
This bundles all runtime dependencies (`@php-wasm/web`, `@php-wasm/universal`, shared modules)
into a single ESM file that can be loaded as a Web Worker. WASM and ICU data files are
copied to `dist/` with content hashes and loaded at runtime.

Run `npm run build:worker` (or `make build-worker`) to rebuild after changes.

## Architecture

### Runtime Flow

```text
index.html
  -> src/shell/main.js
     -> remote.html
        -> src/remote/main.js
           -> sw.js
              -> dist/php-worker.bundle.js
                 -> src/runtime/php-loader.js (@php-wasm/web)
                 -> src/runtime/php-compat.js (compatibility layer)
                 -> src/runtime/bootstrap.js
```

### PHP Runtime

The PHP runtime is provided by WordPress Playground's `@php-wasm/web` and `@php-wasm/universal`
packages. These replace the previous `seanmorris/php-wasm` vendored dependencies.

Key files:

- `src/runtime/php-loader.js` — Creates PHP instances via `loadWebRuntime()` and `new PHP()`
- `src/runtime/php-compat.js` — Compatibility wrapper that maps the WP Playground API to the
  interface expected by bootstrap.js and php-worker.js (request/response conversion,
  analyzePath emulation, Emscripten module access)

The PHP 8.3 WASM binary from `@php-wasm/web` includes all extensions built-in:
`sqlite3`, `pdo_sqlite`, `dom`, `simplexml`, `xml`, `mbstring`, `openssl`, `intl`,
`iconv`, `zlib`, `zip`, `phar`, `curl`, `gd`, `fileinfo`, `xmlreader`, `xmlwriter`.

**Note:** `sodium` is NOT available in the WASM binary despite what earlier documentation
claimed. The OpenSSL fallback patch in `patches/shared/lib/classes/encryption.php` handles
all encryption needs.

### Responsibilities

- `index.html` / `src/shell/main.js`
  - Toolbar, URL bar, iframe host, blueprint import, runtime logs
- `remote.html` / `src/remote/main.js`
  - Registers the service worker and hosts the scoped playground iframe
- `sw.js`
  - Intercepts same-origin requests
  - Maps static vs scoped/runtime requests
  - Rewrites redirects and HTML links for GitHub Pages subpaths
- `php-worker.js` (bundled into `dist/php-worker.bundle.js`)
  - Owns the PHP runtime instance for a scope
  - Boots Moodle and serves HTTP requests through the bridge
- `src/runtime/bootstrap.js`
  - Prepares storage
  - Mounts the readonly Moodle bundle
  - Writes `config.php`
  - Loads a pre-built install snapshot (or falls back to full CLI install)

## Storage Model

The runtime is **fully ephemeral**. All mutable state lives in Emscripten's MEMFS
(JavaScript heap memory). Nothing is persisted to OPFS, IndexedDB, or any other
durable browser storage during normal operation. Closing the tab destroys all state.

Current layout:

- Readonly core: custom VFS mount under `/www/moodle` (from prebuilt `.vfs.bin` image)
- Mutable data: `/persist/moodledata` (MEMFS — the `/persist` name is legacy, not durable)
- SQLite database: `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php` (MEMFS file)
- Config and install markers: `/persist/config` (MEMFS)
- Temp files and sessions: `/tmp/moodle` (MEMFS)

The `syncFs` parameter in `php-compat.js` is set to `null` — no filesystem sync callback
is registered. The `resetOpfsStorage()` function in `remote.html` exists only for cleanup
of legacy data from earlier versions that did use OPFS.

**Why not `:memory:` SQLite?** Each `php.run()` call resets PHP state and closes all PDO
connections. A `:memory:` database would be empty on the next request. The MEMFS file
approach is functionally equivalent to in-memory (the file exists only in the JS heap)
but persists across PHP script executions within the same worker session.

Avoid reintroducing boot-time file-by-file copies of the full Moodle core into persistent storage.
Do not add OPFS, IndexedDB, or other persistence layers unless explicitly required.

## Patch Layout

Build-time Moodle patches use a layered layout:

- `patches/shared/` — canonical shared patch root
- `patches/moodle/` — legacy fallback if `patches/shared/` is absent
- `patches/<branch>/` — optional branch-specific overrides

Shared patches are branch-agnostic and target `lib/...` paths. `scripts/patch-moodle-source.sh`
detects the Moodle source layout and adds the `public/` prefix automatically for 5.1+ trees.

Branch-specific patches are copied literally relative to the Moodle source root:

- use `patches/MOODLE_500_STABLE/lib/...` for legacy-root branches
- use `patches/main/public/lib/...` for `public/` branches

Do not put branch overrides under `patches/<branch>/moodle/...`; the script does not treat
`moodle/` specially and would copy that path literally into the source tree.

## SQLite Prototype Invariants

This repo is no longer using the old active PGlite database path for the main runtime.

Current database assumptions:

- Moodle runs against the deprecated SQLite PDO driver
- The SQLite database file lives in MEMFS (pure memory, no durable storage)
- The DB file path is `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`
- The readonly Moodle core lives under `/www/moodle` (custom VFS mount)
- `config.php` is generated at boot and points at the MEMFS database file
- SQLite pragmas are tuned for in-memory operation: `journal_mode=MEMORY`,
  `synchronous=OFF`, `temp_store=MEMORY`, `cache_size=-8000`, `locking_mode=EXCLUSIVE`
- A pre-built install snapshot (`assets/moodle/snapshot/install.sq3`) is generated at
  build time by `scripts/generate-install-snapshot.sh`. At runtime, `bootstrap.js` fetches
  this snapshot and writes it directly into MEMFS, then updates `wwwroot` in `mdl_config`
  to match the current deployment URL. This eliminates the 3-8s CLI install phase. If the
  snapshot is unavailable, the full CLI install runs as a fallback.

When touching the migration/runtime path, preserve these invariants:

1. Do not reintroduce PGlite as the active DB path
2. Do not move the DB out of the writable MEMFS filesystem
3. Do not turn the readonly core mount back into a full persistent copy of Moodle
4. Keep `$CFG->wwwroot` based on the real app base URL, not the scoped runtime path
5. Keep the default scope stable unless there is a deliberate migration plan
6. Do not add OPFS/IndexedDB persistence for the database — the runtime is ephemeral by design
7. CACHE_DISABLE_ALL is false (MUC enabled). Cache store plugin defaults are seeded in
   the install snapshot, config normalizer, and install runner to prevent admin redirect loops

Important files for this prototype:

- `src/runtime/config-template.js`
- `lib/config-template.js`
- `src/runtime/bootstrap.js`
- `src/runtime/php-loader.js`
- `src/runtime/php-compat.js`
- `sw.js`
- `src/remote/main.js`
- `lib/moodle-loader.js`
- `scripts/patch-moodle-source.sh`
- `scripts/generate-install-snapshot.sh`
- `patches/shared/lib/dml/sqlite3_pdo_moodle_database.php`
- `patches/shared/lib/ddl/sqlite_sql_generator.php`
- `patches/shared/lib/classes/encryption.php`

Prototype-specific defaults currently matter during first boot:

- `rememberusername` is intentionally disabled by default
- several Moodle config values are seeded manually during bootstrap
- `sodium` is NOT available in the WASM binary; the OpenSSL fallback patch handles encryption
- Debug defaults to disabled (`$CFG->debug = 0`) but is configurable via blueprint `runtime.debug`
  (0=NONE, 5=MINIMAL, 15=NORMAL, 32767=DEVELOPER) and `runtime.debugdisplay` (0 or 1),
  or via the Settings dialog in the playground UI
- `CACHE_DISABLE_ALL = false` (MUC enabled — cache store defaults are seeded at build and boot time)
- JS, template, and language string caches are enabled for navigation performance
- PHP `display_errors` is off by default; configurable via `runtime.debugdisplay` in blueprint

If you change any of the above behavior, update:

- `docs/sqlite-wasm-migration-notes.md`
- `docs/TROUBLESHOOTING.md`
- `docs/KNOWN-ISSUES.md`

## GitHub Pages and Base Path Handling

This project is expected to run under a subpath such as `/moodle-playground`.

When modifying `sw.js`, preserve all three behaviors:

1. App base path handling for static hosting in a subdirectory
2. Scoped runtime routing under `/playground/<scope>/<runtime>/...`
3. HTML response rewriting for Moodle-generated links and forms

Moodle, like Omeka, may emit HTML-escaped URLs. If navigation works on first load but breaks after clicking inside the site, inspect the HTML response body first.

### Base path propagation chain

The URL base path must be consistent across the entire stack:

1. `esbuild.worker.mjs` injects `__APP_ROOT__` = `new URL("../", import.meta.url).href`
2. `php-worker.js` passes it as `appRootUrl` → `bootstrapMoodle({ appBaseUrl })` and
   `createPhpRuntime(runtime, { appBaseUrl })`
3. `bootstrap.js`: `buildPublicBase(appBaseUrl)` → `$CFG->wwwroot` in `config.php`
4. `php-loader.js`: `absoluteUrl = appBaseUrl` → passed to `wrapPhpInstance()`
5. `php-compat.js`: extracts `urlBasePath` from `absoluteUrl.pathname` → prepended to
   `SCRIPT_NAME`, `PHP_SELF`, `REQUEST_URI` in `$_SERVER`

If any link in this chain is broken, redirects on subpath deployments will loop.

## Extensions

The `@php-wasm/web` PHP 8.3 runtime includes all required PHP extensions built into the
WASM binary. No separate shared library loading or vendor directories are needed.

Available extensions include: `sqlite3`, `pdo_sqlite`, `dom`, `simplexml`, `xml`,
`mbstring`, `openssl`, `intl`, `iconv`, `zlib`, `zip`, `phar`, `curl`, `gd`,
`fileinfo`, `sodium`, `xmlreader`, `xmlwriter`.

## Fragile Areas

These areas have repeatedly caused regressions during the SQLite migration:

- **php.ini configuration**
  - WP Playground hardcodes `/internal/shared/php.ini` via `PHP_INI_PATH` in `@php-wasm/universal`
  - Writing a separate php.ini file (e.g., `/www/php.ini`) has NO effect — PHP never reads it
  - All php.ini settings must be applied via `setPhpIniEntries()` from `@php-wasm/universal`
  - Settings are applied in `src/runtime/php-loader.js` during runtime creation
  - Blueprint timezone overrides are applied in `src/runtime/bootstrap.js` after provisioning
- `sw.js`
  - query strings must survive scoped redirects
  - HTML rewriting must keep Moodle links/forms inside the scoped runtime
- `src/runtime/php-compat.js`
  - CGI environment variables such as `HTTP_USER_AGENT`, `SCRIPT_NAME`, and `SCRIPT_FILENAME` are critical
  - The Request-to-PHPRequest conversion must preserve headers, method, and body
  - The PHPResponse-to-Response conversion must preserve status codes and headers
  - **PATH_INFO handling**: URLs like `/theme/styles.php/boost/123/all` contain PATH_INFO
    after the `.php` segment. `resolveScriptPath()` splits these into the actual script path
    and the PATH_INFO component. Without this, `isPhpScript()` fails (the URL doesn't end
    in `.php`) and those requests return 404, breaking CSS/JS delivery.
  - **URL base path in `$_SERVER`**: `SCRIPT_NAME`, `PHP_SELF`, and `REQUEST_URI` must include
    the URL base path (e.g., `/moodle-playground` on GitHub Pages). Moodle's
    `setup_get_remote_url()` in `lib/setuplib.php` constructs `$FULLME`/`$FULLSCRIPT` by
    extracting **only the scheme+host** from `$CFG->wwwroot` and combining it with
    `$_SERVER['SCRIPT_NAME']`. If SCRIPT_NAME lacks the base path, all redirect URLs lose
    the subpath, causing infinite redirect loops on subpath deployments.
- `src/remote/main.js`
  - historically, the nested iframe could stall with a valid URL/title but an empty body
    (this is now resolved; the watchdog recovery code remains as a safety net)
- `lib/moodle-loader.js`
  - historically, large VFS downloads could trigger memory pressure due to double-buffer
    allocation (this is now resolved; the loader preallocates a single destination buffer)
- `src/runtime/bootstrap.js`
  - many install-time compatibility shims live here and are easy to break accidentally
  - **Post-install defaults** (`$postinstalldefaults` array): When a new settings file gets
    loaded during install (e.g., via the hardcoded list in the adminlib.php patch), any
    setting that has a dynamic default (computed from `$CFG->wwwroot` or similar) won't have
    a stored value. `any_new_admin_settings()` returns true, and `admin/index.php` redirects
    to `upgradesettings.php`. Fix: add the missing setting with a safe static default to the
    `$postinstalldefaults` array. Known examples: `noreplyaddress`, `supportemail`.
  - **Runtime patches vs `patches/` directory**: Patches applied via the `patches/` directory
    (copied at VFS build time) should NOT also be applied at runtime via `patchFile()` in
    `patchRuntimePhpSources()`. Duplicate patches fail silently but add noise. Only use
    runtime `patchFile()` for files that are in the readonly VFS and need modification at
    boot (e.g., `cache/classes/config.php`, `lib/classes/component.php`, `lib/adminlib.php`).

If a change touches any of these files, prefer validating in a real browser, not only with syntax checks.

## Moodle URL Construction Internals

Understanding how Moodle constructs URLs is critical for this project because we control
the `$_SERVER` variables that Moodle reads.

**Key mechanism** (`lib/setuplib.php`, `setup_get_remote_url()`):
- `$hostandport` = scheme + host extracted from `$CFG->wwwroot` (path is IGNORED)
- `$FULLSCRIPT` = `$hostandport` + `$_SERVER['SCRIPT_NAME']`
- `$FULLME` = `$hostandport` + `$_SERVER['REQUEST_URI']`

This means `$_SERVER['SCRIPT_NAME']` must carry the full URL path including any subpath
prefix (e.g., `/moodle-playground/admin/index.php`, not just `/admin/index.php`).

**Where URLs flow through the system**:
1. Browser requests `/moodle-playground/playground/main/php83-cgi/admin/index.php`
2. `sw.js` strips the scoped prefix → requestPath = `/admin/index.php`
3. `php-compat.js` receives the stripped path and must re-add the URL base path to `$_SERVER`
4. PHP generates redirect Location headers using `$FULLME` or `$CFG->wwwroot` + path
5. `sw.js` rewrites Location headers to add the scoped prefix back

On localhost (`http://localhost:8080`), the URL base path is empty, so this is invisible.
On GitHub Pages (`https://host/moodle-playground`), the base path is `/moodle-playground`.

## Blueprints

Blueprints are step-based JSON files that describe the desired state of a playground
instance. The format is inspired by WordPress Playground Blueprints with Moodle-native
naming and semantics.

Core modules live in `src/blueprint/`:

- `index.js` — public re-exports
- `parser.js` — parse JSON / base64 / data-URL / object inputs
- `schema.js` — hand-written validator (~120 lines, no library)
- `constants.js` — `{{KEY}}` substitution in string values
- `resources.js` — `ResourceRegistry` for url/base64/bundled/vfs/literal resources
- `resolver.js` — blueprint source resolution (`?blueprint=`, `?blueprint-url=`, sessionStorage, default)
- `storage.js` — sessionStorage save/load/clear
- `executor.js` — sequential step runner with progress

Step handlers in `src/blueprint/steps/`:

- `filesystem.js` — mkdir, rmdir, writeFile, writeFiles, copyFile, moveFile, unzip
- `request.js` — request, runPhpCode, runPhpScript
- `moodle-install.js` — installMoodle (declarative marker), setAdminAccount, login
- `moodle-config.js` — setConfig, setConfigs, setLandingPage
- `moodle-users.js` — createUser, createUsers
- `moodle-categories.js` — createCategory, createCategories
- `moodle-courses.js` — createCourse, createCourses, createSection, createSections
- `moodle-enrol.js` — enrolUser, enrolUsers
- `moodle-modules.js` — addModule (label, folder, assign, etc.)
- `moodle-plugins.js` — installMoodlePlugin, installTheme (downloads ZIP, extracts, runs upgrade)

PHP code generators in `src/blueprint/php/helpers.js`.

Assets:

- `assets/blueprints/default.blueprint.json` — default step-based blueprint
- `assets/blueprints/blueprint-schema.json` — JSON Schema for IDE autocompletion
- `assets/blueprints/examples/` — example blueprints

Tests:

- `tests/blueprint/*.test.js` — run with `npm run test:blueprint`

Key design decisions:

- `installMoodle` is a declarative marker — the actual install runs in `bootstrap.js`
- Provisioning steps use `php.run()` with `CLI_SCRIPT` mode (except `login` which uses HTTP)
- Plural steps (e.g., `createUsers`) execute all entities in a single PHP script
- No external dependencies for validation; `fflate` (existing dep) used for unzip
- Blueprint step execution runs between config normalization (0.918) and auto-login (0.95) in `bootstrap.js`

When changing blueprint semantics, update the schema, step handlers, docs, and tests.

## Testing, Linting, and Formatting

### Quick reference

```bash
make test      # Run all unit tests (186 tests across 45 suites)
make lint      # Run Biome linter on src/, tests/, scripts/
make format    # Auto-fix lint and formatting issues
npm run test:e2e  # Run Playwright browser validation (requires built static output)
```

These are also available as npm scripts:

```bash
npm test                  # All tests
npm run test:blueprint    # Blueprint tests only
npm run test:e2e          # Playwright browser validation
```

### Test suites

Tests live in `tests/` and run with Node.js built-in `node:test` (no framework).

#### Blueprint (`tests/blueprint/`)

| File | What it tests |
|------|---------------|
| `parser.test.js` | JSON, base64, data-URL, object parsing |
| `schema.test.js` | Blueprint validation (steps, resources, constants, landingPage) |
| `constants.test.js` | `{{KEY}}` substitution in strings, objects, arrays |
| `resources.test.js` | ResourceRegistry: literal, base64, data-url, @name references |
| `executor.test.js` | Step execution order, failure handling, progress, constants |
| `resolver.test.js` | Blueprint source resolution (inline, base64, data-URL) |
| `steps.test.js` | Step registry: all 30 steps registered, handler dispatch |
| `install-config.test.js` | `buildInstallConfig()` merging from installMoodle step and top-level fields |
| `php-helpers.test.js` | PHP code generation: CLI header, escaping, Moodle API calls, batch operations |

#### Version resolver (`tests/shared/`)

| File | What it tests |
|------|---------------|
| `version-resolver.test.js` | Branch metadata, PHP/Moodle compatibility matrix, version resolution, runtimeId parsing/building, query param parsing, manifest URL building, data integrity |
| `protocol.test.js` | BroadcastChannel naming, snapshot version constant |
| `paths.test.js` | `joinBasePath()` path concatenation and deduplication |
| `storage.test.js` | `buildScopeKey()` storage key construction |

#### Runtime (`tests/runtime/`)

| File | What it tests |
|------|---------------|
| `config-template.test.js` | `config.php` generation (dbtype, wwwroot, escaping, CACHE_DISABLE_ALL, autoloader), php.ini entries (timezone, limits, session paths) |
| `php-compat.test.js` | `resolveScriptPath()` (PATH_INFO splitting, directory→index.php), `isPhpScript()`, `getMimeType()` for all supported extensions |
| `manifest.test.js` | `buildManifestState()` extraction, fallback manifest URL building |

#### Service Worker (`tests/sw/`)

| File | What it tests |
|------|---------------|
| `sw-helpers.test.js` | HTML entity decoding (`&amp;`, `&#x2F;`, `&colon;`, Moodle URLs), scoped runtime path extraction (scope/runtime/path parsing, subpath deployments) |

#### Browser validation (`tests/e2e/`)

| File | What it tests |
|------|---------------|
| `app-load.spec.js` | Playwright validation that the built app shell boots, the remote host overlay clears, and the nested Moodle login form renders in Chromium and Firefox |

### Linting and formatting

The project uses [Biome](https://biomejs.dev/) for linting and formatting. Configuration is in `biome.json`.

- **Scope**: `src/**`, `tests/**`, `scripts/**`
- **Formatter**: 2-space indent, auto organize imports
- **Linter**: Recommended rules, with `noDescendingSpecificity` and `noDuplicateProperties` disabled

`make lint` runs in CI on every push to `main` and on pull requests.

### Syntax checks

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/php-loader.js
node --check src/runtime/php-compat.js
node --check src/shell/main.js
node --check src/remote/main.js
node --check src/blueprint/index.js
```

### CI

The `.github/workflows/ci.yml` workflow runs on push to `main` and on pull requests:

1. Install dependencies
2. Syntax check all runtime files
3. `make test` (81 unit tests)
4. `make lint` (Biome)

Deployment workflows add a Playwright validation stage before publishing:

1. Build the static artifact (`dist-pages/` or `dist-preview/`)
2. Serve the built output with `http-server`
3. Validate the shell, runtime host, and nested Moodle login screen in Chromium and Firefox
4. Upload Playwright screenshots, traces, DOM dumps, console logs, request failures, and static-server logs
5. Continue to deploy only if both browser runs succeed

### Manual validation areas

- First boot install path (every page load is a fresh install)
- Navigation inside Moodle (caching should make second page loads faster)
- GitHub Pages subpath behavior
- Service worker updates after redeploy
- Cache file creation in `/persist/moodledata/cache` (verify Moodle cache system initializes)

If a change touches routing or HTML rewriting, prefer checking real browser behavior, not only syntax.
