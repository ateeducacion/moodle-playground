# Blueprint reference

The complete reference for blueprint files: top-level fields, constants,
resources, and every step. For a conceptual introduction see the
[Overview](index.md); for ready-to-run files see the [Examples](examples.md).
PHP/Moodle version selection lives in [Runtime and versions](runtime.md).

Machine-readable schema:
[`blueprint-schema.json`](https://ateeducacion.github.io/moodle-playground/assets/blueprints/blueprint-schema.json).

A blueprint is a JSON document describing the desired state of an instance at
boot. Steps run in order.

```json
{
  "$schema": "https://ateeducacion.github.io/moodle-playground/assets/blueprints/blueprint-schema.json",
  "preferredVersions": { "php": "8.3", "moodle": "5.0" },
  "landingPage": "/my/",
  "constants": { "SITE_NAME": "My Moodle" },
  "steps": [
    { "step": "installMoodle", "options": { "siteName": "{{SITE_NAME}}" } },
    { "step": "login", "username": "admin" }
  ]
}
```

## Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `steps` | array | yes | Ordered list of step objects (each needs a `step` name). |
| `constants` | object | no | `{{KEY}}` → string map, substituted everywhere before steps run. |
| `resources` | object | no | Named file descriptors referenced as `@name`. |
| `runtime` | object | no | Boot-time `config.php` settings: `debug` (`0`/`5`/`15`/`32767`) and `debugdisplay` (`0`/`1`). See [Runtime and versions](runtime.md). |
| `phpConstants` | object | no | PHP constants defined in `config.php` before `lib/setup.php`. Name → boolean / string / number. See [PHP constants](#php-constants). |
| `landingPage` | string | no | Path opened after boot. Must start with `/`. |
| `preferredVersions` | object | no | `{ "php": "8.3", "moodle": "5.0" }` — preferred runtime, subject to compatibility fallback. See [Runtime and versions](runtime.md). |
| `$schema` | string | no | Informational schema reference. |

## Constants

`constants` defines `{{KEY}}` placeholders that are replaced (deep, in every
string) before any step executes.

```json
{
  "constants": { "ADMIN_EMAIL": "admin@example.com" },
  "steps": [
    { "step": "installMoodle", "options": { "adminEmail": "{{ADMIN_EMAIL}}" } }
  ]
}
```

Context constants `{{REPO}}`, `{{OWNER}}`, `{{REF}}` / `{{BRANCH}}` are derived
from the `repo` / `owner` / `branch` (alias `ref`) URL parameters and merged
*over* the blueprint's own `constants`. This lets one committed blueprint target
the branch it is previewed for. See [URL parameters](../url-parameters.md).

## PHP constants

`phpConstants` defines PHP constants in the booted Moodle's `config.php`, before
`require_once(lib/setup.php)`, so they are available on every request. Each entry is
emitted as a guarded `define()`:

```json
{
  "phpConstants": {
    "MY_FLAG": true,
    "MY_LABEL": "demo",
    "MY_LIMIT": 50
  }
}
```

produces, in `config.php`:

```php
if (!defined('MY_FLAG')) { define('MY_FLAG', true); }
if (!defined('MY_LABEL')) { define('MY_LABEL', 'demo'); }
if (!defined('MY_LIMIT')) { define('MY_LIMIT', 50); }
```

Values may be boolean, string or number; constant names must match
`^[A-Z_][A-Z0-9_]*$` (other names are skipped). This lets a plugin's own blueprint
enable plugin-specific configuration without the playground engine knowing anything
plugin-specific. For example, `mod_exelearning` declares
`"phpConstants": { "EXELEARNING_UNSAFE_LEGACY_IFRAME": true }` so its demo renders the
content iframe same-origin (the php-wasm service worker cannot serve an opaque subframe);
real Moodle never defines that constant.

## Resources

A resource is a named descriptor with **exactly one** source key. Reference it
from a step with the string `"@name"`, or inline the descriptor directly.

| Key | Value |
|-----|-------|
| `url` | Fetch over HTTP(S) (~30 s timeout, ~50 MB cap). |
| `base64` | Inline base64 data. |
| `data-url` | A `data:` URI. |
| `bundled` | Path relative to the app bundle. |
| `vfs` | Path already in the runtime filesystem. |
| `literal` | Inline string or object value. |

```json
{
  "resources": {
    "backup": { "url": "https://example.com/course.mbz" }
  },
  "steps": [
    { "step": "restoreCourse", "data": "@backup", "category": "Demo" }
  ]
}
```

## Steps

!!! note "Legend"
    **(HTTP)** runs over an HTTP request (for session cookies); all other PHP
    steps run via CLI. **(marker)** does no work itself. **(non-fatal)** reports
    a failure but does not abort the rest of the blueprint. Unmarked steps abort
    the blueprint on error. Batch steps take an array under the named field.

### Install and auth

**`installMoodle`** (marker) — install already runs in `bootstrap.js`; this
records install options consumed at boot under `options`: `adminUser`,
`adminPass`, `adminEmail`, `siteName`, `locale`, `timezone`.

```json
{ "step": "installMoodle", "options": { "siteName": "My Moodle", "locale": "en" } }
```

**`setAdminAccount`** — update the admin account. Optional: `password`, `email`,
`firstname`, `lastname` (`username` is ignored).

```json
{ "step": "setAdminAccount", "password": "s3cret", "email": "me@example.com" }
```

**`login`** (HTTP) — start a session. Optional: `username` (default `admin`).

```json
{ "step": "login", "username": "admin" }
```

### Configuration

**`setConfig`** — required `name`. Optional: `value` (default `""`), `plugin`.

```json
{ "step": "setConfig", "name": "enablebadges", "value": "1" }
```

**`setConfigs`** (batch) — required `configs` (array of `{name,value,plugin?}`).

**`setTheme`** — required `name` (theme directory, e.g. `boost`, `moove`).

```json
{ "step": "setTheme", "name": "moove" }
```

**`setLandingPage`** (marker) — required `path`. Overrides top-level `landingPage`.

```json
{ "step": "setLandingPage", "path": "/my/" }
```

### Users

**`createUser`** — required `username`. Optional: `password` (default
`password`), `email` (default `<username>@example.com`), `firstname` (default
username), `lastname` (default `User`).

```json
{ "step": "createUser", "username": "teacher1", "firstname": "Ada" }
```

**`createUsers`** (batch) — required `users` (array of user objects).

### Categories

**`createCategory`** — required `name`. Optional: `description`, `parent`
(parent category name).

```json
{ "step": "createCategory", "name": "Science" }
```

**`createCategories`** (batch) — required `categories` (array).

### Courses

**`createCourse`** — required `fullname`, `shortname`. Optional: `category`
(name; defaults to the top category), `summary`, `format` (default `topics`),
`numsections` (default `5`).

```json
{ "step": "createCourse", "fullname": "Intro to Moodle", "shortname": "M101" }
```

**`createCourses`** (batch) — required `courses` (array).

**`createSection`** — required `course` (shortname). Optional: `name`,
`position` (default `0`).

```json
{ "step": "createSection", "course": "M101", "name": "Week 1" }
```

**`createSections`** (batch) — required `sections` (array).

### Enrolment

**`enrolUser`** — required `username`, `course` (shortname). Optional: `role`
(default `student`).

```json
{ "step": "enrolUser", "username": "teacher1", "course": "M101", "role": "editingteacher" }
```

**`enrolUsers`** (batch) — required `enrolments` (array of `{username,course,role?}`).

### Modules

**`addModule`** — required `module` (e.g. `label`, `assign`, `folder`, `board`),
`course` (shortname). Optional: `section` (default `0`), `name`, `intro`,
`files` (array). Any extra field is written to the module's database record.
Each `files` entry needs `filename` and `data` (resource descriptor); optional
`filearea` (default `content`), `itemid` (default `0`), `filepath` (default `/`).
Install third-party modules with `installMoodlePlugin` first.

```json
{ "step": "addModule", "module": "assign", "course": "M101", "section": 1, "name": "Homework 1" }
```

### Course restore

**`restoreCourse`** (non-fatal) — required: one source, precedence `url` >
`path` > `data` (resource descriptor or `@name`). Optional: `category` (name,
auto-created), `createCategory` (default `true`), `fullname`, `shortname`,
`visible` (default `true`). Large backups can exhaust WASM memory.

```json
{ "step": "restoreCourse", "url": "https://example.com/course.mbz", "category": "Demo" }
```

### Roles

**`createRole`** — required `shortname`. Optional: `name`, `description`,
`archetype`, `resetToArchetype`, `contextlevels` (names or numbers),
`capabilities` (`{cap: allow|prevent|prohibit|inherit}`), `allowAssign`,
`allowOverride`, `allowSwitch`, `allowView` (arrays of role shortnames).

```json
{ "step": "createRole", "shortname": "coordinator", "archetype": "editingteacher" }
```

**`createRoles`** (batch) — required `roles` (array, `@resource`, or URL — JSON).

**`importRolePreset`** — required: one of `xml` (inline role-preset XML) or
`resource` (`@name` / descriptor resolving to XML). Uses Moodle's own parser.

```json
{ "step": "importRolePreset", "resource": "@coordinatorXml" }
```

**`importRoles`** (batch) — required `roles` (array of XML references:
`@name`, raw XML, `{ "xml": "..." }`, or a resource descriptor).

### Scales

**`createScale`** — required `name`, `items` (array or comma-separated string,
low→high). Optional: `description`, `course` (shortname; omit for site-wide).

```json
{ "step": "createScale", "name": "Competency", "items": ["Not yet", "Competent"] }
```

**`createScales`** (batch) — required `scales` (array, `@resource`/URL, or the
`{ "format": "moodle-scale-export", "scales": [...] }` export envelope).

### Cohorts

**`createCohort`** — required `name`. Optional: `idnumber` (idempotency key),
`description`, `visible` (default `true`), `members` (array of existing usernames).

```json
{ "step": "createCohort", "name": "Staff 2026", "idnumber": "staff2026" }
```

**`createCohorts`** (batch) — required `cohorts` (array, `@resource`, or URL).

### Plugins and themes

**`installMoodlePlugin`** — required `url` (GitHub archive ZIP). Optional:
`pluginType`, `pluginName` (auto-detected from the repo name, e.g.
`moodle-mod_board` → `mod` / `board`).

```json
{ "step": "installMoodlePlugin", "url": "https://github.com/brickfield/moodle-mod_board/archive/refs/heads/MOODLE_405_STABLE.zip" }
```

**`installTheme`** — required `url` (ZIP). Optional: `pluginName` (auto-detected).
Installs files only — pair with `setTheme` to activate.

```json
{ "step": "installTheme", "url": "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/MOODLE_500_STABLE.zip" }
```

### Languages

**`installLanguagePack`** (non-fatal) — required: one of `language`,
`languages`, or `lang` (a code, a comma-separated string, or an array; codes
match `^[a-z][a-z0-9_]*$`). Optional: `setDefault` (default `false`). Parent
languages are pulled automatically.

```json
{ "step": "installLanguagePack", "language": "es", "setDefault": true }
```

!!! tip
    Setting the site language (`installMoodle` `options.locale`) already
    installs that pack on boot. Use this step only for **extra** languages or to
    install without changing the default.

### File-backed config settings

These register a file with Moodle's File API and point a setting at it (needed
for logos, favicons, theme images — `setConfig` alone cannot do this).

**`setConfigFile`** — required `plugin`, `name`, `filename`, `data` (resource
descriptor). Optional: `filearea` (default = `name`), `itemid` (default `0`),
`filepath` (default `/`), `replace` (default `true`), `setConfigValue` (default
`true`), `purgeCaches` (default `false`), `author`, `license`, `source`,
`userid` (default site admin).

```json
{ "step": "setConfigFile", "plugin": "theme_boost", "name": "logo", "filename": "logo.png", "data": { "url": "https://example.com/logo.png" } }
```

**`setConfigFiles`** (batch) — required `plugin`, `name`, `files` (non-empty
array; each entry needs `filename` and `data`). Top-level optional fields act as
defaults; the config value points at the first stored file.

### Filesystem

**`mkdir`** — required `path` (created recursively).

**`rmdir`** — required `path`. Optional: `recursive` (default `false`).

**`writeFile`** — required `path`, `data` (string, `@reference`, or resource
descriptor).

```json
{ "step": "writeFile", "path": "/www/moodle/note.txt", "data": "hello" }
```

**`writeFiles`** (batch) — required `files` (array of `{path,data}`).

**`copyFile`** — required `from`, `to`.

**`moveFile`** — required `from`, `to`.

**`deleteFile`** — required `path` (idempotent: a missing path is skipped).

**`deleteFiles`** (batch) — required `files` (array of string paths or `{path}`).

**`unzip`** — required `data` (resource), `destination` (alias `path`).

```json
{ "step": "unzip", "data": "@archive", "destination": "/www/moodle/local/x" }
```

### Requests and code

**`request`** (HTTP) — all optional: `url` (default the site root), `method`
(default `GET`), `headers`, `body`, `expectOk` (default `true` — a status
`>= 400` aborts).

```json
{ "step": "request", "url": "http://localhost:8080/admin/cron.php" }
```

**`runPhpCode`** — required `code` (runs via CLI; `<?php` optional).

```json
{ "step": "runPhpCode", "code": "set_config('country', 'ES');" }
```

**`runPhpScript`** (HTTP) — required `code`. Optional: `expectOk` (default
`true`). Written to a temp file and executed over HTTP.

### PR overlay

**`applyPrOverlay`** — required: one of `files` (pre-resolved manifest),
`repo` + `pr`, or `repo` + `base` + `head`. Optional: `baseRef`,
`runUpgrade` (`off` / `on` / `auto`, default `auto` — non-fatal best-effort),
`root` (default `/www/moodle`), `proxy`, `maxFiles` (default `200`),
`maxFileBytes` (default `5 MiB`), `purgeCaches` (default `true`). `base`
defaults to `main`. See [PR previews](../github/pr-previews.md).

```json
{ "step": "applyPrOverlay", "repo": "moodle/moodle", "pr": 532, "runUpgrade": "auto" }
```

**`purgeMoodleCaches`** — no fields. Resets caches and the component registry
(run automatically by `applyPrOverlay`).

```json
{ "step": "purgeMoodleCaches" }
```

## Execution model

- Steps run **sequentially** in array order.
- Most steps run PHP in `CLI_SCRIPT` mode. `login`, `request`, and
  `runPhpScript` run over HTTP; `installMoodle` and `setLandingPage` are markers.
- By default a failing step **stops** the blueprint and reports the error.
- **Non-fatal steps** report the failure and continue: `restoreCourse` and
  `installLanguagePack`. For `applyPrOverlay`, an unreachable or oversized
  individual file is skipped, and the cache-purge and upgrade phases are
  best-effort — but manifest resolution and the `maxFiles` cap still abort.
- The `createRole` / `createScale` / `createCohort` / `importRoles` generators
  silently skip *references* to capabilities, roles, or users that do not exist,
  but a missing required field or a PHP error still aborts the blueprint.

See the [Examples](examples.md) for complete, working blueprints.
