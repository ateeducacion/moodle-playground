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

The readonly Moodle core is loaded from a prebuilt VFS bundle while mutable state is kept in browser persistence.

## Build System

This project uses npm and a small Makefile workflow.

### Requirements

- Node.js 18+
- npm
- Python 3
- Git

### Common Commands

```bash
npm install
npm run sync-browser-deps
npm run prepare-runtime
npm run bundle

make prepare
make bundle
make serve
make up
```

### Generated Assets

- `assets/moodle/`: readonly runtime bundle files (`.vfs.bin`, index, optional zip)
- `assets/manifests/`: generated bundle manifests

Do not hand-edit generated bundle artifacts unless the task is specifically about the build output.

## Architecture

### Runtime Flow

```text
index.html
  -> src/shell/main.js
     -> remote.html
        -> src/remote/main.js
           -> sw.js
              -> php-worker.js
                 -> src/runtime/bootstrap.js
                 -> src/runtime/php-loader.js
                 -> php-cgi-wasm
```

Responsibilities:

- `index.html` / `src/shell/main.js`
  - Toolbar, URL bar, iframe host, blueprint import, runtime logs
- `remote.html` / `src/remote/main.js`
  - Registers the service worker and hosts the scoped playground iframe
- `sw.js`
  - Intercepts same-origin requests
  - Maps static vs scoped/runtime requests
  - Rewrites redirects and HTML links for GitHub Pages subpaths
- `php-worker.js`
  - Owns the `php-cgi-wasm` instance for a scope
  - Boots Moodle and serves HTTP requests through the bridge
- `src/runtime/bootstrap.js`
  - Prepares storage
  - Mounts the readonly Moodle bundle
  - Writes `config.php` and `php.ini`

## Storage Model

Current model:

- Readonly core: mounted in memory under `/www/moodle`
- Mutable state: persisted under `/persist`
- `moodledata`: `/persist/moodledata`
- Config and manifest markers: `/persist/config`

Avoid reintroducing boot-time file-by-file copies of the full Moodle core into persistent storage.

## GitHub Pages and Base Path Handling

This project is expected to run under a subpath such as `/moodle-playground`.

When modifying `sw.js`, preserve all three behaviors:

1. App base path handling for static hosting in a subdirectory
2. Scoped runtime routing under `/playground/<scope>/<runtime>/...`
3. HTML response rewriting for Moodle-generated links and forms

Moodle, like Omeka, may emit HTML-escaped URLs. If navigation works on first load but breaks after clicking inside the site, inspect the HTML response body first.

## Extensions

The runtime currently resolves these browser-side PHP shared libraries:

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

If Moodle fails due to missing requirements, check:

- `playground.config.json`
- `src/runtime/runtime-registry.js`
- `scripts/sync-browser-deps.mjs`

Do not add a library name to runtime config unless the browser asset is actually available in `vendor/` or the sync/build pipeline has been updated accordingly.

## Blueprints

Blueprints are JSON files that describe the desired state of a playground instance.

Relevant files:

- `assets/blueprints/default.blueprint.json`
- `assets/blueprints/blueprint-schema.json`
- `src/shared/blueprint.js`

The current blueprint model is intentionally narrow and centered on:

- site title / locale / timezone
- admin login
- extra users
- categories
- starter courses

When changing blueprint semantics, update both the schema and the runtime code that consumes it.

## Testing and Verification

There is no large formal test suite in this repository today. Verification is mostly targeted.

### Typical checks

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/php-loader.js
node --check src/shell/main.js
node --check src/remote/main.js
```

### Manual validation areas

- First boot install path
- Reload with persisted state
- Navigation inside Moodle
- GitHub Pages subpath behavior
- Service worker updates after redeploy

If a change touches routing or HTML rewriting, prefer checking real browser behavior, not only syntax.
