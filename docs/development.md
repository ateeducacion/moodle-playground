# Development

## Common commands

```bash
npm install          # Install dependencies
npm run build:worker # Bundle the PHP worker
npm run bundle       # Full bundle (ZIP + snapshot)

make prepare         # Install deps and build the worker only
make prepare-dev     # Worker + default Moodle bundle
make prepare-dev-pretty # Worker + default bundle with colorized parallel output
make prepare-all     # Worker + all Moodle bundles
make bundle          # Build the default branch bundle (or BRANCH=...)
make bundle-all      # Build all Moodle bundles (use JOBS=... to parallelize)
make bundle-all-pretty # Build all bundles with colorized per-branch output
make serve           # Start dev server on port 8080
make up              # Full build + serve
make up-local        # Run a native php -S Moodle for the selected branch
```

`make up-local` respects `BRANCH=...` and reuses the patched checkout in `.cache/moodle/<branch>`.
Examples:

```bash
make up-local
BRANCH=main make up-local
BRANCH=MOODLE_500_STABLE LOCAL_PORT=8082 LOCAL_PHP=php83 make up-local
```

Local SQLite installs are isolated per branch under `.cache/local/<branch>/`, so switching
between `MOODLE_500_STABLE` and `main` does not reuse the same database or `moodledata`.
The local PHP binary must have `pdo_sqlite` enabled.

## Worker bundling

The PHP worker (`php-worker.js`) is bundled with esbuild into `dist/php-worker.bundle.js`. This bundles all runtime dependencies into a single ESM file loaded as a Web Worker. WASM and ICU data files are copied to `dist/` with content hashes.

Run `npm run build:worker` after changes to any runtime file.

## Generated assets

| Path | Description |
|------|-------------|
| `assets/moodle/` | Prebuilt Moodle ZIP bundle (extracted into MEMFS at runtime) |
| `assets/moodle/snapshot/` | Pre-built install snapshot (`install.sq3`) |
| `assets/manifests/` | Bundle manifests |
| `dist/` | esbuild output (worker bundle, WASM, ICU data) |

Do not hand-edit generated artifacts.

## Project structure

```text
src/
  shell/main.js        # Shell UI logic
  remote/main.js       # Runtime host
  runtime/
    bootstrap.js       # Moodle bootstrap and install
    php-loader.js      # PHP instance creation
    php-compat.js      # WP Playground API compatibility
    config-template.js # config.php generator
  blueprint/           # Step-based blueprint system
    index.js           # Public re-exports
    parser.js          # JSON / base64 / data-URL parsing
    schema.js          # Hand-written validator
    constants.js       # {{KEY}} placeholder substitution
    resources.js       # Named resource registry
    resolver.js        # Blueprint source resolution
    executor.js        # Sequential step runner
    storage.js         # sessionStorage persistence
    steps/             # Step handlers (filesystem, Moodle API, etc.)
    php/helpers.js     # PHP code generators for Moodle API calls
  shared/              # Shared utilities
  styles/app.css       # App stylesheet
patches/shared/        # Canonical shared build-time patches
patches/moodle/        # Legacy fallback patch root
patches/<branch>/      # Optional branch-specific source-root overrides
scripts/               # Build and utility scripts
assets/blueprints/     # Blueprint definitions and examples
tests/blueprint/       # Blueprint unit tests
docs/                  # Documentation (this site)
```

## Documentation

The documentation site is built with [MkDocs](https://www.mkdocs.org/) and the [Material theme](https://squidfunk.github.io/mkdocs-material/).

```bash
# Install docs dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-docs.txt

# Preview locally
mkdocs serve

# Build for production
mkdocs build --strict
```

## Tests

### Blueprint tests

```bash
npm run test:blueprint
```

Runs 49 unit tests covering the parser, schema validator, constants, resources, executor, resolver, and step registry.

## Manual validation

After changes, verify in a real browser:

- First boot install path (every page load is a fresh install)
- Navigation inside Moodle (caching should make second page loads faster)
- GitHub Pages subpath behavior
- Service worker updates after redeploy

If a change touches routing or HTML rewriting, prefer checking real browser behavior, not only syntax.

## Patch layout

The patch copier uses a layered model:

- `patches/shared/` is the preferred shared patch root
- `patches/moodle/` is a legacy fallback if `patches/shared/` is absent
- `patches/<branch>/` is an optional branch-specific override layer

Shared patches are branch-agnostic and target `lib/...` paths. The script automatically
adds the `public/` prefix when patching Moodle 5.1+ source trees.

Branch-specific patches are copied literally relative to the Moodle source root:

- `patches/MOODLE_500_STABLE/lib/foo.php` -> `<source>/lib/foo.php`
- `patches/main/public/lib/foo.php` -> `<source>/public/lib/foo.php`

Do not use `patches/<branch>/moodle/...`; that path is not special-cased.
