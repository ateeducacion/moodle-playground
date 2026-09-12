---
name: blueprint-provisioning
description: Implement or debug Moodle Playground blueprint schemas, resources, step handlers, and provisioning PHP. Not WordPress Blueprints.
metadata:
  author: moodle-playground
  version: "1.0"
---

# Blueprint Provisioning System Expert

## Architecture overview

```
Blueprint JSON
  → parser.js (parse JSON / base64 / data-URL / object)
  → schema.js (validate structure, steps, resources)
  → constants.js (substitute {{KEY}} placeholders)
  → resources.js (resolve resource references)
  → executor.js (run steps sequentially with progress)
    → steps/*.js (individual step handlers)
      → php/helpers.js (generate PHP code)
        → php.run() (execute in WASM PHP)
```

## Schema and step reference

Use [the blueprint reference](../../../docs/blueprints/reference.md) for JSON shapes,
resources, and step-specific options; [examples](../../../docs/blueprints/examples.md)
for complete blueprints. Read only the relevant sections.

The executable validator is `src/blueprint/schema.js`; the public schema is
`assets/blueprints/blueprint-schema.json`; the registry is `src/blueprint/steps/index.js`.
Check the handler and current exports in `src/blueprint/php/helpers.js` before using
an API name. `installMoodle` is declarative; bootstrap performs the install.

## PHP code generation (`php/helpers.js`)

### Design principles

1. **CLI_SCRIPT mode**: Provisioning scripts define `CLI_SCRIPT` before loading Moodle;
   `login` authenticates through HTTP instead.
2. **Single-script batch**: Plural steps (e.g., `createUsers`) generate ONE PHP script
   that processes all entities — avoids per-entity `php.run()` overhead
3. **Moodle API calls**: Use official APIs (`user_create_user()`, `create_course()`, etc.)
   where possible; fall back to direct `$DB->insert_record()` where WASM SQLite compat
   requires it (see ADR-0003 for course modules)
4. **Error reporting**: Reuse `steps/check-result.js` and the existing `ok`/`error`
   response convention; preserve graceful exception handling (ADR-0005).
5. **Escaping**: All user-provided strings are escaped with `escapePhp()` before
   embedding in generated PHP code

### Direct DB insert pattern (ADR-0003)

For course modules, Moodle's `add_moduleinfo()` API calls functions that are incompatible
with SQLite in WASM. The blueprint system uses direct DB inserts instead:

```php
// Instead of: add_moduleinfo($moduleinfo)
// We do:
$module = $DB->get_record('modules', ['name' => 'label']);
$instance = $DB->insert_record('label', ['course' => $courseid, 'name' => $name, ...]);
$cmid = $DB->insert_record('course_modules', [
    'course' => $courseid,
    'module' => $module->id,
    'instance' => $instance,
    'section' => $sectionid,
    // ...
]);
// Update section sequence
$section = $DB->get_record('course_sections', ['id' => $sectionid]);
$section->sequence = trim($section->sequence . ',' . $cmid, ',');
$DB->update_record('course_sections', $section);
// Create context
context_module::instance($cmid);
```

## Resources

Use the shapes in [the blueprint reference](../../../docs/blueprints/reference.md)
and the resolver in `src/blueprint/resources.js`. Batch payloads use the shared
`src/blueprint/steps/payload.js`; reuse it instead of adding per-step parsers.

## Plugin installation flow

`installMoodlePlugin` and `installTheme` follow this pipeline:

1. **Parse URL**: Extract plugin type and name from GitHub URL or explicit fields
2. **Auto-detect** (ADR-0002): If type/name not specified, infer from GitHub repo URL
   and `version.php` contents
3. **Download ZIP**: Fetch from URL (GitHub releases via jsDelivr CDN for CORS)
4. **Extract**: Unzip into the correct Moodle plugin directory
5. **Register**: Update `alternative_component_cache` so Moodle discovers the plugin
6. **Upgrade**: Run `upgrade_noncore()` to trigger the plugin's install/upgrade scripts

### GitHub URL auto-detection

```
https://github.com/owner/moodle-mod_customcert
  → type: mod, name: customcert

https://github.com/owner/moodle-block_xp
  → type: block, name: xp

https://github.com/owner/moodle-theme_moove
  → type: theme, name: moove
```

Pattern: `moodle-{type}_{name}` in the repo name. Falls back to reading `version.php`
from the extracted ZIP.

## Executor behavior

### Step execution

Steps run **sequentially** in array order. Each step:
1. Receives the step config object and execution context
2. Performs its operation (usually via `php.run()`)
3. Returns success/failure
4. Reports progress to the main thread

### Error handling (ADR-0005)

By default, step failures are **non-fatal** — the executor logs the error and continues
with the next step. This prevents a single bad step from breaking the entire blueprint.

Steps can be marked as critical:
```json
{ "step": "installMoodle", "critical": true }
```

Critical step failure halts execution.

### Constant substitution

`{{KEY}}` patterns in string values are replaced with values from the `constants` object.
Substitution is recursive (works in nested objects and arrays) but not in keys.

```json
{
    "constants": { "SITE": "My School" },
    "steps": [
        { "step": "setConfig", "name": "fullname", "value": "{{SITE}} Moodle" }
    ]
}
```

## Testing

Blueprint tests live in `tests/blueprint/` and cover:
- Parsing (JSON, base64, data-URL, raw objects)
- Schema validation (required fields, step types, resource types)
- Constant substitution (strings, nested objects, arrays)
- Resource resolution
- Executor behavior (ordering, failures, progress, critical steps)
- PHP code generation (escaping, CLI header, all Moodle API generators)
- Plugin installation (URL parsing, auto-detection, ZIP extraction)

Run with: `npm run test:blueprint`

## Checklist for blueprint changes

- [ ] Is the new step type registered in `src/blueprint/steps/index.js`?
- [ ] Is the step documented in `docs/blueprints/reference.md`?
- [ ] Is the step added to `assets/blueprints/blueprint-schema.json`?
- [ ] Does the PHP code use `CLI_SCRIPT` mode?
- [ ] Are all user strings escaped with `escapePhp()`?
- [ ] Does the step work with SQLite (no MySQL-only syntax)?
- [ ] Are there unit tests in `tests/blueprint/`?
- [ ] Does batch mode generate a single PHP script, not per-entity calls?
- [ ] Is error handling graceful (non-fatal by default)?
- [ ] Does the step report meaningful progress messages?

Rebuild with `npm run build-worker` after blueprint edits and clear Service Worker
caches before browser verification; source unit tests do not detect stale bundles.
