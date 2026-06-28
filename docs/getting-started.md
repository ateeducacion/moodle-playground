# Quick start

The fastest way to a running Moodle is to open the hosted app — no install, no
server, nothing leaves your browser.

## Try it online

1. Open **[moodle-playground.com](https://moodle-playground.com)**.
2. Wait for the runtime to boot (a full Moodle runs in your browser via
   WebAssembly — first boot takes a few seconds).
3. Log in with the default admin account:

   | Username | Password   |
   |----------|------------|
   | `admin`  | `password` |

!!! warning "State is ephemeral"
    Everything runs in memory. A reload keeps your data within the same tab
    session, but **closing the tab destroys it** and clicking **Reset Playground**
    starts fresh. Do not use it to store real data.

## Load a blueprint

A blueprint is a JSON file that provisions an instance at boot (courses, users,
plugins, and more). Load one by adding `?blueprint-url=` to the app URL:

```text
https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/course-with-content.blueprint.json
```

This boots a Moodle with a ready-made course. Browse the other shipped examples
and learn how to write your own in the [Blueprints overview](blueprints/index.md).

## Run it locally in 3 commands

You only need a local copy to develop or contribute. Install Node.js 18+, Git,
and PHP 8.3 with `pdo_sqlite` (`make bundle` runs PHP to build the install
snapshot), then:

```bash
npm install
make prepare && make bundle
make serve
```

Then open **<http://localhost:8080>**.

!!! info "Why a local server?"
    The playground relies on a service worker, which only registers on
    `https://` or `http://localhost`. Opening `index.html` from the filesystem
    will not work.

For the full toolchain (all Moodle branches, PHP/Composer requirements, docs
preview, tests, and lint) see [Run it locally](local-development.md).

## Next steps

- [Blueprints overview](blueprints/index.md) — provision courses, users, and plugins.
- [Basic usage](usage.md) — navigate the app, switch versions, and reset state.
- [Architecture](architecture.md) — how the browser-only runtime works.
- [PR previews](github/pr-previews.md) — test pull requests in the playground.
