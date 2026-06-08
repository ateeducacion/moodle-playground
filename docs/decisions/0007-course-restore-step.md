# ADR-0007 Course backup (.mbz) restore blueprint step

* Status: Accepted
* Date: 2026-06-08

## Context and Problem

Restoring a Moodle course backup (`.mbz`) into a playground required a large, fragile hand-written
`runPhpCode` block: download the file into a blueprint resource, `writeFile` it to disk, then ~40
lines of `restore_controller` orchestration. We want a first-class `restoreCourse` step (same
productization as `installLanguagePack`).

Two constraints shape the design:

1. **`.mbz` files can be large.** The blueprint resource `url` type caps at 50MB
   (`src/blueprint/resources.js`) and buffers the whole file into a JS `arrayBuffer` — a large
   `arrayBuffer` is exactly what caused the past *"RangeError: Array buffer allocation failed"*
   (`docs/TROUBLESHOOTING.md`).
2. **Restore is memory-heavy and can hit SQLite-WASM limits.** Nested savepoints crash the runtime
   (ADR-0003), and Moodle's `default_exception_handler` does `exit(1)` on error, which kills
   `php.run` (ADR-0005).

## Options Considered

* **Resource (`@name`) + `writeFile` + `runPhpCode`** (status quo) — verbose, error-prone, capped at
  50MB, double-buffers the file in JS.
* **JS download (`fetch` → `arrayBuffer` → `writeFile`)** like the plugin installer — bypasses the
  50MB cap but still allocates a full `arrayBuffer` (OOM risk on large files).
* **PHP-side streaming download + `restore_controller`** — PHP downloads the `.mbz` with
  `download_file_content($url, …, $tofile)`, which streams straight into the MEMFS file (no JS
  buffer, no cap), then restores. The download is a GET over `tcpOverFetch` (cross-browser — same
  path `lang_installer` uses, verified in Firefox).

## Decision

Add a `restoreCourse` step (`src/blueprint/steps/moodle-restore.js`) that supports three sources —
`url` (PHP streaming download, recommended for large files), `path` (an `.mbz` already in MEMFS),
and `data` (embedded resource, small backups) — and restores via Moodle's `restore_controller` using
a new `phpRestoreCourse()` generator in `php/helpers.js`. The generated PHP:

- `raise_memory_limit(MEMORY_EXTRA)` and a `set_exception_handler` that reports JSON and `exit(0)`
  (never `exit(1)`), so a restore crash is graceful and the blueprint continues (ADR-0005).
- Resolves the target category by name, auto-creating it (`createCategory: false` to require it),
  defaulting to category id 1.
- Validates the backup is a `TYPE_1COURSE`, creates a course shell with a unique short name
  (`restore_dbops::calculate_course_names`), runs the restore into it (`TARGET_NEW_COURSE`), then
  optionally enforces `fullname`/`shortname` (short name only if free) and `visible`.

The JS handler resolves `data` via the resource registry and writes it to a temp MEMFS path; for
`url`/`path` it passes the source straight to PHP. `php.run` is wrapped in try/catch and reports via
`publish()` (graceful, ADR-0005).

## Consequences

### Positive
* **Memory-efficient for large files** — `url` streams into MEMFS with no JS `arrayBuffer` and no
  50MB cap.
* **Cross-browser** — the download is a GET over `tcpOverFetch` (works in Chromium, Firefox, Safari).
* **Minimal, declarative blueprint** — replaces ~40 lines of `runPhpCode` with one step.
* **Resilient** — a failed/oversized restore is reported, not fatal; the blueprint keeps going.

### Negative / Risks
* **Large/complex backups can still fail** — in-browser memory and SQLite-WASM transaction limits.
  Documented as an explicit warning; outcome is a graceful error, not a crash loop.
* **`url` host must be CORS-reachable / proxy-allowlisted** — arbitrary hosts may not be fetchable.
* **Relies on Moodle `download_file_content($tofile)` streaming in WASM** — if it proves unreliable,
  fall back to a JS streaming fetch → chunked MEMFS write (`php._php.FS`).

## Implementation Notes

### Files
- `src/blueprint/steps/moodle-restore.js` — new `restoreCourse` handler.
- `src/blueprint/php/helpers.js` — `phpRestoreCourse()` generator.
- `src/blueprint/steps/index.js`, `src/blueprint/schema.js` — register the step.
- `tests/blueprint/restore-course.test.js`, `tests/blueprint/steps.test.js` — coverage.
- `docs/blueprint-json.md` — step docs + large-file warning.

## Review Criteria
- If `download_file_content($tofile)` streaming is unreliable in the WASM runtime, switch the `url`
  path to a JS streaming download.
- If a future Moodle changes the backup/restore API (`restore_controller`, `restore_dbops`) or the
  `.mbz` format, re-verify the generator.
- If restore reliability for larger courses matters, investigate chunked/lower-memory restore modes
  or pre-flighting the backup size.
