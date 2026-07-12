---
id: ADR-0027
title: "Coherent selective crash recovery checkpoints"
status: Proposed
date: 2026-07-12
deciders:
  - "ernesto"
reviewers:
  - ""
related:
  issues: []
  prs: ["#264"]
  sdds: []
  adrs: ["ADR-0025"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "ChatGPT (OpenAI)"
  model: "GPT-5.6 Thinking"
---

# ADR-0027: Coherent selective crash recovery checkpoints

## Status

Proposed

## Context

The PHP WASM runtime can crash due to OOM, file descriptor exhaustion, or
other fatal errors. The crash recovery system captures state from the old
runtime and restores it after booting a fresh one.

Moodle's mutable `/persist` tree is already journaled to IndexedDB. This
includes:

- The SQLite database
- `moodledata/filedir`
- Configuration and session state

Runtime-installed plugin directories live outside `/persist`, so they require
a separate in-memory snapshot.

The previous crash path also traversed and copied the complete `filedir` into
JavaScript memory. This could add tens or hundreds of MB of allocations while
the runtime was already under memory pressure.

Simply removing the filedir snapshot is not sufficient. A current DB snapshot
restored over an older IndexedDB filedir checkpoint can leave Moodle records
pointing to missing files.

## Decision drivers

- Crash recovery must avoid full-filedir memory spikes.
- The restored SQLite DB and `filedir` must represent the same recovery point.
- A failed optimization must prefer an older coherent checkpoint over a newer
  inconsistent site.
- Runtime-installed plugin files must still survive recovery where possible.
- The crash path must have an explicit memory bound.

## Options considered

### Option 1: Always snapshot the complete DB, plugins, and filedir

- Pros: Captures the latest in-memory state.
- Cons: Copies the complete filedir during the crash path and can trigger a
  secondary OOM.

### Option 2: Snapshot DB and plugins, but never checkpoint filedir

- Pros: Uses less memory.
- Cons: Can restore a newer DB over an older filedir journal and produce broken
  file references.

### Option 3: Selectively checkpoint pending filedir changes before the DB snapshot (chosen)

- Pros: Copies only filedir files changed since the last journal flush, retains
  DB/filedir coherence, and avoids traversing the complete filedir.
- Cons: Recent changes are discarded when the selective checkpoint cannot be
  completed within the configured bound.

## Decision

Crash recovery will use the existing filesystem journal as the source of truth
for `filedir`:

1. Before reading the SQLite DB snapshot, synchronously flush only pending
   journal operations that enter, leave, or modify `moodledata/filedir`.
2. Normalize operations before hydration so repeated writes to the same path
   are read only once.
3. Preflight the selected WRITE operations and reject a crash checkpoint above
   16 MiB before file contents are copied into JavaScript memory.
4. Capture the SQLite DB only after the filedir checkpoint succeeds.
5. Continue snapshotting tracked runtime-installed plugin directories because
   they live outside `/persist`.
6. If the selective journal checkpoint fails or exceeds the limit, do not
   capture a newer live DB or plugin snapshot. Recovery uses the last complete
   IndexedDB checkpoint instead.
7. If filesystem persistence is unavailable, allow a bounded DB + filedir
   in-memory fallback. Abort the live snapshot when that fallback exceeds the
   same byte limit.

The persistence layer exposes an explicit `flushNow()` operation. It supports
path-selective flushing, serializes with any debounced flush already in flight,
retains operations in the pending queue on failure, and reports operation and
byte counts for diagnostics.

## Consequences

### Positive

- The crash path no longer traverses and copies the complete filedir when
  IndexedDB persistence is active.
- DB and filedir recovery remain coherent.
- Only changed filedir contents since the previous flush are hydrated.
- Oversized crash checkpoints fail before their file contents are read.
- Failed IndexedDB writes no longer silently discard selected pending
  operations.
- Recovery logs expose the number of operations and hydrated bytes.

### Negative

- When the selective checkpoint fails or exceeds 16 MiB, changes newer than the
  last persisted checkpoint are lost.
- The persistence code has additional serialization and selective-flush logic.
- Runtime-installed plugin snapshots remain an independent in-memory cost.

### Neutral

- The normal 1.5-second debounced persistence flow remains unchanged.
- Cache and temporary directories remain excluded from persistence.
- Full site export remains the durable way to preserve a Playground instance.

## Risks

- The 16 MiB limit may need tuning based on real browser and device telemetry.
- An individual upload larger than the limit causes recovery to use the prior
  checkpoint rather than the latest in-memory state.
- Plugin directories can still consume significant memory if very large; a
  separate plugin snapshot limit may be added later.

## Validation

- Unit tests verify that only filedir operations are flushed during the crash
  checkpoint.
- Unit tests verify that repeated writes are hydrated once.
- Unit tests verify that oversized checkpoints are rejected before file reads.
- Unit tests verify that failed persistence writes return operations to the
  pending queue.
- Crash recovery tests verify journal success, checkpoint failure, bounded
  no-persistence fallback, and fallback size rejection.
- CI and manual forced-crash verification cover the complete browser flow.

## Follow-up work

- Measure checkpoint operation counts, hydrated bytes, and recovery success in
  real browser sessions.
- Revisit the 16 MiB threshold using collected evidence.
- Consider a separate bound for runtime-installed plugin snapshots.

## References

- ADR-0025 (runtime lifecycle and diagnostics)
- `src/runtime/fs-persistence.js`
- `src/runtime/crash-recovery.js`
- PR #264
