import { substituteConstants } from "./constants.js";
import { ResourceRegistry } from "./resources.js";
import { getStepHandler } from "./steps/index.js";

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
 * @returns {Promise<{success: boolean, landingPage?: string, failedStep?: string, error?: string}>}
 */
export async function executeBlueprint(blueprint, context) {
  if (!blueprint?.steps?.length) {
    return { success: true };
  }

  const { publish = () => {} } = context;

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

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepName = step.step;
    const progress =
      PROGRESS_START + (i / steps.length) * (PROGRESS_END - PROGRESS_START);

    publish(`Blueprint step ${i + 1}/${steps.length}: ${stepName}`, progress);

    const handler = getStepHandler(stepName);
    if (!handler) {
      return {
        success: false,
        failedStep: `${i + 1}:${stepName}`,
        error: `Unknown step type: ${stepName}`,
      };
    }

    try {
      const result = await handler(step, stepContext);
      // setLandingPage step can override the landing page
      if (stepName === "setLandingPage" && step.path) {
        landingPage = step.path;
      }
      // Capture landingPage from result if returned
      if (result?.landingPage) {
        landingPage = result.landingPage;
      }
    } catch (error) {
      const message = error?.message || String(error);
      publish(`Blueprint step ${stepName} failed: ${message}`, progress);
      return {
        success: false,
        failedStep: `${i + 1}:${stepName}`,
        error: message,
      };
    }
  }

  return {
    success: true,
    landingPage,
  };
}
