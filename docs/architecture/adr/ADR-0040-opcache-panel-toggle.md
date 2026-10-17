---
id: ADR-0040
title: "Expose the experimental OPcache flag as an info-panel toggle that reloads without resetting"
status: Accepted
date: 2026-10-17
deciders: [erseco]
reviewers: []
related:
  issues: [353]
  prs: []
  sdds: [SDD-0002]
  adrs: [ADR-0039, ADR-0038]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5-1"
---

# ADR-0040: Expose the experimental OPcache flag as an info-panel toggle that reloads without resetting

## Status

Accepted (2026-10-17). Extends ADR-0039, which stays the decision on *whether* and
*how* the cache starts; this record only decides how users reach the flag.

## Context

ADR-0039 shipped `?opcache=1|0` with `"opcache": false` as the config default. The
only way to try the cache was to edit the URL, so the soak period asked for in issue
#353 had no users. The same issue proposes a UI entry point and asks whether a
boot-time banner should advertise the flag.

The info panel already hosts the Moodle/PHP selectors with a dirty-state "Apply &
Reset" flow (`src/shell/main.js` `refreshDirtyState()` / `applyConfigAndReset()`),
which reloads the page with `?php=`/`?moodle=`. A version change produces a new
runtime id and therefore a new database path
(`/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`), which is why that flow is
destructive. The `opcache` parameter is already plumbed shell → `remote.html` →
worker (`src/shared/version-resolver.js` `parseQueryParams`, `src/shared/paths.js`
`resolveRemoteUrl`, `isOpcacheEnabled()` in `src/runtime/config-template.js`), and
`blueprintSourceKey()` ignores it, so a reload with a different `opcache` value keeps
the scope, the runtime id and the IndexedDB journal.

FacturaScripts Playground implemented the same toggle first
(erseco/facturascripts-playground#165) and found that phpinfo prints the SAPI's
pretty name (`PHP WASM SAPI (JSPI)`) regardless of `setSapiName()`; the row that
proves the cache is live is `Opcode Caching: Up and Running`.

## Problem

How should users turn the experimental OPcache flag on and off without editing the
URL, without making it the default, and without losing their data?

## Decision drivers

- Make the flag reachable so the soak period produces evidence.
- Do not nag users who only want Moodle to load.
- Reuse the existing panel, dirty-state flow and `?opcache=` contract; no new
  persisted state (playgrounds are ephemeral).
- Enabling OPcache must not reset the site.

## Options considered

### Option 1: Checkbox in the panel's Configuration section (chosen)

Next to the version selectors. Toggling it alone shows a neutral reload note and an
"Apply & Reload" button; a version change on top brings back the destructive "Apply
& Reset" warning. Applying sets or deletes `?opcache=` on the shell URL and reloads
the page. Pros: ~60 lines, reuses everything. Cons: discoverable only to users who
open the panel.

### Option 2: Boot-time banner or toast

Pros: visible to everyone. Cons: the playground has no durable place to remember
"dismissed" (sessionStorage would silence it per tab only), so it nags on every
boot, and it pushes an experimental feature at users who did not ask for it.
Rejected while the flag is experimental.

### Option 3: No UI, flip the default after the soak

Zero code, but it does not help the soak: nobody tries the flag before it becomes
the default. Remains the follow-up once the evidence is in.

## Evidence

- `src/shell/main.js` `applyConfigAndReset()` @ `2be0b46`: full page reload with
  URL parameters; the shell re-reads `opcache` in `main()`.
- `src/shared/paths.js` `blueprintSourceKey()` @ `2be0b46`: only `blueprint-url`,
  `blueprint`, `blueprint-data` take part, so `opcache` cannot force a clean boot.
- AGENTS.md runtime invariants: reloading the same blueprint source retains the
  journal; scope comes from `sessionStorage`.
- erseco/facturascripts-playground#165: same UX, e2e proved the frame keeps its
  scope without `clean=1` and phpinfo goes from `Opcode Caching: Disabled` to
  `Up and Running`.

## Decision

We will add an "OPcache file cache (experimental, uses more memory)" checkbox to
the info panel's Configuration section. `opcacheUrlParam(enabled, config)` in
`config-template.js` is the inverse of `isOpcacheEnabled()`: it yields `"1"`/`"0"`
only when the choice differs from the config default, so the URL stays clean at the
default. Applying an OPcache-only change reloads the page with the same runtime and
scope ("Apply & Reload"); any version change keeps the existing "Apply & Reset"
semantics. No banner. Nextcloud Playground is excluded by its own issue
(ateeducacion/nextcloud-playground#106: the measured gain there is neutral).

The PHP tab's phpinfo is captured on a separate diagnostics runtime
(`createProvisioningRuntime()` in `src/runtime/php-loader.js`), which until now
never applied the SAPI name and therefore always reported `Opcode Caching:
Disabled` on PHP 8.3/8.4. It now receives the same `opcache` decision as the
serving runtime, so the tab reflects the user's choice; the CLI install runtime
stays unchanged (ADR-0039).

## Consequences

### Positive

- The flag is one click away for anyone testing performance; the URL still works
  for scripted runs and bug reports.
- No new storage, no new message types; the panel's dirty-state code grows by one
  input.

### Negative

- A reload interrupts whatever the user was doing inside Moodle (forms in flight
  are lost, data on disk is not).
- Discoverability depends on opening the panel.

### Neutral

- The checkbox reflects the *requested* state (`isOpcacheEnabled()`). The PHP
  tab's phpinfo (`Opcode Caching` row) shows what a runtime booted with that
  decision reports; the e2e canary remains the proof on the serving path.

## Risks

- A future change that makes `blueprintSourceKey()` or the clean-boot conditions
  depend on arbitrary URL parameters would turn the reload into a reset. The e2e
  test asserts the frame keeps its scope without `clean=1`.
- If php-wasm or PHP changes SAPI handling, the toggle degrades to "no effect",
  never to stale bytecode (ADR-0038 validation is unconditional).

## Validation

- Unit: `tests/runtime/config-template.test.js` round-trips `opcacheUrlParam()`
  through `isOpcacheEnabled()` for every config default.
- Browser: `tests/e2e/shell.spec.mjs` covers the dirty-state UI (reload note vs
  warning, button label and style) and an end-to-end toggle on the default PHP 8.3
  runtime: phpinfo `Opcode Caching: Disabled` → check → apply → same scope, no
  `clean=1`, URL carries `opcache=1` → `Opcode Caching: Up and Running`.
- Revisit when issue #353 has the soak measurements: either flip the default (new
  ADR) or remove the toggle.

## Follow-up work

- Issue #353: soak test plan and the default-flip decision.
- Port to Omeka S Playground (ateeducacion/omeka-s-playground#194).

## References

- Issue #353; ADR-0038, ADR-0039; SDD-0002.
- erseco/facturascripts-playground#165 (first implementation).
- ateeducacion/nextcloud-playground#106 (why Nextcloud gets no toggle for now).
