# Run it locally

Run Moodle Playground on your own machine — to host it yourself, work offline, or hack on
the code. If you only want to try the playground, use the hosted app at
<https://moodle-playground.com> instead; nothing below is needed for that.

For the fastest path from clone to a running instance, start with the
[Quick start](getting-started.md). This page is the complete reference.

## Requirements

| Tool | Version | Needed for |
|------|---------|------------|
| Node.js | **18+** | Bundling the shell and PHP worker, running tests. |
| npm | bundled with Node | Dependency management. |
| Python 3 | any | Moodle build helpers and the docs site (Zensical). |
| Git | any | Cloning the repo. |
| PHP | **8.3** with `pdo_sqlite` | Building Moodle bundles (`make bundle`) and the native server (`make up-local`). |
| Composer | any | Only when building **Moodle 5.1+** bundles (`MOODLE_501_STABLE`, `MOODLE_502_STABLE`, `main`). |

!!! note
    PHP 8.3 is only needed at **build time** (it generates the SQLite install snapshot
    that makes boot fast). The playground itself runs PHP compiled to WebAssembly in the
    browser, so end users need nothing installed.

## Clone and install

```bash
git clone https://github.com/ateeducacion/moodle-playground.git
cd moodle-playground
npm install
```

## Build the runtime

A working instance needs two artifacts: the **PHP worker bundle** (`dist/`) and at least
one **Moodle bundle** (`assets/moodle/`). The targets below build them.

=== "First build"

    Build the worker, then the default Moodle branch (5.0) and its install snapshot:

    ```bash
    make prepare
    make bundle
    ```

=== "All branches"

    Build the worker and every supported Moodle branch (slower; needs Composer):

    ```bash
    make prepare-all
    ```

=== "Worker only"

    Rebuild just the PHP worker bundle:

    ```bash
    npm run build-worker
    ```

When to use each command:

| Command | What it does | Use it when |
|---------|--------------|-------------|
| `make prepare` | Installs deps and builds the **worker bundle only** (no Moodle). | First setup, before `make bundle`. |
| `make bundle` | Builds **one** Moodle branch + install snapshot (default 5.0). | You need a runnable Moodle. Override with `BRANCH=...`. |
| `make prepare-all` | Worker + **all** Moodle branches. | Reproducing CI / hosting every version. Pass `JOBS=N` to parallelize. |
| `npm run build-worker` | Rebuilds `dist/php-worker.bundle.js` only. | After editing anything in `src/runtime/**` or `src/blueprint/**`. |

!!! warning "Rebuild the worker after editing blueprint or runtime code"
    The blueprint engine and step handlers are bundled **into the worker**. After changing
    files under `src/blueprint/**` or `src/runtime/**`, run `npm run build-worker` or the
    running app keeps using the stale bundle. Unit tests run the source directly, so they do
    **not** catch a missing rebuild.

## Run

```bash
make serve
```

Open <http://localhost:8080>. The default admin login is `admin` / `password` (override it
with an `installMoodle` step in a [blueprint](blueprints/index.md)).

!!! info "Why a local HTTP server?"
    The playground uses a **service worker** to route requests to the in-browser PHP
    runtime. Service workers only register on `https://` or `http://localhost`, so opening
    `index.html` directly from the filesystem (`file://`) will not work. Always go through
    `make serve`.

Change the port with `PORT`:

```bash
PORT=9000 make serve
```

## Build everything and serve in one step

`make up` runs a full build of **all** Moodle branches and then starts the dev server:

```bash
make up
```

This is the slowest option (it builds every branch, so it needs Composer for 5.1+). Use it
when you want every Moodle version available from a single local instance. For day-to-day
work, `make prepare && make bundle && make serve` is faster.

## Native PHP server (without WASM)

`make up-local` runs Moodle on a native `php -S` server using the **same patched source**
that the WASM runtime uses, backed by a native SQLite database. This is useful for debugging
Moodle behavior without the WebAssembly layer.

```bash
make up-local
```

It builds the selected branch first, then serves it. State is isolated per branch under
`.cache/local/<branch>/`, so switching branches does not reuse the same database or
`moodledata`. The PHP binary you point it at must have `pdo_sqlite` enabled.

Override the branch, port, or PHP binary:

```bash
# Run the development branch
BRANCH=main make up-local

# Pick a port and a specific PHP binary
BRANCH=MOODLE_500_STABLE LOCAL_PORT=8082 LOCAL_PHP=php83 make up-local
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `BRANCH` | `MOODLE_500_STABLE` | Which Moodle branch to serve. |
| `LOCAL_PORT` | `8081` | Port for the native `php -S` server. |
| `LOCAL_PHP` | `php84` | PHP binary to launch (must have `pdo_sqlite`). |

## Selecting Moodle versions

The build defaults to Moodle 5.0 (`MOODLE_500_STABLE`). Override it with `BRANCH=...` on
`make bundle` or `make up-local`:

```bash
BRANCH=MOODLE_404_STABLE make bundle
BRANCH=main make bundle
```

| `BRANCH` value | Moodle version |
|----------------|----------------|
| `MOODLE_404_STABLE` | 4.4 |
| `MOODLE_405_STABLE` | 4.5 |
| `MOODLE_500_STABLE` | 5.0 (default) |
| `MOODLE_501_STABLE` | 5.1 |
| `MOODLE_502_STABLE` | 5.2 |
| `main` | development |

At runtime you can switch versions without rebuilding by using the `moodle` and `php`
[URL parameters](url-parameters.md) — for example `?moodle=4.4`. See
[Runtime and versions](blueprints/runtime.md) for the version/PHP compatibility details.

## Next steps

- [Basic usage](usage.md) — drive the running playground.
- [Blueprints overview](blueprints/index.md) — provision courses, users, and plugins at boot.
- [Architecture](architecture.md) — how the shell, service worker, and PHP runtime fit together.
- [Contributing](maintainers/contributing.md) — running tests, linting, building the docs, and the patch layout.
