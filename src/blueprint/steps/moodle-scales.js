/**
 * Scale step handlers: createScale, createScales.
 *
 * Scales can be defined inline in the blueprint or referenced from an external
 * JSON (URL / @resource / inline descriptor). `createScales` also accepts the
 * `{ "format": "moodle-scale-export", "scales": [...] }` export envelope so a
 * Moodle scale export drops straight in. `items` accepts an array or a
 * comma-separated string; omitting `course` creates a site-wide scale.
 */
import { phpCreateScales } from "../php/helpers.js";
import { checkPhpResult } from "./check-result.js";
import { resolveJsonPayload, toEntryArray } from "./payload.js";

export function registerMoodleScaleSteps(register) {
  register("createScale", handleCreateScale);
  register("createScales", handleCreateScales);
}

async function handleCreateScale(step, { php }) {
  if (!step.name) throw new Error("createScale: 'name' is required.");
  if (!step.items) throw new Error("createScale: 'items' is required.");
  await runCreateScales([step], php);
}

async function handleCreateScales(step, { php, resources }) {
  const data = await resolveJsonPayload(step.scales, resources, "createScales");
  const scales = toEntryArray(data, "scales");
  if (scales.length === 0) {
    throw new Error(
      "createScales: 'scales' must resolve to a non-empty array.",
    );
  }
  for (const s of scales) {
    if (!s || !s.name)
      throw new Error("createScales: each scale requires a 'name'.");
    if (!s.items)
      throw new Error(`createScales: scale '${s.name}' requires 'items'.`);
  }
  await runCreateScales(scales, php);
}

async function runCreateScales(scales, php) {
  const result = await php.run(phpCreateScales(scales));
  checkPhpResult(result, "createScales");
}
