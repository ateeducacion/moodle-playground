import { getReloadStep, RUNTIME_STEPS } from "./checkpoint.js";
import { substituteConstants } from "./constants.js";
import { ResourceRegistry } from "./resources.js";
import { getStepHandler } from "./steps/index.js";
import { defaultNow, deriveStepStatus, sanitizeStepLabel } from "./timing.js";

const PROGRESS_START = 0.92;
const PROGRESS_END = 0.95;

/**
 * Execute a blueprint's steps sequentially.
 *
 * @param {object} blueprint - Parsed blueprint with `steps`, `constants`, `resources`.
 * @param {object} context - Runtime context.
 * @param {object} context.php - PHP runtime instance.
 * @param {Function} context.publish - Progress callback (detail, progress).
 * @param {string} context.appBaseUrl
 * @param {string} context.webRoot
 * @param {string} context.scopeId
 * @param {string} context.runtimeId
 * @param {Function} [context.now] - Monotonic clock override (ms), for testing.
 * @returns {Promise<{success: boolean, landingPage?: string, failedStep?: string, error?: string, timings?: import("./timing.js").StepTiming[]}>}
 */
export async function executeBlueprint(blueprint, context) {
  if (!blueprint?.steps?.length) {
    return { success: true, timings: [] };
  }

  const { publish = () => {} } = context;
  const now = typeof context.now === "function" ? context.now : defaultNow;

  // Substitute constants into the entire blueprint
  const constants = blueprint.constants || {};
  const resolvedBlueprint = substituteConstants(blueprint, constants);
  const steps = resolvedBlueprint.steps;

  // Build resource registry
  const resources = new ResourceRegistry(resolvedBlueprint.resources || {}, {
    appBaseUrl: context.appBaseUrl,
    php: context.php,
  });

  const stepContext = {
    ...context,
    resources,
  };

  let landingPage = resolvedBlueprint.landingPage || null;

  // Per-step timing instrumentation (issue #249). Only the sanitized label —
  // never the step payload — is recorded, so timings are safe to log.
  const t0 = now();
  /** @type {import("./timing.js").StepTiming[]} */
  const timings = [];
  // First failure encountered (reported back), while execution keeps going —
  // step failures are non-fatal by default (ADR-0005). A step with
  // `critical: true` aborts the remaining blueprint on failure.
  let firstFailure = null;
  const recordTiming = (index, stepName, label, startMs, status) => {
    const endMs = Math.round(now() - t0);
    timings.push({
      index,
      step: stepName,
      label,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      status,
    });
  };

  for (let i = 0; i < steps.length; i++) {
    let step = steps[i];
    const stepName = step.step;
    const label = sanitizeStepLabel(step);
    const startMs = Math.round(now() - t0);
    const progress =
      PROGRESS_START + (i / steps.length) * (PROGRESS_END - PROGRESS_START);

    publish(`Blueprint step ${i + 1}/${steps.length}: ${stepName}`, progress);

    const checkpoint = context.checkpoint;
    // Per runtime: each runtime has its own DB, but the scope shares /persist.
    const artifactRoot = checkpoint
      ? `/persist/blueprints/${context.runtimeId || "runtime"}/${checkpoint.fingerprint}/${i}`
      : null;
    const filesystemArtifactPath = artifactRoot && `${artifactRoot}-files`;
    if (checkpoint?.resuming) {
      const runtimeOnly = checkpoint.legacy || checkpoint.changed;
      const isRuntimeStep = RUNTIME_STEPS.has(stepName);
      step =
        runtimeOnly && !isRuntimeStep
          ? null
          : getReloadStep(
              step,
              checkpoint.completed.has(i),
              filesystemArtifactPath,
            );
      if (!runtimeOnly && !isRuntimeStep && !checkpoint.completed.has(i)) {
        firstFailure ||= {
          failedStep: `${i + 1}:${stepName}`,
          error:
            "Previously unfinished step was not replayed automatically; saved code may only be restored.",
        };
      }
      if (["runPhpCode", "runPhpScript"].includes(stepName)) {
        publish(
          `Blueprint step ${i + 1}: arbitrary PHP was not replayed; volatile file effects are not restored. Declare files with filesystem steps.`,
          progress,
        );
      }
      if (!step) {
        recordTiming(i + 1, stepName, label, startMs, "skipped");
        continue;
      }
    }

    const handler = getStepHandler(step.step);
    if (!handler) {
      recordTiming(i + 1, stepName, label, startMs, "failed");
      const error = `Unknown step type: ${stepName}`;
      publish(`Blueprint step ${stepName} skipped: ${error}`, progress);
      if (!firstFailure) {
        firstFailure = { failedStep: `${i + 1}:${stepName}`, error };
      }
      if (step.critical) {
        return { success: false, landingPage, ...firstFailure, timings };
      }
      continue;
    }

    try {
      const result = await handler(step, {
        ...stepContext,
        restoreOnly: Boolean(checkpoint?.resuming),
        previouslyCompleted: Boolean(
          checkpoint?.resuming && checkpoint.completed.has(i),
        ),
        filesystemArtifactPath,
        pluginArchivePath: artifactRoot && `${artifactRoot}.zip`,
        overlayArchivePath: artifactRoot && `${artifactRoot}-overlay.json`,
      });
      // setLandingPage step can override the landing page
      if (stepName === "setLandingPage" && step.path) {
        landingPage = step.path;
      }
      // Capture landingPage from result if returned
      if (result?.landingPage) {
        landingPage = result.landingPage;
      }
      recordTiming(
        i + 1,
        stepName,
        label,
        startMs,
        deriveStepStatus({ result }),
      );
    } catch (error) {
      recordTiming(i + 1, stepName, label, startMs, "failed");
      const message = error?.message || String(error);
      publish(`Blueprint step ${stepName} failed: ${message}`, progress);
      if (!firstFailure) {
        firstFailure = { failedStep: `${i + 1}:${stepName}`, error: message };
      }
      // Non-fatal by default (ADR-0005): keep provisioning the remaining steps
      // so one transient failure (e.g. a resource download) does not discard
      // the whole playground. `critical: true` opts a step into aborting —
      // except on reload, where nothing mutates and login/landing must still run.
      if (step.critical && !checkpoint?.resuming) {
        return { success: false, landingPage, ...firstFailure, timings };
      }
      continue;
    }
    // Checkpoint failures must abort, not be treated as an optional step error.
    if (checkpoint && !checkpoint.resuming) await checkpoint.save(i);
  }

  return {
    success: !firstFailure,
    landingPage,
    ...(firstFailure || {}),
    timings,
  };
}
