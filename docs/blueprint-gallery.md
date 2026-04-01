# Blueprint Gallery

Ready-to-use blueprint examples for common Moodle Playground scenarios.
Each blueprint can be loaded via the `?blueprint-url=` query parameter or
pasted into the Blueprint panel in the playground UI.

All examples live in
[`assets/blueprints/examples/`](https://github.com/ateeducacion/moodle-playground/tree/main/assets/blueprints/examples).

---

## Minimal

**File:** `minimal.blueprint.json`

The smallest possible blueprint — installs Moodle, logs in as admin, and
redirects to the dashboard. Use this as a starting point for custom blueprints.

```
?blueprint-url=assets/blueprints/examples/minimal.blueprint.json
```

**What it does:**

- Installs Moodle with default admin credentials
- Logs in as admin
- Lands on `/my/` (dashboard)

---

## Course with Content

**File:** `course-with-content.blueprint.json`

Creates a single course with a category, a label module, and an assignment.
Good for demonstrating the course creation and module addition flow.

```
?blueprint-url=assets/blueprints/examples/course-with-content.blueprint.json
```

**What it does:**

- Creates a "Science" category
- Creates "Introduction to Physics" course (PHYS101)
- Adds a welcome label and an assignment to section 1
- Lands on the dashboard

---

## Multi-User

**File:** `multi-user.blueprint.json`

Creates multiple users and enrolls them in a course with different roles.
Demonstrates bulk user creation and enrollment.

```
?blueprint-url=assets/blueprints/examples/multi-user.blueprint.json
```

**What it does:**

- Creates teacher and student accounts
- Creates a course
- Enrolls users with appropriate roles (editingteacher, student)

---

## Classroom Ready

**File:** `classroom-ready.blueprint.json`

A full classroom setup with a teacher, three students, a 4-section course
with labels, assignments, and a URL resource across multiple units.

```
?blueprint-url=assets/blueprints/examples/classroom-ready.blueprint.json
```

**What it does:**

- Creates 1 teacher + 3 student accounts
- Creates "English for Beginners" (ENG101) with 4 sections
- Enrolls all users with correct roles
- Adds content across all sections: labels, assignments, URL resources
- Lands on the course view

---

## Plugin: eXeLearning (mod_exeweb)

**File:** `plugin-exeweb.blueprint.json`

Installs the [eXeLearning](https://exelearning.net/) `mod_exeweb` activity
module from its GitHub repository and creates a demo course.

```
?blueprint-url=assets/blueprints/examples/plugin-exeweb.blueprint.json
```

**What it does:**

- Installs `mod_exeweb` from `exelearning/mod_exeweb` (main branch)
- Creates an "Interactive Content" category
- Creates "eXeLearning Demo Course" (EXEDEMO)
- Adds an introductory label
- Lands on the course view

!!! note
    Plugin installation downloads the GitHub ZIP through the configured addon
    proxy before extracting it into MEMFS. The first load may take a few extra
    seconds.

---

## Plugin Showcase

**File:** `plugin-showcase.blueprint.json`

Installs a third-party plugin (Board — a Kanban-style activity) and creates
a course to demonstrate it.

```
?blueprint-url=assets/blueprints/examples/plugin-showcase.blueprint.json
```

**What it does:**

- Installs `mod_board` from GitHub
- Creates a "Plugin Showcase Course"
- Adds a descriptive label
- Lands on the dashboard

---

## How to use

### Via URL parameter

Append `?blueprint-url=` with the path to any example:

```
https://ateeducacion.github.io/moodle-playground/?blueprint-url=assets/blueprints/examples/classroom-ready.blueprint.json
```

### Via the Blueprint panel

1. Open the playground
2. Click the **Blueprint** button in the toolbar
3. Paste the JSON content of any example into the editor
4. Click **Apply**

### Via inline base64

Encode any blueprint as base64 and pass it via `?blueprint=`:

```
?blueprint=eyJzdGVwcyI6W3sic3RlcCI6Imluc3RhbGxNb29kbGUifV19
```

---

## Creating your own

Start from `minimal.blueprint.json` and add steps. See the
[Blueprint Reference](blueprint-json.md) for all available step types,
resource formats, and configuration options.

### Tips

- Use `constants` for values that appear in multiple steps (usernames, emails)
- Use `preferredVersions` to pin PHP and Moodle versions
- Set `landingPage` to control where the user lands after boot
- Plugin installation steps (`installMoodlePlugin`) accept GitHub URLs directly
- The `pluginType` and `pluginName` fields are auto-detected from GitHub repo names
  following the `moodle-{type}_{name}` convention
