# Development

## Common commands

```bash
npm install          # Install dependencies
npm run build:worker # Bundle the PHP worker
npm run bundle       # Full bundle (VFS + snapshot)

make prepare         # Install deps and build the worker only
make prepare-dev     # Worker + default Moodle bundle
make prepare-dev-pretty # Worker + default bundle with colorized parallel output
make prepare-all     # Worker + all Moodle bundles
make bundle          # Build the default branch bundle (or BRANCH=...)
make bundle-all      # Build all Moodle bundles (use JOBS=... to parallelize)
make bundle-all-pretty # Build all bundles with colorized per-branch output
make serve           # Start dev server on port 8080
make up              # Full build + serve
```

## Worker bundling

The PHP worker (`php-worker.js`) is bundled with esbuild into `dist/php-worker.bundle.js`. This bundles all runtime dependencies into a single ESM file loaded as a Web Worker. WASM and ICU data files are copied to `dist/` with content hashes.

Run `npm run build:worker` after changes to any runtime file.

## Generated assets

| Path | Description |
|------|-------------|
| `assets/moodle/` | Readonly runtime bundle (`.vfs.bin`, index) |
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
patches/moodle/        # Build-time Moodle patches
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
