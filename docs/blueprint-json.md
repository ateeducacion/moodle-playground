# Moodle Playground Blueprint Format

Blueprints define the desired state of a Moodle Playground instance using a
step-based JSON format inspired by WordPress Playground Blueprints.

## Format Overview

```json
{
  "$schema": "./blueprint-schema.json",
  "preferredVersions": { "php": "8.3", "moodle": "5.0" },
  "landingPage": "/my/",
  "constants": { "ADMIN_USER": "admin" },
  "resources": {
    "myFile": { "url": "https://example.com/file.zip" }
  },
  "steps": [
    { "step": "installMoodle", "options": { "siteName": "My Moodle" } },
    { "step": "login", "username": "{{ADMIN_USER}}" }
  ]
}
```

## Blueprint Sources

Blueprints can be loaded from:

| Source | Example |
|--------|---------|
| `?blueprint=` query param | Inline JSON, base64-encoded JSON, or `data:` URL |
| `?blueprint-url=` query param | URL to a remote `.blueprint.json` file |
| sessionStorage | Persisted from a previous load in the same tab |
| Default blueprint URL | Configured in `playground.config.json` |
| Built-in default | Minimal install + login |

### Inline Blueprint (base64)

Encode your blueprint as base64 and pass it as the `?blueprint=` parameter:

```
https://example.com/moodle-playground/?blueprint=eyIkc2NoZW1hIjoi...
```

### Data URL

```
https://example.com/moodle-playground/?blueprint=data:application/json;base64,eyIkc2NoZW1hIjoi...
```

## Runtime Configuration

The `runtime` object controls low-level PHP/Moodle settings applied at boot time
via `config.php`. These settings take effect before any blueprint steps execute.

```json
{
  "runtime": {
    "debug": 32767,
    "debugdisplay": 1
  }
}
```

### Debug Settings

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `debug` | integer | `0` | Initial Moodle debug level stored at boot; editable later in Moodle administration |
| `debugdisplay` | integer | `0` | Display debug messages on page (`1`) or only log them (`0`) |

#### Debug Levels

| Value | Name | Description |
|-------|------|-------------|
| `0` | NONE | Do not show any errors or warnings |
| `5` | MINIMAL | Show only fatal errors |
| `15` | NORMAL | Show errors, warnings and notices |
| `32767` | DEVELOPER | Extra Moodle debug messages for developers |

When `debugdisplay` is `1`, PHP `display_errors` is also enabled so that PHP-level
errors appear on the page. `debug` is not locked in `config.php`; it is seeded into
Moodle's stored configuration at boot, so it can still be changed later from the
site administration UI. When `debug` is `32767` (DEVELOPER), Moodle treats the
runtime as developer mode after boot.

These settings can also be changed from the Settings dialog in the playground UI
without editing the blueprint JSON directly. The playground UI resets the initial
boot values; Moodle's own admin settings can still change the debug level afterward.

For ad hoc browser debugging, you can also use a URL override instead of editing
the blueprint:

```text
http://localhost:8080/?debug=true
```

This applies to the current boot only and forces developer debug mode with
`debugdisplay=1` and PHP `display_errors=1`.

### Runtime Constants

Moodle Playground defines `MOODLE_PLAYGROUND` in the generated `config.php` on
every boot:

```php
if (defined('MOODLE_PLAYGROUND') && MOODLE_PLAYGROUND) {
    // Runtime-specific behavior for Moodle Playground.
}
```

This constant is intended as the public runtime marker for Moodle plugins that
need to adapt behavior when running inside the browser/WASM environment.

For same-origin proxy access from PHP, Moodle Playground also defines
`MOODLE_PLAYGROUND_PROXY_URL` in `config.php`. Use it only when a plugin wants
an explicit playground-only proxy contract instead of relying on direct
outbound PHP networking with optional `phpCorsProxyUrl` fallback. If you do
use it, prefer that constant over deriving a proxy path from `$CFG->wwwroot`,
because the worker runtime is served from a scoped
`/playground/<scope>/<runtime>/...` URL:

