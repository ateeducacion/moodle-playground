---
id: ADR-0042
title: "Stream service-worker static responses while caching them"
status: Proposed
date: 2026-10-18
deciders: [erseco]
reviewers: []
related:
  issues: []
  prs: []
  sdds: []
  adrs: [ADR-0001, ADR-0015, ADR-0025]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Grok Build"
  model: "Grok 4.7"
---

# ADR-0042: Stream service-worker static responses while caching them

## Status

Proposed

## Context

Cold boot downloads the Moodle core bundle (Moodle 4.5 is two `tar.zst` parts,
24 MiB + 11 MiB), the install snapshot, and the PHP WASM binary. Those URLs are
same-origin, so `sw.js` handles them. Sensitive paths (`/assets/manifests/*.json`,
`/assets/moodle/`) use `networkFirstStaticFetch`. Everything else static,
including `/dist/*.wasm`, uses `cacheFirstStaticFetch`.

Both functions did `await cache.put(cacheKey, response.clone())` and only then
returned `response`. `Response.clone()` tees the body. `cache.put` reads one
branch. The page or PHP worker cannot read the other branch until the fetch
handler returns the response. On a body larger than the tee buffer, `cache.put`
blocks waiting for a reader that is waiting for `cache.put`.

`startArchiveResolution` publishes `Loading manifest …` at progress 0.16 and
does not publish again until the bundle reader receives a chunk
(`src/runtime/bootstrap.js`). While the service worker holds the part, the
status line stays on that manifest message.

A Playwright trace against
`https://ateeducacion.github.io/moodle-playground/` (2026-10-18, Chromium,
`?clean=1`, the Adaptable 4.5 blueprint) showed the service worker's upstream
fetch for `moodle-core-….part-000` receiving response headers about a second
before its body finished, and the client fetch receiving headers only at that
same moment the upstream body completed. The manifest JSON itself (1.6 KB)
returned in well under a second. On that fast path the whole boot still
finished in 33 s. The frozen 16% is the gap between upstream headers and the
buffered body, which grows with the part size and shrinks with bandwidth.

## Problem

Should the service worker finish writing a static response into Cache Storage
before handing that response to the client?

## Decision drivers

- Boot progress has to move during the core download, including on a slow link.
- A large body must not deadlock the fetch handler.
- Cache Storage remains an optimization. A failed write must not fail the boot.
- Network-first versus cache-first policy stays as it is. This record only
  changes when the body is delivered.
- Firefox request-body buffering (ADR-0015) is a separate constraint and stays.

## Options considered

### Option 1: Keep awaiting `cache.put` before responding

The client sees one chunk only after the whole part is cached. Progress stays
at "Loading manifest" for the entire part. A full tee buffer never unblocks.

### Option 2: Stop intercepting `/assets/moodle/` and `/dist/*.wasm`

The worker would stream the body itself. That avoids the deadlock, but drops
the static-cache fallback and needs a separate rule for every large prefix.
The same bug remains for the next large file that uses the shared helpers.

### Option 3: Return the response immediately and cache a clone in the background

`cache.put(response.clone())` runs concurrently with the client read, and
`FetchEvent.waitUntil` keeps the worker alive until the write settles. A
rejected `cache.put` is ignored. This is the usual Cache API pattern.

## Evidence

- `sw.js` `networkFirstStaticFetch` / `cacheFirstStaticFetch` awaited
  `cache.put` before returning (repository before this change).
- WHATWG streams backpressure: both branches of a tee must be read. MDN
  `Cache.put()` consumes the body it is given.
- Playwright request log, 2026-10-18: client headers for the 24 MiB part were
  delivered when the service worker upstream body completed, not when upstream
  headers arrived. Manifest `MOODLE_405_STABLE.json` is 1631 bytes and returned
  in ~0.2 s (`curl` and the same trace).
- `lib/moodle-loader.js` `fetchPartsWithCache` only called `onProgress` from
  `fetchPartInto`, after a chunk was readable.

## Decision

We will return the network response to the client without awaiting
`cache.put`. The write uses `response.clone()`, is reported with
`waitUntil` when the fetch event is still active, and never fails the
response. `settleStaticFetch` in `src/shared/sw-static-response.js` is the
only implementation. Both static-fetch helpers use it.

The bundle loader also emits progress at 0%, with loaded and total bytes,
before the first part body arrives, and the download band runs from 0.18 to
0.56 so the bar moves during the transfer. Extraction still starts at 0.58.

## Consequences

### Positive

- Cold boot progress tracks the core download instead of sitting on the
  manifest line.
- A Cache Storage quota error no longer wedges the response.
- The client and the cache read the body together, so the worker does not
  hold a second full copy only to unblock the tee.

### Negative

- A service worker that dies mid-write can leave a missing cache entry. The
  next boot fetches again. That was already true of a failed `cache.put`.
- `waitUntil` called after the first `await` in `respondWith` can throw on
  older browsers. The helper ignores that throw. The write still runs.

### Neutral

- Network-first and cache-first selection is unchanged.
- The PHP worker keeps its own checksummed bundle cache
  (`moodle-playground-bundles-v1`). This record does not merge the two caches.

## Risks

- If `cache.put` stops reading, the tee can still apply backpressure to the
  client. That is the same coupling as any streamed cache write. It no longer
  happens before the client is allowed to read.
- Widening the download band to 0.56 assumes "Writing Moodle bundle into
  MEMFS" stays at 0.58. A future progress value in between would be hidden by
  the monotonic clamp in `php-worker.js`.

## Validation

- `tests/sw/sw-static-response.test.js` reads the first chunk of a gated body
  while `cache.put` is still blocked, then checks that the write finishes.
- `tests/shared/moodle-loader-parts.test.js` expects a `ratio: 0` progress
  event before a stalled part fetch resolves.
- Revisit if a boot trace again shows client response headers for
  `/assets/moodle/` arriving only when the service worker upstream body
  completes.

## Follow-up work

- Deploy the rebuilt `sw.bundle.js`. The hosted site keeps the buffering
  behavior until that bundle is published.
- The two cache layers (service worker static cache and the worker bundle
  cache) still store the same parts. Merging them is out of scope.

## References

- `sw.js`
- `src/shared/sw-static-response.js`
- `lib/moodle-loader.js` `fetchPartsWithCache`
- `src/runtime/bootstrap.js` `startArchiveResolution`
- [ADR-0001](ADR-0001-sw-level-scoped-static-asset-caching.md)
- [ADR-0015](ADR-0015-firefox-request-body-buffering.md)
- [ADR-0025](ADR-0025-boot-time-asset-delivery-and-runtime-lifecycle.md)
