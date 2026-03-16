export { substituteConstants } from "./constants.js";
export { executeBlueprint } from "./executor.js";
export { parseBlueprint } from "./parser.js";
export { resolveBlueprint } from "./resolver.js";
export { ResourceRegistry } from "./resources.js";
export { validateBlueprint } from "./schema.js";
export {
  getRegisteredStepNames,
  getStepHandler,
  registerStep,
} from "./steps/index.js";
export { clearBlueprint, loadBlueprint, saveBlueprint } from "./storage.js";

/**
 * Extract install configuration from a blueprint's `installMoodle` step
 * and top-level fields, suitable for the existing CLI install runner.
 *
 * @param {object} blueprint
 * @returns {object} config overlay with admin, siteTitle, locale, timezone, landingPath
 */
export function buildInstallConfig(blueprint) {
  if (!blueprint) return {};

  // Find the installMoodle step for its options
  const installStep = blueprint.steps?.find((s) => s.step === "installMoodle");
  const options = installStep?.options || {};

  // Build the config overlay
  const result = {};

  const siteTitle = options.siteName || blueprint.siteOptions?.fullname;
  if (siteTitle) result.siteTitle = siteTitle;

  const locale = options.locale || blueprint.siteOptions?.locale;
  if (locale) result.locale = locale;

  const timezone = options.timezone || blueprint.siteOptions?.timezone;
  if (timezone) result.timezone = timezone;

  const landingPage = blueprint.landingPage;
  if (landingPage) result.landingPath = landingPage;

  // Admin credentials
  const adminUser = options.adminUser || blueprint.login?.username;
  const adminPass = options.adminPass || blueprint.login?.password;
  const adminEmail = options.adminEmail || blueprint.login?.email;

  if (adminUser || adminPass || adminEmail) {
    result.admin = {
      username: adminUser || "admin",
      password: adminPass || "password",
      email: adminEmail || "admin@example.com",
    };
  }

  return result;
}
