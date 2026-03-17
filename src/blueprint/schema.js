const KNOWN_STEP_NAMES = new Set([
  "installMoodle",
  "setAdminAccount",
  "login",
  "setConfig",
  "setConfigs",
  "setLandingPage",
  "createUser",
  "createUsers",
  "createCategory",
  "createCategories",
  "createCourse",
  "createCourses",
  "createSection",
  "createSections",
  "enrolUser",
  "enrolUsers",
  "addModule",
  "installMoodlePlugin",
  "installTheme",
  "mkdir",
  "rmdir",
  "writeFile",
  "writeFiles",
  "copyFile",
  "moveFile",
  "unzip",
  "request",
  "runPhpCode",
  "runPhpScript",
]);

const RESOURCE_TYPE_KEYS = new Set([
  "url",
  "base64",
  "data-url",
  "bundled",
  "vfs",
  "literal",
]);

/**
 * Validate a blueprint object. Returns {valid, errors}.
 *
 * @param {*} bp
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateBlueprint(bp) {
  const errors = [];

  if (!bp || typeof bp !== "object" || Array.isArray(bp)) {
    errors.push("Blueprint must be a non-null object.");
    return { valid: false, errors };
  }

  // steps — required, must be an array
  if (!Array.isArray(bp.steps)) {
    errors.push("'steps' must be an array.");
  } else {
    for (let i = 0; i < bp.steps.length; i++) {
      const step = bp.steps[i];
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        errors.push(`steps[${i}]: must be an object.`);
        continue;
      }
      if (typeof step.step !== "string" || !step.step) {
        errors.push(`steps[${i}]: missing or invalid 'step' name.`);
        continue;
      }
      if (!KNOWN_STEP_NAMES.has(step.step)) {
        errors.push(`steps[${i}]: unknown step '${step.step}'.`);
      }
    }
  }

  // preferredVersions
  if (bp.preferredVersions !== undefined) {
    if (
      typeof bp.preferredVersions !== "object" ||
      bp.preferredVersions === null ||
      Array.isArray(bp.preferredVersions)
    ) {
      errors.push("'preferredVersions' must be an object if present.");
    }
  }

  // constants
  if (bp.constants !== undefined) {
    if (
      typeof bp.constants !== "object" ||
      bp.constants === null ||
      Array.isArray(bp.constants)
    ) {
      errors.push("'constants' must be an object if present.");
    }
  }

  // resources
  if (bp.resources !== undefined) {
    if (
      typeof bp.resources !== "object" ||
      bp.resources === null ||
      Array.isArray(bp.resources)
    ) {
      errors.push("'resources' must be an object if present.");
    } else {
      for (const [name, desc] of Object.entries(bp.resources)) {
        if (!desc || typeof desc !== "object" || Array.isArray(desc)) {
          errors.push(`resources['${name}']: must be an object.`);
          continue;
        }
        const typeKeys = Object.keys(desc).filter((k) =>
          RESOURCE_TYPE_KEYS.has(k),
        );
        if (typeKeys.length === 0) {
          errors.push(
            `resources['${name}']: missing resource type key (${[...RESOURCE_TYPE_KEYS].join(", ")}).`,
          );
        } else if (typeKeys.length > 1) {
          errors.push(
            `resources['${name}']: must have exactly one type key, found: ${typeKeys.join(", ")}.`,
          );
        }
      }
    }
  }

  // runtime
  if (bp.runtime !== undefined) {
    if (
      typeof bp.runtime !== "object" ||
      bp.runtime === null ||
      Array.isArray(bp.runtime)
    ) {
      errors.push("'runtime' must be an object if present.");
    }
  }

  // landingPage
  if (bp.landingPage !== undefined) {
    if (typeof bp.landingPage !== "string") {
      errors.push("'landingPage' must be a string if present.");
    } else if (!bp.landingPage.startsWith("/")) {
      errors.push("'landingPage' must start with '/'.");
    }
  }

  return { valid: errors.length === 0, errors };
}
