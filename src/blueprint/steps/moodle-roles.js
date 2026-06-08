/**
 * Role step handlers.
 *
 * Two complementary ways to define roles:
 *  - `importRoles` / `importRolePreset` — import native Moodle role preset XML
 *    (the export from Site admin > Users > Permissions > Define roles), inline
 *    or by URL/@resource. Reuses Moodle core's own parser (core_role_preset).
 *  - `createRole` / `createRoles` — JSON-native role definition, inline or by
 *    URL/@resource. Capabilities as an {capability: allow|prevent|prohibit|
 *    inherit} map, context levels by name or number, allow* relationships by
 *    role shortname.
 */
import { phpCreateRoles, phpImportRolePresets } from "../php/helpers.js";
import { checkPhpResult } from "./check-result.js";
import { resolveJsonPayload, resolveXmlItem, toEntryArray } from "./payload.js";

export function registerMoodleRoleSteps(register) {
  register("createRole", handleCreateRole);
  register("createRoles", handleCreateRoles);
  register("importRolePreset", handleImportRolePreset);
  register("importRoles", handleImportRoles);
}

async function handleCreateRole(step, { php }) {
  if (!step.shortname) throw new Error("createRole: 'shortname' is required.");
  await runCreateRoles([step], php);
}

async function handleCreateRoles(step, { php, resources }) {
  const data = await resolveJsonPayload(step.roles, resources, "createRoles");
  const roles = toEntryArray(data, "roles");
  if (roles.length === 0) {
    throw new Error("createRoles: 'roles' must resolve to a non-empty array.");
  }
  for (const r of roles) {
    if (!r || !r.shortname) {
      throw new Error("createRoles: each role requires a 'shortname'.");
    }
  }
  await runCreateRoles(roles, php);
}

async function handleImportRolePreset(step, { php, resources }) {
  const xml = await resolveXmlItem(
    step.xml !== undefined ? { xml: step.xml } : step.resource,
    resources,
    "importRolePreset",
  );
  await runImportRoles([xml], php);
}

async function handleImportRoles(step, { php, resources }) {
  if (!Array.isArray(step.roles)) {
    throw new Error("importRoles: 'roles' must be an array.");
  }
  if (step.roles.length === 0) {
    throw new Error("importRoles: 'roles' must not be empty.");
  }
  const xmls = [];
  for (const item of step.roles) {
    xmls.push(await resolveXmlItem(item, resources, "importRoles"));
  }
  await runImportRoles(xmls, php);
}

async function runCreateRoles(roles, php) {
  const result = await php.run(phpCreateRoles(roles));
  checkPhpResult(result, "createRoles");
}

async function runImportRoles(xmls, php) {
  const result = await php.run(phpImportRolePresets(xmls));
  checkPhpResult(result, "importRoles");
}
