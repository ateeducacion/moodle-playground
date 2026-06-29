# Moodle Playground

<p align="center">
  <img src=".github/screenshot.png" alt="Moodle Playground" width="600">
</p>

<p align="center">
  <a href="https://moodle-playground.pages.dev/" target="_blank" rel="noopener noreferrer">
    <img src="assets/playground-preview-button.svg" alt="Try on Moodle Playground" width="224">
  </a>
</p>

[Live demo](https://moodle-playground.com/) · [Documentation](https://moodle-playground.com/docs/) · [Blueprints](https://moodle-playground.com/docs/blueprints/reference/)

> Run a full Moodle site in the browser — no server required.

Moodle Playground runs [Moodle™](https://moodle.org) entirely in the browser using WebAssembly, powered by [WordPress Playground](https://github.com/WordPress/wordpress-playground)'s `@php-wasm/web` runtime. Every page load boots a fresh Moodle instance with a pre-built SQLite snapshot — nothing is stored on disk and nothing leaves your browser.

## Getting Started

### Try it online

Open the [live demo](https://moodle-playground.com/) — no install needed.

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
- PHP 8.3 with `pdo_sqlite` (for `make up-local`)
- Git

## How It Works

```text
index.html          Shell UI (toolbar, address bar, log panel)
  └─ remote.html    Runtime host — registers the Service Worker
       ├─ sw.js     Intercepts requests → routes to PHP worker
       └─ php-worker.js
            └─ @php-wasm/web (WebAssembly, PHP 8.3)
                 ├─ Moodle core in writable MEMFS  (extracted from ZIP bundle)
                 └─ In-memory state                (SQLite + moodledata in MEMFS)
```

1. The shell boots a scoped runtime host inside an iframe.
2. The Service Worker intercepts all requests under `/playground/<scope>/<runtime>/…`.
3. The PHP worker extracts the Moodle ZIP bundle into writable MEMFS and loads a pre-built install snapshot.
4. Moodle runs against an in-memory SQLite database — fully ephemeral, no persistence.
5. If the PHP runtime crashes (WASM OOM / file descriptor exhaustion), the worker snapshots the DB and user files, boots a fresh runtime, and restores state automatically.

**Default credentials:** username `admin`, password `password`.

### No persistence by design

All state lives in memory (Emscripten MEMFS). Closing the tab destroys everything. This is intentional — the playground is meant for exploration, demos, and testing, not for storing data.

## Blueprints

Blueprints are step-based JSON files that configure and provision a playground instance at boot. Inspired by [WordPress Playground Blueprints](https://wordpress.github.io/wordpress-playground/), they use Moodle-native naming and semantics.

```json
{
  "landingPage": "/course/view.php?id=2",
  "steps": [
    { "step": "installMoodle", "options": { "siteName": "My Moodle" } },
    { "step": "login", "username": "admin" },
    { "step": "installMoodlePlugin", "url": "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip" },
    { "step": "createCourse", "fullname": "Physics 101", "shortname": "PHYS101" },
    { "step": "addModule", "module": "label", "course": "PHYS101", "name": "Welcome", "intro": "<p>Hello World!</p>" }
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

See the [Blueprint reference](docs/blueprints/reference.md) for the full format, all step types, and examples. A sample blueprint is at [`blueprint-sample.json`](blueprint-sample.json).

Schema: [`assets/blueprints/blueprint-schema.json`](assets/blueprints/blueprint-schema.json).

See the [development docs](docs/maintainers/contributing.md) and [`AGENTS.md`](AGENTS.md) for the full command reference.

## Sibling Docker runtime: alpine-moodle

Moodle Playground focuses on browser-based, ephemeral Moodle instances for demos, QA, and shareable test scenarios.

For Docker-based development, CI, plugin development, and persistent integration testing, the sibling project [`alpine-moodle`](https://github.com/erseco/alpine-moodle) can apply a compatible subset of Moodle Playground `blueprint.json` files during container startup.

This means a plugin or course demo can keep a single declarative `blueprint.json` and run it either:

- in Moodle Playground for fast browser validation and sharing, or
- in alpine-moodle for a real Docker-based Moodle environment.

See [`docs/blueprints/runtime.md`](docs/blueprints/runtime.md) for compatibility notes and a portable, Docker-compatible example.

## Contributing

Contributions are welcome. See the [development docs](docs/maintainers/contributing.md) to get started.

## License

See [LICENSE](LICENSE).

## Trademark

"Moodle™" and the Moodle logo are trademarks or registered trademarks of
[Moodle Pty Ltd](https://moodle.com/) and its associated entities, used here for
identification and descriptive purposes only.

Moodle Playground is an independent, community-maintained open-source project built by
[Área de Tecnología Educativa (ATE)](https://www3.gobiernodecanarias.org/medusa/ecoescuela/ate/).
It is **not** affiliated with, endorsed by, sponsored by, or approved by Moodle Pty Ltd or
Moodle HQ. It runs the open-source Moodle™ software in the browser for demonstration,
testing, and educational purposes.

See Moodle's [trademark guidelines](https://moodle.com/trademarks/) for details.
