---
id: ADR-0044
title: "Raise PHP memory_limit to 512M while the OPcache file cache is live"
status: Proposed
date: 2026-10-18
deciders: [erseco]
reviewers: []
related:
  issues: []
  prs: []
  sdds: []
  adrs: [ADR-0024, ADR-0039, ADR-0040, ADR-0043]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Grok Build"
  model: "Grok 4.7"
---

# ADR-0044: Raise PHP memory_limit to 512M while the OPcache file cache is live

## Status

Proposed

## Context

ADR-0024 sets the base `memory_limit` to 256M. ADR-0039 starts OPcache's file
cache on PHP 8.3/8.4 when `?opcache=1` (or the info-panel toggle, ADR-0040)
reports the `uwsgi` SAPI name, and records about +32–71 MiB of WASM linear
memory once the cache is active. PHP 8.5 starts the same file cache without
the flag. The cache directory is `/internal/shared/opcache`.

A reload that only flips the flag keeps the journaled site (ADR-0040). On a
large blueprint the front page then redirects to `admin/index.php`, because
`allversionshash` no longer matches. That page is the one that dies.

Reproduced with `moodle-playground-adaptable_config_7_es_acc.json` (Moodle 4.5,
Adaptable, several plugins, restored course), Playwright Chromium, 2026-10-18:

- Production build `20261018T211922Z-2464fe68`: cold `opcache=0` renders; reload
  `opcache=0` returns HTTP 200 for `admin/index.php`; reload `opcache=1` returns
  HTTP 500. The body is `PHP.run() failed with exit code 255`, stdout and stderr
  empty. `/` itself still returns 303.
- Local Moodle 4.5.12 assets, after discarding CLI-compiled cache entries
  (ADR-0043) and with `memory_limit` still 256M: the same reload still returns
  that 255. `/internal/shared/php-errors.log` stayed empty, so the bailout did
  not go through `zend_error` logging.
- The same local reload with `memory_limit` 512M: `admin/index.php` returns
  HTTP 200. No exit 255.

Exit 255 with empty streams is the engine status (`EG(exit_status)`), not a
WASM trap. `ALLOW_MEMORY_GROWTH` is already on (ADR-0024); the PHP allocator
stops at `memory_limit` before the WASM heap does.

## Problem

What `memory_limit` should apply while the file cache is actually running?

## Decision drivers

- The experimental toggle must reload the same scope and answer `admin/index.php`.
- The 256M base stays for the default runtime. ADR-0024's reason (lower peak
  memory on small devices) still holds when the cache is inert.
- `memory_limit` is a ceiling. `INITIAL_MEMORY` stays 128 MiB, so the browser
  does not reserve 512M up front.
- PHP 8.5 runs the cache even when the flag is off, so keying the ceiling only
  on `?opcache=1` would leave that runtime on the failing limit.

## Options considered

### Option 1: Keep 256M

Matches ADR-0024 everywhere. The large-site reload keeps exiting 255 once the
cache is live. Rejected.

### Option 2: Raise the base to 512M for every runtime

Fixes the page and spends the ceiling on sites that never start the cache.
Rejected.

### Option 3: 512M only while the file cache is live

`?opcache=1` on PHP 8.3/8.4, and any boot on PHP 8.5 or newer. The default
8.3/8.4 runtime stays at 256M. Chosen.

## Decision

`buildPhpIniEntries` sets `memory_limit` to 512M when the file cache will start,
and leaves the ADR-0024 value of 256M otherwise. This does not supersede
ADR-0024.

## Consequences

- A reload that turns the cache on can allocate more PHP heap on the upgrade
  page. Devices that were already near the browser's tab limit can still fail;
  the failure mode moves from a silent exit 255 to ordinary memory pressure.
- PHP 8.5 gets the higher ceiling even with the flag off. That boot was not
  re-run in the browser; the unit test covers the ini value, and the cache
  behaviour is ADR-0039.
- ADR-0043 still discards CLI-compiled entries before the next web request.
  That discard does not stop this exit 255.

## Evidence

- Numbers in Context. Local server was this repo at `2464fe6` plus the uncommitted
  runtime change, `npm run serve` on port 8080, Chromium via Playwright.
- `src/runtime/php-loader.js` `buildPhpIniEntries` / `fileCacheIsLive`.
- ADR-0039 memory table (WASM 161 MiB inert, 193–232 MiB with the cache).

## Validation

`tests/runtime/php-loader.test.js` asserts 256M by default, 256M for PHP 8.4
with the flag off, and 512M when the flag is on or the version is 8.5.

Revisit if a site that fits in 256M with the cache off still exits 255 at 512M
with the cache on, or if a smaller ceiling (for example 384M) is shown to pass
the same blueprint.
