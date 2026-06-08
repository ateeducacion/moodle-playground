import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

// A captured-call PHP mock that records every php.run() body.
function createPhpMock() {
  const calls = [];
  return {
    calls,
    php: {
      async run(code) {
        calls.push(code);
        return { text: '{"ok":true}', errors: "" };
      },
    },
  };
}

// A minimal ResourceRegistry stub returning a fixed text for any reference.
function createResources(text) {
  return {
    async resolveText() {
      return text;
    },
  };
}

const SAMPLE_ROLE_XML = `<?xml version="1.0"?>
<role><shortname>coordinacion</shortname><name>Coordinador</name>
<archetype>editingteacher</archetype>
<contextlevels><level>course</level></contextlevels>
<permissions><allow>moodle/course:manage</allow></permissions></role>`;

describe("createRole / createRoles steps", () => {
  it("registers all role steps", () => {
    for (const name of [
      "createRole",
      "createRoles",
      "importRolePreset",
      "importRoles",
    ]) {
      assert.strictEqual(typeof getStepHandler(name), "function", name);
    }
  });

  it("createRole throws without shortname", async () => {
    const handler = getStepHandler("createRole");
    await assert.rejects(() => handler({}, { php: {} }), /shortname/);
  });

  it("createRole generates create_role + capability + context-level PHP", async () => {
    const handler = getStepHandler("createRole");
    const { php, calls } = createPhpMock();
    await handler(
      {
        shortname: "coordinacion",
        name: "Coordinador",
        archetype: "editingteacher",
        contextlevels: ["course", "module"],
        capabilities: {
          "moodle/course:manage": "allow",
          "mod/quiz:view": "prevent",
        },
        allowAssign: ["teacher"],
      },
      { php },
    );
    assert.strictEqual(calls.length, 1);
    const code = calls[0];
    assert.ok(code.includes("create_role("), "calls create_role");
    // Context-level names resolve to numeric CONTEXT_* constants (course=50, module=70).
    assert.ok(code.includes("set_role_contextlevels($roleid, [50, 70])"));
    // allow -> CAP_ALLOW (1), prevent -> CAP_PREVENT (-1).
    assert.ok(code.includes("assign_capability('moodle/course:manage', 1,"));
    assert.ok(code.includes("assign_capability('mod/quiz:view', -1,"));
    assert.ok(code.includes("core_role_set_assign_allowed"));
  });

  it("createRoles resolves an inline array", async () => {
    const handler = getStepHandler("createRoles");
    const { php, calls } = createPhpMock();
    await handler({ roles: [{ shortname: "a" }, { shortname: "b" }] }, { php });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("$roleids['a']"));
    assert.ok(calls[0].includes("$roleids['b']"));
  });

  it("createRoles resolves a @resource reference (external JSON)", async () => {
    const handler = getStepHandler("createRoles");
    const { php, calls } = createPhpMock();
    const resources = createResources(
      JSON.stringify([{ shortname: "fromurl", name: "From URL" }]),
    );
    await handler({ roles: "@rolesJson" }, { php, resources });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("$roleids['fromurl']"));
  });

  it("createRoles rejects entries without shortname", async () => {
    const handler = getStepHandler("createRoles");
    await assert.rejects(
      () => handler({ roles: [{ name: "no shortname" }] }, { php: {} }),
      /shortname/,
    );
  });
});

describe("importRoles / importRolePreset steps", () => {
  it("importRolePreset accepts inline xml and calls core_role_preset", async () => {
    const handler = getStepHandler("importRolePreset");
    const { php, calls } = createPhpMock();
    await handler({ xml: SAMPLE_ROLE_XML }, { php });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("core_role_preset::parse_preset"));
    assert.ok(calls[0].includes("set_role_contextlevels"));
    // The XML is embedded as a single-quoted PHP literal.
    assert.ok(calls[0].includes("coordinacion"));
  });

  it("importRoles resolves a @resource XML reference", async () => {
    const handler = getStepHandler("importRoles");
    const { php, calls } = createPhpMock();
    const resources = createResources(SAMPLE_ROLE_XML);
    await handler({ roles: ["@coordinacion"] }, { php, resources });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("core_role_preset::is_valid_preset"));
    assert.ok(calls[0].includes("coordinacion"));
  });

  it("importRoles throws when roles is not an array", async () => {
    const handler = getStepHandler("importRoles");
    await assert.rejects(() => handler({ roles: "x" }, { php: {} }), /array/);
  });
});
