# Moodle Playground

[Live demo](https://ateeducacion.github.io/moodle-playground/) · [Documentation](docs/) · [Blueprints](docs/blueprint-json.md)

> Run a full Moodle site in the browser — no server required.

Moodle Playground runs [Moodle](https://moodle.org) entirely in the browser using WebAssembly, powered by [WordPress Playground](https://github.com/WordPress/wordpress-playground)'s `@php-wasm/web` runtime. Every page load boots a fresh Moodle instance with a pre-built SQLite snapshot — nothing is stored on disk and nothing leaves your browser.

## Getting Started

### Try it online

Open the [live demo](https://ateeducacion.github.io/moodle-playground/) — no install needed.

### Run it locally

```bash
git clone https://github.com/ateeducacion/moodle-playground.git
cd moodle-playground
make up
```

Then open <http://localhost:8080>.

### Prerequisites

- Node.js 18+
- npm
- Python 3 for Moodle patch/build helpers and docs
- Git

## How It Works

```text
index.html          Shell UI (toolbar, address bar, log panel)
  └─ remote.html    Runtime host — registers the Service Worker
       ├─ sw.js     Intercepts requests → routes to PHP worker
       └─ php-worker.js
            └─ @php-wasm/web (WebAssembly, PHP 8.3)
                 ├─ Readonly Moodle core  (pre-built VFS bundle)
                 └─ In-memory state       (SQLite + moodledata in MEMFS)
```

1. The shell boots a scoped runtime host inside an iframe.
2. The Service Worker intercepts all requests under `/playground/<scope>/<runtime>/…`.
3. The PHP worker loads the readonly Moodle VFS bundle and a pre-built install snapshot.
4. Moodle runs against an in-memory SQLite database — fully ephemeral, no persistence.

### No persistence by design

All state lives in memory (Emscripten MEMFS). Closing the tab destroys everything. This is intentional — the playground is meant for exploration, demos, and testing, not for storing data.

## Blueprints

Blueprints are step-based JSON files that configure and provision a playground instance at boot. Inspired by [WordPress Playground Blueprints](https://wordpress.github.io/wordpress-playground/), they use Moodle-native naming and semantics.

```json
{
  "landingPage": "/my/",
  "steps": [
    { "step": "installMoodle", "options": { "siteName": "My Moodle" } },
    { "step": "login", "username": "admin" },
    { "step": "createCategory", "name": "Science" },
    { "step": "createCourse", "fullname": "Physics 101", "shortname": "PHYS101", "category": "Science" }
  ]
}
```

A default blueprint is bundled at [`assets/blueprints/default.blueprint.json`](assets/blueprints/default.blueprint.json). Override it by:

- Passing `?blueprint=<inline-json-or-base64>` or `?blueprint-url=<url>` in the URL
- Importing a `.json` file from the shell toolbar

Blueprints can provision:

- Site title, locale, timezone, and admin credentials (`installMoodle`)
- User sessions (`login`)
- Additional users (`createUser`, `createUsers`)
- Course categories (`createCategory`, `createCategories`)
- Courses and sections (`createCourse`, `createCourses`, `createSection`)
- Enrolments (`enrolUser`, `enrolUsers`)
- Course modules (`addModule` — label, assign, folder, etc.)
- Plugins and themes from ZIP URLs (`installMoodlePlugin`, `installTheme`)
- Moodle config values (`setConfig`, `setConfigs`)
- Filesystem operations (`writeFile`, `mkdir`, `unzip`, etc.)
- Arbitrary PHP code (`runPhpCode`, `runPhpScript`)

Use `constants` for `{{PLACEHOLDER}}` substitution and `resources` for named file references.

See the [Blueprint reference](docs/blueprint-json.md) for the full format, all step types, and examples. A sample blueprint is at [`blueprint-sample.json`](blueprint-sample.json).

Schema: [`assets/blueprints/blueprint-schema.json`](assets/blueprints/blueprint-schema.json).

## Development

| Command | Description |
|---------|-------------|
| `make up` | Install deps, build all Moodle bundles with colorized per-branch output, and serve locally |
| `make prepare` | Install npm deps and build the worker only |
| `make prepare-dev` | Install npm deps, build the worker, and build the default Moodle bundle |
| `make prepare-dev-pretty` | Build the worker and default bundle in parallel with colorized local output |
| `make prepare-all` | Install npm deps, build the worker, and build all Moodle bundles |
| `make bundle` | Rebuild the default Moodle VFS bundle and manifest (`BRANCH=...` to override) |
| `make bundle-all` | Rebuild all Moodle bundles; supports parallel jobs via `JOBS=...` |
| `make bundle-all-pretty` | Rebuild all Moodle bundles with colorized per-branch output |
| `make serve` | Start a local server on port 8080 |
| `make up-local` | Start native `php -S` Moodle for the selected branch (`BRANCH=...`, isolated local SQLite per branch) |
| `make clean` | Remove generated bundle and manifest artifacts |
| `make reset` | Full clean including vendored runtime assets |
| `npm run test:blueprint` | Run blueprint unit tests |

### Worker bundling

The PHP worker is bundled with esbuild into `dist/php-worker.bundle.js`:

```bash
npm run build:worker
```

## Deployment

Designed for static hosting, including GitHub Pages. The app handles subpath deployments (e.g., `/moodle-playground`) automatically via Service Worker URL rewriting.

## Technical Details

- **PHP runtime**: `@php-wasm/web` PHP 8.3 with built-in extensions (`sqlite3`, `pdo_sqlite`, `dom`, `xml`, `mbstring`, `openssl`, `intl`, `curl`, `gd`, `zip`, and more)
- **Database**: SQLite via PDO, running from an in-memory file (MEMFS)
- **Boot**: Pre-built install snapshot eliminates the CLI install phase
- **Patches**: Minimal patches to Moodle core for WASM compatibility (SQLite driver, XML parsing, encryption fallback)

For architecture details and migration notes, see the [`docs/`](docs/) directory.

## Contributing

Contributions are welcome. See the [development docs](docs/development.md) to get started.

## License

See [LICENSE](LICENSE).
