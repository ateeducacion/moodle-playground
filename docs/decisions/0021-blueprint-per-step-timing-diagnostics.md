# ADR-0021 Blueprint per-step timing instrumentation and `[blueprint-perf]` diagnostics channel

* Status: Accepted
* Date: 2026-07-08

## Context and Problem

Heavy blueprints (e.g. the user-reported Adaptable demo config with 34 steps: theme ZIP
installs, a large theme config import, a `.mbz` course restore, SCORM/H5P modules, role
imports) provision slowly, but there was **no way to tell which step is slow** without
manually diffing progress-log timestamps.

Before this change the executor (`src/blueprint/executor.js`) published only a *start* line
per step — `Blueprint step N/M: <stepName>` — carried up to the shell log panel with a
boot-relative `[<ms>]` prefix. That has three problems for profiling:

1. **No per-step duration or status.** You must subtract consecutive timestamps by hand, and
   the boot-relative clock resets on a runtime restart, so a naïve diff can go negative.
2. **No machine-readable event.** A grep for `kind:"perf"` returned nothing; all timing was
   free-text, so Playwright (or any dashboard) could not consume it reliably.
3. **No slowest-step ranking**, so the one number a reader wants ("what dominated?") is absent.

See issue #249. We want observability first — measure before optimizing — without changing
provisioning behavior and without leaking secrets (blueprint steps carry passwords/tokens).

## Options Considered

* **A — Add a new worker→shell message kind (`kind:"perf"`) and a `window.__perfReport` mirror.**
  Cleanest for a future dashboard, but requires shell-side plumbing (`src/shell/main.js`
  message switch) and a new protocol surface for what is, today, a diagnostics line.
* **B — `console.log` a JSON marker from the worker.** Playwright does not reliably capture
  nested-iframe worker console output, so the spec could not read it.
* **C — Emit one structured, delimited line at the END of provisioning on the existing
  progress channel**, so it lands in the shell `#log-panel` (which Playwright already reads)
  and survives the panel's 500-line prune. Executor returns a structured `timings` array for
  unit tests; the runtime formats and publishes the line.

## Decision

Chosen: **Option C**, with the timing logic isolated in a new dependency-free module
`src/blueprint/timing.js` so it is unit-testable in isolation.

* The executor records one `StepTiming` per step — `{ index, step, label, startMs, endMs,
  durationMs, status }` — and returns them as `result.timings`. `status` is `success`,
  `skipped` (handler returned `{ skipped: true }`) or `failed` (handler threw). Timing is
  captured even for a failing step and for an unknown step type. A `context.now` override
  keeps it deterministically testable.
* **Secret-safety is by construction (allowlist).** The only human-readable text taken from a
  step is a *sanitized label* derived solely from the author-provided `comment`/`label`
  description fields — never the step payload. `formatBlueprintTimings` serializes only
  `{ i, step, label, ms, status }`, so passwords/tokens/file data cannot appear even if a step
  object carries them.
* The runtime (`src/runtime/bootstrap.js`) publishes, after `executeBlueprint`, two lines:
  * a human summary — `Blueprint timing: N step(s) in Tms. Slowest: #i step (ms), …`
  * a machine-readable, delimited line —
    `[blueprint-perf] {"totalMs":..,"steps":[{"i","step","label","ms","status"}]} [/blueprint-perf]`
  Both are emitted at the end so they survive the log prune. Emission is wrapped in a
  try/catch — diagnostics never break boot.

## Consequences

### Positive
* The slowest blueprint step is identifiable from a single log line, in the browser and in CI.
* Playwright reads the report from `#log-panel` with a stable regex — no deep-iframe access,
  no new protocol. `tests/e2e/blueprint-perf.spec.mjs` asserts the report exists with the
  expected step names (not exact durations) and that passwords are redacted.
* Durations are relative to blueprint start, so they are immune to boot-clock resets.
* Zero behavior change: step order, halt-on-throw semantics, and ADR-0005 graceful handling
  are untouched; overhead is a few `Math.round` calls plus one `JSON.stringify` at the end.

### Negative / Risks
* The machine line couples a format to a consumer (the spec's regex). Mitigated by the
  explicit `[blueprint-perf] … [/blueprint-perf]` delimiters and a unit-tested formatter.
* For a very long blueprint the JSON line can reach a few KB — acceptable as a single line;
  it is namespaced and appears once.

## Implementation Notes

* New: `src/blueprint/timing.js` (`sanitizeStepLabel`, `deriveStepStatus`,
  `formatBlueprintTimings`, `defaultNow`).
* Changed: `src/blueprint/executor.js` (collect + return `timings`),
  `src/runtime/bootstrap.js` (format + publish after `executeBlueprint`).
* Tests: `tests/blueprint/timing.test.js`, `tests/blueprint/executor.test.js`,
  `tests/e2e/blueprint-perf.spec.mjs` (CI-safe local blueprint + opt-in external baseline
  gated by `RUN_EXTERNAL_PERF=1`).
* Because the code lives under `src/blueprint/**` and `src/runtime/**`, run
  `npm run build-worker` after changes (bundled into `dist/php-worker.bundle.js`).
* Profiling guide: `docs/profiling-slow-blueprints.md`.

## Review Criteria

Revisit if: (a) a future dashboard needs a push event, in which case add `kind:"perf"` +
`window.__perfReport` (Option A) with the spec keeping the log-parse fallback; (b) the log
panel prune threshold shrinks below a realistic blueprint's line count, breaking end-line
survival; or (c) per-step sub-timings (download/unzip/write for plugin installs; journal
flush count × bytes) are needed to attribute cost within a step.
