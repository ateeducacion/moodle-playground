# ADR-0023 Resilient resource fetching + non-fatal-by-default blueprint steps

* Status: Accepted
* Date: 2026-07-08

## Context and Problem

Re-measuring the Adaptable demo blueprint after the restore fix (#251, ADR-0022) showed the
remaining provisioning time is dominated by **network fetches of remote assets**, not CPU:
the blueprint pulls 16 resources (config JSON, logo, role XMLs, scales JSON, 3 plugin ZIPs,
the `.mbz`, …) from `raw.githubusercontent.com` during provisioning, and the big per-step
variance (`createScales` 0.65–5.4s, `importRoles` 1.0–3.5s) is network jitter.

Worse, one of three measured runs **aborted the whole blueprint at step 8**: a transient
failure fetching the theme-logo resource made `setConfigFile` throw, and the executor stopped —
so no course restore, no courses, no users. Two problems combined:

1. **No retry.** `resources.resolve()` did a single `fetch()` with a flat 30s timeout; any
   network blip or transient 5xx threw immediately.
2. **A thrown step aborted everything.** Although ADR-0005's intent is "install what we can",
   the executor halted on any thrown step, so a resource-fetch failure discarded the rest of
   an otherwise-working blueprint.

## Options Considered

* **A — Retry only.** Add retry/backoff to `resources.resolve()`. Fixes transient blips but a
  *persistent* failure of even a cosmetic resource (the logo) would still abort the whole run.
* **B — Make each resource-fetching handler catch-and-skip.** Localized, but touches many
  handlers and only covers resource fetches, leaving the executor's abort-on-throw in place.
* **C — Retry + make the executor non-fatal by default (with a `critical` opt-in).** Completes
  ADR-0005's stated intent at the executor level and covers every step uniformly.

## Decision

Chosen: **Option C.**

1. **Retry transient resource fetches.** `ResourceRegistry` fetches URL resources through a
   retry loop (default 3 attempts, linear backoff). Retriable: network errors / aborts (no HTTP
   status) and transient statuses (5xx, 429). Not retriable: permanent 4xx and the 50 MB cap.
   `fetchImpl` / `retryAttempts` / `retryDelayMs` are injectable for tests.
2. **Non-fatal step execution by default.** The executor now logs a failing step (progress +
   `[blueprint-perf]` `status: "failed"`) and continues to the next step, reporting the first
   failure in the result. A step with `"critical": true` still aborts the blueprint. This
   fulfils ADR-0005 ("a failing plugin/module doesn't block subsequent steps") — previously
   only achievable by handlers that avoided throwing — and implements the `critical` flag,
   which was documented but had no effect.

## Consequences

### Positive
* A transient (or persistent) failure of one resource — especially a cosmetic one like the
  logo — no longer discards the rest of the playground. The run-2 abort cannot recur.
* Retry absorbs the network jitter that dominated the post-restore step variance.
* Better observability: the `[blueprint-perf]` report now lists *all* steps with per-step
  `status`, instead of stopping at the first failure.

### Negative / Risks
* Steps after a failure run against possibly-incomplete state; dependent steps then fail too,
  but gracefully (they are reported, not fatal). Net effect is "install what we can", the
  intended behavior. Authors who need hard ordering guarantees use `"critical": true`.
* This reverses the previously-documented "unmarked steps abort" default; `docs/blueprints/reference.md`
  is updated accordingly.

## Implementation Notes

* `src/blueprint/resources.js` — retry loop (`#fetchResourceBytes` / `#fetchOnce`,
  `isTransientFetchError`) + constructor options.
* `src/blueprint/executor.js` — accumulate the first failure, continue by default, honor
  `step.critical`.
* Tests: `tests/blueprint/resources.test.js` (retry: transient network, transient 5xx, budget
  exhaustion, no-retry-on-404) and `tests/blueprint/executor.test.js` (continue on non-critical
  failure, halt on `critical`, continue past unknown step).
* Rebuild the worker after changes (`npm run build-worker`).

## Review Criteria

Revisit if: (a) a step genuinely must halt the blueprint by default (reconsider per-step
defaults); (b) retry masks a persistent misconfiguration that should surface louder; or
(c) parallel/prefetch resource loading is added, which would change where retry lives.
