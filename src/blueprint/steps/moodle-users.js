import { phpCreateUser, phpCreateUsers } from "../php/helpers.js";
import { checkPhpResult } from "./check-result.js";

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
