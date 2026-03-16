# Getting started

## Requirements

- Node.js 18+
- npm
- Python 3
- Git

## Local setup

```bash
git clone https://github.com/ateeducacion/moodle-playground.git
cd moodle-playground
npm install
```

## Building the runtime

```bash
# Prepare Moodle source, apply patches, build VFS bundle
make prepare

# Build the full bundle (VFS image + install snapshot)
make bundle

# Build just the PHP worker bundle
npm run build:worker
```

## Running locally

```bash
make serve
```

This starts a local HTTP server at [http://localhost:8080](http://localhost:8080).

## Validation commands

Quick syntax checks for the main runtime files:

```bash
node --check sw.js
node --check php-worker.js
node --check src/runtime/bootstrap.js
node --check src/runtime/php-loader.js
node --check src/runtime/php-compat.js
node --check src/shell/main.js
node --check src/remote/main.js
```

## Building the documentation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve
```

Preview at [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Configuration

The playground supports URL parameters to select Moodle and PHP versions:

| Parameter | Example | Description |
|-----------|---------|-------------|
| `moodle`  | `?moodle=4.4` | Moodle version |
| `php`     | `?php=8.3` | PHP version |

These can also be set via the Settings panel in the UI.

## Blueprints

Blueprints are JSON files that configure the initial state of a playground instance. See the [Blueprint reference](blueprint-json.md) for details.

The default blueprint is at `assets/blueprints/default.blueprint.json`.
