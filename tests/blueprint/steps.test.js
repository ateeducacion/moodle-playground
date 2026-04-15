import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getRegisteredStepNames,
  getStepHandler,
} from "../../src/blueprint/steps/index.js";

describe("step registry", () => {
  it("has all expected step names registered", () => {
    const expected = [
      "installMoodle",
      "setAdminAccount",
      "login",
      "setConfig",
      "setConfigs",
      "setTheme",
      "setLandingPage",
      "createUser",
      "createUsers",
      "createCategory",
      "createCategories",
      "createCourse",
      "createCourses",
      "createSection",
      "createSections",
      "enrolUser",
      "enrolUsers",
      "addModule",
      "installMoodlePlugin",
      "installTheme",
      "mkdir",
      "rmdir",
      "writeFile",
      "writeFiles",
      "copyFile",
      "moveFile",
      "unzip",
      "request",
      "runPhpCode",
      "runPhpScript",
    ];
    const registered = getRegisteredStepNames();
    for (const name of expected) {
      assert.ok(registered.includes(name), `Missing step: ${name}`);
    }
  });

  it("returns null for unknown steps", () => {
    assert.strictEqual(getStepHandler("doesNotExist"), null);
  });

  it("returns functions for known steps", () => {
    const handler = getStepHandler("login");
    assert.strictEqual(typeof handler, "function");
  });

  it("installMoodle handler is a no-op", async () => {
    const handler = getStepHandler("installMoodle");
    // Should not throw
    await handler({}, {});
  });

  it("setLandingPage returns landingPage", async () => {
    const handler = getStepHandler("setLandingPage");
    const result = await handler({ path: "/course/view.php" }, {});
    assert.strictEqual(result.landingPage, "/course/view.php");
  });

  it("setLandingPage throws without path", async () => {
    const handler = getStepHandler("setLandingPage");
    await assert.rejects(() => handler({}, {}), /path/);
  });

  it("setTheme is registered", () => {
    const handler = getStepHandler("setTheme");
    assert.strictEqual(typeof handler, "function");
  });

  it("setTheme throws without name", async () => {
    const handler = getStepHandler("setTheme");
    await assert.rejects(
      () => handler({}, { php: { run: async () => ({}) } }),
      /name/,
    );
  });

  it("setTheme runs php.run with a set_config('theme', ...) script", async () => {
    const handler = getStepHandler("setTheme");
    const calls = [];
    await handler(
      { name: "moove" },
      {
        php: {
          async run(code) {
            calls.push(code);
            return { text: '{"ok":true}' };
          },
        },
      },
    );
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("set_config('theme', 'moove'"));
    assert.ok(calls[0].includes("theme_reset_all_caches"));
  });
});
