import { phpCreateCategories, phpCreateCategory } from "../php/helpers.js";
import { checkPhpResult } from "./check-result.js";

export function registerMoodleCategorySteps(register) {
  register("createCategory", handleCreateCategory);
  register("createCategories", handleCreateCategories);
}

async function handleCreateCategory(step, { php }) {
  if (!step.name) throw new Error("createCategory: 'name' is required.");
  const code = phpCreateCategory(step);
  const result = await php.run(code);
  checkPhpResult(result, "createCategory");
}

async function handleCreateCategories(step, { php }) {
  if (!Array.isArray(step.categories))
    throw new Error("createCategories: 'categories' must be an array.");
  const code = phpCreateCategories(step.categories);
  const result = await php.run(code);
  checkPhpResult(result, "createCategories");
}
