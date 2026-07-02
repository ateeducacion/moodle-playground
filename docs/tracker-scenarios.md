# Moodle Tracker scenarios

A **Moodle Playground Scenario** is an explicit [blueprint](blueprints/index.md)
embedded in a Moodle Tracker issue description. When the
["Open in Moodle Playground" userscript](browser-userscripts.md) finds one on an
issue page, it adds a button that boots the playground **preconfigured with the
context needed to reproduce the issue** — the course, users, enrolments and
activities the bug needs, already in place.

The scenario is machine-readable JSON. Free-text "Steps to reproduce" are **not**
interpreted: converting arbitrary human-written steps into a Moodle setup would be
unreliable, so the format is explicit and deterministic instead.

## Writing a scenario

The payload is an ordinary blueprint JSON object — the same format as any
playground blueprint (`steps` array required; `landingPage`, `preferredVersions`,
`runtime`, `constants` and `resources` optional). See the
[blueprint reference](blueprints/reference.md) for every step type.

Two placements inside the issue description are supported — exactly these two:

### Form A — fenced code block

Use a fenced code block with the `moodle-playground` language. This is the
canonical form for markdown contexts (and tracker descriptions that keep the
backticks as literal text):

````markdown
```moodle-playground
{
  "landingPage": "/course/view.php?id=2",
  "steps": [
    { "step": "createCourse", "fullname": "Reproduction course", "shortname": "REPRO" },
    { "step": "createUser", "username": "student", "password": "password",
      "firstname": "Test", "lastname": "Student", "email": "student@example.com" },
    { "step": "enrolUser", "username": "student", "course": "REPRO", "role": "student" },
    { "step": "addModule", "module": "data", "course": "REPRO", "section": 1,
      "name": "DB without comments", "comments": 0 },
    { "step": "login", "username": "admin" }
  ]
}
```
````

### Form B — marker phrase + code block

The tracker's rich-text editor converts markdown fences into code blocks and
drops the language, so the fence marker can get lost. In that case, put the
marker phrase **`Moodle Playground Scenario`** (for example as a heading) right
before a code block containing the JSON:

```markdown
### Moodle Playground Scenario

{ "landingPage": "/my/", "steps": [ ... ] }   ← inside a code block
```

### Detection rules

Detection is text-based and deterministic (no natural-language inference):

1. The first marker wins: a ` ```moodle-playground ` fence, or the phrase
   `Moodle Playground Scenario` (case-insensitive).
2. The first balanced `{ ... }` JSON object after the marker is the scenario.
   It is parsed with `JSON.parse` — never executed — and must be an object with
   a `steps` array.
3. A marker with no JSON object after it is treated as a mention, not a
   scenario (no error).
4. A marker **with** broken JSON (or JSON without `steps`) shows a warning
   badge on the issue; the exact error is in the badge's tooltip.

!!! tip
    Keep the JSON in a code block, typed with straight quotes (`"`), not the
    typographic quotes the rich-text editor produces in normal paragraphs. The
    block content is used verbatim.

## What the tracker button does

On `moodle.atlassian.net/browse/<KEY>` pages the userscript adds one floating
button at the bottom-right:

| Issue description | Button |
|-------------------|--------|
| Valid scenario block | **▶ Open issue scenario in Moodle Playground** — opens the playground with the scenario encoded inline (`?blueprint=`, base64url) |
| No scenario block | **▶ Open in Moodle Playground (starter site)** — opens the [starter scenario](#the-starter-scenario) |
| Broken scenario block | **⚠ Moodle Playground: invalid scenario block** — a non-clickable badge; hover it to read the error |

The scenario blueprint is passed **verbatim**: what you wrote in the issue is
exactly what the playground loads (the playground then validates it like any
other blueprint). The existing per-version compare/PR preview badges from the
[userscript's compare mode](browser-userscripts.md#compare-mode) are independent
and unchanged.

To disable the starter button, set `STARTER_SCENARIO = false` in the userscript
(via your userscript manager's editor).

## The starter scenario

When an issue has no scenario block, the starter button loads the bundled
[`tracker-starter`](https://github.com/ateeducacion/moodle-playground/blob/main/assets/blueprints/examples/tracker-starter.blueprint.json)
blueprint — the generic pre-setup proposed in
[issue #166](https://github.com/ateeducacion/moodle-playground/issues/166):

- One course: **Reproduction course** (`REPRO`, topics format, 3 sections)
- Three users: `admin` / `password`, `teacher` / `password`,
  `student` / `password` — teacher and student enrolled in the course as
  `editingteacher` and `student`
- Sample activities: a forum, an assignment, a quiz and a page
- Logged in as admin, landing on the course page

## Limitations

- **Free-text steps are not converted.** Only the explicit scenario block is
  read; ordinary "Steps to reproduce" prose is ignored.
- **Only supported blueprint steps are provisioned.** Unknown steps fail
  blueprint validation in the playground (with a clear error); see the
  [reference](blueprints/reference.md) for the supported list.
- **Quiz questions cannot be created.** `addModule` creates the quiz activity
  structure only; add questions manually after boot.
- **No Moosh.** Provisioning uses the playground's own blueprint engine inside
  the WASM runtime.
- **URL length.** The scenario travels inline in the URL (base64url). Typical
  scenarios are a few hundred bytes; for very large setups prefer hosting a
  blueprint file and linking it with `?blueprint-url=` (see
  [URL parameters](url-parameters.md)).

## See also

- [Browser userscripts](browser-userscripts.md) — installing the tracker/PR button.
- [Blueprints overview](blueprints/index.md) and [reference](blueprints/reference.md).
- [Blueprint examples](blueprints/examples.md) — including `tracker-starter`.
