---
name: blueprint-provisioning
description: Blueprint provisioning system expert. Use when working with blueprint JSON files, step handlers, the executor engine, resource resolution, PHP code generation for Moodle provisioning, or adding new blueprint step types. Covers the full pipeline from blueprint parsing through validation, constant substitution, resource loading, step execution, and progress reporting.
metadata:
  author: moodle-playground
  version: "1.0"
---

# Blueprint Provisioning System Expert

## Role

You are an expert in the Moodle Playground blueprint system — a declarative, step-based
JSON format for describing the desired state of a playground instance. You understand
the full pipeline from blueprint parsing through execution, and you know how to write
PHP code generators that use Moodle's APIs correctly in CLI mode.

## When to activate

- Adding new blueprint step types
- Modifying existing step handlers (`src/blueprint/steps/`)
- Working with the blueprint schema or validation (`src/blueprint/schema.js`)
- Generating PHP code for Moodle provisioning (`src/blueprint/php/helpers.js`)
- Debugging blueprint execution failures
- Working with resource resolution (URL, base64, bundled, VFS, literal)
- Modifying the blueprint executor or progress reporting
- Writing or updating blueprint examples

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

### Key files

| File | LOC | Responsibility |
|------|-----|----------------|
| `src/blueprint/parser.js` | 87 | Parse JSON, base64, data-URL, object inputs |
| `src/blueprint/schema.js` | 149 | Hand-written validator (no library dependencies) |
| `src/blueprint/constants.js` | 32 | `{{KEY}}` substitution in string values |
| `src/blueprint/resources.js` | 155 | `ResourceRegistry` for multi-format resources |
| `src/blueprint/resolver.js` | 127 | Blueprint source resolution (URL, inline, sessionStorage) |
| `src/blueprint/executor.js` | 88 | Sequential step runner with error handling |
| `src/blueprint/storage.js` | 34 | sessionStorage persistence |
| `src/blueprint/index.js` | 57 | Public API re-exports |
| `src/blueprint/php/helpers.js` | 397 | PHP code generation for Moodle API calls |
| `src/blueprint/steps/` | ~1700 | 20 handler files for 30+ step types |

## Blueprint JSON format

### Top-level structure

```json
{
    "$schema": "./assets/blueprints/blueprint-schema.json",
    "landingPage": "/course/view.php?id=2",
    "runtime": {
        "debug": 0,
        "debugdisplay": 0,
        "timezone": "Europe/Madrid"
    },
    "constants": {
        "COURSE_NAME": "My Course",
        "TEACHER_EMAIL": "teacher@example.com"
    },
    "resources": {
        "syllabus": {
            "type": "url",
            "url": "https://example.com/syllabus.pdf"
        }
    },
    "steps": [
        { "step": "installMoodle" },
        { "step": "createUser", "username": "teacher1", "email": "{{TEACHER_EMAIL}}" },
        { "step": "createCourse", "fullname": "{{COURSE_NAME}}", "shortname": "C1" },
        { "step": "enrolUser", "username": "teacher1", "course": "C1", "role": "editingteacher" }
    ]
}
```

### Step types (30+)

#### Installation and config
| Step | Description |
|------|-------------|
| `installMoodle` | Declarative marker — actual install runs in bootstrap.js |
| `setAdminAccount` | Set admin username, password, email |
| `login` | Authenticate a user via HTTP (creates session cookie) |
| `setConfig` | Set a single `$CFG` or admin setting |
| `setConfigs` | Set multiple settings in one step |
| `setLandingPage` | Override the default landing page URL |

#### Users and enrollment
| Step | Description |
|------|-------------|
| `createUser` | Create a single user |
| `createUsers` | Create multiple users in one PHP execution |
| `enrolUser` | Enrol a user in a course with a role |
| `enrolUsers` | Bulk enrollment |

#### Course structure
| Step | Description |
|------|-------------|
| `createCategory` | Create a course category |
| `createCategories` | Create multiple categories |
| `createCourse` | Create a single course |
| `createCourses` | Create multiple courses |
| `createSection` | Add a section to a course |
| `createSections` | Add multiple sections |

#### Activities and modules
| Step | Description |
|------|-------------|
| `addModule` | Add an activity module (label, assign, folder, forum, page, url, etc.) |

