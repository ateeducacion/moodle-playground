# Contributing

The maintainer reference for building, testing, and extending Moodle Playground.

!!! note "Requirements"
    Node.js 18+, npm, Python 3, and Git. PHP 8.3 with `pdo_sqlite` is needed to build Moodle
    bundles (`make bundle`, `make prepare-dev`, `make prepare-all`, `make up`) — the build
    generates the install snapshot — and to run `make up-local`. The worker-only path
    (`make prepare`) and `make serve` do not need PHP. Composer is only needed to build
    Moodle 5.1+ bundles.

## Common commands

```bash
npm install              # Install dependencies

make prepare             # Install deps + build the PHP worker (fast local iteration)
make prepare-dev         # Worker + the default Moodle bundle
make prepare-all         # Worker + all Moodle bundles (CI/release)

make bundle              # Build the default branch bundle (override with BRANCH=...)
make bundle-all          # Build all Moodle branch bundles

make serve               # Start the dev server on http://localhost:8080
make up                  # Full build (all branches) + serve
make up-local            # Run a native php -S Moodle for the selected branch
```

`make up-local` respects `BRANCH=...`, `LOCAL_PORT=...`, and `LOCAL_PHP=...`, and reuses the
patched checkout in `.cache/moodle/<branch>`. Local SQLite state is isolated per branch under
`.cache/local/<branch>/`, so switching branches does not reuse the same database or `moodledata`.

```bash
make up-local
BRANCH=main make up-local
BRANCH=MOODLE_500_STABLE LOCAL_PORT=8082 LOCAL_PHP=php83 make up-local
```

!!! warning "A local HTTP server is required"
    A Service Worker only registers on `https` or `http://localhost`. Opening `index.html`
    from `file://` will not work. Use `make serve` and visit <http://localhost:8080>.

## Worker bundling

The PHP worker (`php-worker.js`) is bundled with esbuild into `dist/php-worker.bundle.js`.
This bundles all runtime dependencies (`@php-wasm/web`, `@php-wasm/universal`, and shared
modules) into a single ESM file loaded as a Web Worker. WASM and ICU data files are copied
to `dist/` with content hashes.

The **blueprint engine is bundled into this worker too** — the step registry and PHP
generators execute inside the bundled worker, not in the shell's main thread.

!!! warning "Rebuild after editing runtime or blueprint code"
    After changing anything under `src/runtime/**` or `src/blueprint/**`, run
    `npm run build-worker` (or `make build-worker`). Otherwise the running app keeps using
    the stale bundle — a new blueprint step fails with `Unknown step type: <name>`.
    `make test` exercises the source directly, so it does **not** catch a missing rebuild.
    When verifying in the browser, also clear the Service Worker caches (use the Reset
    Playground button) because the SW caches the old bundle.

## Generated assets

| Path | Description |
|------|-------------|
| `assets/moodle/` | Prebuilt Moodle ZIP bundle (extracted into MEMFS at runtime) |
| `assets/moodle/snapshot/` | Pre-built install snapshot (`install.sq3`) |
| `assets/manifests/` | Bundle manifests |
| `dist/` | esbuild output (worker bundle, WASM, ICU data) |

Do not hand-edit generated artifacts unless the task is specifically about the build output.

## Project structure

```text
src/
  shell/main.js          # Shell UI: toolbar, address bar, iframe host, logs
  remote/main.js         # Runtime host: registers the SW, hosts the scoped iframe
  runtime/
    bootstrap.js         # Moodle bootstrap and install
    php-loader.js        # PHP instance creation (@php-wasm/web)
    php-compat.js        # WP Playground API compatibility layer
    config-template.js   # config.php generator
  blueprint/             # Step-based blueprint system
    parser.js            # JSON / base64 / data-URL parsing
    schema.js            # Hand-written validator
    constants.js         # {{KEY}} placeholder substitution
    resources.js         # Named resource registry
    resolver.js          # Blueprint source resolution
    executor.js          # Sequential step runner
    steps/               # Step handlers (filesystem, Moodle API, PR overlay, ...)
    php/helpers.js       # PHP code generators for Moodle API calls
  shared/                # Shared utilities
patches/shared/          # Canonical shared build-time patches
patches/<branch>/        # Optional branch-specific source-root overrides
scripts/                 # Build and utility scripts
assets/blueprints/       # Blueprint definitions, examples, and JSON schema
tests/                   # Unit (node:test) and e2e (Playwright) tests
docs/                    # This documentation site
```

See [Architecture](../architecture.md) for how these layers fit together at runtime.

## Tests

Unit tests use Node's built-in `node:test` (no framework). E2E tests use Playwright.

```bash
make test          # Run all unit tests
make test-e2e      # Run Playwright browser tests (Chromium + Firefox)
make lint          # Run Biome on src/, tests/, scripts/
make format        # Auto-fix lint and formatting issues
```

First-time e2e setup: `npm run test:e2e:install`. To target one browser, use
`make test-e2e-chrome` or `make test-e2e-firefox`.

## Documentation

The documentation site is built with **[Zensical](https://github.com/zensical/zensical)**
and the Material theme. It is **not** plain MkDocs — do not run `mkdocs serve`/`mkdocs build`.

```bash
# Install docs dependencies (requirements-docs.txt contains exactly: zensical)
pip install -r requirements-docs.txt

# Preview locally with auto-reload
zensical serve

# Build the production site into site/
zensical build
```

Pages live under `docs/` and the nav is defined in `mkdocs.yml`.

## Adding a blueprint step

Steps are the units of blueprint provisioning. To add one:

1. **Add a handler** in `src/blueprint/steps/` — either in an existing module or a new file.
   A handler is `async (step, context) => { ... }`; validate required fields and throw a
   clear error if they are missing.
2. **Register the name** by wiring the handler into `src/blueprint/steps/index.js` (call
   `register("<stepName>", handler)` from the module's register function).
3. **Add the name to the schema enum** in `assets/blueprints/blueprint-schema.json` so the
   step validates.
4. **Rebuild the worker** with `npm run build-worker` (the blueprint engine runs inside the
   bundled worker — see [Worker bundling](#worker-bundling) above).
5. **Add a unit test** under `tests/blueprint/` and run `make test`.

For PHP generated by a step, add the generator in `src/blueprint/php/helpers.js`. See the
[Blueprint reference](../blueprints/reference.md) for the full list of existing steps.

## Where internal notes live

This page is the contributor-facing reference. Deeper material — Architecture Decision
Records (ADRs), SQLite/WASM migration notes, troubleshooting, and known issues — is linked
from [Internal notes](internal-notes.md).

Significant technical decisions must be recorded as
[ADRs](../architecture/adr/README.md), and significant designs are gated by
[SDDs](../architecture/sdd/README.md) — see each guide for when one is required.

`AGENTS.md` at the repository root is the authoritative guide for AI coding agents and the
specialist agent skills under `.agents/skills/`. Consult it for domain-deep conventions,
checklists, and known pitfalls before working in an unfamiliar area.

Third-party skills (for example Cloudflare's `security-audit`) are vendored into that same
directory with the GitHub CLI (`gh skill add`) and refreshed by the `update-agent-skills`
workflow, which runs `gh skill update --all` weekly and opens a pull request when upstream
changed. Claude Code discovers every skill through the symlinks under `.claude/skills/`.
Never edit a vendored skill in place; the Skills section in `AGENTS.md` has the details.
