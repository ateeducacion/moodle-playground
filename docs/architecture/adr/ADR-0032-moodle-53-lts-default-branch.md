---
id: ADR-0032
title: "Moodle 5.3 LTS is the default branch"
status: Accepted
date: 2026-10-03
deciders:
  - "@erseco"
reviewers:
  - "@erseco"
related:
  issues: ["#327"]
  prs: ["#328"]
  sdds: []
  adrs: ["ADR-0030"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-opus-5-5"
---

# ADR-0032: Moodle 5.3 LTS is the default branch

## Status

Accepted

## Context

Upstream released Moodle 5.3, the new long-term support release
([moodledev.io](https://moodledev.io/general/releases/5.3) lists it as
"Moodle 5.3 (LTS)"). #328 added `MOODLE_503_STABLE`, but the playground still
booted Moodle 5.0, whose general support has ended. ADR-0030 left changing the
default as a separate decision.

## Problem

Which Moodle branch should a visitor get when no `?moodle=`, runtime ID or
blueprint `preferredVersions` selects one?

## Decision drivers

- New users should land on the supported LTS release.
- Explicit selections, older branches and their asset paths must keep working.

## Options considered

### Option 1: Keep Moodle 5.0

No change, but the default stays on an out-of-support release.

### Option 2: Default to Moodle 5.3 LTS on PHP 8.3

One metadata flag plus the config, default blueprint and build defaults.

## Evidence

- `MOODLE_503_STABLE` bundle and snapshot build and render on PHP 8.3/8.4 in
  Chromium and Firefox (`tests/e2e/moodle-53.spec.mjs`, #328 CI).
- `resolveVersions()` falls back to `DEFAULT_MOODLE_BRANCH` and PHP 8.3, which
  5.3 supports.

## Decision

Option 2. `MOODLE_503_STABLE` is labelled "Moodle 5.3.x (LTS)" and is the only
`default: true` branch; `DEFAULT_MOODLE_BRANCH`, `playground.config.json`, the
default blueprint, the minimal fallback blueprint, `make bundle`/`up-local` and
`latest.json` follow it. Example blueprints that pin an older version keep it.

## Consequences

### Positive

- The default playground runs a supported LTS release with the `public/` webroot.

### Negative

- A changed default runtime ID boots fresh for visitors without an explicit
  selection; their previous 5.0 journal is not reused.

### Neutral

- `latest.json` (legacy fallback manifest) now describes 5.3; branch-mismatch
  guards in `src/runtime/manifest.js` still refuse cross-branch fallbacks.

## Risks

Plugins or blueprints that assumed the legacy webroot only through the default
must now request `"moodle": "5.0"` explicitly.

## Validation

Resolver unit tests assert the default branch, label and resolved PHP version;
CI runs the full unit, build and e2e suites against the new default.

## Follow-up work

Revisit the default at the next LTS (6.3 per the upstream calendar).

## References

- [Moodle releases](https://moodledev.io/general/releases)
- [ADR-0030](ADR-0030-pinned-moodle-prereleases.md)
