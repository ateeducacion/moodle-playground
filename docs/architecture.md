# Architecture

Moodle Playground runs a full Moodle LMS entirely in your browser. There is no
server: PHP is compiled to WebAssembly (via WordPress Playground's
[`@php-wasm/web`](https://github.com/WordPress/wordpress-playground)), Moodle's
code lives in an in-memory filesystem, and the database is in-memory SQLite. No
data leaves the browser, and everything is destroyed when the tab closes.

## Layered overview

```text
index.html              Shell UI (toolbar, address bar, log panel)
  └─ remote.html        Runtime host — registers the Service Worker
       ├─ sw.js         Service Worker — intercepts and routes requests
       └─ php-worker     PHP-WASM worker (dist/php-worker.bundle.js)
            └─ @php-wasm/web   WebAssembly PHP 8.x
                 ├─ Moodle core in MEMFS   (extracted from a ZIP bundle)
                 └─ In-memory state        (SQLite + moodledata in MEMFS)
```

## Runtime flow

The shell boots a scoped runtime host inside an iframe. That host registers the
Service Worker, which intercepts every request under
`/playground/<scope>/<runtime>/…` and forwards it to the PHP-WASM worker. On first
boot the worker extracts the Moodle ZIP bundle into MEMFS and loads a pre-built
install snapshot, so Moodle is ready in roughly 3 seconds instead of running a full
8-second CLI install. From then on, each page request is executed by PHP inside
WebAssembly against the in-memory SQLite database, and the Service Worker streams
the HTML back to the iframe.

## Components

- **Shell UI** (`index.html`, `src/shell/main.js`) — the outer page: toolbar,
  address bar, runtime/version selector, log panel, and blueprint import. It hosts
  the runtime in an iframe.
- **Runtime host** (`remote.html`, `src/remote/main.js`) — registers the Service
  Worker and hosts the scoped playground iframe.
- **Service Worker** (`sw.js`) — serves the static app files, routes scoped
  `/playground/<scope>/<runtime>/…` requests to the PHP-WASM worker, and rewrites
  Moodle-generated links and redirects so they work under a subpath.
- **PHP-WASM worker** (`dist/php-worker.bundle.js`) — owns the PHP runtime for a
  scope. It boots Moodle, applies runtime patches, runs blueprint steps, and serves
  each HTTP request through `@php-wasm/web`.
- **Moodle in MEMFS** — Moodle core is extracted from a prebuilt ZIP into the
  writable in-memory filesystem at `/www/moodle`. Mutable data lives in
  `/persist/moodledata` (the `/persist` name is legacy — it is still MEMFS, not
  durable storage).
- **SQLite in memory** — the database is a single SQLite file in MEMFS, accessed
  through an experimental PDO driver patch. Pragmas are tuned for memory-only
  operation (no journaling to disk).
- **Generated assets** (`assets/moodle/`) — the prebuilt Moodle ZIP bundle and the
  install snapshot, produced at build time and loaded into MEMFS at boot.

## Storage model (ephemeral by design)

All state lives in Emscripten's MEMFS (the JavaScript heap) and in-memory SQLite.
**Nothing persists after the tab closes** — this is intentional. The playground is
for exploration, demos, and testing, not for storing real data.

Within a single tab session, mutable state under `/persist` is journaled to
IndexedDB so a reload keeps your data — but only for the same blueprint source.
Loading a different blueprint, or clicking **Reset Playground**, starts fresh.

!!! warning "Implications"
    - **No durable storage.** Treat every session as disposable.
    - **Memory-bound.** Very large courses, backups, or plugins can exhaust WASM
      memory and crash the runtime.
    - **Experimental SQLite.** The PDO SQLite driver patch is not full parity with a
      production Moodle database.

## Subpath deployments and crash recovery

The app can run from a subpath such as GitHub Pages (`/moodle-playground`); the
Service Worker keeps the URL base path consistent so Moodle's redirects and links
resolve correctly. If the PHP runtime hits a fatal WASM error (out of memory, file
descriptor exhaustion), the worker snapshots the database and user files, boots a
fresh runtime, and restores state automatically, with guards to prevent restart
loops.

## Going deeper

This page is the practical overview. For the patch layout, SQLite driver details,
build pipeline, and Architecture Decision Records (ADRs), see the maintainers'
documentation:

- [Maintainers > Contributing](maintainers/contributing.md)
- [Maintainers > Internal notes](maintainers/internal-notes.md)
