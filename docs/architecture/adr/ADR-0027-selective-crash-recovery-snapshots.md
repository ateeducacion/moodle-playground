---
id: ADR-0027
title: "Selective crash recovery snapshots to bound memory usage during recovery"
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
  tool: "Grok (xAI)"
  model: "grok"
---

# ADR-0027: Selective crash recovery snapshots to bound memory usage during recovery

## Status

Proposed

## Context

The PHP WASM runtime can crash due to OOM, file descriptor exhaustion, or other fatal errors. The crash recovery system (see `src/runtime/crash-recovery.js`) takes a snapshot of critical state before destroying the old runtime and restores it after booting a fresh one.

Previously the system captured:
- The SQLite database
- Files from installed plugin directories
- The entire `filedir` (user uploaded content)

All data was read into JavaScript arrays of `Uint8Array` while the runtime was already in a bad state.

## Problem

Capturing the full `filedir` (which can grow to tens or hundreds of MB with user content, course files, etc.) requires significant temporary memory at the exact moment when memory is most constrained. This increases the chance of secondary failures during the recovery process itself.

## Decision drivers

- Crash recovery must be reliable and use as little extra memory as possible.
- The primary value of recovery is preserving the database (courses, users, grades, config) and installed plugins.
- In the ephemeral "playground" model, user-uploaded files are less critical than the structured data.
- We must avoid patterns that make recovery itself likely to OOM.

## Options considered

### Option 1: Always snapshot everything (previous behavior)
- Pros: Maximum data preservation.
- Cons: High memory spike risk during crash.

### Option 2: Never snapshot anything except DB
- Pros: Very safe.
- Cons: Loses plugin files that may have been added at runtime.

### Option 3: Snapshot DB + plugin files, intentionally skip filedir (chosen)
- Pros: Covers the most important state while keeping the snapshot process bounded.
- Cons: User files in filedir are lost on crash (acceptable for this use case).

## Evidence

- Crash snapshots are taken from MEMFS (JS heap) using `readFileAsBuffer` / `listFiles`.
- The `filedir` collection was the largest potential consumer.
- Existing policy already excludes ephemeral cache directories from journaling (see `fs-persistence.js` and ADR-0025 context).
- Recovery is a "best effort" mechanism; full site export is available separately.

## Decision

We will make crash recovery snapshots selective:

- Always attempt to preserve the SQLite database.
- Preserve files from directories registered via `trackPluginDir()` (runtime-installed plugins/themes).
- **Intentionally do not** snapshot the `filedir` contents.

The `savedFiledirFiles` path is disabled, and `hasPendingRestore` no longer considers it.

## Consequences

### Positive
- Significantly lower memory usage during the critical crash → recover window.
- More reliable recovery on memory-constrained devices.
- Consistent with the "ephemeral but useful state" philosophy of the project.

### Negative
- On a crash, user-uploaded files (course resources, user pictures, etc.) will be lost. The database and plugins survive.
- Slightly more complex restore logic and comments.

### Neutral
- The mechanism for tracking plugins remains; only the filedir collection is removed.

## Risks
- A plugin that heavily uses the filedir for its own data could lose state. In practice most plugin data lives in the DB or its own plugin directory (which we still preserve).

## Validation
- Crash recovery unit tests updated/verified for the supported paths.
- Manual crash simulation (via forced errors) in browser.
- Revisit if a strong use-case for preserving large user files on crash appears (e.g. via size-bounded or lazy snapshotting).

## Follow-up work
- Consider adding a size guard + optional filedir snapshot behind a flag if needed in the future.
- Monitor real-world crash frequency and recovery success rate.

## References
- ADR-0025 (runtime lifecycle and diagnostics)
- `src/runtime/crash-recovery.js`
- PR #264
