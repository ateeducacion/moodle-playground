---
id: ADR-0030
title: "Pinned Moodle prerelease channels"
status: Proposed
date: 2026-09-16
deciders: []
reviewers: []
related:
  issues: []
  prs: []
  sdds: []
  adrs: []
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Codex"
  model: "GPT-5"
---

# ADR-0030: Pinned Moodle prerelease channels

## Status

Proposed

## Context

At baseline `77ce7ce`, `src/shared/version-resolver.js` lists stable releases
and moving `main`. Its metadata already has `gitRef`, but
`scripts/fetch-moodle-source.sh` defaults to the channel name instead.
Upstream has published `v5.3.0-beta`; users need to test that release separately.

## Problem

How can the selector and build pipeline expose a specific prerelease without
silently replacing the default stable playground or following development HEAD?

## Decision drivers

- Reuse branch metadata, bundle generation, snapshots and WASM patches.
- Make the prerelease visible and keep stable defaults unchanged.

## Options considered

### Option 1: Use main

No new channel, but cannot identify the published beta independently.

### Option 2: Pin an explicit experimental channel

One metadata entry and build target; adopts new beta/RC refs deliberately.

## Evidence

- Baseline source paths above at `77ce7ce` establish current behavior.
- [Moodle beta tag](https://github.com/moodle/moodle/releases/tag/v5.3.0-beta).
- [5.3 requirements](https://moodledev.io/general/releases/5.3): PHP 8.3/8.4.
- `tests/shared/version-resolver.test.js` checks selection, compatibility,
  runtime IDs, manifest paths and retained default.

## Decision

Add `MOODLE_503_BETA`, selected by `?moodle=5.3`, with `gitRef=v5.3.0-beta`.
This is a local channel ID, not an assertion that an upstream branch exists.
Source fetching reads the existing metadata's `gitRef`, with explicit `GIT_REF`
still taking precedence. Manifests link to the resolved source commit.
Include the channel in both all-branch build commands. Do not change defaults.

## Consequences

### Positive

- Stable and experimental assets/snapshots have separate paths.

### Negative

- One extra bundle adds build time and artifact size.

### Neutral

- Subsequent beta/RC adoption remains a reviewed pin/label update, not automatic.

## Risks

Prereleases may break SQLite/WASM patches even if native PHP installation works.
Browser rendering must be checked; a successful bundle alone is insufficient.

## Validation

Build the pinned source and SQLite snapshot; run resolver/unit tests and
`tests/e2e/moodle-53-beta.spec.mjs` on Chromium and Firefox with PHP 8.3 and 8.4.
See [the test/runbook](../../moodle-53-beta.md) for commands and recorded results.

## Follow-up work

For later prereleases update the pin, label and exact-release assertion together.
For final, add `MOODLE_503_STABLE` after upstream creates it and validate again;
do not promote this beta channel or change stable defaults implicitly.

## References

- [Version resolver](https://github.com/ateeducacion/moodle-playground/blob/f0b64ca/src/shared/version-resolver.js)
- [Source fetcher](https://github.com/ateeducacion/moodle-playground/blob/f0b64ca/scripts/fetch-moodle-source.sh)
