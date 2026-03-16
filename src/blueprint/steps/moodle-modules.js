import { phpAddModule } from "../php/helpers.js";

export function registerMoodleModuleSteps(register) {
  register("addModule", handleAddModule);
}

async function handleAddModule(step, { php }) {
  if (!step.module) throw new Error("addModule: 'module' type is required.");
  if (!step.course)
    throw new Error("addModule: 'course' shortname is required.");
  const code = phpAddModule(step);
  const result = await php.run(code);
  checkPhpResult(result, "addModule");
}

function checkPhpResult(result, stepName) {
  const text = result?.text || "";
  const errors = result?.errors || "";
  if (errors) {
    console.warn(`[blueprint] ${stepName} PHP errors:`, errors);
  }
  if (text?.includes('"ok":false')) {
    throw new Error(
      `${stepName}: PHP returned failure: ${text.substring(0, 500)}`,
    );
  }
}
