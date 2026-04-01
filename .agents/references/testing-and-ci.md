# Testing, Linting, CI/CD Reference

This reference contains detailed test suite inventories, CI/CD pipeline structure,
browser compatibility notes, and manual validation guidance. For quick commands,
see the Testing section in AGENTS.md.

## Test Suites

Tests live in `tests/` and run with Node.js built-in `node:test` (no framework).

### Blueprint (`tests/blueprint/`)

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

### Version resolver (`tests/shared/`)

| File | What it tests |
|------|---------------|
| `version-resolver.test.js` | Branch metadata, PHP/Moodle compatibility matrix, version resolution, runtimeId parsing/building, query param parsing, manifest URL building, data integrity |
| `protocol.test.js` | BroadcastChannel naming, snapshot version constant |
| `paths.test.js` | `joinBasePath()` path concatenation and deduplication |
| `storage.test.js` | `buildScopeKey()` storage key construction |

### Runtime (`tests/runtime/`)

| File | What it tests |
|------|---------------|
| `config-template.test.js` | `config.php` generation (dbtype, wwwroot, escaping, CACHE_DISABLE_ALL, autoloader), php.ini entries (timezone, limits, session paths) |
| `php-compat.test.js` | `resolveScriptPath()` (PATH_INFO splitting, directory→index.php), `isPhpScript()`, `getMimeType()` for all supported extensions |
| `manifest.test.js` | `buildManifestState()` extraction, fallback manifest URL building |

### Service Worker (`tests/sw/`)

| File | What it tests |
|------|---------------|
| `sw-helpers.test.js` | HTML entity decoding (`&amp;`, `&#x2F;`, `&colon;`, Moodle URLs), scoped runtime path extraction (scope/runtime/path parsing, subpath deployments) |

### End-to-End (`tests/e2e/`)

E2E tests use [Playwright](https://playwright.dev/) and run against a real browser (Chromium).
They verify the full playground flow: shell boot → WASM PHP runtime → Moodle loading → blueprint execution.

| File | What it tests |
|------|---------------|
| `shell.spec.mjs` | Shell UI: boot, side panel tabs, logs, blueprint display, settings popover, `?blueprint=` param |
| `moodle-boot.spec.mjs` | Runtime boot lifecycle, PHP Info capture |
| `blueprint-courses.spec.mjs` | Blueprint execution: course creation, user creation, enrollment, module addition |

Run with `make test-e2e` (both browsers), `make test-e2e-chrome`, or `make test-e2e-firefox`.
First-time setup: `npm run test:e2e:install`. Configuration in `playwright.config.mjs`.
The dev server auto-starts on port 8085. Workers: 2 in CI, 3 locally.

**Firefox compatibility:** Tests that require the Moodle runtime (SW + WASM bootstrap)
work in Firefox thanks to the IIFE-bundled Service Worker. Shell-only tests (toolbar,
panels, settings) work in all browsers without the runtime.

## Linting and Formatting

The project uses [Biome](https://biomejs.dev/) for linting and formatting. Configuration is in `biome.json`.

- **Scope**: `src/**`, `tests/**`, `scripts/**`
- **Formatter**: 2-space indent, auto organize imports
- **Linter**: Recommended rules, with `noDescendingSpecificity` and `noDuplicateProperties` disabled

`make lint` runs in CI on every push to `main` and on pull requests.

### Syntax checks

```bash
node --check sw.js
node --check php-worker.js
node --check lib/moodle-loader.js
node --check src/runtime/bootstrap.js
node --check src/runtime/php-loader.js
node --check src/runtime/php-compat.js
node --check src/runtime/crash-recovery.js
node --check src/shell/main.js
node --check src/remote/main.js
node --check src/blueprint/index.js
```

## CI/CD

Everything lives in a single `.github/workflows/ci.yml` workflow (no separate pages.yml
or pr-preview.yml). It triggers on push to `main`, pull requests, and manual dispatch.

```
lint-and-test ───────────────────────────────────────┐
build (5 branches + docs) ──┬── e2e-chromium ────────┤
                            ├── e2e-firefox ──────────┤
                            ├── deploy-preview (PR) ──┤
                            └── deploy-pages (main) ──┘
```

**Jobs:**

| Job | Trigger | What it does |
|-----|---------|--------------|
| `lint-and-test` | Always (except PR close) | Syntax check, `make test` (286+ unit tests), `make lint` |
| `build` | Always (except PR close) | Build all 5 Moodle branches + docs, upload artifact |
| `e2e-chromium` | After build | Playwright e2e tests in Chromium (2 workers) |
| `e2e-firefox` | After build | Playwright e2e tests in Firefox (2 workers) |
| `deploy-pages` | Push to main only | Deploy to GitHub Pages (gates on ALL other jobs) |
| `deploy-preview` | PR only | Deploy to Netlify (parallel with e2e, fast preview URL) |
| `cleanup-preview` | PR close only | Delete Netlify deploy |

**Concurrency:** One run per branch, cancel-in-progress. A new push cancels stale runs.

**Artifact sharing:** Build produces a single `site-build` artifact reused by both e2e
jobs and both deploy jobs. Build once, test and deploy the same artifact.

## Service Worker Bundling (Firefox Compatibility)

The Service Worker (`sw.js`) uses ES module `import` statements, but **Firefox does not
support ES module Service Workers** (Mozilla Bug 1360870). The SW is bundled with esbuild
into `sw.bundle.js` (IIFE format, no imports) at the project root and registered as
`type: "classic"`.

**Important scope rule:** The SW bundle MUST live at the project root, not in `dist/`.
A Service Worker's max scope is its own directory path — `/dist/sw.bundle.js` can only
control `/dist/`, but the SW needs to control `/`. Firefox strictly enforces this and
throws `SecurityError: "The operation is insecure"` if violated.

- Source: `sw.js` (ES module with imports — for development/readability)
- Bundle: `sw.bundle.js` (IIFE, no imports — served to browsers)
- Built by: `npm run build:worker` (esbuild.worker.mjs)
- Registered as: `type: "classic"` in `src/shared/service-worker-version.js`

## Firefox WASM Network Limitations

Firefox and Safari cannot make outbound HTTP calls from Emscripten WASM (errno 23 /
EHOSTUNREACH). When Moodle PHP code tries to use `curl` or `file_get_contents()` on
external URLs, the WASM runtime crashes. The crash recovery system detects this via
`isEmscriptenNetworkError()` in `src/runtime/crash-recovery.js` and returns a user-friendly
502 response instead of crashing the runtime.

## Manual Validation Areas

- First boot install path (every page load is a fresh install)
- Navigation inside Moodle (caching should make second page loads faster)
- GitHub Pages subpath behavior
- Service worker updates after redeploy
- Cache file creation in `/persist/moodledata/cache` (verify Moodle cache system initializes)

If a change touches routing or HTML rewriting, prefer checking real browser behavior, not only syntax.
