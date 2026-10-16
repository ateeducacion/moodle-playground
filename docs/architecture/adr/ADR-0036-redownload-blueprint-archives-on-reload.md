---
id: ADR-0036
title: "Download blueprint plugin and unzip archives again on reload"
status: Accepted
date: 2026-10-16
deciders: [erseco]
reviewers: []
related:
  issues: []
  prs: [341]
  sdds: [SDD-0002]
  adrs: [ADR-0035]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-opus-5-5"
---

# ADR-0036: Download blueprint plugin and unzip archives again on reload

## Status

Accepted (2026-10-16). Amends ADR-0035 for archives only; its checkpoints, overlay
copies and other filesystem artifacts are unchanged.

## Context

ADR-0035 restores volatile blueprint code on a persisted reload. For
`installMoodlePlugin`/`installTheme` it copied the downloaded ZIP to
`/persist/blueprints/<runtimeId>/<fingerprint>/<i>.zip`, and `unzip` copied its
archive to `<i>-files-0.bin`, so a reload could reuse the exact bytes offline.

`/persist` is journaled to IndexedDB per scope, and closing a tab does not delete
that database. Playground sessions are short-lived: people open one, use it and
forget it. Each plugin blueprint therefore left multi-megabyte copies in browser
storage that only a reload of that same tab could ever read.

## Problem

Restore plugin and archive code on reload without persisting copies of it.

## Decision drivers

- Store nothing that a short-lived session does not need.
- A reload must still restore the code the database registered, without rerunning
  install or upgrade scripts on the persisted database.
- Keep the change small; do not touch checkpoints, overlays or other artifacts.

## Options considered

### Option 1: Keep exact ZIP copies (ADR-0035)

Offline reloads work and a moving URL cannot change the code. Rejected: the copies
outlive the session in IndexedDB.

### Option 2: Download the archive again on every boot

Selected. The same mechanism already runs on a fresh boot; reload only skips the
upgrade (plugins) as before. Nothing is stored.

### Option 3: Copy only for pinned/immutable URLs

Rejected: needs URL classification for little gain in an ephemeral session.

## Evidence

- `src/blueprint/steps/moodle-plugins.js` (`installViaZipDownload`) and
  `src/blueprint/steps/filesystem.js` (`handleUnzip`) at `77d6b1e` wrote the copies;
  `src/blueprint/checkpoint.js` (`getReloadStep`) pointed `unzip` at them.
- `/persist` journaling and IndexedDB lifetime: `src/runtime/fs-persistence.js`
  and AGENTS.md ("Closing a tab is not a guarantee that the underlying IndexedDB
  data has been deleted").

## Decision

`installViaZipDownload` always downloads the archive and never writes it to
`/persist`; with `restoreOnly` it still only restores discovery (component cache,
plugin manager, MUC and hook registries) without running `upgrade_noncore`. The
executor no longer passes `pluginArchivePath`. On reload `unzip` runs with its
original `data` resource, and `handleUnzip` no longer saves the archive.

## Consequences

### Positive

- Plugin blueprints no longer leave archive copies in IndexedDB.
- Less code: no copy, no copy-path plumbing.

### Negative

- A reload needs the network (and the addon proxy) to restore plugins and archives;
  offline it fails visibly and the plugin is missing from disk.
- A moving URL (branch archive) can bring newer plugin code than the persisted
  database. Moodle detects the higher `version.php` and asks the admin to upgrade;
  it is not applied silently.
- An `unzip` whose `data` is a `vfs` file that no longer exists on reload fails.

### Neutral

- Copies saved by builds between PR #341 and this change stay in those scopes'
  journals until the scope is reset; nothing reads them any more.

## Risks

Transient download failures on reload; the existing 502/503 retry still applies.

## Validation

Unit tests: reload downloads once, never reads or writes `/persist`, and still
returns before `upgrade_noncore`; an unfinished plugin is restored by download;
`unzip` reload keeps the original resource and saves nothing. Browser test
`tests/e2e/blueprint-reload.spec.mjs` expects one plugin download per boot.

## Follow-up work

None planned. Revisit only if offline reloads become a requirement.

## References

- [ADR-0035](ADR-0035-blueprint-reload-checkpoints.md)
- [SDD-0002](../sdd/SDD-0002-incremental-navigation-and-reload-correctness.md)
