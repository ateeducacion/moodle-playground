/**
 * Blueprint per-step timing instrumentation (issue #249).
 *
 * The executor records one {@link StepTiming} per step it runs. The runtime then
 * surfaces a single machine-readable diagnostics line on the existing progress
 * channel so both humans (shell log panel) and Playwright can read it.
 *
 * Secret-safety is by construction: only the step *index*, *type name*, a
 * *sanitized label* (the author-provided `comment`/`label` description), the
 * *duration* and the *status* are ever emitted. Step payload fields — which may
 * contain passwords, tokens, or file data — are never read into the timing
 * output.
 *
 * @typedef {object} StepTiming
 * @property {number} index    1-based position in the blueprint.
 * @property {string} step     Step type name (e.g. "installTheme").
 * @property {string} label    Sanitized, secret-free description (may be "").
 * @property {number} startMs  Start time, ms since blueprint start.
 * @property {number} endMs    End time, ms since blueprint start.
 * @property {number} durationMs
 * @property {"success"|"skipped"|"failed"} status
 */

const MAX_LABEL_LEN = 80;

/**
 * Extract a human-readable, secret-free label from a blueprint step.
 * Reads ONLY the author-provided `comment`/`label` description fields — never the
 * step payload (username, password, token, data, ...).
 *
 * @param {object} step
 * @returns {string}
 */
export function sanitizeStepLabel(step) {
  if (!step || typeof step !== "object") {
    return "";
  }
  const raw =
    typeof step.comment === "string"
      ? step.comment
      : typeof step.label === "string"
        ? step.label
        : "";
  const oneLine = raw.replace(/\s+/gu, " ").trim();
  if (oneLine.length <= MAX_LABEL_LEN) {
    return oneLine;
  }
  return `${oneLine.slice(0, MAX_LABEL_LEN - 1)}…`;
}

/**
 * Derive a step status from the handler outcome.
 *
 * @param {{ error?: unknown, result?: unknown }} [outcome]
 * @returns {"success"|"skipped"|"failed"}
 */
export function deriveStepStatus(outcome = {}) {
  if (outcome.error) {
    return "failed";
  }
  const result = outcome.result;
  if (result && typeof result === "object" && result.skipped === true) {
    return "skipped";
  }
  return "success";
}

/**
 * Default monotonic clock: `performance.now()` when available, else `Date.now()`.
 * @returns {number}
 */
export function defaultNow() {
  const perf = globalThis.performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

/**
 * Build the human-readable summary + machine-readable diagnostics line from the
 * collected step timings. The machine line is delimited so a consumer (Playwright)
 * can extract it reliably from the shell log:
 *
 *   [blueprint-perf] {"totalMs":..,"steps":[{"i","step","label","ms","status"}]} [/blueprint-perf]
 *
 * Only allowlisted fields are serialized, so the line is safe to log even when a
 * step carried a password or token.
 *
 * @param {StepTiming[]} timings
 * @param {{ totalMs?: number }} [options]
 * @returns {{ perfLine: string, summaryLine: string, report: object }}
 */
export function formatBlueprintTimings(timings, options = {}) {
  const steps = Array.isArray(timings) ? timings : [];

  const totalMs =
    typeof options.totalMs === "number"
      ? Math.round(options.totalMs)
      : steps.reduce((max, t) => Math.max(max, t?.endMs ?? 0), 0);

  const report = {
    totalMs,
    steps: steps.map((t) => ({
      i: t.index,
      step: t.step,
      label: t.label || "",
      ms: t.durationMs,
      status: t.status,
    })),
  };

  const perfLine = `[blueprint-perf] ${JSON.stringify(report)} [/blueprint-perf]`;

  const slowest = [...steps]
    .filter((t) => typeof t.durationMs === "number")
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map((t) => `#${t.index} ${t.step} (${t.durationMs}ms)`);

  const summaryLine =
    `Blueprint timing: ${steps.length} step(s) in ${totalMs}ms.` +
    (slowest.length ? ` Slowest: ${slowest.join(", ")}.` : "");

  return { perfLine, summaryLine, report };
}