```php
if (defined('MOODLE_PLAYGROUND_PROXY_URL') && MOODLE_PLAYGROUND_PROXY_URL !== '') {
    $url = MOODLE_PLAYGROUND_PROXY_URL . '?' . http_build_query([
        'repo' => 'owner/repo',
        'atom' => 'releases',
    ]);
}
```

When `playground.config.json` defines `phpCorsProxyUrl`, Moodle Playground uses
that proxy as the browser-side fallback for outbound HTTP(S) requests made from
PHP itself (`curl`, `file_get_contents()`, etc.) via the `@php-wasm/web`
TCP-over-fetch transport. This is separate from `addonProxyUrl`, which is used
for browser-side addon ZIP downloads and as the upstream target for the
optional same-origin Service Worker proxy endpoint.

`MOODLE_PLAYGROUND_PROXY_URL` remains the explicit same-origin PHP networking
endpoint exposed by the runtime. In the current repo configuration, the tested
direct GitHub feed and release asset URLs also work through PHP WASM networking,
so this constant is optional rather than mandatory for those cases.

## Constants

The `constants` object defines `{{KEY}}` placeholders that are substituted into
all string values in the blueprint before execution:

```json
{
  "constants": {
    "SITE_NAME": "My School",
    "ADMIN_EMAIL": "admin@school.edu"
  },
  "steps": [
    {
      "step": "installMoodle",
      "options": { "siteName": "{{SITE_NAME}}", "adminEmail": "{{ADMIN_EMAIL}}" }
    }
  ]
}
```

### Context constants (`{{REPO}}` / `{{REF}}`)

When a blueprint is loaded through `?blueprint-url=`, the playground derives a
few **context constants** from that URL and merges them *over* the blueprint's
own `constants`. This lets a single committed `blueprint.json` install the
plugin from whatever branch it is being previewed for — without hard-coding
`main`:

| Constant     | Value                                                        |
| ------------ | ----------------------------------------------------------- |
| `{{REPO}}`   | `owner/repo` the blueprint was fetched for                  |
| `{{OWNER}}`  | the owner segment of `{{REPO}}`                             |
| `{{REF}}` / `{{BRANCH}}` | the branch / tag / commit the blueprint was fetched at |

They are derived, in increasing priority, from:

1. the `?blueprint-url=` value's own query — the github-proxy form
   `…/?repo={owner/repo}&branch={ref}&path=blueprint.json` (slash-safe, since
   the ref is a query param);
2. a `raw.githubusercontent.com/{owner}/{repo}/{ref}/…` `?blueprint-url=`;
3. explicit `?repo=` / `?ref=` (or `?owner=` / `?branch=`) on the playground URL.

Author your blueprint with safe defaults so direct opens still work, and let the
context override them for previews:

```json
{
  "constants": { "REPO": "ateeducacion/mod_exelearning", "REF": "main" },
  "steps": [
    {
      "step": "installMoodlePlugin",
      "pluginType": "mod",
      "pluginName": "exelearning",
      "url": "https://github.com/{{REPO}}/archive/refs/heads/{{REF}}.zip"
    }
  ]
}
```

