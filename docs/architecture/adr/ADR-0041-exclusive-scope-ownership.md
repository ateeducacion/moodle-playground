---
id: ADR-0041
title: "Exclusive ownership of a playground scope"
status: Proposed
date: 2026-10-18
deciders: [erseco]
reviewers: []
related:
  issues: []
  prs: []
  sdds: []
  adrs: [ADR-0015, ADR-0027, ADR-0035]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Codex"
  model: "GPT-6"
---

# ADR-0041: Exclusive ownership of a playground scope

## Status

Proposed; implemented locally for validation.

## Context

Tabs may reuse an explicit scope or inherit sessionStorage on duplication. The
PHP bridge and mutable journal are scoped, while runtime selection is separate.
At `3e257773`, every worker listening on the same bridge accepts every request.
Two active workers can execute the same POST, including different PHP versions.

## Problem

How can shared scopes avoid duplicate mutations without implementing concurrent
ownership, changing persisted data, or replacing the Service Worker?

## Decision drivers

- One active PHP worker per scope, including identical runtime versions.
- Preserve reload, Reset, runtime selection, and existing journals.
- No leases, heartbeats, automatic takeover, or replay of pending mutations.

## Options considered

### Option 1: Include only runtime in bridge names

Does not prevent two workers of the same runtime or concurrent journal writers.

### Option 2: Coordinate owners and handoff through the Service Worker

Requires additional lifecycle and SW-restart state. Unnecessary for an ephemeral
playground that does not need simultaneous use of the same scope.

### Option 3: Exclusive Web Lock for the remote document

The browser arbitrates a named lock and releases it when its owner terminates.
`ifAvailable` rejects a second owner immediately rather than queueing a future boot.

## Evidence

- `src/shared/protocol.js`, `sw.js:forwardToPhpWorker`, and
  `php-worker.js:installBridgeListener` at `3e257773` show scope-wide dispatch.
- `tests/e2e/scope-ownership.spec.mjs` covers conflicting versions, identical
  versions, separate scopes, a single POST, owner close, late request IDs,
  persistence, reload, Reset, runtime selection, and progress.
- [Web Locks request semantics](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request).
- ADR-0027 and ADR-0035 prohibit automatic mutation replay and define persistence.

## Decision

Acquire `moodle-playground-owner:<scope>` before reset, storage access, or PHP
worker creation. Hold the exclusive lock for the remote document's lifetime.
The worker opens its HTTP bridge only after authoritative configuration arrives;
cached URL parameters must not make it listen on another scope during startup.
On pagehide terminate the PHP worker before releasing ownership; drain any remote
preparation still in flight. A restored document reloads rather than resuming a
terminated worker. Browser teardown also releases the lock.

A conflicting tab displays an error and requires an explicit reload after the
owner closes. Missing or denied Web Locks fail closed. No IndexedDB deletion is
performed by a rejected owner. Reset and runtime changes reacquire ownership.

Give each remote load a new notification channel suffix, propagated through
shell, remote, and PHP worker. This separates blocked tabs and old notifications.
HTTP reply correlation continues using existing unique request IDs; ownership
changes never redispatch pending HTTP requests. Keep scoped routing, cache keys,
journal names, and DB paths unchanged.

## Consequences

### Positive

- The browser supplies exclusive ownership without application leader election.
- Conflicting tabs cannot create a second PHP worker or reset the active journal.

### Negative

- Web Locks become a required browser capability; there is no unsafe fallback.
- A rejected tab does not automatically start when another tab closes.

### Neutral

- This does not provide transactional exactly-once delivery across browser crashes.
- Existing unflushed-write limits and GET/HEAD-only crash replay remain unchanged.

## Risks

Check page lifecycle and browser storage restrictions. Safari has not been tested.
Older deployed code that does not acquire the lock cannot be fenced by this gate;
close old tabs and refresh the SW/bundles when validating the new protocol.

## Validation

Run unit tests and the scope E2E regression in Chromium and Firefox with fresh SW
caches. Check that blocked tabs never touch persistence and closing/reloading the
owner releases ownership. Existing plugin/reload and crash-recovery tests remain
acceptance gates. Revisit only if concurrent shared-scope editing becomes required.

## Follow-up work

Validate Safari's real iframe/page lifecycle before claiming support there.

## References

- `src/shared/scope-ownership.js`
- `src/remote/main.js`, `src/shell/main.js`, `src/shared/protocol.js`
- `tests/shared/scope-ownership.test.js`, `tests/e2e/scope-ownership.spec.mjs`
- `tests/runtime/worker-configuration.test.js`
