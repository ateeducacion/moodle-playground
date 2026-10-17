---
id: ADR-0039
title: "Start OPcache's file cache on PHP 8.3/8.4 by reporting the uwsgi SAPI name, behind an experimental flag"
status: Accepted
date: 2026-10-16
deciders: [erseco]
reviewers: []
related:
  issues: [344, 343]
  prs: []
  sdds: [SDD-0002]
  adrs: [ADR-0038, ADR-0004, ADR-0011]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5-1"
---

# ADR-0039: Start OPcache's file cache on PHP 8.3/8.4 by reporting the `uwsgi` SAPI name, behind an experimental flag

## Status

Accepted (2026-10-16). Builds on ADR-0038 (timestamp validation and eval blacklist),
which is a prerequisite and ships independently.

## Context

OPcache has been configured in file-cache-only mode since ADR-0004, but on PHP 8.3
and 8.4 it never starts: php-src's `accel_startup()` only accepts a fixed list of
SAPI names (`apache, fastcgi, cli-server, cgi-fcgi, fpm-fcgi, fpmi-fcgi,
apache2handler, litespeed, uwsgi, fuzzer, frankenphp, ngx-php`, plus `cli`/`phpdbg`
with `enable_cli`) and php-wasm's SAPI is named `wasm`. The check runs before
`file_cache_only` is read, so no configuration can bypass it; `@php-wasm/universal`
exposes `PHP.setSapiName()` precisely for this (its own Blueprint runner uses `cli`).

The post-merge performance investigation (2026-10-16, isolated copies of `3acbefb`,
Chromium unless noted) measured the cache with a whitelisted SAPI name and
`validate_timestamps=1`:

| Metric | baseline (`wasm`, cache inert) | cache active |
|---|---|---|
| Cold start, paired alternating runs (5 pairs) | — | **−3.0 s (−32.6 %)**, worker clock −3.6 s |
| Cold start A / reload B / warm reload C | 9203 / 9199 / 5688 ms | 6186 / 5686 / 4683 ms |
| Warm navigation D (4 pages) | 587 / 530 / 518 / 1322 ms | 353 / 441 / 241 / 1201 ms |
| PHP time per request | 58 ms | 17 ms |
| AJAX call / POST / protected file | 65 / 708 / 153 ms | 20 / 533 / 20 ms |
| Firefox cold A / reload B / warm C | 14447 / 14293 / 8789 ms | 9360 / 9285 / 7796 ms |
| WebKit cold A | 9240 ms | 6466 ms |
| WASM linear memory after boot | 161 MiB | 193–232 MiB |
| `.bin` files in MEMFS after one boot | 0 | ≈2,000, 46 MB (zstd ≈5×) |
| e2e suite (Chromium) | 11/11 | 11/11 |

The adversarial lab (Node and browser) showed that with `validate_timestamps=1` and
PHP's default `file_update_protection=2` every rewrite the project produces
(fresh-mtime rewrite, same-size rewrite, delete+recreate, rename+replace,
PHP-generated rewrite, dependency rewrite) recompiles correctly; the only blind spot
is a rewrite that restores the original mtime to the second, which no project write
path does. `opcache_reset()`/`opcache_invalidate()` remain no-ops; the blueprint
restore paths delete the on-disk cache (ADR-0038).

The SAPI name is visible to PHP code as `php_sapi_name()`/`PHP_SAPI`. An audit of
Moodle `main` (`b7260e59`, `public/` excluding tests) found the only non-`cli`
branches to be four `'cgi'` substring checks (`lib/filelib.php` `send_header_404()`,
`mod/assign/feedback/editpdf/ajax_progress.php`, `lib/tcpdf/tcpdf.php` ×2) and one
`=== 'fpm-fcgi'` PATH_INFO fix-up (`lib/setuplib.php`). `cgi-fcgi` and `fastcgi`
would take the `cgi` branches (`header('Status: 404')`, which php-wasm does not
interpret, instead of `HTTP/1.0 404`); `uwsgi`, `frankenphp`, `ngx-php`, `litespeed`
and `apache2handler` have zero references.

PHP 8.5 removed the whitelist, so on `main` + PHP 8.5 the cache is live regardless
of this decision (ADR-0038).

