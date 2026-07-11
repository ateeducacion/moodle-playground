# ADR-0017 Explicit Moodle Playground scenario blocks in tracker issues

* Status: Accepted
* Date: 2026-07-01

## Context and Problem

Issue #166 asks for Moodle Playground instances opened from Moodle Tracker
issues to come preconfigured with the context needed to reproduce the issue.
The natural source of that context — the "Steps to reproduce" section — is
free text inside the description field: not structured, not mandatory, and not
reliably machine-readable. The PR #158 userscript already opens playgrounds
from tracker issues (compare/PR previews), but always onto an empty install.

We need a convention for expressing reproduction context in a tracker issue
that the playground can consume deterministically, plus a sensible default
when no such context exists.

## Options Considered

* **Natural-language parsing of "Steps to reproduce"** — infer courses, users
  and activities from prose (possibly with an LLM).
* **A Behat/Gherkin scenario dialect** — human-readable Given/When/Then steps
  parsed into provisioning actions.
* **An explicit blueprint JSON block in the issue description** — the existing
  playground blueprint format embedded behind a recognizable marker, converted
  1:1 into a `?blueprint=` launch URL.
* **A fixed pre-setup for every tracker launch** — bake a generic course/users
  preset into the existing compare/PR preview blueprints.

## Decision

Adopt the **explicit blueprint block**, with a **bundled starter preset** as
the fallback, and leave the compare/PR preview flow untouched.

* The scenario payload is an ordinary blueprint (steps array required; parsed
  with `JSON.parse` only). Exactly two placements are supported in the
  description: a fenced ` ```moodle-playground ` code block, or the marker
  phrase `Moodle Playground Scenario` followed by a JSON code block. Detection
  is text-based (`textContent`), because Jira's rich-text renderer strips
  markdown fences and its DOM structure is unstable.
* The userscript renders one floating button per issue page: scenario
  (verbatim base64url `?blueprint=`), starter
  (`?blueprint-url=assets/blueprints/examples/tracker-starter.blueprint.json`),
  or a warning badge when a block exists but is invalid.
* The starter preset is a bundled example blueprint (course `REPRO`, teacher +
  student enrolled, forum/assignment/quiz/page), so it is reviewable,
  versioned, unit-tested, and keeps the URL short.

Natural-language parsing is rejected as inherently unreliable (silent wrong
setups are worse than none). A Behat-like shorthand is deferred: it adds a
parser and an ambiguity surface without enabling anything the JSON form cannot
express; it can be layered on later as sugar that compiles to the same
blueprints. No new runtime, schema, or step types are introduced — the
scenario rides the existing `?blueprint=`/`?blueprint-url=` contracts.

## Consequences

### Positive
* Deterministic and transparent: what the issue declares is exactly what the
  playground loads, and the playground's existing validation reports errors.
* Zero runtime changes; nothing to maintain in the boot path. Reuses parser,
  schema, executor, and the PR #158 URL conventions.
* Testable at every layer: pure extraction functions (unit tests via the
  userscript's `__MPP_TEST__` vm hook), offline Playwright fixtures for DOM
  injection, schema tests for the starter preset.
* The starter preset directly implements the issue #166 workaround for the
  vast majority of issues that will never carry a scenario block.

### Negative / Risks
* Issue authors must write JSON; there is no shorthand yet. Mitigated by
  copy-paste templates in `docs/tracker-scenarios.md`.
* Marker-phrase detection could in principle collide with prose that mentions
  "Moodle Playground Scenario" right before an unrelated JSON object; the
  result is a visible warning badge, not a wrong setup.
* The tracker DOM may change; mitigated by reading only page text and using a
  floating button (no Atlassian layout hooks).
* `addModule` cannot create quiz questions, so the starter quiz is empty
  (documented limitation).

## Implementation Notes

* `scripts/moodle-playground-pr-button.user.js` — extraction
  (`extractPlaygroundScenario`, `scanJsonObject`), URL building
  (`buildScenarioUrl`, `buildStarterUrl`), and the idempotent
  `injectTrackerScenario` renderer (state-stamped, SPA-safe, script/style text
  excluded from scanning).
* `assets/blueprints/examples/tracker-starter.blueprint.json` — starter preset.
* Tests: `tests/scripts/tracker-scenario.test.js`,
  `tests/blueprint/tracker-starter.test.js`,
  `tests/e2e/tracker-userscript.spec.mjs`.
* Docs: `docs/tracker-scenarios.md`, `docs/browser-userscripts.md`,
  `docs/blueprints/examples.md`.
* Spec: `docs/internal/specs/tracker-moodle-scenario-blueprints.md`.

## Review Criteria

Revisit this decision if:

* Moodle Tracker adds a structured field (or Forge app) for scenarios — the
  extraction layer should then read that field instead of description text.
* Demand for a Behat-like shorthand materializes (e.g. issue authors refuse
  JSON) — add it as a compiler to blueprint JSON, keeping this format as the
  canonical target.
* The marker forms prove too fragile against Jira renderer changes (e.g. code
  block text stops being reachable via `textContent`).
* Blueprint capabilities grow (quiz questions, groups) — update the starter
  preset and docs accordingly.
