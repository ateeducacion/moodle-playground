import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveStepStatus,
  formatBlueprintTimings,
  sanitizeStepLabel,
} from "../../src/blueprint/timing.js";

describe("sanitizeStepLabel", () => {
  it("uses the step comment when present", () => {
    assert.strictEqual(
      sanitizeStepLabel({ step: "runPhpCode", comment: "Fix front page" }),
      "Fix front page",
    );
  });

  it("falls back to the label field", () => {
    assert.strictEqual(
      sanitizeStepLabel({ step: "createCourse", label: "Demo course" }),
      "Demo course",
    );
  });

  it("returns an empty string when there is no description", () => {
    assert.strictEqual(sanitizeStepLabel({ step: "createUser" }), "");
    assert.strictEqual(sanitizeStepLabel(null), "");
  });

  it("never reads secret-bearing payload fields", () => {
    const label = sanitizeStepLabel({
      step: "createUser",
      username: "student1",
      password: "S3cr3t-Password!",
      token: "abc123token",
    });
    assert.ok(!label.includes("S3cr3t-Password!"));
    assert.ok(!label.includes("abc123token"));
    assert.ok(!label.includes("student1"));
    assert.strictEqual(label, "");
  });

  it("collapses whitespace and truncates long labels", () => {
    const long = `Import   the\n\tAdaptable ${"x".repeat(120)}`;
    const label = sanitizeStepLabel({ step: "runPhpCode", comment: long });
    assert.ok(label.length <= 80);
    assert.ok(!label.includes("\n"));
    assert.ok(!label.includes("\t"));
    assert.ok(label.startsWith("Import the Adaptable"));
  });
});

describe("deriveStepStatus", () => {
  it("maps a thrown error to failed", () => {
    assert.strictEqual(
      deriveStepStatus({ error: new Error("boom") }),
      "failed",
    );
  });

  it("maps a skipped result to skipped", () => {
    assert.strictEqual(
      deriveStepStatus({ result: { skipped: true } }),
      "skipped",
    );
  });

  it("defaults to success", () => {
    assert.strictEqual(
      deriveStepStatus({ result: { landingPage: "/x" } }),
      "success",
    );
    assert.strictEqual(deriveStepStatus({}), "success");
    assert.strictEqual(deriveStepStatus(), "success");
  });
});

describe("formatBlueprintTimings", () => {
  const timings = [
    {
      index: 1,
      step: "installMoodle",
      label: "",
      startMs: 0,
      endMs: 100,
      durationMs: 100,
      status: "success",
    },
    {
      index: 2,
      step: "restoreCourse",
      label: "Demo restore",
      startMs: 100,
      endMs: 1600,
      durationMs: 1500,
      status: "success",
    },
    {
      index: 3,
      step: "createUser",
      label: "",
      startMs: 1600,
      endMs: 1650,
      durationMs: 50,
      status: "failed",
    },
  ];

  it("produces a machine-readable [blueprint-perf] line and a human summary", () => {
    const { perfLine, summaryLine, report } = formatBlueprintTimings(timings);
    assert.match(perfLine, /^\[blueprint-perf\] \{.*\} \[\/blueprint-perf\]$/);
    assert.strictEqual(report.steps.length, 3);
    assert.strictEqual(report.totalMs, 1650);
    // Human summary ranks the slowest step first.
    assert.match(summaryLine, /Blueprint timing: 3 step\(s\) in 1650ms\./);
    assert.match(summaryLine, /Slowest: #2 restoreCourse \(1500ms\)/);
  });

  it("only emits index, step type, label, ms and status (allowlist — no payload)", () => {
    const tainted = [
      {
        index: 1,
        step: "createUser",
        label: "make a user",
        startMs: 0,
        endMs: 5,
        durationMs: 5,
        status: "success",
        // fields that must never be serialised:
        password: "S3cr3t-Password!",
        token: "abc123token",
        data: "base64secretpayload==",
      },
    ];
    const { perfLine, report } = formatBlueprintTimings(tainted);
    const serialized = perfLine + JSON.stringify(report);
    assert.ok(!serialized.includes("S3cr3t-Password!"));
    assert.ok(!serialized.includes("abc123token"));
    assert.ok(!serialized.includes("base64secretpayload"));
    assert.deepStrictEqual(Object.keys(report.steps[0]).sort(), [
      "i",
      "label",
      "ms",
      "status",
      "step",
    ]);
  });

  it("handles an empty timing list", () => {
    const { perfLine, summaryLine, report } = formatBlueprintTimings([]);
    assert.strictEqual(report.steps.length, 0);
    assert.strictEqual(report.totalMs, 0);
    assert.match(perfLine, /\[blueprint-perf\]/);
    assert.match(summaryLine, /0 step\(s\)/);
  });
});
