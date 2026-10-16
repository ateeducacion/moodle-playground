---
id: ADR-0038
title: "Validate OPcache file-cache timestamps and blacklist the eval script path"
status: Accepted
date: 2026-10-16
deciders: [erseco]
reviewers: []
related:
  issues: [343]
  prs: []
  sdds: [SDD-0002]
  adrs: [ADR-0004, ADR-0011]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5-1"
---

# ADR-0038: Validate OPcache file-cache timestamps and blacklist the eval script path

## Status

Accepted (2026-10-16). Amends the OPcache configuration recorded in ADR-0004 and
ADR-0011; it does not change the file-cache-only mode or the SAPI name.

## Context

`src/runtime/config-template.js` has configured OPcache in file-cache-only mode
since ADR-0004 (`opcache.enable=1`, `opcache.file_cache=/internal/shared/opcache`,
`opcache.file_cache_only=1`) with `opcache.validate_timestamps=0`, on the premise
that the bundle is read-only within a session.

Two facts verified during the post-merge performance investigation of PR #341/#342
(2026-10-16) invalidate that premise:

- On PHP 8.3 and 8.4 the configuration was never active: php-src's
  `accel_startup()` (`ext/opcache/ZendAccelerator.c`, `accel_find_sapi`) rejects
  the `wasm` SAPI name before it reads `file_cache_only` and unloads the extension.
  `opcache_get_status()` returns `false` and the cache directory stays empty.
- **PHP 8.5 removed the SAPI whitelist** (php-src `3088d6406847`). On the shipped
  `php_8_5-*.wasm` (8.5.10) the file cache starts under `wasm` with the
  configuration as written. Measured in Node and in Chromium (isolated copy of
  `3acbefb` forced to PHP 8.5): `opcache_get_status()` →
  `{opcache_enabled:false, file_cache_only:true}`, ~1,500 `.bin` files after one
  boot, and a script rewritten after compilation kept returning its **old**
  output. With a stored `.bin` for `/internal/eval.php`, the next
  `php.run({ code })` returned the **previous** snippet.

Files do change within a session: blueprint plugin installs and reloads (ADR-0036
re-downloads and unzips archives on every reload), plugin upgrades from the Moodle
UI, blueprint `writeFile`/patch steps. In file-cache-only mode `opcache_reset()`
and `opcache_invalidate()` are no-ops (both guard on `accelerator_enabled`, which
`accel_activate()` forces to `false`), so the existing `opcache_reset()` hooks in
`src/runtime/bootstrap.js` and `src/blueprint/php/helpers.js` do not invalidate
anything; only deleting `.bin` files or the mtime check can.

The shell offers PHP 8.5 with Moodle `main` (`src/shared/version-resolver.js`),
so deployments already serve this configuration.

## Problem

Which OPcache settings keep bytecode coherent with the files on disk on PHP 8.5
today (and on any version once the cache is deliberately enabled), without
giving up the file cache?

## Decision drivers

- Correctness: a rewritten PHP file must execute its new code on the next request;
  `php.run({ code })` snippets must never execute each other's bytecode.
- No measurable cost: the investigation measured no difference between
  `validate_timestamps=0` and `1` (paired cold starts and warm navigation on a
  variant with the cache active).
- Keep the change independent of the decision to enable the cache on PHP 8.3/8.4
  (issue #344), which needs a SAPI name and its own ADR.
- No new persisted state; `/internal` is not journaled and the cache is per
  session.

## Options considered

1. **Validate timestamps and blacklist the eval path (chosen).**
   `opcache.validate_timestamps=1`, `opcache.revalidate_freq=0`, keep PHP's default
   `opcache.file_update_protection=2`, and `opcache.blacklist_filename` pointing at
   a MEMFS file that lists `/internal/eval.php`. The load path then compares the
   script's whole-second mtime with the one recorded in the `.bin`; a file modified
   less than 2 s before compilation is never stored, so any later rewrite has a
   strictly newer mtime. The blacklist is honoured on store in file-cache-only mode.
2. **Disable OPcache (`opcache.enable=0`).** Removes the hazard and the only
   bytecode cache the runtime has; forecloses the measured −33 % cold start of
   issue #344 and still needs a decision later.
3. **Delete the cache directory at every mutation point from JavaScript.** Needed
   anyway for rewrites that preserve mtimes, but on its own it misses Moodle-side
   mutations (UI plugin upgrade) and every third-party code path that writes PHP.
4. **Unique script path per `php.run({ code })`.** Fixes the eval collision but
   belongs upstream (`@php-wasm/universal` writes `/internal/eval.php`); requested
   in WordPress/wordpress-playground#4465.

## Decision

Option 1. `createPhpIniEntries()` sets `opcache.validate_timestamps=1`,
`opcache.revalidate_freq=0` and `opcache.blacklist_filename=/internal/shared/opcache-blacklist.txt`;
`src/runtime/php-loader.js` writes that blacklist file (`/internal/eval.php`)
before the first request at both runtime creation sites. The PHP-side purge of the
on-disk cache in blueprint plugin/overlay restores (`OPCACHE_CLEAR_BLOCK`) stays
as defence in depth for rewrites that preserve mtimes.

## Consequences

- PHP 8.5: rewritten files recompile on the next request; `php.run({ code })` is
  never cached. PHP 8.3/8.4: no behavioural change (the extension still does not
  start under `wasm`); the settings are the prerequisite for #344.
- Remaining blind spot: a rewrite that restores the original mtime to the second
  (archive extraction that preserves timestamps). None of the project's write paths
  does this today; the blueprint restore purge covers its own paths.
- `opcache.file_update_protection` stays at PHP's default (2 s). Lowering it would
  reintroduce same-second collisions; it is not exposed in the template on purpose.
- An e2e canary (`tests/e2e/opcache-canary.spec.mjs`) writes a PHP file through a
  blueprint, compiles it, rewrites it from PHP and asserts the new output; on Moodle
  `main` + PHP 8.5 it also asserts that the file cache is live, so the test is not
  vacuous.

## Verification

- Unit: `tests/runtime/config-template.test.js` (ini entries, blacklist content).
- Browser: the stale-rewrite and eval-collision canaries that failed on `3acbefb`
  (PHP 8.5.10, Chromium) pass with this configuration (issue #343 records the
  before/after output).
- Regression: full unit suite, `make lint`, Chromium e2e.

## References

- Issue #343; WordPress/wordpress-playground#4465 (upstream SAPI/eval asks).
- php-src 8.3.33 `ext/opcache/ZendAccelerator.c` (`accel_find_sapi`,
  `accel_startup`), `ext/opcache/zend_file_cache.c` (`zend_file_cache_script_load`
  validates `st_mtime` only when `validate_timestamps` is set),
  `ext/opcache/zend_accelerator_module.c` (`opcache_reset`/`opcache_invalidate`
  guards); php-src `3088d6406847` ("Remove the Opcache SAPI whitelist").
- `@php-wasm/universal` `php.ts` (`run({ code })` → `/internal/eval.php`).
- ADR-0004, ADR-0011 (previous OPcache configuration), ADR-0036 (archives are
  re-extracted on reload).