Supported module types via `addModule`:
- `label` — Text/HTML label in a section
- `assign` — Assignment activity
- `folder` — Folder resource (with file upload support)
- `page` — Page resource
- `url` — URL resource
- `forum` — Forum activity
- `choice` — Choice activity
- `quiz` — Quiz activity (structure only, no questions)
- `glossary` — Glossary activity
- `wiki` — Wiki activity
- `feedback` — Feedback activity
- `lesson` — Lesson activity
- `workshop` — Workshop activity
- `data` — Database activity
- `lti` — External tool (LTI)
- `scorm` — SCORM package (requires resource)
- `h5pactivity` — H5P activity

#### Plugins and themes
| Step | Description |
|------|-------------|
| `installMoodlePlugin` | Download and install a Moodle plugin from ZIP URL |
| `installTheme` | Download and install a theme (alias with theme-specific defaults) |

#### Filesystem and code execution
| Step | Description |
|------|-------------|
| `mkdir` | Create a directory in MEMFS |
| `rmdir` | Remove a directory |
| `writeFile` | Write content to a file |
| `writeFiles` | Write multiple files |
| `copyFile` | Copy a file within MEMFS |
| `moveFile` | Move/rename a file |
| `unzip` | Extract a ZIP archive |
| `request` | Make an HTTP request through the PHP runtime |
| `runPhpCode` | Execute arbitrary PHP code |
| `runPhpScript` | Execute a PHP script file |

## PHP code generation (`php/helpers.js`)

### Design principles

1. **CLI_SCRIPT mode**: All provisioning PHP runs with `define('CLI_SCRIPT', true)`
2. **Single-script batch**: Plural steps (e.g., `createUsers`) generate ONE PHP script
   that processes all entities — avoids per-entity `php.run()` overhead
3. **Moodle API calls**: Use official APIs (`user_create_user()`, `create_course()`, etc.)
   where possible; fall back to direct `$DB->insert_record()` where WASM SQLite compat
   requires it (see ADR-0003 for course modules)
4. **Error reporting**: PHP scripts should `echo json_encode(['success' => true, ...])` or
   throw/die with descriptive error messages
5. **Escaping**: All user-provided strings are escaped with `escapePHPString()` before
   embedding in generated PHP code

### Key helper functions

```javascript
// Generate CLI header (require config.php, set up globals)
buildCliHeader()

// Escape a string for embedding in PHP single-quoted strings
escapePHPString(str)

// Generate user creation PHP code
buildCreateUserPhp(userData)

// Generate course creation PHP code
buildCreateCoursePhp(courseData)

// Generate enrollment PHP code
buildEnrolUserPhp(enrolData)

// Generate module addition PHP code (delegates to type-specific generators)
buildAddModulePhp(moduleData)
```

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

## Resource system

Resources are named, typed data sources that steps can reference:

```json
{
    "resources": {
        "my-scorm": {
            "type": "url",
            "url": "https://example.com/package.zip"
        },
        "readme": {
            "type": "literal",
            "contents": "# Welcome\nThis is the course readme."
        },
        "logo": {
            "type": "base64",
            "data": "iVBORw0KGgo...",
            "mimeType": "image/png"
        }
    }
}
```

Resource types:

| Type | Source | Resolution |
|------|--------|-----------|
| `url` | HTTP URL | Fetched at execution time |
| `base64` | Base64-encoded string | Decoded in-memory |
| `literal` | Plain text string | Used directly |
| `bundled` | Path relative to assets/ | Loaded from app assets |
| `vfs` | Path in MEMFS | Read from virtual filesystem |

Steps reference resources by name with `@` prefix: `"resource": "@my-scorm"`.

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
- Resource resolution (all 5 types)
- Executor behavior (ordering, failures, progress, critical steps)
- PHP code generation (escaping, CLI header, all Moodle API generators)
- Plugin installation (URL parsing, auto-detection, ZIP extraction)

Run with: `npm run test:blueprint`

## Checklist for blueprint changes

- [ ] Is the new step type registered in `src/blueprint/steps/index.js`?
- [ ] Is the step documented in `docs/blueprint-json.md`?
- [ ] Is the step added to `assets/blueprints/blueprint-schema.json`?
- [ ] Does the PHP code use `CLI_SCRIPT` mode?
- [ ] Are all user strings escaped with `escapePHPString()`?
- [ ] Does the step work with SQLite (no MySQL-only syntax)?
- [ ] Are there unit tests in `tests/blueprint/`?
- [ ] Does batch mode generate a single PHP script, not per-entity calls?
- [ ] Is error handling graceful (non-fatal by default)?
- [ ] Does the step report meaningful progress messages?
