import assert from "node:assert/strict";
import { it } from "node:test";
import { findMoodleFrame, withDiagnosticDeadline } from "../e2e/helpers.mjs";

it("finds the rendered Moodle iframe when Firefox reports its host as about:blank", () => {
  const host = { url: () => "about:blank", name: () => "site-frame" };
  const app = { name: () => "remote-frame", parentFrame: () => host };
  const unrelated = {
    name: () => "remote-frame",
    parentFrame: () => ({ name: () => "other-host", url: () => "about:blank" }),
  };
  const page = { frames: () => [unrelated, app] };
  assert.equal(findMoodleFrame(page), app);
  assert.equal(findMoodleFrame({ frames: () => [unrelated] }), null);
});

it("bounds failed-browser diagnostics without hiding their errors", async () => {
  assert.equal(
    await withDiagnosticDeadline(Promise.resolve("captured"), 20),
    "captured",
  );
  await assert.rejects(
    withDiagnosticDeadline(new Promise(() => {}), 1),
    /timed out/,
  );
  await assert.rejects(
    withDiagnosticDeadline(Promise.reject(new Error("browser closed")), 20),
    /browser closed/,
  );
});
