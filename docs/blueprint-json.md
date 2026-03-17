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
| `debug` | integer | `0` | Moodle debug level |
| `debugdisplay` | integer | `0` | Display debug messages on page (`1`) or only log them (`0`) |

#### Debug Levels

| Value | Name | Description |
|-------|------|-------------|
| `0` | NONE | Do not show any errors or warnings |
| `5` | MINIMAL | Show only fatal errors |
| `15` | NORMAL | Show errors, warnings and notices |
| `32767` | DEVELOPER | Extra Moodle debug messages for developers |

When `debugdisplay` is `1`, PHP `display_errors` is also enabled so that PHP-level
errors appear on the page. When `debug` is `32767` (DEVELOPER), Moodle's
`$CFG->debugdeveloper` is set to `true`.

These settings can also be changed from the Settings dialog in the playground UI
without editing the blueprint JSON directly.

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

### Enrolment

| Step | Description |
|------|-------------|
| `enrolUser` / `enrolUsers` | Enrol users into courses with roles |

### Modules

| Step | Description |
|------|-------------|
| `addModule` | Add a course module (label, folder, assign, etc.) |

### Plugins

| Step | Description |
|------|-------------|
| `installMoodlePlugin` | Download a plugin ZIP, extract to the correct directory, and run Moodle upgrade |
| `installTheme` | Download a theme ZIP, extract, and run Moodle upgrade |

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

### installMoodlePlugin

```json
{
  "step": "installMoodlePlugin",
  "pluginType": "block",
  "pluginName": "participants",
  "url": "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip"
}
```

Supported plugin types: `mod`, `block`, `local`, `theme`, `auth`, `enrol`, `filter`,
`format`, `report`, `tool`, `editor`, `atto`, `tiny`, `qtype`, `qbehaviour`,
`gradeexport`, `gradeimport`, `gradereport`, `repository`, `plagiarism`,
`availability`, `calendartype`, `message`, `profilefield`, `datafield`,
`assignsubmission`, `assignfeedback`, `booktool`, `quizaccess`, `ltisource`.

If `pluginName` is omitted, it is guessed from the GitHub URL (e.g.,
`moodle-block_participants` becomes `participants`).

### installTheme

```json
{
  "step": "installTheme",
  "pluginName": "moove",
  "url": "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/master.zip"
}
```

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
