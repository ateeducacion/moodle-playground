---
id: ADR-0046
title: "Turn the OPcache file cache on by default"
status: Proposed
date: 2026-10-19
deciders: [erseco]
reviewers: []
related:
  issues: [353]
  prs: []
  sdds: []
  adrs: [ADR-0039, ADR-0040, ADR-0043, ADR-0044]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "Claude Opus 5.5"
---

# ADR-0046: Turn the OPcache file cache on by default

## Status

Proposed. Amends ADR-0039, which kept the cache behind an experimental flag that
was off by default. How the cache starts (the `uwsgi` SAPI name) does not change.

## Context

ADR-0039 starts OPcache's file cache on PHP 8.3/8.4 by reporting the `uwsgi` SAPI
name. It shipped behind `?opcache=1` and `"opcache": false` in
`playground.config.json` while it soaked. ADR-0040 added an info-panel toggle.
Two problems found while it soaked are already fixed:

- ADR-0043: the cache is discarded after CLI runs.
- ADR-0044: `memory_limit` is 512M while the cache is live.

Issue #353 asked for a soak test and a decision on how to expose the cache.

## Problem

With the cache off, every Moodle request compiles its PHP again, and most of a
user's time in the playground is spent navigating pages.

## Decision drivers

- Faster navigation for every user, not only those who know the flag.
- No regression in install time, reload time, memory or stability.
- Users must still be able to turn it off.

## Options considered

1. **Keep it off by default.** Safe, but most users never get the speed-up.
2. **Turn it on by default and keep `?opcache=0` and the panel toggle.**
3. **Turn it on only in some browsers.** Not needed: the results are the same
   in all three engines.

## Decision

Option 2. `playground.config.json` ships `"opcache": true`. `isOpcacheEnabled()`
does not change: a URL value still wins, and a config without the key still
means off. The panel toggle now unchecks to `?opcache=0`.

## Consequences

- PHP 8.3/8.4 report `php_sapi_name() === "uwsgi"` by default. The ADR-0039
  audit found no Moodle code that branches on it.
- `memory_limit` is 512M by default (ADR-0044).
- Tests that need the `wasm` SAPI pass `?opcache=0`.

## Evidence

Public site, Moodle 5.3, blueprint
`moodle-playground-adaptable_config_7_es_acc.json`, Playwright, 2026-10-19
(issue #353 comments):

| | Chromium | Firefox | WebKit |
|---|---|---|---|
| `/my/` visible, off → on | 1036 → 466 ms | 2342 → 1102 ms | 801 → 401 ms |
| Cold install, off → on | 46.6 → 44.3 s | 77.5 → 58.3 s | 45.1 → 49.9 s |
| Same-tab reload | same | same | same |

Long session (Chromium, cold install plus 40 navigations, two sessions per flag):

- Peak RSS of the browser process tree: off 2483/2439 MB, on 2009/2063 MB.
- Same RSS after 40 navigations.
- No PHP memory errors, WASM traps, crashes or recoveries.

Not tested on a real low-memory device.

## Validation

- `tests/e2e/shell.spec.mjs`: the panel toggle starts checked and turns the
  cache off.
- `tests/e2e/opcache-canary.spec.mjs`: rows pass `?opcache=0` or `?opcache=1`
  explicitly.
- `make test`, `make lint`, Chromium and Firefox e2e in CI.
