---
id: ADR-0031
title: "Proxy worker serves generic responses as sandboxed data"
status: Proposed
date: 2026-09-25
deciders:
  - "@erseco"
reviewers:
  - "@erseco"
related:
  issues: []
  prs: []
  sdds: []
  adrs: []
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-opus-5-5"
---

# ADR-0031: Proxy worker serves generic responses as sandboxed data

## Status

Proposed

## Context

`scripts/github-proxy-worker.js` is the canonical CORS proxy used by all four
playgrounds (`github-proxy` and `zip-proxy` Cloudflare Workers). Its generic
`?url=` mode authorizes Nextcloud/ownCloud public shares on any host by path
shape (`/s/{token}[/download]`), because shares live on arbitrary self-hosted
domains. Same-host redirects from a share were followed to any path, and the
upstream body, `Content-Type` and `Set-Cookie` were returned with
`Access-Control-Allow-Origin: *`. Anyone could therefore serve their own HTML
from the proxy's origin (for example `github-proxy.exelearning.dev`).

## Problem

How do we keep arbitrary-host Nextcloud shares working without letting the
proxy origin serve attacker-controlled documents?

## Decision drivers

- Nextcloud shares on any host must keep working (eXeViewer, playground blueprints).
- Every consumer reads proxied bodies with `fetch()`; none renders them as a page.
- Small, testable change in one canonical file mirrored to three repos.

## Options considered

### Option 1: Host allowlist for Nextcloud

Blocks the abuse, but breaks shares from any instance not listed.

### Option 2: Sandbox every generic response and restrict share redirects

Add `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`,
drop `Set-Cookie`, and follow same-host share redirects only into `/s/`,
`/index.php/s/`, `/public.php/` and `/remote.php/`.

### Option 3: Force `application/octet-stream` for every response

Also neutralizes documents, but loses meaningful content types that some
consumers may inspect.

## Evidence

- Generic-mode handler and redirect policy: `scripts/github-proxy-worker.js`
  (`handleGenericProxy`, `NEXTCLOUD_SHARE_PATH`).
- Regression tests: `tests/shared/github-proxy-worker.test.js`
  ("blocks a same-host Nextcloud redirect outside the share/DAV paths",
  "serves share responses sandboxed, nosniff and without cookies").
- CSP `sandbox` applies to documents only, not to `fetch()` consumers:
  <https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy/sandbox>.

## Decision

We choose Option 2. Generic proxy responses are data, not documents.

## Consequences

### Positive

- The proxy origin can no longer host scriptable attacker content or set cookies.
- Arbitrary-host Nextcloud shares keep working.

### Negative

- Anyone opening a proxied URL directly in a browser sees an inert, sandboxed page.

### Neutral

- The worker is still usable as a bandwidth relay for share-shaped URLs. Rate
  limiting at the Cloudflare level is the remaining mitigation.

## Risks

A Nextcloud deployment that redirects share downloads through another path
would now fail with 400. The tests cover the documented `/public.php/dav/`
flow; extend `NEXTCLOUD_REDIRECT_PATH` if a real instance needs more.

## Validation

Unit tests above; after deploy, run the regression sweep from the proxy deploy
notes on both workers (`github-proxy`, `zip-proxy`).

## Follow-up work

- Deploy to both Cloudflare Workers and re-sync the three `zip-proxy-worker.js` mirrors.

## References

- `scripts/github-proxy-worker.js`
- `tests/shared/github-proxy-worker.test.js`
