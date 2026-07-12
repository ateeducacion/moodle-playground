# ADR Index

This page lists every Architecture Decision Record in Moodle Playground. See
[Architecture Decision Records](README.md) for the policy and
[`ADR-0000-template.md`](ADR-0000-template.md) for the starting point.

The index is maintained by hand. When an ADR is added, superseded, or changes
status, update the table.

ADR-0001 through ADR-0023 were migrated from the former `docs/decisions/`
folder and keep their original lightweight format (see
[Legacy ADRs](README.md#legacy-adrs-00010023)).

| ID | Title | Status | Date |
|---|---|---|---|
| [ADR-0000](ADR-0000-template.md) | Template | Template | — |
| [ADR-0001](ADR-0001-sw-level-scoped-static-asset-caching.md) | Service Worker-level caching for scoped static assets | Accepted | 2026-03-27 |
| [ADR-0002](ADR-0002-plugin-auto-detection-from-github-urls.md) | Plugin type and name auto-detection from GitHub URLs | Accepted | 2026-03-27 |
| [ADR-0003](ADR-0003-direct-db-inserts-for-course-modules.md) | Direct database inserts for course module addition (WASM SQLite compat) | Accepted | 2026-03-27 |
| [ADR-0004](ADR-0004-opcache-tuning-and-runtime-ux-defaults.md) | OPcache tuning and runtime UX defaults for WASM (amended by ADR-0011) | Accepted | 2026-03-27 |
| [ADR-0005](ADR-0005-resilient-blueprint-step-execution.md) | Resilient blueprint step execution with graceful error handling | Accepted | 2026-03-27 |
| [ADR-0006](ADR-0006-moodle-langpack-proxy-allowance.md) | Language pack installation via the CORS proxy and Moodle's lang_installer | Accepted | 2026-06-08 |
| [ADR-0007](ADR-0007-course-restore-step.md) | Course backup (.mbz) restore blueprint step | Accepted | 2026-06-08 |
| [ADR-0008](ADR-0008-blueprint-roles-scales-cohorts-provisioning.md) | Blueprint provisioning for roles, scales and cohorts | Accepted | 2026-06-08 |
| [ADR-0009](ADR-0009-file-backed-config-settings-blueprint-steps.md) | File-backed Moodle configuration settings in blueprints | Accepted | 2026-06-08 |
| [ADR-0010](ADR-0010-build-time-localcache-seed.md) | Build-time localcache seed (theme CSS + DI container) | Accepted | 2026-06 |
| [ADR-0011](ADR-0011-bundle-trim-and-runtime-tuning.md) | Bundle content trim and php.ini / runtime tuning (amends ADR-0004) | Accepted | 2026-06 |
| [ADR-0012](ADR-0012-worker-static-fast-path.md) | Static-file fast path bypassing the serial PHP request queue | Accepted | 2026-06 |
| [ADR-0013](ADR-0013-build-time-requirejs-combined-bundle-seed.md) | Build-time RequireJS combined-bundle seed (re-enable cachejs) | Accepted | 2026-06 |
| [ADR-0014](ADR-0014-production-require-of-tests-files-patch.md) | Patch production code that require_once()s files under tests/ | Accepted | 2026-06 |
| [ADR-0015](ADR-0015-firefox-request-body-buffering.md) | Buffer the request body synchronously for Firefox (SW fetch handler) | Accepted | 2026-06 |
| [ADR-0016](ADR-0016-runtime-pr-file-overlay.md) | Runtime PR file overlay for Moodle core PR previews (`applyPrOverlay`) | Accepted | 2026-06-28 |
| [ADR-0017](ADR-0017-tracker-scenario-blueprints.md) | Explicit Moodle Playground scenario blocks in tracker issues | Accepted | 2026-07-01 |
| [ADR-0018](ADR-0018-core-bundle-solid-compression-experiment.md) | Solid compression for core bundles (tar.zst) — experiment that led to adoption | Accepted | 2026-07-05 |
| [ADR-0019](ADR-0019-streaming-tar-zstd-core-bundle-extraction.md) | Streaming (bounded-memory) extraction for tar.zst core bundles (amended by ADR-0020) | Accepted | 2026-07-05 |
| [ADR-0020](ADR-0020-preserve-empty-directories-in-tar-bundle.md) | Preserve empty plugin-type-root directories in the tar.zst bundle | Accepted | 2026-07-06 |
| [ADR-0021](ADR-0021-blueprint-per-step-timing-diagnostics.md) | Blueprint per-step timing instrumentation + `[blueprint-perf]` diagnostics channel | Accepted | 2026-07-08 |
| [ADR-0022](ADR-0022-browser-side-course-backup-download.md) | Browser-side course backup (.mbz) download with progress | Accepted | 2026-07-08 |
| [ADR-0023](ADR-0023-resilient-resource-fetch-and-non-fatal-steps.md) | Resilient resource fetching + non-fatal-by-default blueprint steps | Accepted | 2026-07-08 |
| [ADR-0024](ADR-0024-browser-memory-and-emscripten-configuration.md) | Lower base PHP memory_limit and Emscripten INITIAL_MEMORY for browser WASM environments | Proposed | 2026-07-12 |
| [ADR-0025](ADR-0025-boot-time-asset-delivery-and-runtime-lifecycle.md) | Boot-time asset delivery overlap, static fast-paths, and long-lived runtime diagnostics | Proposed | 2026-07-12 |
