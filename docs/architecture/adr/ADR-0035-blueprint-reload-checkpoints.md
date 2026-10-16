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

Second-review regressions against `f1b43cf`: Chromium's plugin and overlay fixtures
execute an `after_config` hook on first boot but lose its effect after reload.
Moodle bundle source `42622298fe06f9626d988d60b2bf589bd8f850e8`,
`public/lib/classes/hook/manager.php::get_cache()` reads the local/shared
`hookcallbacks.php` files; `public/cache/classes/helper.php::purge_all()` only
purges cache stores and ad-hoc MUC caches. Tests are in
`tests/e2e/blueprint-reload.spec.mjs` and `tests/e2e/blueprint-review.spec.mjs`.

## Decision

Store version1, SHA-256 of the blueprint and completed zero-based step indices in
`mdl_config.playground_blueprint_checkpoint`. Save an empty checkpoint before
first provisioning and update it after each successful handler. A failed save
aborts subsequent mutations; ordinary handler failures retain ADR-0005 semantics.
Treat incompatible/mismatched metadata as a changed blueprint (the source key can
stay the same while its content changes): keep the data, replay nothing but
login/landing, and warn that Reset applies the new blueprint.
Reset saves the already resolved URL/inline blueprint before recreating the remote
(without another network fetch); parameterless Reset resolves the default again;
different-source clean boots consume their source key only after SW control and
remote URL assignment, not before a possible control-related shell reload.
Moodle can clear the origin's sessionStorage on jsrev/login changes. The shell
handles the resulting storage-clear event by restoring only its active scope,
source identity, selected blueprint and navigation state, not Moodle's caches.
Create the empty checkpoint immediately after writing the install snapshot (or
after successful CLI installation), before the installed marker, seed and language
tasks. An interruption in those later tasks is unfinished provisioning, not legacy.

On persisted boot, skip durable mutations and arbitrary PHP/HTTP requests. Repeat
login/landing-page selection; restore only completed explicit `/www` or `/tmp`
filesystem operations, filtering mixed batches and normalized traversal paths.
Also restore declared derived `moodledata/{cache,localcache,temp,muc}` paths using
the journal's shared exclusion predicate. Never overwrite durable `/persist` data
on reload; transformed copy/move operations retain `critical`.
Preserve the exact downloaded plugin
ZIP and applied overlay files (volatile roots only) below
`/persist/blueprints/<runtimeId>/<fingerprint>/`
(each runtime has its own DB, but the scope shares `/persist`); restore
files/discovery without repeating install/upgrade scripts or a full cache purge
(the unversioned DI container and bytecode are dropped without bumping revisions;
`purgeCaches:false` drops nothing for overlays). Both plugin and overlay restores
empty MUC with `cache_helper::purge_all()` and delete **both**
`cachedir/hookcallbacks.php` and `localcachedir/hookcallbacks.php`. Moodle's
`core\hook\manager` reads those files independently of MUC; boot requests can
cache the base hook registry before restored code exists. MUC purging alone
does not restore those hooks. The shared generated block also drops DI and
bytecode without changing JS/theme revisions.
Volatile
means "not journaled": any path outside `/persist` (except devices) plus the
derived directories above. On reload a failing `critical` step does not stop
login/landing, and an executor that never started leaves auto-login enabled. An overlay with skipped files or a failed upgrade still saves what
it applied, so reload restores the code the DB saw. Flush existing persistence
before publishing runtime readiness so future live recovery snapshots cannot
reference unflushed artifacts. A failed flush warns instead of blocking: the
journal is replaced atomically, so the previous state stays coherent. No new IndexedDB database or core journal.
Flush rejection and unavailable persistence also warn without aborting the session;
record elapsed time, hydrated bytes and operation count for profiling.
After live crash-snapshot DB restoration, discard MUC warmed by bootstrap against
the older DB before plugin refresh/re-login. Use `cache_helper::purge_all()`, not
`purge_all_caches()`: derived values must match the recovered DB without bumping
asset revisions. A failure to clear them is reported as an error but does not
abort: restore() has already consumed the crash snapshot, so throwing would leave
a rejected runtime promise (every request failing, toolbar locked) and discard
the recovered DB.
After a non-idempotent request crashes and runtime reset is allowed, return the
503 without replaying it, then bootstrap the replacement runtime inside the
existing serial queue. Otherwise the rotation progress locks the toolbar while
recovery waits for a GET the locked toolbar cannot send. Failed recovery emits
an error instead of leaving readiness pending forever.
Apply the installation locale only on fresh installs; otherwise bootstrap would
undo a checkpointed `setConfig(lang)` before the executor skips that completed step.

Save bytes for declared volatile filesystem outputs too. Reload reads those
artifacts rather than re-fetching resources or consuming a move's original source;
a move from `/persist` to `/www` must not delete persisted data again.

Legacy instances without metadata do not replay mutations. They emit an explicit
warning because the provenance of volatile files is unknown. Previously unfinished
steps are not retried automatically and remain a visible blueprint failure.
An unfinished plugin/overlay may restore an already saved artifact, without
downloading or running install/upgrade again; it remains unfinished. Keep that
code even after registration failure because the retained DB may contain partial
schema changes. Do not delete all failed-step artifacts as quota cleanup.
A previously completed plugin/theme absent from the retained installed-plugin
registry is treated as uninstalled and is not restored from its old ZIP.
Legacy sites still require explicit recovery: downloading a moving URL cannot
establish compatibility with the code that produced their database.
Skipped arbitrary PHP emits a warning that its volatile filesystem effects are
not restored; no PHP payload is logged.

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
