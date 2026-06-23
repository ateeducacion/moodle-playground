# 0015 — Buffer the request body synchronously for Firefox

## Status

Accepted (2026-06).

## Context and Problem

The service worker bridges every scoped request to the PHP worker
(`forwardToPhpWorker` → `serializeRequest`). For non-`GET`/`HEAD` requests it
must read the request body and forward it to the worker, which rebuilds the
request via `buildPhpRequest(originalRequest, forwardedUrl, body)`.

Firefox's service worker implementation **neuters `event.request.body` once the
`fetch` handler yields to the event loop** (the first `await`). After that point
reading the body — `event.request.arrayBuffer()` or `request.clone().arrayBuffer()`
— resolves empty (and constructing a streaming `new Request({ body, duplex })`
throws, rejecting `respondWith` with *"A ServiceWorker intercepted the request
and encountered an unexpected error"*). Chromium keeps the body across awaits,
so the bug is Firefox-only.

The symptom is that any non-`GET` request whose **body is semantically required**
fails on Firefox: form `POST`s (including login, which carries the CSRF token +
credentials) and, in WebDAV-based apps, `PROPFIND`/`REPORT`. Requests that ignore
their body (e.g. a `POST` to a front controller that just renders a page) appear
to work, which makes the bug easy to miss.

This SW already read the body "early" — but **after** `await
resolveScopedRequest(event, url)`, i.e. after the handler had already yielded.
That contradicted the accompanying comment ("before any async operations").

Empirically that previous placement still **worked** on Firefox (a logout →
CSRF login `POST` round-trip succeeded under Playwright Firefox), because for a
scoped path `resolveScopedRequest` returns synchronously, so awaiting it only
schedules one microtask and the body survives. But that correctness is
incidental: it relies on `resolveScopedRequest` never awaiting before returning,
and on a single microtask being short enough — both of which a future change
could break, reintroducing the silent Firefox failure. The sibling playgrounds,
which read the body several awaits later (inside `forwardToPhpWorker`), did fail
in Firefox. So this is a **hardening + documentation** decision, not a bug fix.

## Options Considered

* **Read the body lazily inside `serializeRequest`** (status quo of the sibling
  playgrounds before their fix): simplest, but the read happens after several
  awaits and is reliably empty on Firefox.
* **Read it after `resolveScopedRequest`** (this project's previous state):
  better, but still after a yield and dependent on `resolveScopedRequest`
  resolving synchronously for the common scoped-path case.
* **Buffer it synchronously at the very top of the `fetch` handler, before any
  await, and forward the buffered bytes** (chosen).

## Decision

Capture the body in the `fetch` listener **before** `event.respondWith(...)`'s
async work runs any `await`:

```js
self.addEventListener("fetch", (event) => {
  const bufferedBody = ["GET", "HEAD"].includes(event.request.method)
    ? null
    : event.request.clone().arrayBuffer().catch(() => null);
  event.respondWith((async () => { /* … */ })());
});
```

* `clone()` (rather than consuming `event.request` directly) leaves the original
  request intact for the pass-through branches (`fetch(event.request)`, the
  static cache fetches), so buffering is safe for every code path.
* The promise is awaited later where the body is actually needed
  (`const earlyBody = await bufferedBody;` — `bufferedBody` is `null` for
  `GET`/`HEAD` and `await null` is `null`, so no extra guard is needed) and
  threaded into `buildPhpRequest(..., earlyBody)`. Starting the read
  synchronously is what matters; awaiting the already-started read afterwards is
  fine.
* `.catch(() => null)` keeps a failed/absent body from rejecting the handler.

The worker already received an `ArrayBuffer` body before, so Chromium behaviour
is unchanged; only the Firefox failure mode is removed.

## Consequences

### Positive

* Form `POST`s (login, settings, blueprint-driven actions) work on Firefox, at
  parity with Chromium.
* The code now matches its stated intent ("buffer before any async operation")
  and is no longer coupled to `resolveScopedRequest` happening to resolve
  synchronously.

### Negative / Risks

* The body of every non-`GET` request is cloned and buffered even for the
  pass-through branches that end up calling `fetch(event.request)`. The extra
  clone is a cheap reference until consumed and is dropped when unused; bodies in
  this app are small (form posts), so the overhead is negligible.

## Implementation Notes

* `sw.js`: `bufferedBody` captured at the top of the `fetch` handler; the former
  post-`resolveScopedRequest` `earlyBody` read now just `await`s it. Rebuild with
  `npm run build-worker` (the SW is shipped as `sw.bundle.js`).
* The sibling php-wasm playgrounds (omeka-s, nextcloud, facturascripts) carried
  the lazy-read variant of this bug and were fixed with the same pattern
  (e.g. ateeducacion/nextcloud-playground#24, verified in Playwright Firefox:
  WebDAV folder navigation and a CSRF login `POST` went from failing to working).

## Review Criteria

* Revisit if the SW transport changes (e.g. a `MessagePort` rework, see ADR 0012)
  in a way that moves body handling — the synchronous capture must stay before
  the first `await`.
