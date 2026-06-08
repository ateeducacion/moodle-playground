import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

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

function createResources(text) {
  return {
    async resolveText() {
      return text;
    },
  };
}

describe("createCohort / createCohorts steps", () => {
  it("registers both cohort steps", () => {
    assert.strictEqual(typeof getStepHandler("createCohort"), "function");
    assert.strictEqual(typeof getStepHandler("createCohorts"), "function");
  });

  it("createCohort throws without name", async () => {
    const handler = getStepHandler("createCohort");
    await assert.rejects(() => handler({}, { php: {} }), /name/);
  });

  it("createCohort generates cohort_add_cohort + member adds", async () => {
    const handler = getStepHandler("createCohort");
    const { php, calls } = createPhpMock();
    await handler(
      {
        name: "Profesorado 2026",
        idnumber: "staff2026",
        members: ["alice", "bob"],
      },
      { php },
    );
    assert.strictEqual(calls.length, 1);
    const code = calls[0];
    assert.ok(code.includes("cohort_add_cohort"));
    assert.ok(code.includes("'idnumber' => 'staff2026'"));
    assert.ok(code.includes("cohort_add_member"));
    assert.ok(code.includes("'username' => 'alice'"));
  });

  it("createCohorts resolves a @resource reference (external JSON)", async () => {
    const handler = getStepHandler("createCohorts");
    const { php, calls } = createPhpMock();
    const resources = createResources(
      JSON.stringify([{ name: "C1" }, { name: "C2", idnumber: "c2" }]),
    );
    await handler({ cohorts: "@cohortsJson" }, { php, resources });
    assert.strictEqual(calls.length, 1);
    assert.ok(
      calls[0].includes("'name' => 'C1'") || calls[0].includes("$name = "),
    );
    assert.ok(calls[0].includes("C2"));
  });

  it("createCohorts rejects entries without name", async () => {
    const handler = getStepHandler("createCohorts");
    await assert.rejects(
      () => handler({ cohorts: [{ idnumber: "x" }] }, { php: {} }),
      /name/,
    );
  });
});
