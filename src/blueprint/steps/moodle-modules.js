import { phpAddModule } from "../php/helpers.js";

export function registerMoodleModuleSteps(register) {
  register("addModule", handleAddModule);
}

async function handleAddModule(step, { php, publish }) {
  if (!step.module) throw new Error("addModule: 'module' type is required.");
  if (!step.course)
    throw new Error("addModule: 'course' shortname is required.");
  const code = phpAddModule(step);
  let result;
  try {
    result = await php.run(code);
  } catch (err) {
    // php.run() throws on non-zero exit code. Check stdout for success.
    const stdout = err.message
      ?.match(/=== Stdout ===\s*([\s\S]*?)(?:=== Stderr|$)/)?.[1]
      ?.trim();
    if (stdout?.includes('"ok":true')) {
      return;
    }
    const detail = `addModule ${step.module} failed: ${String(err.message || err).slice(0, 150)}`;
    if (publish) publish(detail, 0.95);
    throw new Error(detail);
  }
  const text = result?.text || "";
  const errors = result?.errors || "";
  if (errors && publish) {
    publish(
      `addModule ${step.module} PHP errors: ${errors.slice(0, 200)}`,
      0.95,
    );
  }
  if (text?.includes('"ok":false')) {
    const detail = `addModule ${step.module} failed: ${text.slice(0, 200)}`;
    if (publish) publish(detail, 0.95);
    throw new Error(detail);
  }
}
