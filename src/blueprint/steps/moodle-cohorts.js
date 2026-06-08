/**
 * Cohort step handlers: createCohort, createCohorts.
 *
 * Site-level cohorts, defined inline or referenced from an external JSON
 * (URL / @resource / inline descriptor). Idempotent on idnumber (or name).
 * Optional `members` is a list of usernames added to the cohort.
 */
import { phpCreateCohorts } from "../php/helpers.js";
import { checkPhpResult } from "./check-result.js";
import { resolveJsonPayload, toEntryArray } from "./payload.js";

export function registerMoodleCohortSteps(register) {
  register("createCohort", handleCreateCohort);
  register("createCohorts", handleCreateCohorts);
}

async function handleCreateCohort(step, { php }) {
  if (!step.name) throw new Error("createCohort: 'name' is required.");
  await runCreateCohorts([step], php);
}

async function handleCreateCohorts(step, { php, resources }) {
  const data = await resolveJsonPayload(
    step.cohorts,
    resources,
    "createCohorts",
  );
  const cohorts = toEntryArray(data, "cohorts");
  if (cohorts.length === 0) {
    throw new Error(
      "createCohorts: 'cohorts' must resolve to a non-empty array.",
    );
  }
  for (const c of cohorts) {
    if (!c || !c.name)
      throw new Error("createCohorts: each cohort requires a 'name'.");
  }
  await runCreateCohorts(cohorts, php);
}

async function runCreateCohorts(cohorts, php) {
  const result = await php.run(phpCreateCohorts(cohorts));
  checkPhpResult(result, "createCohorts");
}
