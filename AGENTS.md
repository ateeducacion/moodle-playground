<!--
MAINTENANCE: Update this file when:
- Adding/removing npm scripts in package.json or targets in Makefile
- Changing the runtime flow (shell, remote host, service worker, php worker)
- Modifying the Moodle bundle format, manifest schema, or storage model
- Changing deployment assumptions for GitHub Pages or other static hosting
- Adding new conventions for blueprints, extensions, or persistent state
- Updating upstream project references (WordPress Playground, Omeka S Playground)
- Adding or removing agent skills under .agents/skills/
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

The Moodle core is extracted from a prebuilt ZIP bundle into Emscripten MEMFS (in-memory)
at boot. All files — core and mutable state — live in writable MEMFS. The runtime is fully
ephemeral — all state is lost when the browser tab closes or the page is reloaded.

## Related Projects and Upstream References

This project builds on WordPress Playground (`@php-wasm/*`) for the PHP WASM runtime and
Omeka S Playground for the shell/remote/sw/worker architecture pattern. Before inventing a
solution, check if either upstream already solved the same problem.

For full details: @.agents/references/upstream-projects.md

## Specialist Agent Skills

This project includes domain-expert agent skills under `.agents/skills/`. Each skill
provides deep context for a specific area of the codebase. Activate the appropriate
skill when working in its domain — the skill file contains API references, checklists,
known pitfalls, and conventions that are not repeated elsewhere in this document.

| Skill | Directory | When to use |
|-------|-----------|-------------|
| **Moodle Internals** | `@.agents/skills/moodle-internals/SKILL.md` | Moodle APIs, plugin system, database schema, install/upgrade lifecycle, config settings, course structure, user management, enrollment, MUC caching, SQLite compatibility, patch layout, bootstrap fragile areas |
| **WP Playground & php-wasm** | `@.agents/skills/wp-playground-php-wasm/SKILL.md` | `@php-wasm/web` and `@php-wasm/universal` APIs, PHP instance lifecycle, `php.run()` execution model, filesystem operations, `setPhpIniEntries()`, request/response conversion, `php-compat.js` adapter, outbound PHP networking, php.ini configuration |
| **WASM & Browser Runtime** | `@.agents/skills/wasm-browser-runtime/SKILL.md` | WASM crashes and memory limits, Emscripten MEMFS, service worker routing and caching, Web Worker communication, crash recovery, GitHub Pages subpath deployment, browser storage constraints, Firefox SW bundling |
| **Blueprint Provisioning** | `@.agents/skills/blueprint-provisioning/SKILL.md` | Blueprint JSON format, step handlers, executor engine, resource resolution, PHP code generation, plugin/theme installation, constant substitution, adding new step types |
| **Unit Testing** | `@.agents/skills/unit-testing/SKILL.md` | Writing and reviewing unit tests with `node:test`, mocking `php.run()` and MEMFS, testing PHP code generators, service worker helpers, runtime utilities, test organization conventions |
| **E2E Testing (Playwright)** | `@.agents/skills/e2e-playwright/SKILL.md` | Browser-based end-to-end tests with Playwright, WASM boot waiting strategies, iframe navigation, blueprint execution verification, shell UI interaction, debugging flaky tests |

### Additional references

| Reference | Location | Content |
|-----------|----------|---------|
| **Testing & CI/CD** | `@.agents/references/testing-and-ci.md` | Test suite inventories, CI/CD pipeline, Biome linting, Firefox compatibility, manual validation |
| **Upstream Projects** | `@.agents/references/upstream-projects.md` | WordPress Playground and Omeka S Playground details, when to consult each |

### Skill activation guidelines

1. **Read the skill file** when entering its domain — it contains the authoritative
   reference for conventions and known issues in that area.
2. **Cross-reference skills** when a change spans domains. For example, adding a new
   blueprint step that installs a plugin touches both `blueprint-provisioning` and
   `moodle-internals` (plugin type system, upgrade lifecycle).
3. **Follow the checklists** at the end of each skill file before submitting changes.
4. **Do not duplicate** skill content in this file — AGENTS.md provides the architectural
   overview; skills provide the deep domain knowledge.

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

- `assets/moodle/`: runtime bundle files (`.zip`, snapshot, manifests)
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
packages. Key files:

