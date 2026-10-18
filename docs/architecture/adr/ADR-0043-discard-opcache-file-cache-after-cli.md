---
id: ADR-0043
title: "Discard the OPcache file cache after CLI runs, before the next web request"
status: Proposed
date: 2026-10-18
deciders: [erseco]
reviewers: []
related:
  issues: []
  prs: []
  sdds: []
  adrs: [ADR-0038, ADR-0039, ADR-0040, ADR-0044]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Grok Build"
  model: "Grok 4.7"
---

# ADR-0043: Discard the OPcache file cache after CLI runs, before the next web request

## Status

Proposed

## Context

ADR-0039 starts OPcache's file cache on PHP 8.3/8.4 when `?opcache=1` (or the
info-panel toggle, ADR-0040) reports the `uwsgi` SAPI name. The cache lives at
`/internal/shared/opcache` and is not journaled. ADR-0038 blacklists
`/internal/eval.php` because every `php.run({ code })` reuses that path, and
turns timestamp validation on. `opcache_reset()` and `opcache_invalidate()` are
no-ops in `file_cache_only` mode.

Blueprint provisioning, the config normalizer, and plugin registration all call
`php.run({ code })` with `CLI_SCRIPT` defined before they include Moodle. The
file cache keys on the real path of each include, not on the eval script, so
those includes are stored. The optimizer folds `CLI_SCRIPT` into the bytecode
when the constant is already defined. The next HTTP request is a fresh
`php.run()` (PHP state resets) and loads that bytecode.

That folding is a correctness bug of its own. It is not what made
`admin/index.php` exit 255 on a large reload: with this discard in place and
`memory_limit` still 256M, that page still exited 255. The exit is the memory
ceiling in ADR-0044.

## Problem

Should web requests execute bytecode that CLI snippets wrote into the file
cache?

## Decision drivers

- A reload that only flips the experimental flag must keep the journaled site
  (ADR-0040) and answer the first page.
- CLI steps during one boot should still share the cache with each other. The
  measured cold-start win (ADR-0039) comes from compiling once, not from
  recompiling on every snippet.
- `opcache_reset()` cannot do this. Deleting the directory from inside PHP is
  too early: the running snippet compiles more files after the delete, and a
  follow-up `php.run()` would compile another CLI view of the same files.

## Options considered

### Option 1: Delete the file cache at the end of every CLI `php.run()`

Correct, and it throws away the cache CLI steps could share. Boot would
recompile Moodle once per snippet.

### Option 2: Delete the file cache on the next web request, once

CLI steps keep sharing bytecode. The first `request()` after any CLI `run()`
removes `/internal/shared/opcache` children from MEMFS before `php.run({ scriptPath })`,
then the page compiles as a web request. Later pages reuse that web bytecode
until another CLI snippet runs. Chosen.

### Option 3: Raise `memory_limit` and keep the CLI bytecode

ADR-0044 does raise the ceiling, and that is what stops the observed exit 255.
The web request would still execute bytecode compiled while `CLI_SCRIPT` was
defined. That does not answer this problem.

## Decision

`wrapPhpInstance().run()` marks the file cache dirty, including when the snippet
exits non-zero. The next `request()` deletes the cache directory's children
before executing PHP. The directory itself stays. Web requests do not mark the
cache dirty. `/internal/eval.php` stays blacklisted (ADR-0038).

PHP's `error_log` is `/internal/shared/php-errors.log` (not under `/persist`).
On a non-fatal `PHP.run()` failure the worker appends that file to the shell
error.

## Consequences

- The first page after provisioning compiles from source. Later pages in the
  same session reuse web bytecode.
- A CLI snippet after the site is up (plugin re-register, crash recovery)
  invalidates the cache once, on the following page.
- With the flag off the directory stays empty and the discard is a no-op readdir.

## Evidence

- `src/runtime/php-compat.js` `run()` / `request()` and `src/blueprint/steps/moodle-plugins.js` `runMoodleUpgrade` (`define('CLI_SCRIPT', true)` then `require config.php`).
- Local Playwright, Chromium, 2026-10-18, blueprint `moodle-playground-adaptable_config_7_es_acc.json`, Moodle 4.5.12 assets: cold `opcache=0` rendered; reload `opcache=1` with this discard and `memory_limit` 256M still returned HTTP 500 on `admin/index.php` (`PHP.run()` exit 255, empty stdout and stderr, nothing in `/internal/shared/php-errors.log`). The same reload at 512M returned HTTP 200 (ADR-0044). The worker stack URL can still show an earlier `opcache=` query: `php-worker.js` reads authoritative params from the `configure-blueprint` message because the service worker caches the script without its query.

## Validation

`tests/runtime/opcache-cli-cache.test.js` asserts the cache survives `run()` and
is gone before the script path executes, that the root directory remains, that a
failed CLI run still dirties the cache, and that a second web request does not
delete bytecode created after the discard.