## Problem

Should the runtime report a whitelisted SAPI name so OPcache's file cache starts on
PHP 8.3/8.4, which name, and under what rollout control?

## Decision drivers

- Cold start and per-request PHP time are the dominant user-visible costs
  (SDD-0002); −33 % cold start is the largest single improvement measured.
- Correctness must not depend on timing: ADR-0038's validation and blacklist must
  be in place first.
- Memory ceiling on low-end devices: +32…71 MiB linear memory and 46 MB of MEMFS.
- Moodle and third-party code must not change behaviour because of the name.
- Reversible without a deploy: a URL parameter and a config default.

## Options considered

1. **`cgi-fcgi`** — measured variant. Takes Moodle's `cgi` branches:
   `send_header_404()` emits `Status: 404`, which php-wasm ignores, so code paths
   that call it and exit without an exception would return 200. Rejected.
2. **`fpm-fcgi`** — triggers the PATH_INFO fix-up in `lib/setuplib.php`. Rejected.
3. **`uwsgi` (chosen)** — whitelisted since PHP 7.x; no Moodle or bundled
   third-party reference; php-wasm stores the name only to re-apply it on runtime
   hot-swap. `frankenphp`/`ngx-php` are equivalent but newer in the whitelist.
4. **Shared-memory OPcache / JIT** — no SHM backend in the browser build
   (upstream WordPress/wordpress-playground#3617/#3618); out of scope.
5. **Leave the cache inert** — forgoes the measured gains; PHP 8.5 diverges anyway.

## Decision

- `src/runtime/php-loader.js` calls `php.setSapiName("uwsgi")` right after creating
  the serving `PHP` instance, before any request, when the runtime option `opcache`
  is set. The provisioning (CLI install) runtime is unchanged.
- The option comes from `?opcache=1|0` (shell → remote host → worker, like `debug`
  and `profile`) with `playground.config.json`'s `opcache` key as the default
  (`false` today). `isOpcacheEnabled()` in `config-template.js` is the single
  decision point.
- The e2e canary (`tests/e2e/opcache-canary.spec.mjs`) runs an additional row with
  `?opcache=1` on PHP 8.3 and asserts both the live cache and `PHP_SAPI === "uwsgi"`.
- Default stays off until the flag has soaked; flipping the default is a one-line
  config change recorded by a follow-up ADR with fresh measurements.

## Consequences

- With the flag: ≈−3 s cold start, −40…−50 % warm navigation, +32…71 MiB WASM
  memory, 46 MB of `.bin` in MEMFS (not journaled; rebuilt every session).
- `php_sapi_name()` returns `uwsgi` inside Moodle; `phpinfo()` and the environment
  page show it. Plugins that branch on exotic SAPI names would see a change — none
  known in core or bundled libraries.
- Rewrites that preserve mtimes stay the known blind spot (ADR-0038); the blueprint
  restore purge covers the project's own archive paths.
- Upstream dependence: if php-wasm ever renames its SAPI or PHP changes the
  whitelist semantics again, the flag degrades to today's behaviour (cache inert),
  never to stale bytecode, because ADR-0038's validation is unconditional.

## Verification

- Unit: `tests/runtime/config-template.test.js` (`isOpcacheEnabled`, SAPI name),
  `tests/shared/version-resolver.test.js` and `tests/shared/paths.test.js`
  (parameter plumbing).
- Browser: canary row `5.3:8.3:opcache` (live cache, `uwsgi`, rewrite recompiles)
  on Chromium; paired cold-start comparison with the flag on vs off recorded in the
  implementing PR.

## References

- Issue #344 (measurements, lab matrix, SAPI audit), issue #343 / ADR-0038.
- WordPress/wordpress-playground#4465 (upstream: SAPI selection docs, eval blacklist).
- php-src 8.3.33 `ext/opcache/ZendAccelerator.c` (`accel_find_sapi`,
  `accel_startup`); `@php-wasm/universal` `php.ts` (`setSapiName`,
  `hotSwapPHPRuntime` re-applies the name); `php_wasm.c` (`wasm_set_sapi_name`).
- ADR-0004, ADR-0011 (OPcache configuration history), SDD-0002.
