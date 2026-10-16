import assert from "node:assert/strict";
import { it } from "node:test";
import {
  findMoodleFrame,
  waitForMoodleContent,
  withDiagnosticDeadline,
} from "../e2e/helpers.mjs";

it("reselects the app frame during readiness instead of waiting on the initial blank frame", async () => {
  const frame = (visible) => ({
    locator: () => ({ first: () => ({ isVisible: async () => visible }) }),
  });
  const blank = frame(false);
  const rendered = frame(true);
  let calls = 0;
  assert.equal(
    await waitForMoodleContent(
      () => (++calls === 1 ? blank : rendered),
      ["#reload-state"],
      2000,
    ),
    rendered,
  );
  assert.ok(calls >= 2);
});

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

it("does not pin readiness to a frame whose browser protocol call never completes", async () => {
  const stalled = {
    locator: () => ({
      first: () => ({ isVisible: () => new Promise(() => {}) }),
    }),
  };
  const rendered = {
    locator: () => ({ first: () => ({ isVisible: async () => true }) }),
  };
  let calls = 0;
  assert.equal(
    await waitForMoodleContent(
      () => (++calls === 1 ? stalled : rendered),
      ["#page-content"],
      4000,
    ),
    rendered,
  );
});
