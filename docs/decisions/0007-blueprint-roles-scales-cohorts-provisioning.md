# ADR-0007 Blueprint provisioning for roles, scales and cohorts

* Status: Accepted
* Date: 2026-06-08

## Context and Problem

The blueprint system could provision users, courses, categories, sections, enrolments, modules,
plugins and language packs, but had **no way to define roles, grading scales or cohorts**. These
are essential for realistic Moodle setups: custom roles (e.g. a course "coordinator", or a guest
that can see hidden courses), competency/grading scales, and site cohorts.

Real-world inputs already exist in two shapes:

* **Roles** are routinely authored in the Moodle admin UI and exported as *role preset XML*
  (*Site administration → Users → Permissions → Define roles → Export*) — a `<role>` document with
  archetype, context levels, hundreds of capabilities, and
  `allowassign`/`allowoverride`/`allowswitch`/`allowview` relationships.
* **Scales** are commonly captured as JSON (a `{ "format": "moodle-scale-export", "scales": [...] }`
  envelope where each scale has a `name` and a comma-separated `items` string).

Two requirements drove the design: data must be definable **inline in the blueprint** *and*
**by reference to an external JSON/XML (URL or similar)**; and the result should generalize so the
remaining "and the rest" data (cohorts now; custom fields, competencies later) is cheap to add.

## Options Considered

* **Option 1 — A new "external file" mechanism per step.** Add bespoke `rolesUrl` / `scalesUrl`
  fields and fetch logic in each handler. Rejected: it duplicates the existing resource system and
  invents a parallel, inconsistent way to reference external data.

* **Option 2 — JSON-only roles.** Express every role as a JSON capability map. Rejected as the sole
  mechanism: real exports carry hundreds of capabilities and relationship tables; re-encoding them
  as JSON by hand is impractical, and we would be reimplementing Moodle's own preset parser.

* **Option 3 — Reuse the resource system; add domain steps; for roles support both the native XML
  preset (via Moodle core's parser) and a JSON-native form.** New steps consume the existing
  `ResourceRegistry` (`url`/`base64`/`data-url`/`bundled`/`vfs`/`literal` + `@name`), exactly like
  `writeFile`/`unzip`, so "load from a URL" needs no new code.

## Decision

**Option 3.** Add three step domains, each definable inline or by `@resource`/URL through the
existing resource system:

1. **Roles — two complementary steps.**
   * `importRolePreset` / `importRoles` import **native Moodle role preset XML**, parsed by Moodle
     core itself (`core_role_preset::parse_preset` / `is_valid_preset`). A two-pass apply
     (create/update all role records, then context levels + system-context capabilities +
     relationship tables) lets interdependent roles reference each other. Capabilities of
     uninstalled plugins are skipped. Idempotent on `shortname`. The generated PHP is adapted from a
     reference `apply-role-presets.php` but accepts XML **strings** (no filesystem in WASM CLI mode).
   * `createRole` / `createRoles` define roles from a JSON map (`capabilities`, `contextlevels`,
     `allow*` relationships, optional `resetToArchetype`). Permission and context-level names are
     resolved to integers in JS so only safe values reach PHP.

2. **Scales — `createScale` / `createScales`.** `items` accepts an array or a comma-separated
   string. `createScales` also accepts the `moodle-scale-export` envelope so an exported file works
   as-is. Idempotent on `(courseid, name)` via the `grade_scale` class; omitting `course` creates a
   site-wide standard scale.

3. **Cohorts — `createCohort` / `createCohorts`.** Site-context cohorts via `cohort_add_cohort`,
   with optional `members` (usernames → `cohort_add_member`). Idempotent on `idnumber` (or `name`).

A shared `src/blueprint/steps/payload.js` resolves a batch step's payload from an inline array, a
`@name` reference, an inline resource descriptor, or a raw JSON/XML string. All generated PHP runs
in `CLI_SCRIPT` mode, escapes input via `escapePhp()`, installs a graceful `set_exception_handler`
(JSON `{"ok":false}` + `exit(0)` instead of killing WASM — see ADR-0005), and echoes JSON.

## Consequences

### Positive

* **One way to reference external data.** Inline and URL/`@resource` come from the same resource
  system already used elsewhere; no new fetch path, no new CORS/proxy surface.
* **High-fidelity roles for free.** Real exported roles drop straight in because Moodle's own parser
  applies them; the JSON form stays available for small, readable roles.
* **Idempotent and non-fatal**, consistent with the rest of the blueprint executor (ADR-0005).
* **Extensible.** The same handler+generator+resolver recipe covers cohorts now and future data
  (custom fields, competencies) with minimal code.

### Negative / Risks

* **`importRoles` depends on `admin/roles/classes/preset.php`.** It is core Moodle (ships in the
  runtime bundle), but a future core refactor of `core_role_preset` would require revisiting the
  generator.
* **Two ways to define roles** (XML and JSON) is slightly more surface to document; mitigated by a
  clear "use XML for exports, JSON for small custom roles" guideline.
* **Capability skipping is silent per role** (counted, not failed) — a capability for a missing
  plugin is dropped rather than erroring, matching the reference importer's behaviour.

## Implementation Notes

### Files added
* `src/blueprint/steps/moodle-roles.js`, `moodle-scales.js`, `moodle-cohorts.js` — step handlers.
* `src/blueprint/steps/payload.js` — shared inline/`@resource`/URL/raw payload resolution.
* `tests/blueprint/moodle-roles.test.js`, `moodle-scales.test.js`, `moodle-cohorts.test.js`.
* `assets/blueprints/examples/roles-scales-cohorts.blueprint.json` — runnable example.

### Files modified
* `src/blueprint/php/helpers.js` — `phpImportRolePresets`, `phpCreateRoles`, `phpCreateScales`,
  `phpCreateCohorts`, `normalizeScaleItems`, and a shared graceful handler.
* `src/blueprint/steps/index.js` — register the three step groups.
* `src/blueprint/schema.js`, `assets/blueprints/blueprint-schema.json` — add the 8 step names
  (the JSON schema enum also picked up the previously missing `setTheme` / `installLanguagePack`).
* `tests/blueprint/steps.test.js` — extend the expected step list.
* `docs/blueprint-json.md`, `docs/blueprint-gallery.md` — document the steps, the inline-vs-URL
  model, and the extension pattern.

## Review Criteria

* If Moodle core changes `core_role_preset` (parsing API or the role preset XML schema), re-verify
  `importRoles` against a fresh export.
* If the `grade_scale`, `create_role`/`assign_capability`, or `cohort_*` APIs change, re-verify the
  affected generator.
* If the resource system gains new descriptor types, confirm `payload.js`'s
  `isResourceDescriptor()` still distinguishes descriptors from inline domain data (e.g. the scale
  envelope).
