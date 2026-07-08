import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeBlueprint } from "../../src/blueprint/executor.js";
import { registerStep } from "../../src/blueprint/steps/index.js";

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

  // ---------------------------------------------------------------------------
  // Per-step timing instrumentation (issue #249)
  // ---------------------------------------------------------------------------

  it("records a per-step timing entry for every executed step", async () => {
    const php = createMockPhp();
    // Controlled monotonic clock: t0, then (start, end) per step.
    const ticks = [0, 0, 10, 10, 35];
    let i = 0;
    const now = () => ticks[Math.min(i++, ticks.length - 1)];

    const result = await executeBlueprint(
      {
        steps: [
          { step: "installMoodle" },
          { step: "setLandingPage", path: "/x" },
        ],
      },
      { php, publish: () => {}, now, webRoot: "/www/moodle" },
    );

    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.timings));
    assert.strictEqual(result.timings.length, 2);

    const [a, b] = result.timings;
    assert.strictEqual(a.index, 1);
    assert.strictEqual(a.step, "installMoodle");
    assert.strictEqual(a.status, "success");
    assert.strictEqual(a.startMs, 0);
    assert.strictEqual(a.endMs, 10);
    assert.strictEqual(a.durationMs, 10);

    assert.strictEqual(b.index, 2);
    assert.strictEqual(b.step, "setLandingPage");
    assert.strictEqual(b.durationMs, 25);
  });

  it("times a failed step, marks it failed, and still returns partial timings", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [{ step: "installMoodle" }, { step: "createUser" }], // missing username -> throws
      },
      { php, publish: () => {} },
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.failedStep.includes("createUser"));
    assert.ok(Array.isArray(result.timings));
    assert.strictEqual(result.timings.length, 2);

    const failed = result.timings[1];
    assert.strictEqual(failed.step, "createUser");
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(typeof failed.durationMs, "number");
    assert.ok(failed.durationMs >= 0);
  });

  it("records a timing entry for an unknown step", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      { steps: [{ step: "installMoodle" }, { step: "nonExistentStep" }] },
      { php, publish: () => {} },
    );
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.timings.length, 2);
    assert.strictEqual(result.timings[1].step, "nonExistentStep");
    assert.strictEqual(result.timings[1].status, "failed");
  });

  it("marks a step whose handler returns { skipped: true }", async () => {
    registerStep("__test_skipped_step", async () => ({ skipped: true }));
    const php = createMockPhp();
    const result = await executeBlueprint(
      { steps: [{ step: "__test_skipped_step" }] },
      { php, publish: () => {} },
    );
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.timings.length, 1);
    assert.strictEqual(result.timings[0].status, "skipped");
  });

  it("never leaks step passwords into the timing output", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [
          {
            step: "createUser",
            username: "student1",
            password: "S3cr3t-Password!",
            email: "s@example.com",
            firstname: "A",
            lastname: "B",
            comment: "make a student",
          },
        ],
      },
      { php, publish: () => {} },
    );

    const serialized = JSON.stringify(result.timings);
    assert.ok(!serialized.includes("S3cr3t-Password!"));
    assert.strictEqual(result.timings[0].label, "make a student");
    assert.strictEqual(result.timings[0].status, "success");
  });
});
