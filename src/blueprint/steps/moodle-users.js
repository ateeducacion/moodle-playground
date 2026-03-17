import { phpCreateUser, phpCreateUsers } from "../php/helpers.js";

export function registerMoodleUserSteps(register) {
  register("createUser", handleCreateUser);
  register("createUsers", handleCreateUsers);
}

async function handleCreateUser(step, { php }) {
  if (!step.username) throw new Error("createUser: 'username' is required.");
  const code = phpCreateUser(step);
  const result = await php.run(code);
  checkPhpResult(result, "createUser");
}

async function handleCreateUsers(step, { php }) {
  if (!Array.isArray(step.users))
    throw new Error("createUsers: 'users' must be an array.");
  const code = phpCreateUsers(step.users);
  const result = await php.run(code);
  checkPhpResult(result, "createUsers");
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
