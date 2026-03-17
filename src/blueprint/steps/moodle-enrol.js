import { phpEnrolUser, phpEnrolUsers } from "../php/helpers.js";

export function registerMoodleEnrolSteps(register) {
  register("enrolUser", handleEnrolUser);
  register("enrolUsers", handleEnrolUsers);
}

async function handleEnrolUser(step, { php }) {
  if (!step.username || !step.course) {
    throw new Error("enrolUser: 'username' and 'course' are required.");
  }
  const code = phpEnrolUser(step);
  const result = await php.run(code);
  checkPhpResult(result, "enrolUser");
}

async function handleEnrolUsers(step, { php }) {
  if (!Array.isArray(step.enrolments))
    throw new Error("enrolUsers: 'enrolments' must be an array.");
  const code = phpEnrolUsers(step.enrolments);
  const result = await php.run(code);
  checkPhpResult(result, "enrolUsers");
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
