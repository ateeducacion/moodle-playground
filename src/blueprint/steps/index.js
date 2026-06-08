import { registerFilesystemSteps } from "./filesystem.js";
import { registerMoodleCategorySteps } from "./moodle-categories.js";
import { registerMoodleCohortSteps } from "./moodle-cohorts.js";
import { registerMoodleConfigSteps } from "./moodle-config.js";
import { registerMoodleCourseSteps } from "./moodle-courses.js";
import { registerMoodleEnrolSteps } from "./moodle-enrol.js";
import { registerMoodleInstallSteps } from "./moodle-install.js";
import { registerMoodleLanguageSteps } from "./moodle-language.js";
import { registerMoodleModuleSteps } from "./moodle-modules.js";
import { registerMoodlePluginSteps } from "./moodle-plugins.js";
import { registerMoodleRestoreSteps } from "./moodle-restore.js";
import { registerMoodleRoleSteps } from "./moodle-roles.js";
import { registerMoodleScaleSteps } from "./moodle-scales.js";
import { registerMoodleUserSteps } from "./moodle-users.js";
import { registerRequestSteps } from "./request.js";

/** @type {Map<string, (step: object, context: object) => Promise<void>>} */
const STEP_REGISTRY = new Map();

export function registerStep(name, handler) {
  STEP_REGISTRY.set(name, handler);
}

export function getStepHandler(name) {
  return STEP_REGISTRY.get(name) || null;
}

export function getRegisteredStepNames() {
  return [...STEP_REGISTRY.keys()];
}

// Register all built-in steps
registerFilesystemSteps(registerStep);
registerRequestSteps(registerStep);
registerMoodleInstallSteps(registerStep);
registerMoodleConfigSteps(registerStep);
registerMoodleUserSteps(registerStep);
registerMoodleCategorySteps(registerStep);
registerMoodleCourseSteps(registerStep);
registerMoodleEnrolSteps(registerStep);
registerMoodleModuleSteps(registerStep);
registerMoodleLanguageSteps(registerStep);
registerMoodleRestoreSteps(registerStep);
registerMoodlePluginSteps(registerStep);
registerMoodleRoleSteps(registerStep);
registerMoodleScaleSteps(registerStep);
registerMoodleCohortSteps(registerStep);
