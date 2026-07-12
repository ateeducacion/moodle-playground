---
id: ADR-0025
title: "Boot-time asset delivery overlap, static fast-paths, and long-lived runtime diagnostics"
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
  adrs: ["ADR-0012", "ADR-0019", "ADR-0001"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Grok (xAI)"
  model: "grok"
---

# ADR-0025: Boot-time asset delivery overlap, static fast-paths, and long-lived runtime diagnostics

## Status

Proposed

## Context

Moodle Playground boots by streaming a ~35 MiB tar.zst core bundle, a ~8 MiB install snapshot, a localcache seed, and the PHP WASM binary. These assets were previously fetched with limited overlap. The service worker already provides a scoped static cache (ADR-0001, ADR-0012) and the runtime uses reactive-only restart on fatal WASM errors.

Long-running tabs accumulate state in the single PHP instance and MEMFS.

## Problem

Sequential or late fetching of snapshot/localcache assets adds to critical path time. Not all cacheable Moodle-generated assets (theme/fonts, yui) were routed through the fast SW path. Long-lived runtimes have no visibility into potential leak accumulation.

## Decision drivers

- Minimize time-to-ready on cold boots.
- Increase the surface of requests served without hitting the serial PHP worker.
- Provide observability for very long sessions without introducing expensive preventive restarts (which cost full re-boots).
- Build incrementally on existing streaming extraction (ADR-0019) and worker fast-paths (ADR-0012).

## Options considered

### Option 1: Do nothing
- Pros: No new code.
- Cons: Leaves measurable boot time and cache misses on the table.

### Option 2: Full preventive runtime rotation every N requests
- Pros: Limits leak accumulation (as done in some WP Playground paths).
- Cons: Expensive (full Moodle boot cost); contradicts previous decision to only rotate on fatal errors.

### Option 3: Early parallel prefetch + expanded SW rules + high-watermark diagnostics (chosen)
- Pros: Overlaps small assets with large ones and WASM compile; more assets hit fast path; gives operators a signal without forcing reboots.
- Cons: Slight increase in concurrent network requests (still bounded).

## Evidence

- `php-worker.js` already starts `startArchiveResolution` before `php.refresh()` (comment references overlapping download band 0.16-0.44).
- Snapshot + localcache are ~8 MiB + ~1.4 MiB and hit Cache API on repeat boots.
- `CACHEABLE_PHP_ASSET_RE` and `SCOPED_STATIC_CACHE` logic in `sw.js`.
- Bundle trimming and tar.zst already in place (ADR-0018/0019/0020).
- High request counts observed in long-lived testing sessions.

## Decision

We will:
- Kick off snapshot (`install.sq3`) and localcache seed prefetch as soon as the archive manifest is known (via `.then` on `archivePromise` in `getRuntimeState`), in parallel with WASM compile and core bundle streaming.
- Expand `CACHEABLE_PHP_ASSET_RE` to include `theme/fonts.php` and `lib/yui.php`.
- Add a high watermark constant (`RUNTIME_HIGH_WATERMARK_REQUESTS = 1500`) that emits a single diagnostic log to the shell when crossed. No automatic rotation.
- Add a few more safe exclusions in `scripts/build-moodle-bundle.sh` (editorconfig, psalm/phpstan configs, .github/workflows) protected by existing tripwires, plus an explicit tar.zst existence assertion after conversion.
- Keep the reactive-only restart policy; the watermark is purely diagnostic.

## Consequences

### Positive
- Reduced wall time until first usable Moodle page on cold boots (snapshot bytes arrive earlier).
- More theme/asset requests served from the fast SW cache layer instead of queuing through the PHP worker.
- Operators of long-lived tabs get a gentle signal to consider "Reset Playground".
- Slightly smaller future bundles.

### Negative
- One extra concurrent fetch at boot (small assets).
- Diagnostic message may be seen by users who keep tabs open for days (intended).

### Neutral
- The fundamental "one serial PHP instance per scope, ephemeral MEMFS + journal" model is unchanged.

## Risks
- Over-prefetching could contend with the large tar.zst on very slow networks. Mitigated because snapshot is much smaller and benefits from Cache API.
- High watermark may be hit legitimately in testing scenarios.

## Validation
- Existing boot e2e tests and blueprint-perf tests.
- Manual timing with browser devtools network + performance tabs.
- Verify expanded asset patterns actually hit the scoped cache (inspect Cache Storage).
- Revisit the 1500 watermark or make it configurable if feedback indicates it is too noisy or too high.

## Follow-up work
- Consider exposing a `?memory-profile=1` or similar for deeper heap inspection.
- If preventive rotation becomes desirable later, it can be added behind an explicit flag (see ADR-0024 context).
- Continue auditing cacheable PHP asset routes as Moodle evolves.

## References
- ADR-0001, ADR-0012 (SW static caching and fast path)
- ADR-0019 (streaming tar.zst extraction)
- `php-worker.js` (archivePromise + prefetch logic)
- `sw.js` (CACHEABLE_PHP_ASSET_RE)
- `scripts/build-moodle-bundle.sh`
- WordPress Playground patterns for download monitors and early asset fetching
