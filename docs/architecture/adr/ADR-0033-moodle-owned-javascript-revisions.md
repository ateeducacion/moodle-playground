---
id: ADR-0033
title: "Moodle-owned JavaScript revisions and versioned RequireJS seeds"
status: Proposed
date: 2026-10-16
deciders: []
reviewers: []
related:
  issues: []
  prs: []
  sdds: [SDD-0002]
  adrs: [ADR-0013]
supersedes: [ADR-0013]
superseded_by: []
ai_assistance:
  tool: "Codex"
  model: "GPT-5"
---

# ADR-0033: Moodle-owned JavaScript revisions and versioned RequireJS seeds

## Status

Proposed replacement for ADR-0013's fixed revision; its build-time combine,
core/first-only serving and no-runtime-combine constraints remain unchanged.

## Context

At `06bcd45a`, config-template.js forces jsrev=1 to match the seeded sha1(1)
combine. Moodle 5.3's configonlylib.php rejects revisions older than its release
date minus two days. Its ESM controller consequently serves development assets
without public immutable caching. Purges and plugin upgrades also cannot update
the effective revision while config.php overrides the database.

## Problem

Keep the prebuilt AMD combine without overriding Moodle's revision or assigning
old combined code a new revision after a mutation.

## Decision drivers

- Correct ESM delivery and cache invalidation before performance.
- No Moodle core modification, new runtime dependency or runtime combine.
- Legacy manifests and seeds remain usable through the per-module fallback.

## Options considered

### Option 1: Replace 1 with another fixed timestamp

The audit prototype improves warm navigation, but still prevents normal
invalidation and embeds a fixture-specific revision. Rejected.

### Option 2: Let Moodle own jsrev and version the build-time seed

Selected. A changed database revision cannot match the old seed filename.
Missing combinations use the existing per-module serving path.

## Evidence

- `src/runtime/config-template.js`, `scripts/generate-install-snapshot.sh` and
  `scripts/patch-moodle-source.sh` at `06bcd45a`.
- Moodle `42622298fe06f9626d988d60b2bf589bd8f850e8`,
  `public/lib/configonlylib.php:216–263` and
  `public/lib/classes/route/controller/esm_controller.php:80–138`.
- Performance audit dated 2026-10-16, F1/F2: dashboard median4676→698ms in
  sequential local series. These are not guaranteed production percentages
  and do not establish a cold-start improvement.

## Decision

Do not set `$CFG->jsrev` in generated config.php. Build the combine at
`requirejs/sha1($CFG->jsrev)` and include a numeric `requirejs/revision` metadata
file in the seed. Publish it as additive `snapshot.jsrev` manifest metadata.
When advertised, verify both metadata and the corresponding combined file during
extraction. Invalid metadata fails loudly; absent metadata remains compatible.
Never rename an old seed to a newer database revision. Purges/plugin upgrades
continue using Moodle's own revision changes and the existing per-module fallback.

## Consequences

### Positive

- Moodle 5.3 ESM URLs use valid revisions without hardcoded timestamps.
- Runtime mutations can invalidate URLs normally.
- Seed verification detects mismatched build artifacts.

### Negative

- Old sha1(1) seeds no longer accelerate AMD requests using a different DB
  revision; rebuild assets to regain the combine. They do not break loading.
- A purge or revision change may use the slower per-module path until a
  matching seed is available; correctness takes precedence over stale code.
- When the seed is advertised, cachejs stays on after a purge (no `is_dir`
  guard). The patched requirejs.php never builds a combine; without a matching
  one it serves modules individually under the positive revision. The client
  keeps a valid jsrev, so ESM stays public/immutable instead of dropping to -1.

### Neutral

- Schema version remains1. SQLite, journaling, OPcache and PHP-WASM versions
  are not changed by this decision.

## Risks

Mismatched snapshot/seed metadata, plugin AMD delivery, lazy modules and subpath
CSS must remain covered. Keep source maps needed by the per-module fallback.

## Validation

Unit tests for unpinned configuration and manifest validation; runtime seed
checks; Chromium/Firefox on5.3 and an older branch, including purge, plugin AMD,
plugin upgrade and reload. Compare against rebuilt dependencies, not stale bundles.

## Follow-up work

Public immutable ESM caching is a separate change, ADR-0034. A direct MEMFS map
and effective OPcache activation remain out of scope.

## References

- [ADR-0013](ADR-0013-build-time-requirejs-combined-bundle-seed.md)
- [SDD-0002](../sdd/SDD-0002-incremental-navigation-and-reload-correctness.md)
- [Moodle ESM controller](https://github.com/moodle/moodle/blob/42622298fe06f9626d988d60b2bf589bd8f850e8/public/lib/classes/route/controller/esm_controller.php)
