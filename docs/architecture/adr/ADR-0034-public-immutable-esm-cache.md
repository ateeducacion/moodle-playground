---
id: ADR-0034
title: "Cache public immutable ESM responses inside the existing scope"
status: Accepted
date: 2026-10-16
deciders: [erseco]
reviewers: []
related:
  issues: []
  prs: [341]
  sdds: [SDD-0002]
  adrs: [ADR-0001, ADR-0033]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Codex"
  model: "GPT-5"
---

# ADR-0034: Cache public immutable ESM responses inside the existing scope

## Status

Accepted (2026-10-16).

## Context

The SW at `06bcd45a` caches static extensions and several PHP asset endpoints.
Bare ESM specifiers, including react and react-dom/client, bypass that cache and
execute PHP repeatedly. Moodle's ESM controller explicitly marks valid production
responses public and immutable; invalid revisions are not immutable.

## Problem

Avoid repeated PHP work without caching authenticated HTML, protected files,
generic router endpoints or development/error responses.

## Decision drivers

- Preserve scope/runtime/build isolation and the existing300-entry eviction.
- Require the upstream controller's public-asset declaration.
- Never infer that PHP PATH_INFO is public from a .js/.css extension.

## Options considered

### Option 1: Cache every r.php response or every path ending in .js

Rejected: authentication and protected files can use those paths.

### Option 2: Allow only explicit ESM production paths and public immutable JS

Selected. Unknown/ambiguous paths retain ordinary routing.

## Evidence

- `sw.js` and `src/shared/sw-url-rewrite.js` at `06bcd45a`.
- Moodle `42622298fe06f9626d988d60b2bf589bd8f850e8`, ESM controller:
  `cookies:false`, GET only, registry lookup, revision validation and immutable
  headers (`public/lib/classes/route/controller/esm_controller.php`).
- The initial exploratory audit measured fewer warm PHP requests with F1+F2
  (dashboard57→5), not an isolated F2 effect. Cold-start improvement was not
  established by that experiment.
- Coherent 3.1.57 series: F1 dashboard already makes zero ESM requests to PHP
  in all ten measured navigations. Remaining routes are `/my/`,
  `/lib/ajax/service.php` and `/lib/ajax/service-nologin.php` (one sample also
  loads four previously uncached theme/editor images). F2 does not reduce
  their median request count. Its isolated two-fetch test proves an ESM cache hit,
  not an incremental latency gain in a navigation whose HTTP/module caches are warm.

## Decision

Only GET requests for canonical `/r.php/core/esm/<positive-safe-integer>/<specifier>`
paths without query strings are ESM cache candidates. Cache only HTTP200 JavaScript
responses with explicit public and immutable directives; reject private/no-store/
no-cache, Set-Cookie and Vary:*. Recheck these rules on cache hits as well.
The Set-Cookie check is defense in depth for visible headers only: browser fetch
can filter this header. Public controller semantics, canonical path, content type
and explicit immutable/public cache directives are the admission boundary.
Ambiguous encodings, generic router endpoints and protected PHP PATH_INFO take
the normal PHP route. Static extensions apply only to non-PHP paths; retain the
existing explicit legacy PHP asset allowlist, plus TinyMCE's revisioned
`lib/editor/tiny/{loader,lang}.php/<rev>/` (cached by Moodle only for a valid
revision), which the PATH_INFO exclusion would otherwise send through PHP.
Exclude development revisions (`requirejs.php/-1/...`, Tiny `-1`) and honor private,
no-store and no-cache directives on legacy assets too. The plugin-upgrade browser
test demonstrated stale v1 code after a successful v2 upgrade without this guard.

## Consequences

### Positive

- Repeated public ESM requests avoid the serial PHP queue.
- Protected files with static-looking extensions are excluded explicitly.

### Negative

- First misses still execute PHP. No cold-start speedup is promised.
- Unusual encodings/queries intentionally miss the cache.

### Neutral

- No pooling, direct MEMFS mapping, persistence change or browser feature beyond
  the existing Cache Storage APIs is introduced.

## Risks

Controller behavior and headers may change upstream. Revisions must remain
Moodle-owned (ADR-0033); a deployment must rebuild both worker bundles and change
build metadata rather than reusing stale SW caches.

## Validation

Tests cover development/error/HTML/private/protected responses and path ambiguity,
scope/runtime/build separation, actual SW hits, purges and plugin revision changes.
Run browser tests on Chromium and Firefox, root and subpath deployments.

## Follow-up work

Measure an incremental improvement against F1 separately. Do not combine this
with PHP-WASM upgrades, OPcache activation or the experimental ESM file map.

## References

- [ADR-0001](ADR-0001-sw-level-scoped-static-asset-caching.md)
- [ADR-0033](ADR-0033-moodle-owned-javascript-revisions.md)
- [SDD-0002](../sdd/SDD-0002-incremental-navigation-and-reload-correctness.md)
