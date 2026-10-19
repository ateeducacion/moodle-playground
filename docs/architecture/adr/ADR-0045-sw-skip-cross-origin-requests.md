---
id: ADR-0045
title: "Leave cross-origin requests to the browser instead of passing them through the Service Worker"
status: Proposed
date: 2026-10-19
deciders: [erseco]
reviewers: []
related:
  issues: [363, 353]
  prs: []
  sdds: []
  adrs: [ADR-0001, ADR-0015]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "Claude Opus 5.5"
---

# ADR-0045: Leave cross-origin requests to the browser instead of passing them through the Service Worker

## Status

Proposed

## Context

The fetch handler in `sw.js` called `respondWith()` for every request. For
cross-origin URLs it either served the moodle.org iframe notice or returned
`fetch(event.request)` unchanged. That pass-through added nothing, because the
browser makes the same request itself when no response is provided.

The blueprint engine runs in the PHP worker, which the Service Worker controls.
It downloads plugin ZIPs, course backups and resources with `fetch()`, so those
downloads also went through the pass-through.

## Problem

In Firefox, `respondWith(fetch(event.request))` never settles when the response
is a cross-origin redirect. `raw.githubusercontent.com//owner/...` answers with
a `307` and a relative `Location`. Firefox follows that redirect without a
Service Worker (200) and hangs with one. Chromium follows it in both cases.

Issue #363: `moodle-playground-adaptable_config_7_es_acc.json` has one plugin URL
with `//`. In Firefox, provisioning stopped at "Downloading plugin ZIP". The
bootstrap navigation of `#remote-frame` stayed pending in the Service Worker
until Firefox terminated the worker and reset the interception. The navigation
then went to GitHub Pages and showed its 404.

## Decision drivers

- Blueprint downloads must work in Firefox.
- The fix belongs in the shared request path, not in each download step.
- Keep the moodle.org iframe notice.

## Options considered

1. **Do not call `respondWith()` for cross-origin requests, except moodle.org.**
   The browser handles them natively, as it would with no Service Worker.
2. **Collapse `//` in blueprint URLs.** This only covers one URL shape. Any
   other cross-origin redirect would still hang.
3. **Add a timeout to blueprint downloads.** This turns the hang into an error,
   and the step still fails.

## Decision

Option 1. `shouldInterceptRequest(url, swOrigin)` in
`src/shared/sw-url-rewrite.js` returns true for same-origin URLs and for
`moodle.org` / `www.moodle.org`. The fetch handler returns before
`respondWith()` when it is false.

## Consequences

- Cross-origin requests from Moodle pages and from the PHP worker no longer pass
  through the Service Worker. They follow the browser's normal CORS and redirect
  handling.
- The proxies (`addonProxyUrl`, `phpCorsProxyUrl`) are cross-origin too and also
  go direct. Same-origin `__playground_proxy__` requests are still intercepted.
- A future feature that needs to rewrite cross-origin responses in the Service
  Worker has to add its host to `shouldInterceptRequest`.

## Evidence

Playwright Firefox 157.0 and Chromium 156, local build, 2026-10-19:

- `fetch("https://raw.githubusercontent.com//HenarLG/Playground_pruebas/refs/heads/main/local_accessibility.zip")`
  - Before: Firefox without a Service Worker returns 200, and through the
    Service Worker it hangs for more than 20 s. Chromium returns 200 in both cases.
  - After: both browsers return 200 through the Service Worker.
- The issue #363 blueprint with `&moodle=5.3`
  - Before: Firefox hangs at "Downloading plugin ZIP" and ends on the GitHub
    Pages 404.
  - After: Firefox loads `/my/` in 41 s.

## Validation

- `tests/sw/sw-helpers.test.js` → `shouldInterceptRequest`.
- `make test`, `make lint`, and Chromium and Firefox e2e.
