# 0010 — Build-time localcache seed (theme CSS + DI container)

## Status

Accepted (2026-06).

## Context

A fresh Moodle install leaves deterministic, per-bundle work to be done at
runtime, and the playground paid for it in the browser on every boot:

- The CLI install queues `\core\task\build_installed_themes_task`
  (`upgrade_themes()`), which nobody ran — the playground has no cron — so the
  boot pipeline compiled Boost's SCSS in WASM (1-3 s) as a "warmup".
- The warmup wrote `localcache/theme/<rev>/<name>/all.css`, but
  `theme/styles.php` serves `theme/<rev>/<name>/css/all_<subrev>.css`
  (note the `css/` subdirectory and the `_<subrev>` suffix from
  `theme_styles_get_filename()`). The warmed file was never found, so the
  first page view recompiled the SCSS a second time inside the request.
- The first request also compiled the DI container
  (`localcache/di/CompiledContainer.php`, `\core\di`).

All of this output is a pure function of the bundle, so it belongs on the
build machine.

## Decision

`generate-install-snapshot.sh` now drains the adhoc queue with
`admin/cli/adhoc_task.php --execute --force --ignorelimits` (after the qbank
transfer-task DELETE, so those never execute), asserts `task_adhoc` is empty,
pre-compiles the DI container, and packages
`snapshot/localcache.zip` = `localcache/{theme,di}` (whitelist).
The manifest advertises the artifacts via additive `snapshot.drained` and
`snapshot.localcache {path,fileName,size,sha256}` fields (schemaVersion 1).

At boot, snapshot-origin sessions download the seed (sha256-verified), extract
it into `/persist/moodledata/localcache` with `ZipArchive`, and skip the SCSS
warmup and the qbank drainer steps. The warmup remains for the CLI-install
fallback and legacy manifests — fixed to call `theme_build_css_for_themes()`
so the candidate sheet lands where `styles.php` actually looks.

## Key constraints verified

- **Cache keys**: the seed and the snapshot DB come from the same build run,
  so `localcache/theme/<themerev>/<name>/css/all_<themesubrev>.css` matches
  the DB's `themerev` / `theme_<name>.themerev` by construction. Runtime
  validation (`min_is_revision_valid_and_current()`) only checks the rev is a
  plausible timestamp.
- **Path portability**: candidate sheets contain no host or filesystem paths
  (`theme_config::post_process()` strips scheme+host) but keep the wwwroot
  *path* prefix — the build uses `http://localhost` (empty prefix), so on
  subpath deploys the extractor rewrites `/theme/image.php/` and
  `/theme/font.php/` with the runtime base path. The compiled DI container is
  generated PHP with no absolute paths; a grep tripwire in the build fails
  loud if any build-machine path ever leaks into the seed.
- **What must NOT ship**: `.lastpurged` (its absence skips the
  purge-on-boot check in `make_localcache_directory()`), `bootstrap.php`
  (bootstraphash embeds the build dbname), `core_component.php`
  (build-machine classmap paths), and the `scsscache-*` dirs (designer-mode
  only; deleted in normal mode). The whitelist packaging makes these
  structurally impossible to include.
- **Persistence interplay**: `fs-persistence.js` deliberately never journals
  `/persist/moodledata/(cache|localcache|temp|muc)` — the seed is therefore
  re-applied from the (HTTP-cached) artifact on every snapshot-origin boot,
  including journaled reloads. If an in-session cache purge bumps `themerev`
  (e.g. a plugin install), the seeded sheets simply go unused and Moodle
  lazily recompiles, same as before.

## Consequences

- Boot skips 1-3 s of scssphp work; the first click no longer recompiles the
  SCSS (~1.5-4 s) nor builds the DI container (~0.2-0.5 s) — the candidate
  sheet is served at the `ABORT_AFTER_CONFIG` stage without a full bootstrap.
- ~0.7 MB extra parallel download per cold boot (seed zip, Cache-API cached).
- An advertised-but-broken seed fails the boot loudly (deploy bug); only
  manifests without the fields fall back to the legacy path.
