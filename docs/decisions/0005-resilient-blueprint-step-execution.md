# ADR-0005 Resilient blueprint step execution with graceful error handling

* Status: Accepted
* Date: 2026-03-27

## Context and Problem

Blueprint steps that execute PHP code (`addModule`, `installMoodlePlugin`, `installTheme`)
previously threw JavaScript errors on failure, aborting the entire blueprint execution.
This was problematic for two reasons:

1. **Moodle's exception handler calls `exit(1)`** — When a PHP error occurs during module
   addition or plugin upgrade, Moodle's `default_exception_handler` calls
   `abort_all_db_transactions()` and then `die(1)`. The `die(1)` triggers a non-zero exit
   code in `php.run()`, which throws a JavaScript error. Our PHP try/catch blocks never
   execute because the exception handler runs first and exits.

2. **All-or-nothing execution** — A single failing step (e.g., one plugin's upgrade
   crashes) would prevent all subsequent steps from running. In a playground context, it's
   better to install what we can and report failures than to abort everything.

## Options Considered

* **Option 1: Abort on first error (previous behavior)** — Simple but poor UX. A blueprint
  that installs 3 plugins and creates 5 modules would fail entirely if the second plugin
  has an upgrade issue, even though the other steps would succeed independently.

* **Option 2: Override the exception handler + catch JS errors + publish to UI** — Replace
  Moodle's exception handler in generated PHP code with one that outputs JSON and exits
  cleanly (`exit(0)` instead of `exit(1)`). Wrap `php.run()` calls in JavaScript try/catch
  to handle cases where the override doesn't apply (e.g., errors before our handler is
  registered). Report failures via the `publish()` progress callback instead of throwing.

* **Option 3: Pre-validate before execution** — Check prerequisites (DB schema, module
  availability, etc.) before running the step. Reduces failures but can't eliminate them
  — many errors only manifest during execution.

## Decision

**Option 2**: Multi-layer error resilience with progress-based reporting.

The implementation uses three layers of protection:

### Layer 1: PHP exception handler override
Generated PHP code registers a custom exception handler that outputs JSON and exits
cleanly:
```php
set_exception_handler(function($e) {
    while (ob_get_level()) ob_end_clean();
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit(0);
});
```

### Layer 2: JavaScript try/catch around `php.run()`
If the PHP handler doesn't catch the error (e.g., fatal errors, segfaults, or errors
before the handler is registered), the JavaScript catch block handles it:
```javascript
try {
  result = await php.run(code);
} catch (err) {
  // Extract stdout in case it contains success JSON despite non-zero exit
  const stdout = err.message?.match(/=== Stdout ===\s*([\s\S]*?)(?:=== Stderr|$)/)?.[1];
  if (stdout?.includes('"ok":true')) return; // Actually succeeded
  if (publish) publish(`Step failed: ${err.message.slice(0, 200)}`, 0.95);
  return; // Don't throw — let next step continue
}
```

### Layer 3: Response parsing with publish-based reporting
Even when `php.run()` succeeds, the response is checked for `"ok":false` and PHP stderr
output. Failures are reported via `publish()` (visible in the progress bar) instead of
throwing.

## Consequences

### Positive
* **Blueprint execution continues** — A failing plugin or module doesn't block subsequent
  steps. Users get as much of their blueprint as possible.
* **Visible error reporting** — Failures appear in the progress UI as messages, not as
  silent failures or opaque JS errors.
* **Handles Moodle's `exit(1)` pattern** — The PHP handler override prevents the most
  common failure mode. The JS catch handles edge cases.
* **Stdout recovery** — Even when `php.run()` throws, the stdout may contain `"ok":true`
  from successful execution before an exit-code mismatch. The catch block checks for this.
* **Plugin files persist** — For plugin installation, the ZIP is already extracted to the
  target directory before the upgrade step runs. Even if the upgrade fails, the plugin files
  are in place and may work after a manual cache purge or page reload.

### Negative / Risks
* **Silent partial failures** — Users might not notice that a step failed if they don't
  watch the progress messages. The progress bar is transient. Consider adding a summary
  log after blueprint execution.
* **Inconsistent state** — A module with a DB insert but a failed context creation, or a
  plugin with files but no upgrade, is in an intermediate state. In a playground context
  this is acceptable; in production it would not be.
* **Error messages are truncated** — Messages are sliced to 150-300 characters for the
  progress bar. Full errors go to `console.warn` but the user may not have DevTools open.

## Implementation Notes

### Files modified
- `src/blueprint/steps/moodle-plugins.js`:
  - `runMoodleUpgrade()` now wraps `php.run()` in try/catch, reports via `publish()`.
  - Added `playground_refresh_installed_plugin_cache()` call to register new plugins
    in the component cache before upgrade.
  - Clears `allversionshash` config to force upgrade detection.
  - Calls `upgrade_noncore(true)` unconditionally instead of checking
    `moodle_needs_upgrading()` first.
- `src/blueprint/steps/moodle-modules.js`:
  - `handleAddModule()` wraps `php.run()` in try/catch with stdout recovery.
  - Removed the old `checkPhpResult()` function that threw on failure.
- `src/blueprint/php/helpers.js`:
  - `ADD_MODULE_SETUP` constant includes the exception handler override.
  - Used by all `phpAdd*()` functions.

### Error handling patterns used

| Layer | Catches | Reports via | Continues? |
|-------|---------|-------------|------------|
| PHP handler | Moodle exceptions | JSON in stdout | Yes (`exit(0)`) |
| JS try/catch | `php.run()` throws | `publish()` | Yes (return) |
| Response parse | `"ok":false` in JSON | `publish()` | Yes (no throw) |

## Review Criteria

- If a post-execution summary or log panel is added to the playground UI, route step
  failures there in addition to the progress bar.
- If blueprint steps gain rollback semantics (undo on failure), the "continue on error"
  approach would need to record which steps succeeded for selective rollback.
- If Moodle changes its exception handling (e.g., Moodle 5.x removes
  `default_exception_handler`), the PHP override may need updating.
