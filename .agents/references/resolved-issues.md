# Resolved Issues Log

Historical record of issues that were previously tracked in `docs/KNOWN-ISSUES.md`
and have since been resolved. Kept here for reference when debugging regressions or
understanding past architectural decisions.

## First render inside the nested iframe — resolved

The inner iframe would reach a valid Moodle URL but the document body remained empty
(white screen). Fixed by watchdog recovery logic in `src/remote/main.js` and
improvements to the boot sequence.

The recovery code (`isFrameDocumentStalled()`, `scheduleFrameRecovery()`) remains as
a safety net but is no longer triggered during normal operation.

## CACHE_DISABLE_ALL admin redirect loop — resolved

Three interacting issues when enabling MUC (`CACHE_DISABLE_ALL = false`):

1. **Missing cache store admin settings** — `cachestore_apcu`, `cachestore_redis`
   settings were missing from the database. `any_new_admin_settings()` detected them
   as "new" and redirected to `upgradesettings.php`.
2. **`adminsetuppending` flag** — the CLI installer sets `adminsetuppending = 1`,
   which caused `is_major_upgrade_required()` to redirect all pages to admin.
3. **`moodle_needs_upgrading()` version hash mismatch** — `allversionshash` computed
   at runtime differs from the snapshot value. Caused `/my/` to redirect to
   `/admin/index.php` on every request.

**Fix:** Snapshot generation seeds cache store defaults and clears `adminsetuppending`
at build time. Config normalizer re-seeds on every boot. Runtime patches make
`moodle_needs_upgrading()` and `any_new_admin_settings()` return `false` (ephemeral
runtime, no upgrades possible).

Files involved: `scripts/generate-install-snapshot.sh`, `src/runtime/bootstrap.js`,
`src/runtime/config-template.js`.

## Large readonly bundle memory pressure — resolved

The bundle loader in `lib/moodle-loader.js` preallocates a single destination buffer
when `content-length` is known and fills it incrementally, eliminating the
double-buffer allocation that previously caused `RangeError: Array buffer allocation
failed`.

## Pre-built install snapshot — implemented

`scripts/generate-install-snapshot.sh` creates a SQLite snapshot at build time.
`bootstrap.js` loads it at runtime, falling back to the full CLI install if the
snapshot is unavailable. Eliminates the 3-8s CLI install phase on every boot.

## First render and login route determinism — resolved

The first render of the inner Moodle iframe and the login/home route now render
reliably without requiring a manual second load.
