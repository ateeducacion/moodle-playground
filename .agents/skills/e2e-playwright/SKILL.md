---
name: e2e-playwright
description: Write or debug browser-playground Playwright tests for WASM readiness, nested app frames, provisioning, and reload behavior.
metadata:
  author: playgrounds
  version: "2.0"
---

# Browser-playground E2E tests

Use the E2E section of the host repository's
[testing reference](../../references/playground-testing.md) for helpers, selectors,
and runner settings. Keep this local reference outside the installed skill. If
absent, inspect the nearest spec and `playwright.config.mjs` instead of assuming
helpers from another playground exist.

## Readiness and assertions

Shell readiness and application readiness are separate. The enabled address bar
can show that the shell is usable before the application renders. Reuse existing
readiness helpers and wait for the app content needed by the test.

The common frame layout is `#site-frame` (remote host) → `#remote-frame` (app).
Confirm it in the host and target both levels for application assertions:

```js
const app = page.frameLocator("#site-frame").frameLocator("#remote-frame");
```

An address-bar update or blueprint textarea value does not establish successful
provisioning. Assert the resulting resource/content. Shell-only features can be
asserted in the shell. Use condition-based waits, not fixed boot sleeps.

## Isolation, reload, and debugging

Use the runner's existing timeout/concurrency settings. `fullyParallel: false`
does not mean all tests or tabs share one runtime. Do not serialize the entire
suite as an unrelated flakiness fix.

Avoid reusing another playground's dev server on the same port. Changing baseURL
alone may not change the startup command; inspect configuration or start an
isolated external server with matching URL and external-server settings.

For reload tests, wait for the relevant journal writes; shell readiness does not
prove a debounced flush completed. Assert the retained application state. A fresh
context isolates tab scope but is not a universal cache invalidation mechanism.

Worker source changes require a rebuilt bundle. Clear Service Worker caches during
manual verification; Reset Playground clears data. Inspect existing diagnostics,
logs, and traces before adjusting selectors or increasing timeouts. Use the
separate terminal browser skill for exploration, not as a test-generation policy.
