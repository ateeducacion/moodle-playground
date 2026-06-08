import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeScaleItems } from "../../src/blueprint/php/helpers.js";
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

describe("normalizeScaleItems", () => {
  it("joins an array into a comma-separated string", () => {
    assert.strictEqual(
      normalizeScaleItems(["No competente aún", "Competente"]),
      "No competente aún, Competente",
    );
  });

  it("trims and drops empty items from a string", () => {
    assert.strictEqual(normalizeScaleItems("Poor, , Good ,"), "Poor, Good");
  });
});

describe("createScale / createScales steps", () => {
  it("registers both scale steps", () => {
    assert.strictEqual(typeof getStepHandler("createScale"), "function");
    assert.strictEqual(typeof getStepHandler("createScales"), "function");
  });

  it("createScale throws without name or items", async () => {
    const handler = getStepHandler("createScale");
    await assert.rejects(
      () => handler({ items: ["a", "b"] }, { php: {} }),
      /name/,
    );
    await assert.rejects(() => handler({ name: "S" }, { php: {} }), /items/);
  });

  it("createScale generates grade_scale insert with comma-joined items", async () => {
    const handler = getStepHandler("createScale");
    const { php, calls } = createPhpMock();
    await handler(
      { name: "Competencia", items: ["No competente aún", "Competente"] },
      { php },
    );
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("grade_scale"));
    assert.ok(calls[0].includes("$items = 'No competente aún, Competente'"));
    // No course -> site-wide scale.
    assert.ok(calls[0].includes("$courseid = 0"));
  });

  it("createScale scopes to a course when 'course' is given", async () => {
    const handler = getStepHandler("createScale");
    const { php, calls } = createPhpMock();
    await handler({ name: "S", items: "a,b", course: "CHEM101" }, { php });
    assert.ok(calls[0].includes("'shortname' => 'CHEM101'"));
  });

  it("createScales accepts the moodle-scale-export envelope from a @resource", async () => {
    const handler = getStepHandler("createScales");
    const { php, calls } = createPhpMock();
    const envelope = JSON.stringify({
      format: "moodle-scale-export",
      format_version: 1,
      scales: [
        { name: "Escala 1", items: "Bajo, Alto" },
        { name: "Escala 2", items: "Uno, Dos, Tres" },
      ],
    });
    await handler(
      { scales: "@standardScales" },
      {
        php,
        resources: createResources(envelope),
      },
    );
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("Escala 1"));
    assert.ok(calls[0].includes("Escala 2"));
  });

  it("createScales accepts a plain inline array", async () => {
    const handler = getStepHandler("createScales");
    const { php, calls } = createPhpMock();
    await handler({ scales: [{ name: "X", items: ["a", "b"] }] }, { php });
    assert.ok(calls[0].includes("$name = 'X'"));
  });
});
