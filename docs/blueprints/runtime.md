# Runtime and versions

By default a blueprint runs in the **browser/WASM runtime**: it boots a fresh,
in-memory Moodle and applies the blueprint at startup, with nothing stored on
disk. The *same* `blueprint.json` can also run in the sibling Docker runtime,
[`alpine-moodle`](https://github.com/erseco/alpine-moodle), which runs a real
PHP + Nginx Moodle server in a container.

This page shows how to pick the Moodle and PHP version, and how to write a
blueprint that stays portable across both runtimes.

## Pick a Moodle and PHP version

There are two ways to select versions. URL parameters win for a quick one-off;
`preferredVersions` makes the choice travel with the blueprint.

=== "URL parameters"

    ```text
    https://moodle-playground.com/?moodle=4.5&php=8.3
    ```

    See [URL parameters](../url-parameters.md) for the full list.

=== "Blueprint field"

    ```json
    {
      "preferredVersions": { "php": "8.3", "moodle": "5.0" },
      "steps": []
    }
    ```

Supported versions:

| Component | Available | Default |
| --------- | --------- | ------- |
| Moodle branch | 4.4, 4.5, 5.0, 5.1, 5.2, main (development) | 5.0 |
| PHP | 8.1 – 8.5 | 8.3 (depends on the Moodle branch) |

!!! note
    The PHP version must be compatible with the chosen Moodle branch. If it is
    not, the runtime falls back to a compatible PHP version for that branch.
    `preferredVersions` is **advisory**: the Docker image pins its Moodle/PHP
    version at build time and may ignore it.

## Browser runtime vs Docker runtime

The two runtimes are complementary. Pick one per task:

| Use case | Recommended runtime |
| -------- | ------------------- |
| Share a demo with no server | Moodle Playground |
| Reproduce a bug quickly in the browser | Moodle Playground |
| Validate blueprint syntax and scenario flow | Moodle Playground |
| Create a public link for reviewers | Moodle Playground |
| Develop a plugin with mounted code | alpine-moodle |
| Run CI against a real PHP/Moodle container | alpine-moodle |
| Test persistence, cron, mail, database behavior | alpine-moodle |
| Restore large MBZ backups or use heavier data | alpine-moodle |

!!! warning "Browser state is ephemeral"
    The browser runtime keeps everything in memory. State is lost when the tab
    closes; it is not a place to store real data. Use the Docker runtime when you
    need persistence, cron, or outbound services.

## Write portable blueprints

To keep a blueprint working in **both** runtimes:

- Prefer explicit, ordered `steps` over runtime-specific shortcuts.
- Use stable identifiers so steps can reference each other: course `shortname`,
  category `name`, user `username`.
- Avoid steps that run arbitrary code or touch the filesystem
  (`runPhpCode`, `runPhpScript`, `writeFile`, `unzip`, …) — they are disabled by
  default in Docker.
- Keep remote resources small, or bundle them with the blueprint, for
  reproducibility.
- Treat `landingPage` as a hint; a Docker runtime may not navigate
  automatically.
- Treat `preferredVersions` as advisory (see the note above).

## Step compatibility

The browser runtime supports every step in the
[reference](reference.md). The `alpine-moodle` column below reflects its current,
**experimental** implementation — always confirm against its
[blueprint documentation](https://erseco.github.io/alpine-moodle/blueprints/).

| Step group | Moodle Playground | alpine-moodle |
| ---------- | ----------------- | ------------- |
| `setConfig` / `setConfigs` / `setTheme` | supported | supported |
| `createCategory` / `createCourse` / `createUser(s)` / `enrolUser` | supported | supported |
| `installMoodlePlugin` / `installTheme` | supported | supported |
| `installMoodle` | supported | handled by container startup |
| `login` | supported | no-op (no browser auto-login) |
| `restoreCourse` / `addModule` | supported | planned |
| `runPhpCode` / `runPhpScript` / `writeFile` / `unzip` | supported | disabled by default |

Steps not listed (batch variants, `setConfigFile(s)`, `installLanguagePack`,
role/scale/cohort steps, filesystem helpers, `request`, …) work in Moodle
Playground; in `alpine-moodle` they are either planned or disabled and fail
clearly rather than being silently ignored.

## Example: a portable blueprint

This blueprint avoids browser-only and unsafe steps, so it runs in both
runtimes. A copy lives at
`assets/blueprints/examples/docker-compatible.blueprint.json`.

```json
{
  "$schema": "../blueprint-schema.json",
  "preferredVersions": {
    "php": "8.3",
    "moodle": "5.0"
  },
  "landingPage": "/course/index.php",
  "steps": [
    {
      "step": "setConfig",
      "name": "debug",
      "value": 32767
    },
    {
      "step": "createCategory",
      "name": "Blueprint demo"
    },
    {
      "step": "createCourse",
      "fullname": "Blueprint demo course",
      "shortname": "BLUEPRINT101",
      "category": "Blueprint demo"
    },
    {
      "step": "createUser",
      "username": "student1",
      "password": "ChangeMe123!",
      "email": "student1@example.com",
      "firstname": "Student",
      "lastname": "One"
    },
    {
      "step": "enrolUser",
      "username": "student1",
      "course": "BLUEPRINT101",
      "role": "student"
    }
  ]
}
```

Open it in the hosted app:

```text
https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/docker-compatible.blueprint.json
```

## Run the same blueprint in Docker

Mount the blueprint and point `MOODLE_BLUEPRINT` at it:

```yaml
services:
  moodle:
    image: erseco/alpine-moodle:latest
    ports:
      - "8080:8080"
    environment:
      MOODLE_DATABASE_TYPE: sqlite3
      MOODLE_USERNAME: admin
      MOODLE_PASSWORD: ChangeMe123!
      MOODLE_EMAIL: admin@example.com
      MOODLE_SITENAME: "Blueprint Demo"
      MOODLE_BLUEPRINT: /blueprints/demo.blueprint.json
    volumes:
      - moodledata:/var/www/moodledata
      - ./demo.blueprint.json:/blueprints/demo.blueprint.json:ro

volumes:
  moodledata:
```

!!! tip
    For the full step list and field reference, see the
    [blueprint reference](reference.md). For ready-made scenarios, see the
    [examples](examples.md).
