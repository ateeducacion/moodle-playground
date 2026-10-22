---
id: ADR-0047
title: "Expose the runtime web root to blueprints as {{MOODLE_DIRROOT}}"
status: Proposed
date: 2026-10-22
deciders: [erseco]
reviewers: []
related:
  issues: [394]
  prs: []
  sdds: []
  adrs: [ADR-0035]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "Claude Opus 5.5"
---

# ADR-0047: Expose the runtime web root to blueprints as {{MOODLE_DIRROOT}}

## Status

Proposed

## Context

Moodle 5.1 moved web-served code, plugins included, under `public/`. Each branch
in `src/shared/version-resolver.js` declares its `webRoot` (`/www/moodle` up to
5.0, `/www/moodle/public` from 5.1). `installMoodlePlugin` already installs into
`context.webRoot`, but filesystem steps such as `unzip` take literal paths. A
blueprint written for 5.0 and booted with `?moodle=5.2` installs the plugin under
`public/` and unzips its assets outside it (issue #394).

## Problem

How does one blueprint address plugin directories on every supported Moodle
version, including when the URL overrides `preferredVersions`?

## Decision drivers

- One blueprint must work for every version the playground offers.
- The value must follow the runtime that booted, not the blueprint's preference.
- Existing literal paths must keep their meaning.

## Options considered

### Option 1: built-in, reserved `{{MOODLE_DIRROOT}}` constant

Add the booted runtime's `webRoot` to the constants `substituteConstants()`
already applies. Blueprint constants cannot override it.

### Option 2: rewrite `/www/moodle/` paths to the web root

Silent and wrong for files outside `public/` such as `config.php`, which stays in
the source root on Moodle 5.1+.

### Option 3: one blueprint per Moodle version

Breaks URL version overrides and duplicates every blueprint.

## Evidence

- `src/shared/version-resolver.js`: per-branch `webRoot`.
- `src/blueprint/executor.js`: constants are substituted once, before steps and
  checkpoint reload decisions, so reloads see resolved paths.
- `tests/blueprint/executor.test.js` › `{{MOODLE_DIRROOT}} (#394)`: resolution on
  every branch, shadowing, nested values and checkpoint reload.

## Decision

We will add `MOODLE_DIRROOT`, set to `context.webRoot`, to the blueprint
constants in `executeBlueprint`, after the blueprint's own constants so it
cannot be overridden. Literal paths are not rewritten.

## Consequences

### Positive

- Version-independent blueprints for plugin assets.
- URL overrides resolve against the selected runtime.

### Negative

- A blueprint that already defined its own `MOODLE_DIRROOT` constant now gets
  the runtime value.

### Neutral

- The checkpoint fingerprint hashes the unresolved blueprint. Each runtime has
  its own database and checkpoint, so the same fingerprint never spans two web
  roots.

## Risks

Low. Blueprints without the placeholder behave exactly as before.

## Validation

The unit tests above. Once the follow-up lands, boot the `exelearning/mod_exescorm`
blueprint with `?moodle=5.0` and `?moodle=5.2` and check the editor loads.

## Follow-up work

Update the blueprints of `exelearning/mod_exescorm`, `exelearning/mod_exeweb` and
`exelearning/moodle-mod_exelearning`.

## References

- Issue #394
- [Blueprint reference](../../blueprints/reference.md#moodle_dirroot)
- ADR-0035 (blueprint reload checkpoints)
