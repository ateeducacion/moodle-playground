import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPrApiUrl,
  normalizeOverlayManifest,
} from "../../src/blueprint/pr-overlay.js";
import { validateBlueprint } from "../../src/blueprint/schema.js";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

const php = {
  run: async () => assert.fail("validation must fail before running PHP"),
};

describe("bulk step validation", () => {
  for (const [name, key, error] of [
    ["createRoles", "roles", /'roles' must resolve to a non-empty array/],
    ["createScales", "scales", /'scales' must resolve to a non-empty array/],
    ["createCohorts", "cohorts", /'cohorts' must resolve to a non-empty array/],
  ]) {
    it(`${name} rejects an empty or envelope-less payload`, async () => {
      await assert.rejects(getStepHandler(name)({ [key]: [] }, { php }), error);
      await assert.rejects(
        getStepHandler(name)({ [key]: { other: [1] } }, { php }),
        error,
      );
    });
  }

  it("importRoles rejects an empty list", async () => {
    await assert.rejects(
      getStepHandler("importRoles")({ roles: [] }, { php }),
      /'roles' must not be empty/,
    );
  });
});

describe("validateBlueprint shape errors", () => {
  it("reports non-object steps and invalid runtime/landingPage values", () => {
    const { valid, errors } = validateBlueprint({
      steps: [null, ["x"]],
      runtime: [],
      landingPage: 5,
    });
    assert.equal(valid, false);
    assert.deepEqual(errors, [
      "steps[0]: must be an object.",
      "steps[1]: must be an object.",
      "'runtime' must be an object if present.",
      "'landingPage' must be a string if present.",
    ]);
    assert.deepEqual(
      validateBlueprint({ steps: [], landingPage: "my/" }).errors,
      ["'landingPage' must start with '/'."],
    );
    assert.equal(
      validateBlueprint({ steps: [], runtime: {}, landingPage: "/" }).valid,
      true,
    );
  });
});

describe("pr-overlay input validation", () => {
  it("rejects non-object manifest entries and non-positive PR numbers", () => {
    assert.throws(
      () => normalizeOverlayManifest([null]),
      /files\[0\] must be an object/,
    );
    assert.throws(
      () => normalizeOverlayManifest([[]]),
      /files\[0\] must be an object/,
    );
    assert.throws(() => buildPrApiUrl("o/r", 0), /invalid pr '0'/);
    assert.throws(() => buildPrApiUrl("o/r", "x"), /invalid pr 'x'/);
  });
});
