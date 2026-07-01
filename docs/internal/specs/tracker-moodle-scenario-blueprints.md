# Spec: tracker-moodle-scenario-blueprints

* Status: Implemented
* Date: 2026-07-01
* Issue: [#166](https://github.com/ateeducacion/moodle-playground/issues/166)
* Related: PR #158 (GitHub compare mode / tracker userscript), ADR 0016 (runtime PR overlay), ADR 0017 (this feature's decision record)

## Problem statement

Moodle Tracker issues describe reproduction context ("Steps to reproduce") as free
text inside the description field. It is not a structured field and it is not
mandatory. When a tester opens Moodle Playground from a tracker issue (via the
PR #158 userscript), the instance boots empty: reproducing the issue still
requires manually creating courses, users, enrolments, and activities.

Issue #166 asks for playground instances opened from the tracker to be
preconfigured with the context needed to reproduce the issue.

## Goals

1. Let tracker issue authors embed an **explicit, deterministic scenario block**
   in the issue description that Moodle Playground converts into a Blueprint.
2. When no scenario block exists, offer a **documented starter preset** (one
   course, teacher + student enrolled, sample activities) so testers start from
   a useful site instead of an empty install.
3. Preserve all existing PR #158 behavior (compare-mode and PR badges).
4. Keep everything testable: pure extraction functions, deterministic URLs.

## Non-goals

1. **No natural-language parsing** of arbitrary "Steps to reproduce" text. A
   scenario is machine-readable JSON, or it does not exist.
2. **No Moosh dependency** — it does not exist in this project and does not fit
   the browser/WASM runtime.
3. **No full Behat/Gherkin parser.** A Behat-like shorthand is documented as
   future work; the JSON Blueprint block ships first.
4. No new blueprint step types — the scenario reuses the existing step registry.
5. No quiz question authoring — `addModule` supports quiz structure only
   (documented limitation).

## User stories

1. As an issue reporter, I write a "Moodle Playground Scenario" block in my
   tracker issue so testers land on a site that already has the course,
   users and activity my bug needs.
2. As a tester, I click one button on a tracker issue and get a playground
   preconfigured for that issue.
3. As a tester on an issue with no scenario, I click a starter button and get a
   generic reproduction site (course + teacher + student + sample activities).
4. As a reviewer, the existing "Open in Moodle Playground" compare/PR badges
   keep working exactly as before.

## Scenario format (supported forms — exactly these two)

The scenario payload is a **Moodle Playground Blueprint JSON object** (same
schema as `assets/blueprints/blueprint-schema.json`; `steps` array required).
Two placements inside a tracker issue description are supported:

### Form A — fenced code block (markdown contexts)

````markdown
```moodle-playground
{
  "landingPage": "/course/view.php?id=2",
  "steps": [ { "step": "createCourse", "fullname": "Repro", "shortname": "REPRO" } ]
}
```
````

### Form B — marker phrase + code block (tracker rich-text editor)

The Jira editor converts/strips fence backticks, so the marker phrase
`Moodle Playground Scenario` (e.g. as a heading) followed by a code block with
the JSON is also supported:

```markdown
### Moodle Playground Scenario

{ "landingPage": "/my/", "steps": [ ... ] }   ← inside a Jira code block
```

Detection is text-based (the userscript reads `textContent`), deterministic and
case-insensitive: find the first marker (fence language or marker phrase), then
parse the first balanced `{...}` JSON object after it. The first scenario block
on the page wins. Content is parsed with `JSON.parse` only — never evaluated.

Result states:

| State | Meaning | Tracker UI |
|-------|---------|------------|
| not found | no marker, or marker with no JSON object after it | starter button |
| valid | JSON object with a `steps` array | "Open issue scenario" button |
| invalid | marker + JSON present but broken (bad JSON, non-object, missing `steps`) | warning badge with the error in its tooltip; no launch button |

## Starter preset

`assets/blueprints/examples/tracker-starter.blueprint.json` — a bundled,
deterministic blueprint (single source of truth, tiny URL via `?blueprint-url=`):

- `installMoodle` (site "Tracker reproduction site", admin/password)
- course `REPRO` ("Reproduction course", topics, 3 sections)
- users `teacher`/`password` and `student`/`password`, enrolled as
  `editingteacher` / `student`
- sample activities: forum, assignment, quiz (structure only — no questions),
  page
- login as admin, landing on the course page

## Acceptance criteria

1. A valid scenario block on a tracker issue page yields exactly one
   "Open issue scenario in Moodle Playground" button whose URL decodes to the
   scenario blueprint verbatim (landingPage, preferredVersions, runtime,
   constants, resources, steps preserved).
2. An issue page without a scenario yields exactly one starter button pointing
   at the bundled starter blueprint.
3. A broken scenario yields a warning badge (error in tooltip), and no scenario
   launch button.
4. Repeated injection passes (SPA mutations, interval ticks) never duplicate
   buttons; navigating to another issue refreshes the button.
5. Compare-mode and PR badges from PR #158 are unaffected.
6. Extraction never evaluates content (JSON.parse only) and is covered by unit
   tests; injection is covered by Playwright fixture tests with no live network.
7. The starter blueprint passes `validateBlueprint` and is listed in the
   examples gallery.

## Technical plan

1. **Userscript** (`scripts/moodle-playground-pr-button.user.js`):
   - Add pure helpers: `extractPlaygroundScenario(text)`, `scanJsonObject`,
     `buildScenarioUrl(blueprint)`, `buildStarterUrl()`.
   - Add `injectTrackerScenario()` to the tracker tick: runs on
     `/browse/<KEY>` pages, reads the description container's `textContent`
     (fallback: `document.body`), renders one floating button/badge
     (bottom-right, zero Atlassian layout coupling), idempotent via a state
     stamp, refreshed on SPA navigation.
   - Button labels are chosen so they can never match the marker regexes
     (prevents self-detection feedback loops through the body-text fallback).
   - Add a `__MPP_TEST__` hook: when defined (node:vm test sandbox), export the
     pure helpers and skip DOM wiring.
   - New config const `STARTER_SCENARIO` to disable the starter button.
2. **Starter blueprint**: new bundled example + gallery row.
3. **No runtime/schema changes**: the scenario is a plain blueprint consumed by
   the existing `?blueprint=` (base64url) and `?blueprint-url=` paths.

## Test plan

- `tests/scripts/tracker-scenario.test.js` (node:test + node:vm on the real
  userscript): extraction (both forms, unrelated fences, invalid JSON,
  non-object, missing steps, field preservation, no evaluation), URL generation
  (encoding, determinism, special characters, no double encoding), label/marker
  collision guard.
- `tests/blueprint/tracker-starter.test.js`: starter blueprint file validates
  and provisions the expected entities.
- `tests/e2e/tracker-userscript.spec.mjs` (Playwright, routed fixture page for
  `moodle.atlassian.net`, offline): one button per state, dedup, SPA refresh,
  compare badges unaffected, DOM-variation fallback.

## Migration / backwards compatibility

- Purely additive. Existing `?blueprint=`/`?blueprint-url=` contracts are
  reused, not changed. Existing userscript installs pick the feature up on
  update; without updating, old behavior is unchanged.
- No schema change: scenarios are ordinary blueprints.

## Rollout and documentation

- New `docs/tracker-scenarios.md` (format spec, examples, limitations).
- Updates: `docs/browser-userscripts.md`, `docs/blueprints/examples.md`,
  `mkdocs.yml` nav, `AGENTS.md` ADR table.
- ADR 0017 records the format decision.
- Future work (documented, not implemented): Behat-like shorthand; merging a
  scenario with `applyPrOverlay` compare previews; mapping the tracker
  "Affects version" field to `preferredVersions`.
