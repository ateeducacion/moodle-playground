---
id: ADR-0037
title: "Verify re-downloaded blueprint archives against a checkpointed hash on reload"
status: Accepted
date: 2026-10-16
deciders: [erseco]
reviewers: []
related:
  issues: [345]
  prs: []
  sdds: [SDD-0002]
  adrs: [ADR-0035, ADR-0036]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5-1"
---

# ADR-0037: Verify re-downloaded blueprint archives against a checkpointed hash on reload

## Status

Accepted (2026-10-16). Extends ADR-0036; the checkpoint model of ADR-0035 is
unchanged apart from one additive field.

## Context

ADR-0036 made `installMoodlePlugin`/`installTheme` download their archive on every
boot instead of keeping a copy in `/persist`. On a persisted reload the step only
restores discovery; it never runs `upgrade_noncore()`. Measurements on `main` at
`3acbefb` (issue #345) showed two gaps in that path:

- When the URL serves different bytes than the ones that were installed (a branch
  archive that moved on), the reload extracts and **executes the new code** while
  `mdl_config_plugins.version` keeps the old value. Nothing upgrades, nothing warns,
  and the plugin's own pages show no upgrade prompt because Moodle only checks
  `allversionshash` on admin pages.
- A thrown `fetch()` error (offline, dropped connection, an error page without CORS
  headers) was not retried — only HTTP 502/503 responses were — and surfaced as the
  browser's bare `Failed to fetch`, with no hint that a plugin archive was involved.

Playground sessions are short-lived; the project avoids persisting anything a
session does not need (ADR-0036).

## Problem

Detect on reload that an archive no longer matches the code the persisted database
was installed with, without storing the archive, and make a failed download
understandable.

## Decision drivers

- No new persisted state beyond what the checkpoint already stores; no archive copies.
- Never run install/upgrade scripts automatically against a persisted database.
- Keep the diff inside the plugin step and the checkpoint serializer.
- A failing reload must say which archive failed and what to check.

## Options considered

### Option 1: Compare only `version.php` with the persisted version

Cheap, but blind to archives whose content changed without a version bump (the
common case for a moving branch), and it needs the archive parsed before deciding.

### Option 2: Store the SHA-256 of the installed archive in the checkpoint

Selected. 64 hex characters per archive step inside the existing
`mdl_config.playground_blueprint_checkpoint` row (`archives: { "<step index>":
"<sha256>" }`). The reload hashes the re-downloaded bytes before extracting; only on
a mismatch does it read `version.php` and the persisted version to decide.

### Option 3: Keep archive copies for pinned URLs

Rejected by ADR-0036.

## Evidence

- `src/blueprint/steps/moodle-plugins.js` at `3acbefb`: `installViaZipDownload`
  retried only `response.status === 502 || 503`; a thrown fetch error propagated to
  the executor's generic `Blueprint step … failed:` line.
- Issue #345 reload lab (`p1-bump-reload`): after a reload with a newer archive the
  fixture reported `db 2026101600 / file 2026101601 / hook hook-2026101601` — new
  code live, database not upgraded, no prompt. `p1-offline-reload`: the log showed
  `Blueprint step installMoodlePlugin failed: Failed to fetch` and the landing page
  was a bare `Not Found`.
- `src/blueprint/checkpoint.js` (ADR-0035): the checkpoint row already holds
  `{ version, fingerprint, completed }` and is rewritten on each completed step.
- Moodle `lib/upgradelib.php` `moodle_needs_upgrading()` short-circuits on
  `allversionshash`; clearing it makes the next admin page compute the real state.

## Decision

- The checkpoint gains an optional `archives` map (step index → SHA-256 of the
  archive bytes). It is written with the completed step on first install; malformed
  entries are ignored on load.
- On a persisted reload of a completed plugin/theme step the handler hashes the
  downloaded bytes before extracting:
  - equal to the stored hash → extract and restore discovery as before;
  - no stored hash (checkpoint written before this ADR) → extract and store the hash;
  - different hash and the archive's `version.php` is **newer** than the persisted
    version → extract, publish a warning, store the new hash and clear
    `allversionshash` so Moodle asks the admin to upgrade on the next admin page;
  - different hash otherwise (same version with different content, older than the
    persisted database, or unreadable version) → publish a warning and skip
    extraction; the plugin stays missing from disk and Moodle reports it as such.
  `upgrade_noncore()` is never run on reload.
- Downloads retry twice with backoff (1 s, 2 s) on thrown errors and on HTTP
  502/503; other statuses fail immediately. The final error names the archive URL
  and the cause and tells the user to check the network/proxy and reload when
  online. The executor's existing failure channel surfaces it.

## Consequences

### Positive

- A moving URL can no longer run newer plugin code silently; the user is told and
  Moodle takes over with its own upgrade flow.
- Content changes without a version bump are detected, which `version.php` alone
  cannot do.
- Offline or proxy failures are retried and explained.

### Negative

- Hashing adds one SHA-256 of the archive per plugin step per boot (milliseconds for
  typical archives, well below the download itself).
- A skipped extraction leaves the plugin missing from disk until Reset Playground;
  this is the safe failure for code we cannot vouch for.

### Neutral

- Checkpoints from earlier builds adopt the first archive they see on reload; they
  gain protection from the second reload on.

## Risks

- A user who legitimately replaced the archive behind a pinned URL with same-version
  edits will see the extraction skipped; Reset Playground installs it. Documented.
- `Number()` comparison of versions tolerates Moodle's `YYYYMMDDXX.NN` decimals; a
  non-numeric `version.php` is treated as unreadable and skipped.

## Validation

Unit tests in `tests/blueprint/moodle-plugins.test.js` (same hash, same version
with changed content, older archive, newer archive, pre-hash checkpoint, retry on
thrown error, bounded retries, no retry on 404, `version.php` parsing) and
`tests/blueprint/checkpoint.test.js` (hash round-trip, malformed hashes dropped,
step index passed to handlers). Browser test `tests/e2e/blueprint-reload.spec.mjs`
reloads with a newer archive and asserts the new hook runs, the database version is
unchanged, `allversionshash` is empty and the warning is logged. Revisit if plugins
ever need to be upgraded automatically on reload.

## Follow-up work

- Issue #345 item 3 (first-install `purge_all_caches()` recompiling theme CSS) is a
  separate performance change with its own ADR note.

## References

- [ADR-0035](ADR-0035-blueprint-reload-checkpoints.md)
- [ADR-0036](ADR-0036-redownload-blueprint-archives-on-reload.md)
- [SDD-0002](../sdd/SDD-0002-incremental-navigation-and-reload-correctness.md)
- Issue #345
