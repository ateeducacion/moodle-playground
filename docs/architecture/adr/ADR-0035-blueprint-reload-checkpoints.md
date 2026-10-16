---
id: ADR-0035
title: "Checkpoint provisioning and restore volatile blueprint artifacts"
status: Proposed
date: 2026-10-16
deciders: []
reviewers: []
related:
  issues: []
  prs: []
  sdds: [SDD-0002]
  adrs: [ADR-0005, ADR-0027]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Codex"
  model: "GPT-5"
---

# ADR-0035: Checkpoint provisioning and restore volatile blueprint artifacts

## Status

Proposed. The maintainer explicitly approved the replay policy during this task;
this record still awaits repository review.

## Context

At `06bcd45a`, bootstrap reuses the persisted database but executes every blueprint
step again. The audit's five reloads fail on an existing course. Core MEMFS is
rebuilt, so skipping every step would instead lose declared files and plugins.

## Problem

Reload retained Moodle data without repeating provisioning mutations, while
restoring declared volatile artifacts and recreating the session.

## Decision drivers

- Keep the SQLite/filedir recovery invariants of ADR-0027.
- Never automatically replay arbitrary PHP or HTTP requests, including POST.
- Do not turn reload into an implicit plugin upgrade from a moving URL.

## Options considered

### Option 1: Replay everything or skip everything

Rejected: respectively duplicates persisted data or drops volatile files.

### Option 2: Store a separate IndexedDB list of successful steps

Rejected: the list could disagree with the recovered database.

### Option 3: Checkpoint inside SQLite and restore declared artifacts

Selected. It changes no public blueprint schema and uses the existing journal.

## Evidence

`src/runtime/bootstrap.js`, `src/blueprint/executor.js`, filesystem/plugin/overlay
handlers and `src/runtime/crash-recovery.js` at `06bcd45a`; audit scenario C (5/5
course-creation errors). Explicit maintainer approval of this policy, 2026-10-16.

## Decision

Store version1, SHA-256 of the blueprint and completed zero-based step indices in
`mdl_config.playground_blueprint_checkpoint`. Save an empty checkpoint before
first provisioning and update it after each successful handler. A failed save
aborts subsequent mutations; ordinary handler failures retain ADR-0005 semantics.
Reject incompatible/mismatched metadata without replaying provisioning.

On persisted boot, skip durable mutations and arbitrary PHP/HTTP requests. Repeat
login/landing-page selection; restore only completed explicit `/www` or `/tmp`
filesystem operations, filtering mixed batches and normalized traversal paths.
Never overwrite `/persist` data on reload. Preserve the exact downloaded plugin
ZIP and applied overlay files below `/persist/blueprints/<fingerprint>/`; restore
files/discovery without repeating install/upgrade scripts. Flush existing
persistence before publishing runtime readiness so future live recovery snapshots
cannot reference unflushed artifacts. No new IndexedDB database or core journal.
Apply the installation locale only on fresh installs; otherwise bootstrap would
undo a checkpointed `setConfig(lang)` before the executor skips that completed step.

Save bytes for declared volatile filesystem outputs too. Reload reads those
artifacts rather than re-fetching resources or consuming a move's original source;
a move from `/persist` to `/www` must not delete persisted data again.

Legacy instances without metadata do not replay mutations. They emit an explicit
warning because the provenance of volatile files is unknown. Previously unfinished
steps are not retried automatically and remain a visible blueprint failure.

## Consequences

### Positive

- Reload retains courses, configuration and File API data without duplication.
- Declared plugins survive without re-downloading moving URLs or upgrading again.

### Negative

- Stored ZIPs/overlays add MEMFS and IndexedDB bytes and a boot-time flush.
- Legacy/partial provisioning needs explicit user recovery, not an automatic retry.
- Arbitrary PHP effects on volatile files are not reconstructed. Updates made to
  `/www` outside declared blueprint steps remain volatile, as before this change.

### Neutral

- The active database remains a MEMFS file; no OPFS or persistent PHP state.

## Risks

Checkpointing is not a transaction around arbitrary PHP: a crash between a mutation
and its marker leaves an uncertain step. Never retry it automatically. Missing
saved artifacts fail visibly; do not silently fetch a replacement. This is not a
general persistence layer for runtime editor/plugin-manager changes to `/www`.
After a manual plugin upgrade, the retained DB may be newer than the saved ZIP;
that reload workflow requires separate code-version consistency validation.

## Validation

Unit tests cover policy, constants, mixed paths, metadata validation, failed saves,
partial provisioning and offline plugin/overlay restoration. Browser tests must
verify authentication, retained DB/File API data, non-repeated PHP/POST, restored
files/plugins and unchanged counts after persisted reload on Chromium/Firefox.

## Follow-up work

An explicit retry/recovery UX and persistence of arbitrary runtime code edits need
separate design work; do not infer either from a reload.

## References

- [SDD-0002](../sdd/SDD-0002-incremental-navigation-and-reload-correctness.md)
- [ADR-0027](ADR-0027-selective-crash-recovery-snapshots.md)
- `tests/blueprint/checkpoint.test.js`, `tests/e2e/javascript-assets.spec.mjs`.
