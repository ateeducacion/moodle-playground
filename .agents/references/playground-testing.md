# Moodle testing reference

Local details for the shared unit-testing and E2E skills. Read only the relevant
section; this file is not part of the remotely installed skill package.

## Unit tests

- Tests are `tests/{blueprint,runtime,shared,sw}/*.test.js`; use `make test`,
  `npm run test:blueprint`, or `node --test` with a specific file.
- For generated PHP, use actual exports in `src/blueprint/php/helpers.js` and
  `steps/check-result.js`. The result convention is `ok`/`error`; provisioning
  defines `CLI_SCRIPT`. Preserve escaping and SQLite compatibility.
- Step contexts and ResourceRegistry mocks must follow current handlers. Reuse
  the nearest test rather than borrowing a Nextcloud argv/occ mock.
- Use [testing/CI reference](testing-and-ci.md) for CI-specific work.

## E2E

- `tests/e2e/helpers.mjs` provides `waitForShellReady`, `waitForPlaygroundReady`,
  `getMoodleFrame`, `navigateWithinPlayground`, `waitForMoodlePath`, blueprint
  encoding, unique suffixes, and diagnostics. Use full readiness for Moodle UI.
- Reuse `readyTimeoutMs` / `specTimeoutMs`; CI has a larger boot budget.
  `getMoodleFrame` targets `#site-frame` then `#remote-frame`.
- `playwright.config.mjs` owns Chromium/Firefox projects and worker counts.
  `make test-e2e-chrome` and `make test-e2e-firefox` select a browser. The install
  npm script installs Chromium only.
- `PLAYWRIGHT_PORT` changes the managed port; external servers use
  `PLAYWRIGHT_BASE_URL` plus `PLAYWRIGHT_EXTERNAL_SERVER=1`.
- `admin-flows.spec.mjs` is skipped in CI; run it locally for those flows.
- For reload assertions, wait for relevant journal flushes and check retained
  Moodle data. Reset/different blueprint source clears the environment; caches
  are excluded from journaling as described in [runtime reference](php-wasm-runtime.md).