> The `?path=` mode of the github-proxy serves a single raw repo file (e.g. the
> branch's `blueprint.json`) with CORS, so the preview link can stay short
> (`?blueprint-url=` instead of a giant base64 `?blueprint=`):
> `https://github-proxy.exelearning.dev/?repo={owner/repo}&branch={ref}&path=blueprint.json`.

## Resources

Named resources can be defined once and referenced from steps using `@name`:

```json
{
  "resources": {
    "courseBackup": { "url": "https://example.com/backup.mbz" },
    "readme": { "literal": "Hello World" },
    "logo": { "base64": "iVBORw0KGgo..." }
  }
}
```

### Resource Types

| Type | Key | Description |
|------|-----|-------------|
| URL | `url` | Fetch from HTTP(S) URL |
| Base64 | `base64` | Inline base64-encoded data |
| Data URL | `data-url` | `data:` URI with optional base64 |
| Bundled | `bundled` | Relative path within the app bundle |
| VFS | `vfs` | Path in the PHP virtual filesystem |
| Literal | `literal` | Inline string or object value |

## Step Types

### Installation & Auth

| Step | Description |
|------|-------------|
| `installMoodle` | Declarative marker — install runs automatically via snapshot/CLI |
| `setAdminAccount` | Update admin user's password, email, name |
| `login` | Create a session for a user (uses HTTP for cookies) |

### Configuration

| Step | Description |
|------|-------------|
| `setConfig` | Set a single Moodle config value |
| `setConfigs` | Set multiple config values in one call |
| `setLandingPage` | Override the post-boot landing page |

### Users

| Step | Description |
|------|-------------|
| `createUser` | Create a single user |
| `createUsers` | Create multiple users in a single PHP call |

### Categories & Courses

| Step | Description |
|------|-------------|
| `createCategory` / `createCategories` | Create course categories |
| `createCourse` / `createCourses` | Create courses |
| `createSection` / `createSections` | Add sections to courses |
| `restoreCourse` | Restore a Moodle course backup (`.mbz`) into a category |

### Enrolment

| Step | Description |
|------|-------------|
| `enrolUser` / `enrolUsers` | Enrol users into courses with roles |

### Roles, scales & cohorts

| Step | Description |
|------|-------------|
| `importRolePreset` / `importRoles` | Import native Moodle role preset XML (inline or by URL/resource) |
| `createRole` / `createRoles` | Define/customize roles from JSON (capabilities, context levels, relationships) |
| `createScale` / `createScales` | Create grading scales (inline, or from a scale-export JSON) |
| `createCohort` / `createCohorts` | Create site-level cohorts with optional members |

### Modules

| Step | Description |
|------|-------------|
| `addModule` | Add a course module (label, folder, assign, etc.) |

### Plugins

| Step | Description |
|------|-------------|
| `installMoodlePlugin` | Download a plugin ZIP, extract to the correct directory, and run Moodle upgrade |
| `installTheme` | Download a theme ZIP, extract, and run Moodle upgrade |

### Languages

| Step | Description |
|------|-------------|
| `installLanguagePack` | Install one or more language packs via Moodle's `lang_installer` (downloads from `download.moodle.org/langpack`) |

> **Tip:** you usually don't need this step. Setting the site language
> (`installMoodle` `options.locale`, or `siteOptions.locale`) auto-installs that pack on
> boot. Use `installLanguagePack` to add **extra** languages or install without changing the
> default. Both paths work in every browser (Chromium, Firefox, Safari). See
> [ADR-0006](decisions/0006-moodle-langpack-proxy-allowance.md).

### Filesystem

| Step | Description |
|------|-------------|
| `mkdir` | Create a directory |
| `rmdir` | Remove a directory |
| `writeFile` | Write a file from literal/resource data |
| `writeFiles` | Write multiple files |
| `copyFile` | Copy a file |
| `moveFile` | Move a file |
| `unzip` | Extract a ZIP archive |

### Low-level

| Step | Description |
|------|-------------|
| `request` | Execute an HTTP request through the PHP runtime |
| `runPhpCode` | Run arbitrary PHP code via CLI |
| `runPhpScript` | Write + execute a PHP script via HTTP |

## Step Examples

### installMoodle

```json
{
  "step": "installMoodle",
  "options": {
    "adminUser": "admin",
    "adminPass": "password",
    "adminEmail": "admin@example.com",
    "siteName": "My Moodle",
    "locale": "en",
    "timezone": "UTC"
  }
}
```

### createCourse

```json
{
  "step": "createCourse",
  "fullname": "Introduction to Moodle",
  "shortname": "MOODLE101",
  "category": "Playground Courses",
  "summary": "Learn how to use Moodle.",
  "format": "topics",
  "numsections": 10
}
```

### enrolUser

```json
{
  "step": "enrolUser",
  "username": "student1",
  "course": "MOODLE101",
  "role": "student"
}
```

### addModule

Adds a course module (activity) to an existing course. The `module` field is the
Moodle module name (e.g., `label`, `assign`, `folder`, `board`). For third-party
modules, install the plugin first with `installMoodlePlugin`.

```json
{
  "step": "addModule",
  "module": "assign",
  "course": "MOODLE101",
  "section": 1,
  "name": "First Assignment",
  "intro": "Submit your work here."
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `module` | yes | Module type name (`label`, `assign`, `folder`, `board`, etc.) |
| `course` | yes | Course shortname |
| `section` | no | Section number (default: 0) |
| `name` | no | Activity name (defaults to module type) |
| `intro` | no | Description HTML |
| `files` | no | Array of file descriptors to attach to the module (see below) |

Works with any installed module type, including plugins installed via
`installMoodlePlugin` in earlier blueprint steps. The module is created using
direct database inserts (not `add_moduleinfo()`) for SQLite WASM compatibility.

Any additional fields not listed above are copied directly to the module's
database record, allowing you to set module-specific columns (e.g.,
`exeorigin`, `exescormtype`, `grade`).

#### Attaching files to modules

Use the `files` array to upload files into a module's Moodle file storage area.
Each entry supports the same resource descriptors used by `writeFile` (`url`,
`base64`, `@reference`, etc.):

```json
{
  "step": "addModule",
  "module": "exeweb",
  "course": "EXEWEB01",
  "section": 1,
  "name": "My Content",
  "exeorigin": "local",
  "files": [
    {
      "filearea": "package",
      "filename": "content.elpx",
      "data": { "url": "https://example.com/content.elpx" }
    }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `filename` | yes | — | Name for the stored file |
| `data` | yes | — | Resource descriptor: `{"url": "..."}`, `{"base64": "..."}`, `"@resourceName"`, etc. |
| `filearea` | no | `content` | Moodle file area name (e.g., `package`, `content`, `intro`) |
| `itemid` | no | `0` | Item ID within the file area |
| `filepath` | no | `/` | Directory path within the file area |

Files are stored via Moodle's `get_file_storage()->create_file_from_pathname()`
using the module's context, with `mod_{module}` as the component name.

### installMoodlePlugin

Installs a Moodle plugin from a GitHub ZIP URL. Both `pluginType` and `pluginName`
are auto-detected from the GitHub repository name (e.g., `moodle-mod_board` →
type `mod`, name `board`). Only the `url` is required:

```json
{
  "step": "installMoodlePlugin",
  "url": "https://github.com/brickfield/moodle-mod_board/archive/refs/heads/MOODLE_405_STABLE.zip"
}
```

You can override the detected values if needed:

```json
{
  "step": "installMoodlePlugin",
  "pluginType": "block",
  "pluginName": "participants",
  "url": "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | yes | GitHub archive ZIP URL |
| `pluginType` | no | Auto-detected from URL. Override for non-standard repo names |
| `pluginName` | no | Auto-detected from URL. Override for non-standard repo names |

GitHub archive ZIPs are fetched through the configured addon proxy before
extraction, which avoids common browser CORS issues and supports branch names
that contain `/`.

Supported plugin types: `mod`, `block`, `local`, `theme`, `auth`, `enrol`, `filter`,
`format`, `report`, `tool`, `editor`, `atto`, `tiny`, `qtype`, `qbehaviour`,
`gradeexport`, `gradeimport`, `gradereport`, `repository`, `plagiarism`,
`availability`, `calendartype`, `message`, `profilefield`, `datafield`,
`assignsubmission`, `assignfeedback`, `booktool`, `quizaccess`, `ltisource`.

### installTheme

Downloads a Moodle theme ZIP and registers it with the Moodle upgrade pipeline.
This step only installs the files — it does **not** activate the theme. Pair it
with `setTheme` (below) to switch the site to the newly installed theme.

```json
{
  "step": "installTheme",
  "url": "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/MOODLE_500_STABLE.zip"
}
```

Theme name is auto-detected from the GitHub repository name (`moodle-theme_moove`
→ `moove`). Override it when the repo does not follow the `moodle-theme_<name>`
convention:

```json
{
  "step": "installTheme",
  "pluginName": "moove",
  "url": "https://example.com/custom-theme.zip"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `url` | yes | GitHub archive ZIP URL (or any direct ZIP URL) |
| `pluginName` | no | Auto-detected from URL. Override for non-standard repo names |

> Install and activation are intentionally separate steps. If the upgrade phase
> of `installTheme` fails but the files land on disk, the subsequent `setTheme`
> still activates the theme on the next request. See
> [ADR-0005](./decisions/0005-resilient-blueprint-step-execution.md) for the
> rationale.

### setTheme

Switches the active site theme by writing `$CFG->theme` and purging the Moodle
theme caches so the next page load serves the new CSS.

```json
{
  "step": "setTheme",
  "name": "moove"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Theme directory name under `/theme/<name>` (e.g. `boost`, `classic`, `moove`) |

Bundled themes (`boost`, `classic`) do not need `installTheme` — `setTheme` alone
is enough. For third-party themes, call `installTheme` first, then `setTheme`.

#### Popular free themes

Pin theme branches to match the Moodle version served by your playground build.
Moodle theme repositories follow the `MOODLE_<version>_STABLE` branch convention.

| Theme | Repository | Recommended ref |
|-------|------------|-----------------|
| **Boost** | bundled with Moodle | (no install required) |
| **Classic** | bundled with Moodle | (no install required) |
| **Moove** | [willianmano/moodle-theme_moove](https://github.com/willianmano/moodle-theme_moove) | `MOODLE_500_STABLE` or `MOODLE_405_STABLE` |
| **Adaptable** | [tonyjbutler/moodle-theme_adaptable](https://github.com/tonyjbutler/moodle-theme_adaptable) | `MOODLE_405_STABLE` |
| **Trema** | [tremadesigns/moodle-theme_trema](https://github.com/tremadesigns/moodle-theme_trema) | tag matching your Moodle branch |

Example — install Moove and make it the active theme:

```json
{
  "steps": [
    { "step": "installMoodle" },
    {
      "step": "installTheme",
      "url": "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/MOODLE_500_STABLE.zip"
    },
    { "step": "setTheme", "name": "moove" }
  ]
}
```

A ready-to-run version of this example ships as
`assets/blueprints/examples/visual-theme-moove.blueprint.json` in the
repository.

> **Compatibility tip:** third-party themes track Moodle's stable branches. If
> you see a blank page or the theme falls back to Boost, your Moove ref does
> not match the Moodle version used by this playground. Check the Moodle
> branch shown in the shell footer and swap the ref accordingly.

### installLanguagePack

Install one or more language packs. Uses Moodle's own `lang_installer`, which downloads the
correct pack for the running Moodle version from `download.moodle.org/langpack` (proxied — works
in every browser).

```json
{
  "step": "installLanguagePack",
  "language": "es",
  "setDefault": true
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `language` | yes | A language code (`"es"`), a comma-separated string (`"es,fr,ca"`), or an array (`["es", "fr"]`). Codes must match `/^[a-z][a-z0-9_]*$/` (e.g. `es`, `pt_br`). Aliases: `languages`, `lang`. |
| `setDefault` | no | When `true`, sets the installed language as the site default (`$CFG->lang`). Defaults to `false` (install only). |

The pack version is resolved automatically from the running Moodle branch — do not hardcode a
version. Parent languages are pulled automatically (e.g. `pt_br` also installs `pt`). A download
failure is non-fatal: the blueprint continues and Moodle falls back to English strings.

**Auto-install:** if you only need the site to be in one language, you usually don't need this
step at all — set the site language (`installMoodle` `options.locale`, or `siteOptions.locale`)
and the matching pack is installed automatically on boot:

```json
{
  "steps": [
    { "step": "installMoodle", "options": { "locale": "es" } }
  ]
}
```

Use `installLanguagePack` when you want **additional** languages available in the language menu,
or to install a pack without making it the default.

### restoreCourse

Restore a Moodle course backup (`.mbz`) into a category, using Moodle's own `restore_controller`.

```json
{
  "step": "restoreCourse",
  "url": "https://raw.githubusercontent.com/owner/repo/main/course.mbz",
  "category": "PRUEBAS"
}
```

Provide exactly one **source** (precedence `url` > `path` > `data`):

| Field | Required | Description |
|-------|----------|-------------|
| `url` | one source | URL of the `.mbz`. Downloaded **inside PHP** and streamed straight to disk (memory-efficient — best for large files). The host must be CORS-reachable (e.g. `raw.githubusercontent.com`) or proxy-allowlisted. |
| `path` | one source | Path to an `.mbz` already in the runtime filesystem (e.g. written by a previous `writeFile` step). |
| `data` | one source | Embedded backup (string `@resourceName` or a resource descriptor). Buffered in memory — **only for small backups**; prefer `url` for large ones. |
| `category` | no | Target category **name**. Auto-created if missing (set `createCategory: false` to require it). Defaults to the top category (id 1) when omitted. |
| `createCategory` | no | `false` to error instead of creating a missing category. Defaults to `true`. |
| `fullname` | no | Override the restored course full name (otherwise the backup's name is kept). |
| `shortname` | no | Preferred course short name. Applied only if free; Moodle keeps the backup's name on a clash (short names are unique). |
| `visible` | no | Course visibility. Defaults to `true`. |

> **⚠️ Large backups may fail.** The playground runs Moodle entirely in the browser via
> WebAssembly, with limited memory. Restoring a large or complex `.mbz` (many activities, big
> files, completion/calendar data) can exceed the runtime's memory or hit SQLite-in-WASM
> transaction limits and fail. A failed restore is reported in the boot log and does **not** abort
> the rest of the blueprint. Prefer smaller course backups, and host large `.mbz` files at a
> CORS-accessible URL (e.g. GitHub raw) so they stream into the runtime instead of being buffered.

## Roles, scales and cohorts

These steps provision access control and grading building blocks. Each one can take its data
**inline in the blueprint** or **by reference to an external JSON/XML** — there is no separate
mechanism for "load from a URL": the steps consume the same [resource descriptors](#resources)
(`url`, `base64`, `data-url`, `bundled`, `vfs`, `literal`) and `@name` references that
`writeFile`/`unzip` already use. So any of these are valid for a batch step's payload:

```jsonc
"roles": [ { "shortname": "coordinacion" } ]      // inline array
"roles": "@coordinacionRoles"                       // @name resource (declared in "resources")
"roles": { "url": "https://host/roles.json" }       // inline resource descriptor (fetched + parsed)
```

All of these steps are **idempotent** and **non-fatal** (a failure is reported and the blueprint
continues — see [ADR-0005](./decisions/0005-resilient-blueprint-step-execution.md)). They are
documented in [ADR-0008](./decisions/0008-blueprint-roles-scales-cohorts-provisioning.md).

### importRolePreset / importRoles

Import **native Moodle role preset XML** — the `<role>` document produced by *Site administration
→ Users → Permissions → Define roles → Export*. The XML is parsed by Moodle core itself
(`core_role_preset`), so any role exported from any Moodle drops straight in, with its archetype,
context levels, capabilities and `allowassign`/`allowoverride`/`allowswitch`/`allowview`
relationships. Roles are matched by `shortname` (created or updated). Capabilities belonging to
plugins that are not installed here are skipped.

```json
{ "step": "importRolePreset", "resource": "@coordinacionXml" }
```

```json
{
  "step": "importRoles",
  "roles": [
    "@coordinacionXml",
    { "url": "https://example.com/student_vercursosocultos.xml" },
    { "xml": "<role><shortname>tutor</shortname>…</role>" }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `xml` | one of | Inline role preset XML string (single step `importRolePreset`) |
| `resource` | one of | `@name` or resource descriptor resolving to role preset XML (single step) |
| `roles` | yes (`importRoles`) | Array of XML references: `@name`, raw XML string, `{ "xml": … }`, or a resource descriptor |

### createRole / createRoles

Define or customize roles from a **JSON-native** description (good for readable, small roles).
Idempotent on `shortname`.

```json
{
  "step": "createRole",
  "shortname": "coordinacion",
  "name": "Coordinador",
  "description": "Course coordinator",
  "archetype": "editingteacher",
  "resetToArchetype": true,
  "contextlevels": ["course", "module"],
  "capabilities": {
    "moodle/course:manage": "allow",
    "mod/quiz:addinstance": "prevent"
  },
  "allowAssign": ["teacher", "student"],
  "allowView": ["teacher"]
}
```

`createRoles` takes a `roles` array (inline, `@resource`, or URL descriptor — JSON).

| Field | Required | Description |
|-------|----------|-------------|
| `shortname` | yes | Unique role shortname |
| `name` | no | Display name (defaults to `shortname`) |
| `description` | no | Role description |
| `archetype` | no | One of `manager`, `coursecreator`, `editingteacher`, `teacher`, `student`, `guest`, `user`, `frontpage` |
| `resetToArchetype` | no | When `true` (with an `archetype`), seed the role with the archetype's default capabilities before applying overrides |
| `contextlevels` | no | Where the role can be assigned: names (`system`, `coursecat`, `course`, `module`, `block`, `user`) or numbers |
| `capabilities` | no | Map of `capability → allow \| prevent \| prohibit \| inherit` (applied at the system context; capabilities of missing plugins are skipped) |
| `allowAssign` / `allowOverride` / `allowSwitch` / `allowView` | no | Arrays of role shortnames defining the relationship tables |

> **XML vs JSON for roles.** Use `importRoles` for real exports (hundreds of capabilities — let
> Moodle parse them); use `createRole` to define a small custom role legibly inside the blueprint.

### createScale / createScales

Create or update grading scales. Idempotent on `(course, name)`.

```json
{
  "step": "createScale",
  "name": "Competency",
  "items": ["Not competent yet", "Competent"],
  "description": "Default competency scale",
  "course": "CHEM101"
}
```

`createScales` accepts an array, a `@resource`/URL, **and** the Moodle scale-export envelope
(`{ "format": "moodle-scale-export", "scales": [ … ] }`), so an exported scale file works as-is:

```json
{ "step": "createScales", "scales": { "url": "https://example.com/moodle-standard-scales.json" } }
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Scale name |
| `items` | yes | Scale options low→high, as an array or a comma-separated string (Moodle stores them comma-separated) |
| `description` | no | Scale description (HTML) |
| `course` | no | Course shortname to scope the scale to; omit for a **site-wide** standard scale (`courseid = 0`) |

### createCohort / createCohorts

Create or update site-level cohorts. Idempotent on `idnumber` (or `name` when no `idnumber`).

```json
{
  "step": "createCohort",
  "name": "Staff 2026",
  "idnumber": "staff2026",
  "description": "Teaching staff",
  "members": ["alice", "bob"]
}
```

`createCohorts` accepts a `cohorts` array (inline, `@resource`, or URL descriptor).

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Cohort name |
| `idnumber` | no | Stable identifier used as the idempotency key |
| `description` | no | Cohort description |
| `visible` | no | `false` to hide the cohort (default `true`) |
| `members` | no | Array of usernames to add to the cohort (users must already exist) |

### Adding more "and the rest" (extension pattern)

These three domains all follow the same small recipe, which you can repeat for other
provisioning data (custom profile fields, competency frameworks, badges, …):

1. Add a `php<Thing>()` generator in `src/blueprint/php/helpers.js` (CLI mode, escaped input,
   graceful handler, JSON output — adapt an existing one).
2. Add a `src/blueprint/steps/moodle-<thing>.js` handler that resolves its payload with
   `resolveJsonPayload()` from `steps/payload.js` (this gives you inline / `@resource` / URL for
   free) and calls the generator.
3. Register it in `src/blueprint/steps/index.js`, add the names to `src/blueprint/schema.js` and
   `assets/blueprints/blueprint-schema.json`, then document and test it.
## Naming Conventions

- Step names use camelCase: `createUser`, `setConfig`, `addModule`
- Plural steps accept arrays: `createUsers` with `users`, `enrolUsers` with `enrolments`
- Course references use `shortname` throughout
- Category references use `name` throughout
- Constants use `UPPER_SNAKE_CASE`

## Execution Model

Steps execute sequentially. If a step fails, execution stops and the error
is reported. The `installMoodle` step is a declarative marker — Moodle is
already installed by `bootstrap.js` before step execution begins. All
provisioning steps run in `CLI_SCRIPT` mode except `login` which uses
HTTP for session cookies.

## Import / Export

Blueprints can be exported and imported via the sidebar Blueprint tab:

- **Export**: downloads the current blueprint as a `.blueprint.json` file
- **Import**: loads a `.blueprint.json` file, validates it, and resets the playground

## Default Blueprint

The default blueprint is at `assets/blueprints/default.blueprint.json`. Example
blueprints are in `assets/blueprints/examples/`.
