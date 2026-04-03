# Moodle Playground

<p align="center">
  <img src="../ogimage.png" alt="Moodle Playground" width="600">
</p>

Moodle running entirely in your browser using WebAssembly. No server required.

## What is this?

Moodle Playground lets you run a full Moodle LMS instance in your browser for learning, testing, and prototyping course experiences. Everything runs locally — no installation, no server, no data leaves your machine.

The runtime is **fully ephemeral**: all state lives in memory and is lost when you close the tab.

Default credentials: username `admin`, password `password`.

## How it works

The project follows a layered architecture:

1. **Shell UI** (`index.html` + `src/shell/main.js`) — toolbar, URL bar, iframe host, runtime logs
2. **Runtime host** (`remote.html` + `src/remote/main.js`) — registers the service worker and hosts the playground iframe
3. **Request routing** (`sw.js` + `php-worker.js`) — intercepts requests and routes them to the PHP runtime
4. **PHP/Moodle runtime** (`src/runtime/*`) — boots Moodle via `@php-wasm/web` and serves HTTP requests through a bridge
5. **Generated assets** (`assets/moodle/`) — prebuilt ZIP bundle with Moodle core (extracted into writable MEMFS at runtime)

## Quick start

```bash
# Clone the repo
git clone https://github.com/ateeducacion/moodle-playground.git
cd moodle-playground

# Install and build
npm install
make prepare
make bundle

# Start the dev server
make serve
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## Features

- Full Moodle 4.4 / 5.0 running in WebAssembly
- PHP 8.1 to 8.5 support (version depends on Moodle branch; default: 8.3)
- SQLite database via [experimental PDO driver patch](https://moodle.atlassian.net/browse/MDL-88218) (in-memory, no persistence needed)
- Pre-built install snapshot for fast boot (~3s vs ~8s full install)
- Step-based blueprint system for provisioning users, courses, enrolments, modules, and more
- Works on GitHub Pages with subpath support

## Project links

- [GitHub repository](https://github.com/ateeducacion/moodle-playground)
- [Getting started](getting-started.md)
- [Architecture](architecture.md)
- [Blueprint reference](blueprint-json.md)
- [Plugin install notes for this branch](plugin-install-branch-notes.md)

## CI/CD and GitHub Actions

The project includes a reusable GitHub Action for generating live PR previews of Moodle Playground:

- [**action-moodle-playground-pr-preview**](https://github.com/ateeducacion/action-moodle-playground-pr-preview) — Deploys a temporary Moodle Playground instance for each pull request, allowing reviewers to test changes in the browser before merging.

The main CI/CD pipeline (`.github/workflows/ci.yml`) handles linting, unit tests, E2E tests (Chromium + Firefox), and deployment to GitHub Pages on push to `main`.

---

Made with ❤️ by [Área de Tecnología Educativa](https://www3.gobiernodecanarias.org/medusa/ecoescuela/ate/)
