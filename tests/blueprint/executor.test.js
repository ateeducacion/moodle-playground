import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeBlueprint } from "../../src/blueprint/executor.js";

// Minimal mock PHP runtime
function createMockPhp() {
  const calls = [];
  return {
    calls,
    run(code) {
      calls.push({ type: "run", code });
      return { text: '{"ok":true}', errors: "" };
    },
    writeFile(path, _data) {
      calls.push({ type: "writeFile", path });
    },
    readFile(path) {
      calls.push({ type: "readFile", path });
      return new Uint8Array();
    },
    request(req) {
      calls.push({ type: "request", url: req.url });
      return {
        status: 200,
        text() {
          return '{"ok":true}';
        },
        headers: new Headers(),
      };
    },
  };
}

describe("executeBlueprint", () => {
  it("returns success for empty steps", async () => {
    const result = await executeBlueprint({ steps: [] }, {});
    assert.strictEqual(result.success, true);
  });

  it("returns success for null blueprint", async () => {
    const result = await executeBlueprint(null, {});
    assert.strictEqual(result.success, true);
  });

  it("executes steps in order", async () => {
    const progressCalls = [];
    const php = createMockPhp();

    const result = await executeBlueprint(
      {
        steps: [
          { step: "installMoodle" },
          { step: "setLandingPage", path: "/course/" },
        ],
      },
      {
        php,
        publish: (detail, progress) => progressCalls.push({ detail, progress }),
        webRoot: "/www/moodle",
      },
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.landingPage, "/course/");
    assert.strictEqual(progressCalls.length, 2);
  });

  it("stops on unknown step", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [{ step: "nonExistentStep" }],
      },
      { php, publish: () => {} },
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes("Unknown step type"));
  });

  it("substitutes constants before execution", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        constants: { PAGE: "/my/" },
        steps: [{ step: "setLandingPage", path: "{{PAGE}}" }],
      },
      { php, publish: () => {} },
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.landingPage, "/my/");
  });

  it("reports failed step index and name", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [
          { step: "installMoodle" },
          { step: "createUser" }, // missing username
        ],
      },
      { php, publish: () => {} },
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.failedStep.includes("createUser"));
  });
});
