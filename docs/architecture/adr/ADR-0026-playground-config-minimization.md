---
id: ADR-0026
title: "Playground-specific minimization of Moodle configuration and features for memory and simplicity"
status: Proposed
date: 2026-07-12
deciders:
  - "ernesto"
reviewers:
  - ""
related:
  issues: []
  prs: ["#262"]
  sdds: []
  adrs: ["ADR-0024", "ADR-0004", "ADR-0011"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Grok (xAI)"
  model: "grok"
---

# ADR-0026: Playground-specific minimization of Moodle configuration and features for memory and simplicity

## Status

Proposed

## Context

Moodle Playground runs a complete Moodle instance in a single-process WASM environment with an ephemeral MEMFS filesystem. Every enabled Moodle feature (analytics, messaging, badges, global search, portfolios, stats, etc.) can allocate caches, scheduled tasks, and background processing that increases both memory usage and boot/navigation time.

The existing config normalizer (`createConfigNormalizerPhp`) and early install disables already force many values to playground-friendly defaults.

## Problem

Without an explicit policy, new Moodle features or default settings can gradually increase the memory and CPU footprint of the playground, making it less usable on typical browser devices.

## Decision drivers

- Keep peak memory low (256M base + Emscripten heap as per ADR-0024).
- Reduce unnecessary background work in a single-user, short-lived session.
- Maintain a simple, predictable UX (no messaging, no analytics, minimal UI clutter).
- Decisions must be safe and reversible for real Moodle content created in the playground.

## Options considered

### Option 1: Only tune php.ini and opcache
- Pros: Low risk.
- Cons: Does not address higher-level Moodle subsystems that still run.

### Option 2: Disable features only during install
- Pros: Simple.
- Cons: Many settings are re-read or re-initialized later; not sufficient for runtime.

### Option 3: Maintain an explicit, documented set of forced low-overhead config values (chosen)
- Pros: Clear policy, easy to audit and extend, applied consistently after every boot/snapshot.
- Cons: Requires maintenance when new features appear in Moodle.

## Evidence

- Moodle core already provides many `set_config` opportunities during early install and normalizer phases.
- Existing disables in `src/runtime/bootstrap.js` (CACHE_DISABLE_*, early_install_lang, etc.) and the normalizer.
- Measurements and experience from heavy blueprints showing memory pressure from caches and tasks.
- Alignment with WP Playground approach of aggressively minimizing non-essential features.

## Decision

We will maintain and expand a curated list of Moodle configuration settings that are forced to low or disabled values specifically for the Playground environment via the post-install config normalizer.

Examples added in this work:
- `enableanalytics = 0`
- `enablestats = 0`
- `enableportfolios = 0`
- `messaging = 0`
- `enablebadges = 0`
- `enableglobalsearch = 0`
- `allowemojipicker = 0`
- `showuseridentity = ''`

These are applied in addition to the php.ini tuning from ADR-0024.

## Consequences

### Positive
- Lower memory usage from unused caches and background tasks.
- Faster page loads and blueprint execution.
- Cleaner UI for typical playground use cases.

### Negative
- Some advanced Moodle features are intentionally unavailable by default (users can still enable them via blueprints or manual config if needed).
- Requires periodic review when upgrading Moodle versions.

### Neutral
- The normalizer runs on every boot (including snapshot boots), so changes take effect immediately.

## Risks
- Over-disabling could break plugins that expect certain features. Mitigated by only touching well-known core settings and keeping the list auditable.

## Validation
- Existing e2e and unit tests continue to pass.
- Manual testing with classroom-ready and multi-user blueprints.
- Revisit list when adding major new Moodle versions or when specific features become important for common scenarios.

## Follow-up work
- Document the full current list in docs (if it grows significantly).
- Consider exposing a `runtime.minimal` blueprint flag in the future if more granularity is needed.

## References
- ADR-0024 (memory_limit and Emscripten tuning)
- ADR-0011 (earlier bundle trim and runtime tuning)
- `src/runtime/bootstrap.js` (createConfigNormalizerPhp)
- PR #262
