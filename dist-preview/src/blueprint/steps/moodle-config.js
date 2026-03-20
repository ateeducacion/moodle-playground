import { phpSetConfig, phpSetConfigs } from "../php/helpers.js";

export function registerMoodleConfigSteps(register) {
  register("setConfig", handleSetConfig);
  register("setConfigs", handleSetConfigs);
  register("setLandingPage", handleSetLandingPage);
}

async function handleSetConfig(step, { php }) {
  if (!step.name) throw new Error("setConfig: 'name' is required.");
  const code = phpSetConfig(step.name, step.value ?? "", step.plugin || null);
  await php.run(code);
}

async function handleSetConfigs(step, { php }) {
  if (!Array.isArray(step.configs))
    throw new Error("setConfigs: 'configs' must be an array.");
  const code = phpSetConfigs(step.configs);
  await php.run(code);
}

async function handleSetLandingPage(step, _context) {
  // The landing page is captured by the executor from step.path.
  // No PHP execution needed.
  if (!step.path) throw new Error("setLandingPage: 'path' is required.");
  return { landingPage: step.path };
}
