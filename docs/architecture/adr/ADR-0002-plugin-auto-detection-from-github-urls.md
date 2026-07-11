# ADR-0002 Plugin type and name auto-detection from GitHub URLs

* Status: Accepted
* Date: 2026-03-27

## Context and Problem

The `installMoodlePlugin` blueprint step previously required explicit `pluginType` and
`pluginName` fields for every plugin installation. This was redundant because GitHub
repositories for Moodle plugins follow a standard naming convention: `moodle-{type}_{name}`
(e.g., `moodle-mod_board`, `moodle-block_participants`, `moodle-local_staticpage`).

Requiring users to specify `pluginType: "mod"` and `pluginName: "board"` alongside a URL
that already encodes both values made blueprints verbose and error-prone — a mismatched
type/name pair would silently install files to the wrong directory.

## Options Considered

* **Option 1: Keep explicit fields as required** — No change. Users must specify both
  fields. Simple but creates unnecessary friction and copy-paste errors.

* **Option 2: Auto-detect from URL, allow explicit overrides** — Parse the GitHub
  archive URL to extract the repo name, split on `moodle-{type}_{name}`, and validate
  that the type maps to a known Moodle plugin directory. Users can still override
  either field for non-standard repos. Falls back to clear error messages if detection
  fails.

* **Option 3: Require a manifest or `version.php` file** — Download the ZIP first, read
  `version.php` to extract `$plugin->component`. Accurate but much slower and requires
  fetching the ZIP before validation.

## Decision

**Option 2**: Auto-detect plugin type and name from the GitHub URL, with explicit override
support.

The new `detectPluginTypeAndName(url)` function replaces the old `guessPluginNameFromUrl()`
and returns both `type` and `name` (previously only name was guessed, and type was always
required). The detection validates the extracted type against the known `PLUGIN_TYPE_DIRS`
mapping before accepting it.

Explicit `pluginType` and `pluginName` fields always take precedence, so the auto-detection
is a convenience default, not a constraint.

## Consequences

### Positive
* **Simpler blueprints** — A plugin install step can be just `{ "step": "installMoodlePlugin", "url": "https://github.com/..." }`.
* **Fewer errors** — The type and name are derived from the same URL, eliminating mismatches.
* **Backwards compatible** — Existing blueprints with explicit fields still work unchanged.
* **Clear errors** — If the URL doesn't follow the convention and no explicit fields are
  provided, the error message tells the user exactly what to add.
* **Tested** — `tests/blueprint/moodle-plugins.test.js` covers auto-detection for multiple
  plugin types, explicit overrides, unknown types, and plugin directory path mapping.

### Negative / Risks
* **Only works for GitHub archive URLs** — Non-GitHub sources or custom download URLs will
  still need explicit `pluginType` and `pluginName`.
* **Convention dependency** — If a plugin author doesn't follow the `moodle-{type}_{name}`
  convention, auto-detection fails (gracefully — with a clear error message).

## Implementation Notes

### Files modified
- `src/blueprint/steps/moodle-plugins.js` — New `detectPluginTypeAndName()` function
  replaces `guessPluginNameFromUrl()`. Both `handleInstallMoodlePlugin()` and
  `handleInstallTheme()` use auto-detection with explicit overrides.
- `tests/blueprint/moodle-plugins.test.js` — New test file with comprehensive coverage:
  registration, validation, auto-detection for multiple types, explicit overrides, path
  mapping for 13+ plugin types, sample URL validation.
- `blueprint-sample.json` — Updated to use URL-only syntax.
- `docs/blueprint-json.md` — Documented auto-detection behavior and field tables.

### Detection logic
1. Parse the URL to extract the pathname.
2. Match `/([^/]+)/archive/` to get the repository name.
3. Strip the `moodle-` prefix (case-insensitive).
4. Split on the first underscore: `{type}_{name}`.
5. Validate that `{type}` exists in `PLUGIN_TYPE_DIRS`.
6. Return `{ type, name }` or `{ type: null, name: null }` on failure.

## Review Criteria

- If Moodle Directory or other plugin registries become common download sources, add
  URL patterns for those as well.
- If the `moodle-{type}_{name}` convention changes or gains exceptions, update the regex.
