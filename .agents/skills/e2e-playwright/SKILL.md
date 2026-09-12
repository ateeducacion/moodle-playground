---
name: e2e-playwright
description: Write, review, or debug tests/e2e Playwright specs for Moodle Playground. Covers WASM readiness and nested Moodle frames; not terminal browser automation.
metadata:
  author: moodle-playground
  version: "1.0"
---

# Moodle Playground E2E tests

## Existing infrastructure

Use `tests/e2e/helpers.mjs` and the nearest spec as the implementation pattern.
`playwright.config.mjs` owns browser projects, server startup, concurrency, and
output paths; avoid copying that configuration into tests.

- `waitForShellReady(page)` is sufficient for shell-only interactions.
- `waitForPlaygroundReady(page)` waits for Moodle content as well as the shell.
- `getMoodleFrame(page)` targets `#site-frame` → `#remote-frame`.
- `navigateWithinPlayground(page, path)` and `waitForMoodlePath` handle navigation.
- `buildBlueprintParam`, `uniqueSuffix`, and diagnostics helpers already exist.
- Reuse `readyTimeoutMs` / `specTimeoutMs`: WASM boot has a larger budget in CI.

## Assertions and isolation

Verify the behavior the feature promises. For provisioning, assert the resulting
Moodle content inside `getMoodleFrame(page)`; an address-bar change alone does not
prove that a course, user, or activity was created. Shell-only behavior can be
asserted in the shell. Wait for readiness before interacting, using conditions
instead of fixed sleeps.

Each test's browser context isolates its tab scope; the config already permits
multiple workers while keeping `fullyParallel: false`. Do not impose a blanket
serial-execution rule. Avoid running sibling checkouts against the same server:
`reuseExistingServer` can silently connect a test to the wrong application.

For reload tests, mutable `/persist` data is journaled to IndexedDB. A different
blueprint source or a reset clears the environment. Derived Moodle caches are
excluded from the journal. Ensure the test waits for the relevant persistence
operation rather than assuming a write has flushed immediately.

## Running and diagnosing

```bash
make test-e2e-chrome
make test-e2e-firefox
npx playwright test tests/e2e/shell.spec.mjs --project=chromium
```

Use `PLAYWRIGHT_PORT` for an isolated server; `PLAYWRIGHT_EXTERNAL_SERVER=1` skips
server startup when intentionally targeting an existing instance. Other settings
are in `playwright.config.mjs`. The browser installation npm script installs
Chromium only; ensure Firefox is installed when running its project.

Worker or blueprint source changes require `npm run build-worker`. Clear Service
Worker caches before manual browser checks. Reset Playground does not refresh the
worker bundle. Start manual runtime debugging with `?debug=true`.

Inspect the existing diagnostics collector and trace output when a test fails.
`admin-flows.spec.mjs` is skipped in CI; run it locally when changing those flows.
For terminal-driven exploration, use the separate `playwright-cli` skill.
