# Blueprints overview

A **blueprint** is a JSON file that describes how a Moodle Playground instance should look at boot. It is a list of **steps** that run in order — install Moodle, log in, create a course, enrol a user, install a plugin, and so on. When the playground boots with a blueprint, it replays those steps so you land on a ready-to-use site instead of an empty install.

This page is the hands-on tutorial. For the full list of step types and their fields, see the [reference](reference.md). For ready-made files you can open right away, see the [examples](examples.md).

## A minimal blueprint

```json title="demo.blueprint.json"
{
  "steps": [
    { "step": "installMoodle", "options": { "siteName": "My Moodle" } },
    { "step": "login", "username": "admin" },
    { "step": "setLandingPage", "path": "/" }
  ]
}
```

That installs Moodle, logs in as the admin, and opens the site home page. Every other step builds on top of this skeleton.

!!! note "Admin credentials"
    The default admin is `admin` / `password`. Change them with the `installMoodle` step's `options` (`adminUser`, `adminPass`, `adminEmail`) — see the walkthrough below.

## Loading a blueprint

There are four ways to get a blueprint into the playground.

=== "From a URL"

    Point `blueprint-url` at a relative or absolute file:

    ```
    https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/minimal.blueprint.json
    ```

=== "Inline"

    Pass the blueprint directly with `blueprint` (raw JSON, base64, gzip+base64url, or a `data:` URL). This has the highest precedence:

    ```
    https://moodle-playground.com/?blueprint=%7B%22steps%22%3A%5B%7B%22step%22%3A%22installMoodle%22%7D%5D%7D
    ```

=== "Import in the shell"

    Use the shell toolbar / Settings to **import** a `.json` blueprint file from your machine — no URL needed.

=== "Bundled default"

    With no override, the playground loads `assets/blueprints/default.blueprint.json`.

The source precedence is: `blueprint` > `blueprint-url` > saved session > project default > built-in minimal. See [URL parameters](../url-parameters.md) for the full parameter list.

!!! tip "Same blueprint = same data on reload"
    Within a tab, your changes are kept on reload **for the same blueprint source**. Loading a different blueprint — or clicking **Reset Playground** — starts fresh. Closing the tab destroys everything (the runtime is fully ephemeral).

## Top-level fields

Most blueprints only need `steps`. The other fields are optional:

```json
{
  "$schema": "./blueprint-schema.json",
  "preferredVersions": { "php": "8.3", "moodle": "5.0" },
  "runtime": { "debug": 0, "debugdisplay": 0 },
  "constants": { "ADMIN_USER": "admin" },
  "landingPage": "/",
  "steps": [ ]
}
```

| Field | Purpose |
|-------|---------|
| `steps` | **Required.** The ordered list of steps to run. |
| `constants` | Map of `{{KEY}}` values substituted everywhere before steps run. |
| `runtime` | `debug` / `debugdisplay` written to the config at boot. |
| `landingPage` | Path to open after boot (leading slash). |
| `preferredVersions` | Preferred `php` / `moodle` — see [Runtime and versions](runtime.md). |
| `$schema` | Informational; points at `blueprint-schema.json`. |

## Constants ({{KEY}})

Constants let you write a value once and reuse it. Every `{{KEY}}` placeholder is replaced (deeply, across all steps) before the blueprint runs.

```json
{
  "constants": {
    "ADMIN_USER": "admin",
    "ADMIN_PASS": "password",
    "ADMIN_EMAIL": "admin@example.com"
  },
  "steps": [
    {
      "step": "installMoodle",
      "options": {
        "adminUser": "{{ADMIN_USER}}",
        "adminPass": "{{ADMIN_PASS}}",
        "adminEmail": "{{ADMIN_EMAIL}}"
      }
    },
    { "step": "login", "username": "{{ADMIN_USER}}" }
  ]
}
```

Blueprint constants merge with constants derived from URL parameters — `{{REPO}}`, `{{OWNER}}`, `{{BRANCH}}`, and `{{REF}}` — which is how PR-preview blueprints target a branch without hardcoding it. See [URL parameters](../url-parameters.md).

## Build it up step by step

The snippets below stack into one blueprint. Add them to the `steps` array in this order.

### 1. Install Moodle and log in

```json
{ "step": "installMoodle", "options": { "siteName": "My Moodle", "adminPass": "password" } },
{ "step": "login", "username": "admin" }
```

`installMoodle` is a marker — the actual install happens during boot using its `options`. `login` runs over HTTP so the landing page opens already authenticated.

### 2. Create a user

```json
{
  "step": "createUser",
  "username": "teacher1",
  "firstname": "Jane",
  "lastname": "Teacher",
  "email": "teacher1@example.com"
}
```

Only `username` is required; the password defaults to `password`.

### 3. Create a course

```json
{ "step": "createCategory", "name": "Sample Courses" },
{
  "step": "createCourse",
  "fullname": "Getting Started with Moodle",
  "shortname": "INTRO101",
  "category": "Sample Courses"
}
```

`fullname` and `shortname` are required. The `shortname` is how later steps reference the course.

### 4. Enrol the user

```json
{
  "step": "enrolUser",
  "username": "teacher1",
  "course": "INTRO101",
  "role": "editingteacher"
}
```

`role` defaults to `student`.

### 5. Add a course module

```json
{
  "step": "addModule",
  "module": "label",
  "course": "INTRO101",
  "section": 1,
  "name": "Welcome",
  "intro": "<h3>Welcome!</h3><p>Created via a blueprint.</p>"
}
```

`module` and `course` are required. Other fields depend on the activity type — `label`, `assign`, and `page` are common starters.

### 6. Install a plugin from GitHub

```json
{
  "step": "installMoodlePlugin",
  "url": "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip"
}
```

Use a **GitHub archive ZIP URL** (`/archive/refs/heads/<branch>.zip` or `/archive/refs/tags/<tag>.zip`). The plugin type and name are auto-detected from the repo name (the `moodle-TYPE_NAME` convention). To add a theme instead, use `installTheme` and activate it with `setTheme`.

!!! tip "Many more steps exist"
    Users, categories, courses, sections, roles, scales, cohorts, language packs, file operations, raw PHP, and Moodle core PR overlays all have dedicated steps. The [reference](reference.md) lists every one with its fields.

## Common errors

- **Invalid JSON.** A trailing comma or missing quote stops the whole blueprint. Validate the file (most editors flag this) before loading it.
- **Wrong step name.** An unknown `step` value fails with `Unknown step type`. Check spelling against the [reference](reference.md).
- **Bad plugin URL.** `installMoodlePlugin` / `installTheme` need a real GitHub **archive** ZIP URL, and the branch or tag in the URL must exist on the remote — a not-yet-pushed branch returns 404.
- **Outbound download blocked.** Firefox and Safari cannot make outbound network calls from WASM PHP, so plugin and language-pack downloads may need a proxy (`addonProxyUrl` / `phpCorsProxyUrl`). Chromium works best. See [URL parameters](../url-parameters.md).
- **Out of memory.** Very large plugins, courses, or backups can exhaust WASM memory and crash the runtime. Keep blueprints lean and split big restores.

## Next steps

- [Examples](examples.md) — copy-paste blueprints you can open immediately.
- [Reference](reference.md) — every top-level field, step, and step option.
- [Runtime and versions](runtime.md) — choosing PHP and Moodle versions.
- [URL parameters](../url-parameters.md) — loading and configuring blueprints from the URL.
