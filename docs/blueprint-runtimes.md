# Blueprint runtimes

Moodle Playground blueprints describe Moodle scenarios **declaratively**: an
ordered list of `steps`, named `resources`, and `{{CONSTANT}}` substitutions.
The primary runtime in this repository is the **browser/WASM runtime** — it
boots a fresh, in-memory Moodle and applies a blueprint at startup, with nothing
stored on disk.

The same `blueprint.json` can also be applied by a **sibling Docker runtime**,
[`alpine-moodle`](https://github.com/erseco/alpine-moodle), which runs a real
PHP + Nginx Moodle server in a container. It applies a compatible subset of
blueprint steps after Moodle has been installed or upgraded.

The two projects are **complementary siblings**, not competitors and not one
replacing the other. A single declarative blueprint can support different
lifecycle stages:

- **authoring** — write and iterate on a scenario;
- **QA** — validate the scenario and reproduce issues;
- **plugin demo** — show a plugin in a known-good Moodle;
- **CI** — run automated checks against a real server;
- **Docker development** — develop with mounted plugin code;
- **persistent integration testing** — exercise cron, mail, the database and the
  file system over time.

## Choosing a runtime

| Use case                                                     | Recommended runtime |
| ------------------------------------------------------------ | ------------------- |
| Share a demo with no server                                  | Moodle Playground   |
| Reproduce a bug quickly in the browser                       | Moodle Playground   |
| Validate blueprint syntax and scenario flow                  | Moodle Playground   |
| Develop a Moodle plugin with mounted code                    | alpine-moodle       |
| Run CI against a real PHP/Moodle container                   | alpine-moodle       |
| Test persistence, cron, file system, mail, database behavior | alpine-moodle       |
| Restore larger MBZ backups or use heavier data               | alpine-moodle       |
| Create a public link for reviewers                           | Moodle Playground   |

## Portable blueprint authoring guidelines

To keep a blueprint working in **both** runtimes:

- Prefer explicit ordered `steps` over runtime-specific shortcuts.
- Prefer stable identifiers:
    - course `shortname`,
    - category `idnumber`,
    - user `username`.
- Avoid browser/WASM-specific assumptions when targeting Docker too.
- Avoid unsafe steps (`runPhpCode`, `runPhpScript`, `writeFile`, `unzip`, …) in
  portable blueprints — they are disabled by default in Docker.
- Keep remote resources small, or use bundled resources.
- Prefer bundle-relative resources for reproducibility.
- Use `landingPage` as a hint; Docker runtimes may not automatically navigate.
- Treat `preferredVersions` as advisory; runtimes may select versions
  differently (the Docker image pins its Moodle/PHP version at build time).
- Check the runtime compatibility matrix before relying on a step in both
  runtimes.

## Runtime compatibility matrix

Step names below match this repository's
[`assets/blueprints/blueprint-schema.json`](../assets/blueprints/blueprint-schema.json).
The `alpine-moodle` column reflects its current, experimental implementation;
always confirm against its
[blueprint documentation](https://erseco.github.io/alpine-moodle/blueprints/).

| Step                  | Moodle Playground | alpine-moodle                | Notes                                                       |
| --------------------- | ----------------- | ---------------------------- | ----------------------------------------------------------- |
| `installMoodle`       | supported         | handled by container startup | In Docker this is normally not an explicit blueprint step   |
| `login`               | supported         | no-op                        | Browser-only auto-login is not equivalent to Docker         |
| `setConfig`           | supported         | supported                    | Portable                                                    |
| `setConfigs`          | supported         | supported                    | Portable                                                    |
| `setAdminAccount`     | supported         | supported                    | Portable with care                                          |
| `installMoodlePlugin` | supported         | supported                    | ZIP/resource based                                          |
| `installTheme`        | supported         | supported                    | ZIP/resource based                                          |
| `setTheme`            | supported         | supported                    | Portable                                                    |
| `createCategory`      | supported         | supported                    | Prefer `idnumber`                                           |
| `createCourse`        | supported         | supported                    | Prefer `shortname`                                          |
| `createUser`          | supported         | supported                    | Prefer `username`                                           |
| `createUsers`         | supported         | supported                    | Portable                                                    |
| `enrolUser`           | supported         | supported                    | Portable                                                    |
| `restoreCourse`       | supported         | planned                      | Match actual alpine-moodle implementation                   |
| `addModule`           | supported         | planned                      | More complex in the Docker MVP                              |
| `runPhpCode`          | supported         | disabled by default          | Not recommended for portable blueprints                     |
| `runPhpScript`        | supported         | disabled by default          | Not recommended for portable blueprints                     |
| `writeFile`           | supported         | disabled by default          | Requires a path policy                                      |
| `unzip`               | supported         | disabled by default          | Requires a path policy                                      |

Other steps in the schema (`createCategories`, `createCourses`, `createSection`,
`createSections`, `enrolUsers`, `setConfigFile(s)`, `setLandingPage`,
`installLanguagePack`, `createRole(s)`, `importRole(s)`, `createScale(s)`,
`createCohort(s)`, `mkdir`, `rmdir`, `copyFile`, `moveFile`, `request`) are fully
supported in Moodle Playground; in `alpine-moodle` they are either **planned**
or **disabled** (unsafe). They fail clearly there rather than being silently
ignored.

## Example: Docker-compatible blueprint

This example avoids browser-only and unsafe steps, so it runs in both runtimes.
A copy lives at
[`assets/blueprints/examples/docker-compatible.blueprint.json`](../assets/blueprints/examples/docker-compatible.blueprint.json).

```json
{
  "$schema": "../assets/blueprints/blueprint-schema.json",
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
      "name": "Blueprint demo",
      "idnumber": "blueprint-demo"
    },
    {
      "step": "createCourse",
      "fullname": "Blueprint demo course",
      "shortname": "BLUEPRINT101",
      "category": "blueprint-demo"
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

## Running the same blueprint in Docker

Docker support lives in `alpine-moodle`. Mount the blueprint and point
`MOODLE_BLUEPRINT` at it:

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

!!! note
    - Docker support lives in `alpine-moodle`; this repository remains focused on
      the browser runtime.
    - Compatibility may vary by step and should be checked against the matrix
      above and against the `alpine-moodle` documentation.
