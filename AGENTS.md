# AGENTS.md — Moodle Playground debugging & dev guide

A practical guide for AI agents and humans working on **moodle-playground**, a
browser-only Moodle that runs on PHP compiled to WebAssembly. It boots Moodle
(4.4 → 5.2) entirely client-side: no server, no PHP host, no database server.

This is the most mature of the four sibling PHP-WASM playgrounds
(nextcloud / **moodle** / omeka / facturascripts). They share the same shell +
worker + service-worker architecture, the same `@php-wasm/*` pins, Biome lint,
and a `make test/lint/bundle` workflow. Moodle is the exception that commits
`vendor/fflate.js` (see [Build & test](#build--test)).

---

## Overview / Architecture

The runtime is split across a few cooperating layers. Reading them in this order
makes the data flow clear:

| Layer | Files | Role |
|-------|-------|------|
| Shell UI | `index.html`, `src/shell/main.js` | The page at `/`. Address bar, runtime picker, blueprint editor, reset button. Owns the `scopeId` and renders the host iframe `#site-frame`. |
| Remote host | `remote.html`, `src/remote/main.js` | Loaded inside `#site-frame`. Registers the service worker, spawns the PHP worker, and renders the real Moodle in a nested iframe `#remote-frame`. |
| PHP worker | `php-worker.js` → bundled to `dist/php-worker.bundle.js` | Web Worker. Owns the PHP-WASM instance, runs the bootstrap/install, serves PHP requests. |
| Service worker | `sw.js` → bundled to `sw.bundle.js` (at repo **root**, not `dist/`) | Intercepts scoped HTTP requests and routes them into the worker. Must live at root so its scope can cover `/playground/...`. |
| Runtime | `src/runtime/*` | Boot logic: `bootstrap.js` (install/upgrade orchestration + inline PHP), `php-loader.js` (PHP instance + FS setup), `config-template.js` (generates Moodle `config.php` and `php.ini`), `php-compat.js` (request/response adapter), `manifest.js`, `crash-recovery.js`, `fs-persistence.js`. |
| Shared | `src/shared/*` | `storage.js` (scopeId + sessionStorage), `paths.js` (scoped URL builders), `protocol.js` (BroadcastChannel names), `version-resolver.js` (runtime id parsing), `config.js`. |
| Blueprint | `src/blueprint/` | Modular, blueprint-driven provisioning. `index.js`, `executor.js`, `parser.js`, `resolver.js`, `schema.js`, and `steps/*` (one handler per step type: `moodle-install`, `moodle-users`, `moodle-courses`, `moodle-modules`, `moodle-plugins`, …). |
| Loader | `lib/moodle-loader.js` | Fetches the prebuilt Moodle core ZIP (with cache) and extracts it into MEMFS. |

The Moodle core is extracted from a prebuilt ZIP into Emscripten **MEMFS**
(in-memory) at boot. Everything — core code *and* mutable data — lives in MEMFS;
the runtime then journals just the mutable data to IndexedDB (see
[Persistence](#persistence-model)).

Worker bundling is done by esbuild (`esbuild.worker.mjs`), which produces both
`dist/php-worker.bundle.js` and `sw.bundle.js`. The `@php-wasm/*` packages are
pinned at `^3.1.36`.

---

## Running locally

```sh
make serve            # PORT=8080 npm run serve   (http-server . -p 8080 -c-1)
```

Before serving, the esbuild worker bundle must exist:

```sh
make build-worker     # npm run build:worker → dist/php-worker.bundle.js + sw.bundle.js
make bundle           # builds ONE Moodle core ZIP (BRANCH=MOODLE_500_STABLE by default) — heavy, needs PHP 8.3
```

Convenience targets:

```sh
make prepare          # deps + build-version + build-worker  (fast loop; worker only)
make prepare-dev      # prepare + one Moodle branch bundle
make up               # deps + build-version + build-worker + all 6 branch bundles + serve
make up-local         # builds a bundle then runs scripts/setup-local.sh (real PHP backend on $LOCAL_PORT)
```

### CRITICAL gotcha: never use a privileged port

`http-server` binds the port directly. A port **< 1024** fails with `EACCES` in
this environment. Always use a high port (the default `8080` is fine):

```sh
make serve PORT=8080      # good
make serve PORT=80        # EACCES — do not do this
```

`make bundle` requires PHP 8.3 on the host (`make check-php` auto-detects the
Homebrew `php@8.3` binary). Without it, bundling fails fast with a clear message.

---

## Scoped URL routing

There are three nested documents. Verify by booting and inspecting the iframe
tree:

```
/                                            ← shell (index.html, #site-frame)
└─ remote.html?scope=<scopeId>&runtime=<runtimeId>&path=<path>   ← #site-frame src (host)
   └─ /playground/<scopeId>/<runtimeId>/<path>   ← #remote-frame src (the real Moodle)
```

- The shell builds the host URL with `resolveRemoteUrl()` (`src/shared/paths.js`)
  and sets it as `#site-frame.src` = `remote.html?scope=…&runtime=…&path=…`.
- `src/remote/main.js` then navigates the nested `#remote-frame` to the real
  scoped path via `buildScopedSitePath()`:
  `/playground/<scopeId>/<runtimeId>/<path>`.
- The service worker intercepts requests under that scoped prefix and dispatches
  them to the PHP worker.

**Runtime id format** is `php<MM>-<moodleBranch>`, e.g. the default runtime is
`php83-moodle50` (PHP 8.3 + Moodle 5.0). It is parsed by `parseRuntimeId()` in
`src/shared/version-resolver.js` (a legacy `php83-cgi` form is also handled).

**scopeId format** is `tab-<uuid>` (`crypto.randomUUID`), generated by
`createScopeId()` in `src/shared/storage.js`.

---

## Boot & readiness

Booting is **slow** — it compiles/extracts Moodle core into MEMFS and runs (or
restores) a full install. Moodle is the slowest of the four siblings; a cold
boot can take **tens of seconds**. Always poll for readiness; never assume the
page is up after a fixed delay.

Readiness signals (the same ones the e2e suite waits on, see
`tests/e2e/helpers.mjs`):

1. **Shell ready** — `#address-input` becomes **enabled** and the runtime label
   (`#current-runtime-label`) is populated. This happens after the worker posts
   its `worker-ready` message.
2. **Frame booted** — `#site-frame`'s `src` contains `scope=`.
3. **Moodle content** — the nested `#remote-frame` shows real Moodle markup and
   the remote boot overlay (`.remote-boot__card`) is hidden.

The boot pipeline (high level): remote registers the SW → waits for SW control →
spawns the PHP worker with `?scope=&runtime=…` → posts `configure-blueprint`
with `runtimeParams` → worker boots PHP, restores `/persist`, runs the install
gate, then navigates `#remote-frame`.

---

## Persistence model

Mutable Moodle state under `/persist` is journaled to **IndexedDB** via
`@php-wasm/fs-journal`, implemented in `src/runtime/fs-persistence.js` and wired
from `src/runtime/php-loader.js`. This is the "Wave 4" persistence shared with
the nextcloud / facturascripts siblings.

- **Keyed by `scopeId`.** `scopeId` is **sessionStorage**-based
  (`moodle-playground:active` in `src/shared/storage.js`). That means
  **within-session durability**: state survives reloads *in the same tab*, but is
  lost when the tab closes (a new tab gets a fresh `scopeId`).
- **IndexedDB db name:** `moodle-fs-journal:<scopeId>`
  (`PERSIST_DB_PREFIX = "moodle-fs-journal"` in `fs-persistence.js`). Ops are
  stored in the `ops` object store.
- On boot, `initFsPersistence(php, scopeId)` replays the saved journal onto the
  fresh MEMFS *before* Moodle bootstraps, so the install gate finds the restored
  DB and skips provisioning. New `/persist` writes are journaled back (debounced
  ~1.5s). SQLite temp files (`*.sqlite-journal|-wal|-shm`) are skipped.
- **Reset / clean boot.** The `#reset-button`, or appending `?clean=1` to the
  remote URL, forces a clean boot. The shell sets `pendingCleanBoot` →
  appends `clean=1` → `src/remote/main.js` threads `forceCleanBoot` through
  `runtimeParams` into the worker → `php-loader.js` calls
  `clearJournal(scopeId)` instead of replaying.

### THE KEY LESSON: persist DATA, not caches

`config-template.js` sets `MOODLEDATA_ROOT = "/persist/moodledata"`. That means
Moodle's caches also resolve under `/persist`:

```php
$CFG->dataroot      = '/persist/moodledata';
$CFG->cachedir      = '/persist/moodledata/cache';
$CFG->localcachedir = '/persist/moodledata/localcache';
$CFG->tempdir       = '/persist/moodledata/temp';
// + muc under /persist/moodledata/muc
```

These caches **must NOT be journaled**. `fs-persistence.js` excludes them from
**both** journaling and replay with:

```js
const EPHEMERAL_RE =
  /^\/persist\/moodledata\/(cache|localcache|temp|muc)(\/|$)/;
```

**Why this matters (the CompiledContainer bug):** Moodle's `localcache` holds the
compiled DI container, written via a temp-file + `rename`. That rename pattern
does **not** survive the journal round-trip, so restoring a stale `localcache`
into a fresh runtime left Moodle referencing a compiled container whose file was
missing — surfacing as **`Class "CompiledContainer" not found`** on reload after
creating content. The boot-time cache purge
(`remove_dir($CFG->cachedir...)` / `localcachedir` / `tempdir` / `muc` in the
`core` install stage of `src/runtime/bootstrap.js`) only runs during a fresh
install, **not** on a persisted reload. So the fix is to never persist the
caches in the first place and let Moodle rebuild them every boot.

**What actually persists:** only real data — the SQLite database
(`/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`), `filedir`, `config`
(`/persist/config/...`), and sessions. Everything cache-like is rebuilt on each
boot.

### Install gate & admin

The worker writes an **install marker** at
`/persist/config/moodle-playground-install-<scope>-<runtime>.json` and a DB at
`/persist/moodledata/moodle_<scope>_<runtime>.sq3.php` (see `buildDatabaseName`
/ `buildInstallStatePath` in `bootstrap.js`). On reboot, `installStateMatches()`
checks the marker (runtime id, bundle version, release, sha256, dbName,
`installed === true`); if it matches, it **skips the install/CLI provisioning**
("Using persisted install marker"). Otherwise it falls back to a provisioning
check ("database already installed"), then a prebuilt install snapshot, then a
full CLI install.

Admin credentials (from `playground.config.json` and the default blueprint
`assets/blueprints/default.blueprint.json`):

```
username: admin
password: password
```

The playground keeps an admin session after boot (`autologin` aside, the
finalize/login step sets the admin user).

---

## Debugging recipes

Run these from the **page console** (the shell document at `/`). For the
journaled DB you can run them in the shell or remote context — IndexedDB is
per-origin.

**List all IndexedDB databases (find your journal):**

```js
await indexedDB.databases();
// look for { name: "moodle-fs-journal:tab-<uuid>", version: 1 }
```

**Read the journal ops for the current session:**

```js
const scope = sessionStorage.getItem("moodle-playground:active");
const db = await new Promise((res, rej) => {
  const r = indexedDB.open(`moodle-fs-journal:${scope}`, 1);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const ops = await new Promise((res, rej) => {
  const tx = db.transaction("ops", "readonly").objectStore("ops").getAll();
  tx.onsuccess = () => res(tx.result); tx.onerror = () => rej(tx.error);
});
console.table(ops.map(o => ({ type: o.opType ?? o.type, path: o.path })));
```

**Confirm caches are NOT being journaled** (should print `[]`):

```js
ops.filter(o => /^\/persist\/moodledata\/(cache|localcache|temp|muc)/.test(o.path));
```

**Wipe the current session's persisted data and reboot clean:**

```js
const scope = sessionStorage.getItem("moodle-playground:active");
indexedDB.deleteDatabase(`moodle-fs-journal:${scope}`);
location.search = "?clean=1";   // or just click "Reset Playground"
```

**Inspect the active scope / runtime / saved state:**

```js
sessionStorage.getItem("moodle-playground:active");                  // scopeId
JSON.parse(sessionStorage.getItem(`moodle-playground:${scope}:state`)); // { runtimeId, path }
```

**Reproduce the CompiledContainer failure mode:** boot, create a course/content,
reload the *same tab*. If a regression re-introduces cache journaling you'll see
`Class "CompiledContainer" not found` instead of the dashboard.

**Boot is hanging?** Watch the remote boot overlay status (`#remote-status`) and
the shell log panel (`#log-panel`). The worker emits `[playground] core:*`
progress lines during install. Enable Moodle debug output by appending
`?debug=...` to the URL (threaded into `config.php` `debugdisplay`).

---

## Build & test

```sh
make lint     # npx @biomejs/biome check   — also auto-wraps long lines
make format   # biome check --fix
make test     # node --test tests/**/*.test.js   (~460 unit tests)
make test-e2e # Playwright (chromium + firefox)
```

- **Biome formatting:** lint auto-wraps long lines and enforces its own style.
  When editing, match the wrapping Biome produces or `make lint` will reformat
  it. Run `make format` before committing.
- **Worker bundle:** a source change in `php-worker.js` or anything it imports
  (`src/runtime/*`, `src/shared/*`, `src/blueprint/*`, `lib/*`) only reaches the
  browser after `make build-worker`. **Verify a change landed by grepping the
  bundle:**

  ```sh
  make build-worker
  grep -c "CompiledContainer" dist/php-worker.bundle.js
  ```

- **`make bundle` is heavy:** it builds the Moodle core ZIP per branch via
  `scripts/build-moodle-bundle.sh` and needs PHP 8.3. `bundle-all` builds all six
  branches: `MOODLE_404_STABLE`, `MOODLE_405_STABLE`, `MOODLE_500_STABLE`,
  `MOODLE_501_STABLE`, `MOODLE_502_STABLE`, `main`.
- **Gitignored build output:** `dist/`, `sw.bundle.js(.map)`, `assets/moodle/`,
  `assets/manifests/*.json`, and `vendor/` are ignored. **Exception:**
  `vendor/fflate.js` and `vendor/fflate-browser.js` are force-committed (Moodle
  is the only sibling that vendors fflate this way) — don't delete them thinking
  they're build artifacts.

---

## CI gotchas

CI is a single workflow, `.github/workflows/ci.yml`, triggered on push/PR to
`main`. Jobs: `lint-and-test` (syntax + `make test` + `make lint`, no PHP) →
`build` (all 6 branch bundles + docs site) → `e2e` (Playwright matrix) →
`deploy-pages` (push to main) / `deploy-preview` (PRs) / `cleanup-preview` (PR
close).

- **NEVER `git add -A`.** This repo carries local `.claude/` (and `.omc/`)
  artifacts in the working tree. Stage explicit files only:
  `git add AGENTS.md`.
- **Least-privilege permissions.** The workflow declares top-level
  `permissions:` and a job should not be granted more than `contents: read`
  unless it genuinely needs write (Pages/PR-comment jobs do). If you add a
  read-only analysis job (e.g. CodeQL), give it `permissions: contents: read`.
- **E2E is Playwright** with a CI matrix of **chromium + firefox** (2 workers
  each). **Firefox is the slow one** and the usual source of flakiness — budget
  for it and prefer the readiness polls in `tests/e2e/helpers.mjs` over fixed
  waits.
- **Netlify PR preview.** The `build` job uploads a `site-build` artifact; the
  `deploy-preview` job downloads it to `dist-site/` and publishes to Netlify with
  alias `pr-<N>`, reachable at
  `https://pr-<N>--moodle-playground.netlify.app`. The preview is torn down by
  `cleanup-preview` when the PR closes.

---

## Quick file map

| Need to change… | Look in |
|-----------------|---------|
| Shell UI / address bar / reset | `index.html`, `src/shell/main.js` |
| Host iframe / SW + worker spawn / clean-boot threading | `remote.html`, `src/remote/main.js` |
| Scoped URL building / runtime id parsing | `src/shared/paths.js`, `src/shared/version-resolver.js` |
| PHP instance, MEMFS setup, journal wiring | `src/runtime/php-loader.js` |
| Install/upgrade orchestration + inline PHP | `src/runtime/bootstrap.js` |
| Generated `config.php` / `php.ini` / cache paths | `src/runtime/config-template.js` |
| IndexedDB journaling + the cache-exclusion rule | `src/runtime/fs-persistence.js` |
| Request/response adapter | `src/runtime/php-compat.js` |
| Provisioning steps (courses, users, plugins…) | `src/blueprint/steps/*` |
| Service-worker routing | `sw.js` |
| Boot readiness helpers (use these in tests) | `tests/e2e/helpers.mjs` |
