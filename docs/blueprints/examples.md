# Blueprint examples

A gallery of ready-to-use blueprints. Click **Open** to launch one in the hosted
playground, or open the source on GitHub to copy and adapt it.

New to blueprints? Start with the [Overview](index.md). For every step type and
field, see the [Reference](reference.md).

| Example | What it provisions | Key steps | Launch |
|---------|--------------------|-----------|--------|
| [minimal](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/minimal.blueprint.json) | Bare install, admin login, dashboard landing | `installMoodle`, `login` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/minimal.blueprint.json) |
| [course-with-content](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/course-with-content.blueprint.json) | One course with a label and an assignment | `createCategory`, `createCourse`, `addModule` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/course-with-content.blueprint.json) |
| [multi-user](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/multi-user.blueprint.json) | Teacher + two students enrolled by role | `createUsers`, `enrolUsers` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/multi-user.blueprint.json) |
| [classroom-ready](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/classroom-ready.blueprint.json) | 1 teacher + 3 students, 4-section course, mixed content | `createUsers`, `createCourse`, `enrolUsers`, `addModule` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/classroom-ready.blueprint.json) |
| [plugin-showcase](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/plugin-showcase.blueprint.json) | Installs `mod_board` (Kanban) + demo course | `installMoodlePlugin`, `createCourse`, `addModule` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/plugin-showcase.blueprint.json) |
| [plugin-exeweb](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/plugin-exeweb.blueprint.json) | Installs eXeLearning `mod_exeweb` + demo course | `installMoodlePlugin`, `createCourse`, `addModule` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/plugin-exeweb.blueprint.json) |
| [roles-scales-cohorts](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/roles-scales-cohorts.blueprint.json) | XML role import, JSON role, scales, a cohort with members | `importRoles`, `createRole`, `createScale`, `createCohort` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/roles-scales-cohorts.blueprint.json) |
| [visual-theme-moove](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/visual-theme-moove.blueprint.json) | Installs and activates the Moove theme | `installTheme`, `setTheme`, `createCourse` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/visual-theme-moove.blueprint.json) |
| [docker-compatible](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/docker-compatible.blueprint.json) | Portable subset that also runs in alpine-moodle | `setConfig`, `createCourse`, `createUser`, `enrolUser` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/docker-compatible.blueprint.json) |
| [pr-overlay](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/pr-overlay.blueprint.json) | Moodle core PR preview via runtime file overlay | `applyPrOverlay`, `login` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/pr-overlay.blueprint.json) |
| [tracker-starter](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/tracker-starter.blueprint.json) | Generic [tracker issue](../tracker-scenarios.md) reproduction site: course, teacher + student, forum/assignment/quiz/page | `createCourse`, `createUsers`, `enrolUsers`, `addModule` | [Open](https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/tracker-starter.blueprint.json) |

!!! tip
    Loading a different blueprint in the same tab starts fresh. Reloading the
    **same** blueprint keeps your data for that tab session. See
    [Overview](index.md) for the persistence model.

## Copy-paste examples

These are reproduced verbatim from the files linked above. Paste any of them into
the Blueprint panel, or save as `.json` and load with `?blueprint-url=`.

### minimal

The smallest useful blueprint: install Moodle, log in as admin, land on the dashboard.

```json
{
  "$schema": "../blueprint-schema.json",
  "landingPage": "/my/",
  "steps": [
    {
      "step": "installMoodle",
      "options": {
        "adminUser": "admin",
        "adminPass": "password",
        "adminEmail": "admin@example.com",
        "siteName": "My Moodle"
      }
    },
    {
      "step": "login",
      "username": "admin"
    }
  ]
}
```

### course-with-content

One category, one course, a welcome label and an assignment. Note the `{{KEY}}`
constants reused across steps.

```json
{
  "$schema": "../blueprint-schema.json",
  "landingPage": "/my/",
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
        "adminEmail": "{{ADMIN_EMAIL}}",
        "siteName": "Course Demo"
      }
    },
    {
      "step": "login",
      "username": "{{ADMIN_USER}}"
    },
    {
      "step": "createCategory",
      "name": "Science"
    },
    {
      "step": "createCourse",
      "fullname": "Introduction to Physics",
      "shortname": "PHYS101",
      "category": "Science",
      "summary": "A starter course covering basic physics concepts."
    },
    {
      "step": "addModule",
      "module": "label",
      "course": "PHYS101",
      "section": 1,
      "name": "Welcome",
      "intro": "<h3>Welcome to Physics 101!</h3><p>This course covers the fundamentals of physics.</p>"
    },
    {
      "step": "addModule",
      "module": "assign",
      "course": "PHYS101",
      "section": 1,
      "name": "First Assignment",
      "intro": "Submit a short essay on Newton's laws of motion."
    },
    {
      "step": "setLandingPage",
      "path": "/my/"
    }
  ]
}
```

### plugin-showcase

Installs a third-party plugin from a GitHub archive ZIP and adds a demo course.

```json
{
  "$schema": "../blueprint-schema.json",
  "landingPage": "/my/",
  "preferredVersions": { "php": "8.3", "moodle": "5.0" },
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
        "adminEmail": "{{ADMIN_EMAIL}}",
        "siteName": "Plugin Showcase"
      }
    },
    {
      "step": "login",
      "username": "{{ADMIN_USER}}"
    },
    {
      "step": "installMoodlePlugin",
      "url": "https://github.com/bynfrancesco/moodle-mod_board/archive/refs/heads/main.zip",
      "pluginType": "mod",
      "pluginName": "board"
    },
    {
      "step": "createCourse",
      "fullname": "Plugin Showcase Course",
      "shortname": "PLUGINS",
      "summary": "A course that demonstrates third-party Moodle plugins."
    },
    {
      "step": "addModule",
      "module": "label",
      "course": "PLUGINS",
      "section": 1,
      "name": "Board Plugin",
      "intro": "<h3>Board Activity</h3><p>The Board plugin provides a Kanban-style collaborative board within Moodle courses.</p>"
    },
    {
      "step": "setLandingPage",
      "path": "/my/"
    }
  ]
}
```

!!! note
    Plugin and theme downloads fetch a GitHub archive ZIP at boot. In Firefox and
    Safari this may need a CORS proxy; Chromium works best. See the
    [Reference](reference.md) for `installMoodlePlugin` and `installTheme`.

## Next steps

- [Blueprints overview](index.md) — what a blueprint is and how to load one
- [Blueprint reference](reference.md) — all step types, fields, constants, and resources
