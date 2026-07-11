# ADR-0003 Direct database inserts for course module addition

* Status: Accepted
* Date: 2026-03-27

## Context and Problem

The `addModule` blueprint step (used to add labels, folders, assignments, and generic
activity modules to courses) previously used Moodle's `add_moduleinfo()` function. This
function uses **delegated transactions with nested savepoints** internally to handle
validation, file copying, calendar events, completion tracking, and event dispatching.

In the SQLite PDO WASM runtime, nested savepoints crash. The Moodle SQLite driver's
transaction handling is limited — `BEGIN TRANSACTION` works, but nested savepoints cause
"Error writing to database" errors that trigger Moodle's `default_exception_handler`,
which calls `exit(1)` and kills the WASM process. This made `addModule` steps unreliable
and often fatal.

## Options Considered

* **Option 1: Patch the SQLite PDO driver to support nested savepoints** — Would require
  emulating savepoints in the deprecated SQLite driver. High complexity, fragile, and the
  driver is already unsupported by Moodle HQ.

* **Option 2: Wrap `add_moduleinfo()` in a retry loop** — Retry after WASM crashes.
  Unreliable because the crash corrupts the PHP runtime state and the retry would run in
  an undefined state.

* **Option 3: Direct database inserts bypassing `add_moduleinfo()`** — Insert minimal
  records directly into `course_modules` and the module-specific table (e.g., `assign`,
  `label`, `folder`), then create the context and link to the course section. Skips the
  transaction machinery entirely.

## Decision

**Option 3**: Use direct database inserts for course module creation.

The generated PHP code now:
1. Overrides Moodle's `default_exception_handler` to prevent `exit(1)` on errors — instead,
   it outputs a JSON error and exits cleanly with `exit(0)`.
2. Inserts a `course_modules` record with required fields (`course`, `module`, `instance=0`,
   `section=0`, `visible`, `groupmode`, `groupingid`, `added`).
3. Inserts a module instance record (e.g., into the `assign` table) with `course`, `name`,
   `intro`, `introformat`, `timemodified`.
4. Updates `course_modules.instance` to point to the new instance.
5. Creates the module context via `context_module::instance($cmid)`.
6. Links the module to the correct course section via `course_add_cm_to_section()`.

This produces functional course modules visible in the course page. Advanced features
(calendar events, completion rules, grading setup) are not configured, which is acceptable
for the playground's provisioning use case.

## Consequences

### Positive
* **Reliable module creation** — No more crashes from nested savepoints in SQLite WASM.
* **Simpler code** — The shared `ADD_MODULE_SETUP` and `ADD_MODULE_EXEC` constants in
  `helpers.js` are reused across all module types (label, folder, assign, generic).
* **Graceful errors** — The exception handler override ensures errors are reported as
  JSON output instead of killing the WASM process.
* **Works with third-party modules** — The generic module path uses the same direct insert
  approach, so blueprint-installed plugins can also have modules added.

### Negative / Risks
* **Incomplete module setup** — Calendar events, completion defaults, grading areas, and
  event dispatching are skipped. Modules work for viewing and basic interaction but may
  lack some admin-configured features.
* **Diverges from Moodle API** — If Moodle adds required columns to `course_modules` or
  module tables in future versions, the direct inserts may need updating.
* **No file handling** — Modules that require file records at creation time (e.g., resource
  module with an uploaded file) won't work with this approach. The `intro` field supports
  text content only.

## Implementation Notes

### Files modified
- `src/blueprint/php/helpers.js` — Added `ADD_MODULE_SETUP` (exception handler override)
  and `ADD_MODULE_EXEC` (shared insert logic) constants. Updated `phpAddLabel()`,
  `phpAddFolder()`, `phpAddAssign()`, `phpAddGenericModule()` to use them instead of
  `add_moduleinfo()`.
- `src/blueprint/steps/moodle-modules.js` — Updated `handleAddModule()` with try/catch
  wrapping and graceful error reporting via `publish()`.
- `tests/blueprint/php-helpers.test.js` — Updated tests to verify `insert_record` in
  generated PHP code instead of `add_moduleinfo`.

### Exception handler pattern
```php
set_exception_handler(function($e) {
    while (ob_get_level()) ob_end_clean();
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit(0);  // Clean exit, not exit(1)
});
```
This pattern is reused in module addition and plugin upgrade steps.

## Review Criteria

- If the Moodle SQLite driver is improved to support nested savepoints (unlikely — it's
  deprecated), `add_moduleinfo()` could be restored for fuller feature support.
- If a future Moodle version adds required `NOT NULL` columns to `course_modules`, the
  insert records in `ADD_MODULE_EXEC` must be updated.
- If users need completion, calendar, or grading features on provisioned modules, consider
  adding optional post-insert setup calls that run outside transactions.
