---
id: ADR-0028
title: "Sentry error monitoring via a minimal hand-rolled envelope client"
status: Proposed
date: 2026-08-15
deciders:
  - "@erseco"
reviewers:
  - ""
related:
  issues: []
  prs: []
  sdds: []
  adrs: ["ADR-0026"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5"
---

# ADR-0028: Sentry error monitoring via a minimal hand-rolled envelope client

## Status

Proposed

## Context

Moodle Playground runs entirely in the visitor's browser. When a deployed
session breaks — a shell exception, a bootstrap failure, a WASM crash that
crash recovery cannot absorb — the only trace today is the in-page Logs panel,
which the affected visitor rarely reports. There is no server, so there are no
server logs; the project has zero visibility into production failures on
GitHub Pages deployments.

A Sentry organization (`erseco`) already exists and hosts monitoring for
sibling eXeLearning projects, so operational cost of one more project is
negligible. The new Sentry project is `moodle-playground` (EU/DE data region).

Two architectural constraints shape the integration:

1. The shell (`src/shell/main.js`) is served as an **unbundled** ES module
   straight from source — there is no build step through which an npm SDK
   could be bundled for it (only `php-worker.js` and `sw.js` are bundled).
2. The worker already funnels every serious runtime failure (boot errors,
   fatal WASM crashes, failed restarts) to the shell as `kind: "error"`
   messages on the scope's BroadcastChannel (`php-worker.js`), so the shell
   is a natural single capture point for the whole stack.

## Problem

How should the playground report unhandled errors to Sentry given that the
shell cannot bundle an npm SDK, without adding a runtime dependency on a
third-party CDN, and without monitoring failures ever affecting the app?

## Decision drivers

- No build step for the shell; integration must load as a plain ES module.
- No new runtime dependency on external CDNs (the app is self-contained;
  everything else is served from the deployment origin).
- Monitoring must be strictly best-effort: a Sentry outage, an ad blocker, or
  a malformed DSN must never break or slow the playground.
- Small maintenance surface, testable with `node:test` like the rest of
  `src/shared/`.
- Config-driven (deployments without a DSN get a no-op), consistent with the
  `playground.config.json` philosophy (ADR-0026).

## Options considered

### Option 1: Sentry Loader Script (CDN `<script>` tag in `index.html`)

- Pros: official, full SDK feature set (breadcrumbs, replay, tracing),
  zero code to maintain.
- Cons: adds a third-party CDN request to every page load of an otherwise
  self-contained app; blocked by ad blockers in a way that also delays SDK
  availability; features like session replay are unnecessary for this
  project's needs and add page weight.

### Option 2: `@sentry/browser` npm package, bundled

- Pros: official SDK, self-hosted (no CDN).
- Cons: the shell has no bundling step; adopting one for the shell (or
  vendoring the SDK) restructures the delivery pipeline for a monitoring
  concern. The SDK is ~80 KB min+gzip — large relative to the entire shell.

### Option 3: Minimal hand-rolled envelope client in `src/shared/` (chosen)

- Pros: plain ES module (~250 lines) loaded like every other shared module;
  no dependency, no CDN; posts directly to the DSN's `/api/<id>/envelope/`
  ingest endpoint via `fetch(..., { keepalive: true })`; fully unit-testable;
  degrades to a no-op without a DSN.
- Cons: no breadcrumbs/replay/tracing; stack-frame parsing is best-effort;
  must track Sentry's envelope protocol (stable, versioned `sentry_version=7`).

## Evidence

- Shell served unbundled: `index.html` loads
  `<script type="module" src="./src/shell/main.js">`; only the worker and SW
  are built by `esbuild.worker.mjs`.
- Worker error funnel: `php-worker.js` posts `kind: "error"` for bootstrap
  failures, fatal crashes, and failed restarts; the shell handles them in
  `bindShellChannel()` (`src/shell/main.js`).
- Sentry envelope endpoint and DSN authentication: Sentry developer
  documentation, <https://develop.sentry.dev/sdk/data-model/envelopes/> and
  <https://develop.sentry.dev/sdk/overview/>.
- Unit coverage: `tests/shared/monitoring.test.js` (DSN parsing, stack
  parsing, envelope shape, dedupe/cap, no-op behavior).

## Decision

We will implement a minimal Sentry client at `src/shared/monitoring.js` and
enable it from the shell when `playground.config.json` provides
`sentry.dsn`:

- `initMonitoring()` runs in `src/shell/main.js` after runtime selection is
  resolved, tagging events with `runtime`, `moodleBranch`, and `phpVersion`,
  and using the generated `BUILD_VERSION` as the Sentry `release` (falling
  back to unset in dev checkouts).
- Captured signals: uncaught `window` errors, `unhandledrejection`, the
  `main()` boot failure path, and every `kind: "error"` BroadcastChannel
  message relayed from the runtime worker.
- The `environment` is auto-detected (`development` on localhost,
  `production` otherwise) and can be overridden via `sentry.environment`.
- Client safety rails: hard cap of 30 events per session, per-session
  dedupe by event signature, fire-and-forget delivery, and every capture
  path wrapped so it can never throw into the caller.

The DSN is committed in `playground.config.json`: browser DSNs are public
identifiers by design (they authorize event submission only).

## Consequences

### Positive

- Production failures on GitHub Pages deployments become visible with
  version, runtime, and browser context attached.
- Zero impact on deployments that omit `sentry` from their config.
- No new dependency, no CDN, no change to the delivery pipeline.

### Negative

- No breadcrumbs, session replay, or performance tracing; if those are ever
  needed the decision should be revisited toward the official SDK.
- The envelope format is maintained by hand (mitigated by its stability and
  by unit tests pinning the emitted shape).

### Neutral

- Worker-side errors are captured indirectly through the existing
  BroadcastChannel relay rather than by a client inside the worker.

## Risks

- Ad blockers commonly block Sentry ingest hosts: some sessions will go
  unreported. Accepted — monitoring is best-effort telemetry, not an audit
  log.
- A noisy failure loop could burn Sentry quota; the 30-event session cap and
  signature dedupe bound the volume.

## Validation

- `tests/shared/monitoring.test.js` pins DSN parsing, envelope shape, dedupe,
  caps, and no-op behavior.
- After deploy: trigger a forced error in production and confirm the event
  appears in the `moodle-playground` Sentry project with correct release,
  environment, and tags.
- Revisit if: Sentry rejects envelopes after a protocol change, event volume
  approaches quota, or richer diagnostics (breadcrumbs/replay) are needed.

## Follow-up work

- Optionally initialize a client inside `php-worker.js` for richer crash
  context (request counts, restart reasons) instead of relying on the relay.
- Consider uploading source maps if minification is ever introduced (the
  shell currently ships unminified source, so stacks are already readable).

## References

- Sentry envelope protocol: <https://develop.sentry.dev/sdk/data-model/envelopes/>
- Sentry SDK overview / DSN semantics: <https://develop.sentry.dev/sdk/overview/>
- ADR-0026 (playground config minimization)
- `src/shared/monitoring.js`, `src/shell/main.js`,
  `tests/shared/monitoring.test.js`, `playground.config.json`
