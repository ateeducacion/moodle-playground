# Moodle Playground

> Moodle in the browser, powered by WebAssembly. No traditional backend required.

Inspired by WordPress Playground and aligned with the product shape of `omeka-s-playground`, this project runs a Moodle site entirely in the browser using `php-wasm`, `php-cgi-wasm`, Service Workers and a file-backed SQLite database. The readonly Moodle core is served from a pre-built bundle while mutable state is kept in browser persistence.

## Getting Started

### Quick start

```bash
git clone https://github.com/ateeducacion/moodle-playground.git
cd moodle-playground
make up
```

Open <http://localhost:8080>.

### Prerequisites

- Node.js 18+
- npm
- Python 3
- Git

### Make targets

| Command | Description |
|---------|-------------|
| `make up` | Install deps, prepare runtime assets, build the Moodle bundle, and serve locally |
| `make prepare` | Install npm deps, sync browser runtime assets, and build the bundle |
| `make bundle` | Build the Moodle bundle and manifest |
| `make serve` | Start a static server on port 8080 |
| `make clean` | Remove generated bundle and manifest artifacts |
| `make reset` | Clean generated bundle artifacts and the vendored runtime |

## How It Works

```text
index.html          Shell UI (toolbar, address bar, log panel, iframe viewport)
  └─ remote.html    Runtime host — registers the Service Worker
       ├─ sw.js     Intercepts requests and forwards them to the PHP worker
       └─ php-worker.js
            └─ php-cgi-wasm (WebAssembly)
                 ├─ Readonly Moodle core  (assets/moodle/*.vfs.*)
                 └─ Writable overlay      (IndexedDB-backed wasm FS, config, moodledata)
```

The runtime flow is deliberately similar to `omeka-s-playground`:

1. The shell boots a scoped runtime host.
2. The Service Worker routes requests under `/playground/<scope>/<runtime>/...`.
3. The PHP worker loads the manifest and readonly Moodle VFS bundle.
4. Only mutable paths such as `config.php`, `moodledata`, and runtime markers are written.

## Blueprint Support

Blueprints are JSON files that describe the desired state of a playground instance.

A default blueprint is bundled at [`assets/blueprints/default.blueprint.json`](assets/blueprints/default.blueprint.json). You can override it by:

- Passing `?blueprint=/path/to/file.json` in the URL.
- Importing a `.json` file from the shell panel.

### Blueprint scope in this repo

The current blueprint model covers:

- Site title, locale and timezone
- Admin login defaults
- Additional users
- Starter categories
- Starter courses

The schema is available at [`assets/blueprints/blueprint-schema.json`](assets/blueprints/blueprint-schema.json).

## Bundle and Runtime Assets

The offline pipeline generates:

- `assets/moodle/*.vfs.bin`
- `assets/moodle/*.vfs.index.json`
- `assets/moodle/*.zip`
- `assets/manifests/latest.json`

The browser runtime depends on vendored assets under `vendor/`, prepared via:

```bash
npm run sync-browser-deps
```

The current runtime resolves these shared PHP libraries:

- `dom`
- `iconv`
- `intl`
- `libxml`
- `simplexml`
- `zlib`
- `zip`
- `mbstring`
- `openssl`
- `phar`

Some Moodle capabilities may still require additional extensions or a custom `php-wasm` build.

## Deployment

The project is designed for static hosting, including GitHub Pages.

Important runtime assumptions:

- requests are routed through the Service Worker
- the app may live under a subpath such as `/moodle-playground`
- HTML redirects and links are rewritten to stay scoped inside the runtime iframe

## Current Status

What is now aligned with Omeka:

- same shell/remote split
- scoped runtime routing
- readonly bundle mounting
- blueprint import/export flow
- repo-level maintenance files (`AGENTS.md`, `Makefile`, `.gitignore`, `playground.config.json`)

What still needs further hardening:

- full Moodle provisioning
- reliable admin autologin
- broader extension coverage for Moodle requirements
- end-to-end validation of the installer/admin flow in Chromium and GitHub Pages
