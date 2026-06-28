# ADR-0009 Support file-backed Moodle configuration settings in blueprints

* Status: Accepted
* Date: 2026-06-08

## Context and Problem

Blueprints could set Moodle configuration with `setConfig` / `setConfigs`, which call
`set_config($name, $value, $plugin)` and write **scalar** values into the `config` /
`config_plugins` tables. This covers strings, HTML, CSS, JSON, numbers and booleans.

It does **not** cover the many admin settings that are backed by a **file**. Settings declared
with `admin_setting_configstoredfile` (and similar file-manager settings) — theme logos and
favicons, header and marketing images, certificate backgrounds, and a range of plugin assets —
do not store their value in `config`. They store a record in Moodle's **File API** (`files`
table), keyed by context + component + filearea + itemid + filepath + filename, plus a config
value that points at the first stored file path (e.g. `/logo.png`). Moodle serves these through
`pluginfile.php`, which reads the File API, not the raw filesystem.

Consequently a blueprint cannot reproduce a real theme/plugin configuration that includes a logo
or image: `set_config()` alone is insufficient, and copying bytes onto disk with `writeFile`
never registers the file with Moodle, so it is never found or served.

## Options Considered

* **Option 1 — Overload `setConfig`.** Detect file-shaped values and branch into File API code.
  Rejected: it conflates two very different storage models behind one step, makes the simple
  scalar path harder to reason about, and gives no obvious place for file-specific options
  (filearea, itemid, replace, metadata).

* **Option 2 — `runPhpCode` per case.** Tell authors to hand-write `get_file_storage()` calls.
  Rejected: it leaks Moodle File API internals into every blueprint, is error-prone (escaping,
  context, admin user id), and is not reusable.

* **Option 3 — Theme-specific importers.** Add an Adaptable importer (and one per theme) that
  knows each theme's settings. Rejected: not generic, high maintenance, and most file settings
  follow the *same* File API shape regardless of plugin.

* **Option 4 — Generic, explicit file-backed steps.** Add `setConfigFile` (one file) and
  `setConfigFiles` (many files in one area) that store files via the File API in the system
  context under a configurable component/filearea/itemid/filepath/filename and write the matching
  config value — reusing the existing resource system for the file bytes.

## Decision

**Option 4.** Add two explicit steps, kept separate from scalar `setConfig` / `setConfigs`:

* `setConfigFile` — resolve `data` (any [resource descriptor](../blueprints/reference.md#resources):
  `url` / `base64` / `data-url` / `bundled` / `vfs` / `literal` / `@name`) to a temp MEMFS path,
  then store it via `get_file_storage()->create_file_from_pathname()` in
  `context_system::instance()` with `component = plugin`. Defaults: `filearea = name`, `itemid = 0`,
  `filepath = "/"`; the area is deleted first (`replace`, default `true`); and
  `set_config(name, filepath+filename, plugin)` is written (`setConfigValue`, default `true`).

* `setConfigFiles` — the same, for a list of files sharing one filearea: the area is deleted once,
  every file is stored, and the config value is set to the **first** stored file's path.

Both accept optional File API metadata (`author`, `license`, `source`, `userid`), default the file
owner to the site admin (falling back to user id `2`), and accept opt-in `purgeCaches` that runs
`theme_reset_all_caches()` (if present) and `purge_all_caches()`. Caches are **not** purged by
default — purging is expensive and most settings do not need it.

The bytes reach PHP exactly like `addModule` file attachments: resolved in JS, written to a temp
MEMFS path, and referenced by path in the generated script (no large base64 embedded in PHP). The
generated PHP runs in `CLI_SCRIPT` mode, escapes all input via `escapePhp()`, uses `parseInt` for
ids, installs a graceful `set_exception_handler` (JSON `{"ok":false}` + `exit(0)` instead of
killing WASM — see ADR-0005), and echoes JSON. `setConfig` / `setConfigs` are untouched.

## Consequences

### Positive

* **Blueprints reproduce real theme/plugin configuration**, including logos, favicons and image
  galleries — not just scalar settings.
* **Generic and reusable.** Nothing is hardcoded to Adaptable or any theme; any component/filearea
  works, so themes and plugins share one mechanism.
* **Scalar vs file config stay separate and explicit.** `setConfig` keeps its simple contract; the
  file path has its own steps with file-specific options.
* **No theme-specific code in the generic step**, and **one way to reference file bytes** — the
  existing resource system (no new fetch/CORS surface).
* **Consistent with the executor**: graceful, non-fatal, escaped, JSON-returning (ADR-0005).

### Negative / Risks

* **Some settings still need bespoke importers.** A plugin whose export format is custom (not a
  plain stored file plus a path) may need its own importer on top of these steps.
* **Filearea/itemid conventions vary.** A few settings deviate from `filearea = name` / `itemid = 0`;
  authors must set `filearea` / `itemid` explicitly for those.
* **`get_file_storage()` / `create_file_from_pathname()` are core Moodle APIs.** A future core
  change to the File API would require revisiting the generators.
* **Theme caches.** A stored theme file may not appear until caches rebuild; mitigated by
  `purgeCaches: true` or a later `setTheme` step (documented).

## Implementation Notes

### Files added
* `src/blueprint/steps/moodle-config-files.js` — `setConfigFile` / `setConfigFiles` handlers
  (validation, resource resolution to temp paths, defaults, PHP-failure surfacing).
* `tests/blueprint/moodle-config-files.test.js` — handler tests (defaults, overrides, validation,
  `setConfigValue: false`, `purgeCaches`, multi-file).

### Files modified
* `src/blueprint/php/helpers.js` — `phpSetConfigFile`, `phpSetConfigFiles`, and a shared
  `GRACEFUL_HANDLER` hoisted near `CLI_HEADER` for reuse.
* `src/blueprint/steps/index.js` — register the new step group.
* `src/blueprint/schema.js`, `assets/blueprints/blueprint-schema.json` — add the 2 step names.
* `tests/blueprint/steps.test.js`, `tests/blueprint/schema.test.js`,
  `tests/blueprint/php-helpers.test.js` — extend coverage (registration, validation, generators).
* `docs/blueprint-json.md` — new "File-backed configuration settings" section with examples.

## Review Criteria

* If Moodle core changes the File API (`get_file_storage`, `create_file_from_pathname`,
  `delete_area_files`) or the `admin_setting_configstoredfile` storage convention, re-verify the
  generators against a real file-backed setting.
* If a plugin's file setting uses a non-standard filearea/itemid or a custom export format,
  reconsider whether a bespoke importer is warranted on top of these steps.
* If the resource system gains new descriptor types, confirm both steps still resolve `data`
  through `resources.resolve()` unchanged.