- `src/runtime/php-loader.js` — Creates PHP instances via `loadWebRuntime()` and `new PHP()`
- `src/runtime/php-compat.js` — Compatibility wrapper (request/response conversion,
  analyzePath emulation, Emscripten module access)

The PHP 8.3 WASM binary includes all extensions built-in:
`sqlite3`, `pdo_sqlite`, `dom`, `simplexml`, `xml`, `mbstring`, `openssl`, `intl`,
`iconv`, `zlib`, `zip`, `phar`, `curl`, `gd`, `fileinfo`, `xmlreader`, `xmlwriter`.

**Note:** `sodium` is NOT available in the WASM binary. The OpenSSL fallback patch in
`patches/shared/lib/classes/encryption.php` handles all encryption needs.

### Outbound HTTPS From PHP

Uses WordPress Playground's `tcpOverFetch` bridge. For full details see the
WP Playground & php-wasm skill. Key constraints unique to this repo:

- The generated CA must avoid explicit `keyUsage`, `nsCertType`, and SAN IP extensions
  (upstream ASN.1 encoder mis-encodes them — PR #1926-style CA profile).
- `addonProxyUrl` is for browser-side ZIP downloads. `phpCorsProxyUrl` is for runtime PHP
  networking fallback. Do not conflate the two.
- After any change in `src/runtime/php-loader.js`, `php-worker.js`, or other worker imports,
  run `npm run build:worker`.

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
  - Extracts the Moodle ZIP bundle into writable MEMFS
  - Writes `config.php` and runtime helper scripts
  - Applies runtime patches to Moodle PHP sources
  - Loads a pre-built install snapshot (or falls back to full CLI install)
  - Executes blueprint steps (courses, users, plugins, etc.)
- `src/runtime/crash-recovery.js`
  - Detects fatal WASM errors (OOM, file descriptor exhaustion)
  - Snapshots the DB, plugin files, and user uploads before runtime destruction
  - Restores state onto a fresh runtime after crash
  - Replays safe (GET/HEAD) requests automatically

## Storage Model

The runtime is **fully ephemeral**. All mutable state lives in Emscripten's MEMFS
(JavaScript heap memory). Nothing is persisted to OPFS, IndexedDB, or any other
durable browser storage during normal operation. Closing the tab destroys all state.

Current layout:

- Moodle core: extracted from ZIP bundle into `/www/moodle` (writable MEMFS)
- Mutable data: `/persist/moodledata` (MEMFS — the `/persist` name is legacy, not durable)
- SQLite database: `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php` (MEMFS file)
- Config and install markers: `/persist/config` (MEMFS)
- Temp files and sessions: `/tmp/moodle` (MEMFS)

**Why not `:memory:` SQLite?** Each `php.run()` call resets PHP state and closes all PDO
connections. A `:memory:` database would be empty on the next request. The MEMFS file
persists across PHP script executions within the same worker session.

Avoid reintroducing boot-time file-by-file copies of the full Moodle core into persistent storage.
Do not add OPFS, IndexedDB, or other persistence layers unless explicitly required.

## Crash Recovery (PHP Runtime Restart)

The PHP WASM runtime can crash mid-session due to resource exhaustion. For full recovery
flow details, see the WASM & Browser Runtime skill. Key files:

- `src/runtime/crash-recovery.js` — `isFatalWasmError()`, `createSnapshotManager()`
- `php-worker.js` — `resetRuntime()`, `reRegisterPluginsAfterRestore()`

Anti-loop guards: max 20 restarts/session, min 10 requests before restart, no POST replay.

## SQLite Prototype Invariants

Current database assumptions:

- Moodle runs against the deprecated SQLite PDO driver
- The SQLite database file lives in MEMFS (pure memory, no durable storage)
- The DB file path is `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`
- `config.php` is generated at boot and points at the MEMFS database file
- SQLite pragmas are tuned for in-memory operation: `journal_mode=MEMORY`,
  `synchronous=OFF`, `temp_store=MEMORY`, `cache_size=-8000`, `locking_mode=EXCLUSIVE`
- A pre-built install snapshot (`assets/moodle/snapshot/install.sq3`) eliminates the
  3-8s CLI install phase. If unavailable, the full CLI install runs as a fallback.

When touching the migration/runtime path, preserve these invariants:

1. Do not reintroduce PGlite as the active DB path
2. Do not move the DB out of the writable MEMFS filesystem
3. Do not copy the full Moodle core into persistent (OPFS/IndexedDB) storage
4. Keep `$CFG->wwwroot` based on the real app base URL, not the scoped runtime path
5. Keep the default scope stable unless there is a deliberate migration plan
6. Do not add OPFS/IndexedDB persistence for the database — the runtime is ephemeral by design
7. CACHE_DISABLE_ALL is false (MUC enabled). Cache store plugin defaults are seeded in
   the install snapshot, config normalizer, and install runner to prevent admin redirect loops

Important files for this prototype:

- `src/runtime/config-template.js`, `lib/config-template.js`
- `src/runtime/bootstrap.js`, `src/runtime/php-loader.js`, `src/runtime/php-compat.js`
- `src/runtime/crash-recovery.js`
- `sw.js`, `src/remote/main.js`, `php-worker.js`, `lib/moodle-loader.js`
- `scripts/patch-moodle-source.sh`, `scripts/generate-install-snapshot.sh`
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
- For browser/runtime debugging, prefer opening the app with `?debug=true` first.
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
2. `php-worker.js` passes it as `appRootUrl` → `bootstrapMoodle({ appBaseUrl })`
3. `bootstrap.js`: `buildPublicBase(appBaseUrl)` → `$CFG->wwwroot` in `config.php`
4. `php-loader.js`: `absoluteUrl = appBaseUrl` → passed to `wrapPhpInstance()`
5. `php-compat.js`: extracts `urlBasePath` → prepended to `SCRIPT_NAME`, `PHP_SELF`, `REQUEST_URI`

If any link in this chain is broken, redirects on subpath deployments will loop.

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
instance. For full format, step types, PHP code generation, and resource system details,
see the Blueprint Provisioning skill.

Key design decisions:
- `installMoodle` is a declarative marker — the actual install runs in `bootstrap.js`
- Provisioning steps use `php.run()` with `CLI_SCRIPT` mode (except `login` which uses HTTP)
- Blueprint step execution runs between config normalization (0.918) and auto-login (0.95)

When changing blueprint semantics, update the schema, step handlers, docs, and tests.

## Testing, Linting, and Formatting

### Quick reference

```bash
make test      # Run all unit tests (286+ tests across 63 suites)
make test-e2e  # Run Playwright browser tests (shell, boot, blueprints)
make lint      # Run Biome linter on src/, tests/, scripts/
make format    # Auto-fix lint and formatting issues
```

For full test suite inventories, CI/CD pipeline, and browser compatibility details:
@.agents/references/testing-and-ci.md

## Architecture Decision Records (ADRs)

Every significant technical decision must be documented as an Architecture Decision Record.
ADRs capture the context, options considered, rationale, consequences, and review criteria
so that future contributors (human or AI) understand **why** a choice was made — not just what.

### Rules

1. **When to write an ADR**: Any change that introduces a new pattern, modifies the request
   pipeline, changes the storage model, adds a dependency, or alters build/deployment behavior.
   When in doubt, write one — a short ADR is better than no ADR.
2. **Template**: Always start from `.templates/adr-template.md`. Do not invent a new format.
3. **Location**: `docs/decisions/NNNN-kebab-case-title.md`, numbered sequentially.
4. **Language**: English.
5. **Status values**: `Proposed`, `Accepted`, `Rejected`, `Obsolete`, `Superseded by ADR-NNNN`.
6. **Cross-reference**: When an ADR supersedes another, update the old ADR's status.
7. **Link from code**: When code implements an ADR, add a brief comment referencing it
   (e.g., `// See docs/decisions/0001-sw-level-scoped-static-asset-caching.md`).

### Current ADRs

| ADR | Topic | Status |
|-----|-------|--------|
| [0001](docs/decisions/0001-sw-level-scoped-static-asset-caching.md) | SW-level caching for scoped static assets | Accepted |
| [0002](docs/decisions/0002-plugin-auto-detection-from-github-urls.md) | Plugin type & name auto-detection from GitHub URLs | Accepted |
| [0003](docs/decisions/0003-direct-db-inserts-for-course-modules.md) | Direct DB inserts for course modules (WASM SQLite compat) | Accepted |
| [0004](docs/decisions/0004-opcache-tuning-and-runtime-ux-defaults.md) | OPcache tuning and runtime UX defaults | Accepted |
| [0005](docs/decisions/0005-resilient-blueprint-step-execution.md) | Resilient blueprint step execution with graceful errors | Accepted |
