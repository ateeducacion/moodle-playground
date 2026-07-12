---
id: ADR-0024
title: "Lower base PHP memory_limit and Emscripten INITIAL_MEMORY for browser WASM environments"
status: Proposed
date: 2026-07-12
deciders:
  - "ernesto"
reviewers:
  - ""
related:
  issues: []
  prs: []
  sdds: []
  adrs: ["ADR-0004", "ADR-0011"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Grok (xAI)"
  model: "grok"
---

# ADR-0024: Lower base PHP memory_limit and Emscripten INITIAL_MEMORY for browser WASM environments

## Status

Proposed

## Context

Moodle Playground runs a full Moodle site inside a browser using PHP compiled to WebAssembly via @php-wasm. All code and mutable state live in Emscripten's MEMFS (JavaScript heap) plus the WASM linear memory. The previous default `memory_limit` was 512M with no explicit Emscripten `INITIAL_MEMORY` constraint.

Moodle's own environment checker (docs.moodle.org) states a minimum of ~96M, with 128M frequently recommended and larger values only for heavy operations. WordPress Playground uses 256M by default.

Heavy operations (install, course restore, large plugin installs) already call `raise_memory_limit(MEMORY_EXTRA)`.

## Problem

A 512M base `memory_limit` (plus the Emscripten module's default heap reservation) leads to unnecessarily high peak memory usage in the browser, increasing OOM risk on memory-constrained devices and slowing cold-start allocation.

## Decision drivers

- Reduce peak WASM + JS heap usage in the browser.
- Align with upstream Moodle recommendations and WP Playground practices.
- Preserve correctness for Moodle workloads via `raise_memory_limit` on heavy paths.
- Keep Emscripten heap growth explicit and bounded at start.

## Options considered

### Option 1: Keep 512M (status quo)
- Pros: No risk of hitting limits in edge cases.
- Cons: Wastes browser memory; contradicts the goal of lightweight playgrounds.

### Option 2: Drop to 128M base
- Pros: Maximum memory savings.
- Cons: Riskier for Moodle's larger footprint + plugins + theme compilation without relying entirely on raises.

### Option 3: 256M base + explicit INITIAL_MEMORY + ALLOW_MEMORY_GROWTH (chosen)
- Pros: Good balance per Moodle docs; significant reduction from 512M; Emscripten starts smaller and grows only as needed.
- Cons: Requires validation on real devices; some very large restores may still need the raise path.

## Evidence

- Moodle docs: https://docs.moodle.org/502/en/admin/environment/php_setting/memory_limit (min ~96M, 128M commonly recommended).
- WP Playground source: `packages/php-wasm/universal/src/lib/php.ts` uses `memory_limit=256M`.
- Existing `raise_memory_limit(MEMORY_EXTRA)` calls in `src/runtime/bootstrap.js:349` and `src/blueprint/php/helpers.js:604`.
- Emscripten options passed via `loadWebRuntime` (see `src/runtime/php-loader.js` and WP's `load-runtime.ts`).
- Bundle already trimmed (ADR-0011); snapshot + localcache seeds reduce work.

## Decision

We will:
- Set base `memory_limit = "256M"`, `post_max_size = "64M"`, `upload_max_filesize = "64M"` in `createPhpIniEntries` (and mirrored in `lib/config-template.js` and `scripts/setup-local.sh`).
- Pass `emscriptenOptions: { INITIAL_MEMORY: 128 * 1024 * 1024, ALLOW_MEMORY_GROWTH: 1 }` to both primary and provisioning `loadWebRuntime` calls.
- Continue using `raise_memory_limit(MEMORY_EXTRA)` for install/restore/blueprint heavy steps.
- Update opcache values modestly as part of the same tuning pass where appropriate (inert under `file_cache_only`).

## Consequences

### Positive
- Lower peak memory usage at boot and during normal navigation.
- Faster WASM instantiation (smaller initial heap).
- Better experience on mobile / low-RAM browsers.
- Still safe for Moodle because of explicit raises on heavy paths.

### Negative
- Very large one-off operations may hit the limit until `raise_memory_limit` takes effect.
- Requires re-testing with real blueprints and course restores.

### Neutral
- The opcache `memory_consumption` / `interned_strings_buffer` knobs remain largely inert under `file_cache_only=1`.

## Risks
- Under-estimating memory needs of certain third-party plugins or very large restores in a single request. Mitigated by existing raise calls and the ability to tune per-blueprint if needed.

## Validation
- Unit tests for `createPhpIniEntries` continue to pass.
- Manual verification in browser with `?debug=true` and memory profiling.
- Existing e2e tests (including blueprint-perf and restore) exercise heavy paths.
- Revisit if we observe "Allowed memory size" errors in common scenarios not covered by raises.

## Follow-up work
- Monitor real usage; consider a blueprint `runtime.memory_limit` override if needed.
- Re-evaluate once upstream @php-wasm offers better per-instance memory controls.

## References
- https://docs.moodle.org/502/en/admin/environment/php_setting/memory_limit
- ADR-0004 (OPcache tuning)
- ADR-0011 (bundle trim and runtime tuning)
- `src/runtime/config-template.js`
- `src/runtime/php-loader.js`
- WordPress Playground `php.ts` and `load-runtime.ts`
