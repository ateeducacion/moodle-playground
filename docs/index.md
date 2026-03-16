# Moodle Playground

Moodle running entirely in your browser using WebAssembly. No server required.

## What is this?

Moodle Playground lets you run a full Moodle LMS instance in your browser for learning, testing, and prototyping course experiences. Everything runs locally — no installation, no server, no data leaves your machine.

The runtime is **fully ephemeral**: all state lives in memory and is lost when you close the tab.

## How it works

The project follows a layered architecture:

1. **Shell UI** (`index.html` + `src/shell/main.js`) — toolbar, URL bar, iframe host, runtime logs
2. **Runtime host** (`remote.html` + `src/remote/main.js`) — registers the service worker and hosts the playground iframe
3. **Request routing** (`sw.js` + `php-worker.js`) — intercepts requests and routes them to the PHP runtime
4. **PHP/Moodle runtime** (`src/runtime/*`) — boots Moodle via `@php-wasm/web` and serves HTTP requests through a bridge
5. **Generated assets** (`assets/moodle/`) — prebuilt VFS bundle with readonly Moodle core

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
- PHP 8.3 with all required extensions built-in
- SQLite database (in-memory, no persistence needed)
- Pre-built install snapshot for fast boot (~3s vs ~8s full install)
- Blueprint system for configuring site title, users, courses, etc.
- Works on GitHub Pages with subpath support

## Project links

- [GitHub repository](https://github.com/ateeducacion/moodle-playground)
- [Getting started](getting-started.md)
- [Architecture](architecture.md)
- [Blueprint reference](blueprint-json.md)

---

Made with ❤️ by [Área de Tecnología Educativa](https://www3.gobiernodecanarias.org/medusa/ecoescuela/ate/)
