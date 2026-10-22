import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { executeBlueprint } from "../../src/blueprint/executor.js";
import { registerStep } from "../../src/blueprint/steps/index.js";
import { MOODLE_BRANCHES } from "../../src/shared/version-resolver.js";

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

  describe("{{MOODLE_DIRROOT}} (#394)", () => {
    const editorZip = Buffer.from(
      zipSync({ "index.html": strToU8("<html></html>") }),
    ).toString("base64");
    const unzipInto = async (webRoot, constants, checkpoint) => {
      const files = new Map();
      const result = await executeBlueprint(
        {
          constants,
          resources: { editorArchive: { base64: editorZip } },
          steps: [
            {
              step: "unzip",
              destination: "{{MOODLE_DIRROOT}}/mod/exescorm/dist",
              data: "@editorArchive",
            },
          ],
        },
        {
          php: {
            _php: {
              mkdirTree: () => {},
              writeFile: (path, data) => files.set(path, data),
            },
          },
          webRoot,
          checkpoint,
        },
      );
      assert.equal(result.success, true, result.error);
      return [...files.keys()];
    };

    for (const { version, webRoot } of MOODLE_BRANCHES) {
      // Moodle 5.1 moved the web-served code under public/; dev tracks main.
      const expected =
        version === "dev" || Number(version) >= 5.1
          ? "/www/moodle/public"
          : "/www/moodle";
      it(`resolves to ${expected} on Moodle ${version}`, async () => {
        assert.equal(webRoot, expected);
        assert.deepEqual(await unzipInto(webRoot), [
          `${expected}/mod/exescorm/dist/index.html`,
        ]);
      });
    }

    it("cannot be shadowed by a blueprint constant", async () => {
      assert.deepEqual(
        await unzipInto("/www/moodle/public", { MOODLE_DIRROOT: "/tmp" }),
        ["/www/moodle/public/mod/exescorm/dist/index.html"],
      );
    });

    it("replays into the resolved directory on a checkpoint reload", async () => {
      const checkpoint = {
        fingerprint: "fixture",
        resuming: true,
        completed: new Set([0]),
        save: () => {},
      };
      assert.deepEqual(
        await unzipInto("/www/moodle/public", undefined, checkpoint),
        ["/www/moodle/public/mod/exescorm/dist/index.html"],
      );
    });

    it("resolves inside nested values next to blueprint constants", async () => {
      const seen = [];
      registerStep("__test_capture_step", async (step) => {
        seen.push(step.options);
      });
      const result = await executeBlueprint(
        {
          constants: { PLUGIN: "exescorm" },
          steps: [
            {
              step: "__test_capture_step",
              options: { paths: ["{{MOODLE_DIRROOT}}/mod/{{PLUGIN}}"] },
            },
          ],
        },
        { webRoot: "/www/moodle" },
      );
      assert.equal(result.success, true);
      assert.deepEqual(seen, [{ paths: ["/www/moodle/mod/exescorm"] }]);
    });
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

  // ---------------------------------------------------------------------------
  // Resilient execution: non-fatal by default, `critical` opt-in (ADR-0005)
  // ---------------------------------------------------------------------------

  it("continues after a non-critical step failure and runs later steps", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [
          { step: "installMoodle" },
          { step: "createUser" }, // missing username -> throws (non-critical)
          { step: "setLandingPage", path: "/after/" },
        ],
      },
      { php, publish: () => {} },
    );

    // The blueprint reports the failure but did NOT abort: the later step ran.
    assert.strictEqual(result.success, false);
    assert.ok(result.failedStep.includes("createUser"));
    assert.strictEqual(result.landingPage, "/after/");
    assert.strictEqual(result.timings.length, 3);
    assert.strictEqual(result.timings[1].status, "failed");
    assert.strictEqual(result.timings[2].status, "success");
  });

  it("halts on a step marked critical", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [
          { step: "installMoodle" },
          { step: "createUser", critical: true }, // throws + critical -> halt
          { step: "setLandingPage", path: "/after/" },
        ],
      },
      { php, publish: () => {} },
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.failedStep.includes("createUser"));
    // The later step did NOT run.
    assert.strictEqual(result.landingPage, null);
    assert.strictEqual(result.timings.length, 2);
  });

  it("continues past an unknown step type (non-fatal) and runs later steps", async () => {
    const php = createMockPhp();
    const result = await executeBlueprint(
      {
        steps: [
          { step: "nonExistentStep" },
          { step: "setLandingPage", path: "/after/" },
        ],
      },
      { php, publish: () => {} },
    );
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes("Unknown step type"));
    assert.strictEqual(result.landingPage, "/after/");
    assert.strictEqual(result.timings.length, 2);
    assert.strictEqual(result.timings[0].status, "failed");
  });
});
