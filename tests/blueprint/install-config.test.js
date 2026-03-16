import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInstallConfig } from "../../src/blueprint/index.js";

describe("buildInstallConfig", () => {
  it("returns empty object for null blueprint", () => {
    const result = buildInstallConfig(null);
    assert.deepStrictEqual(result, {});
  });

  it("returns empty object for undefined blueprint", () => {
    const result = buildInstallConfig(undefined);
    assert.deepStrictEqual(result, {});
  });

  it("extracts options from installMoodle step", () => {
    const result = buildInstallConfig({
      steps: [
        {
          step: "installMoodle",
          options: {
            adminUser: "myadmin",
            adminPass: "secret",
            adminEmail: "me@example.com",
            siteName: "My Moodle",
            locale: "es",
            timezone: "Europe/Madrid",
          },
        },
      ],
    });
    assert.strictEqual(result.siteTitle, "My Moodle");
    assert.strictEqual(result.locale, "es");
    assert.strictEqual(result.timezone, "Europe/Madrid");
    assert.strictEqual(result.admin.username, "myadmin");
    assert.strictEqual(result.admin.password, "secret");
    assert.strictEqual(result.admin.email, "me@example.com");
  });

  it("extracts landingPage from top-level field", () => {
    const result = buildInstallConfig({
      landingPage: "/course/view.php?id=1",
      steps: [],
    });
    assert.strictEqual(result.landingPath, "/course/view.php?id=1");
  });

  it("falls back to top-level siteOptions when no installMoodle step", () => {
    const result = buildInstallConfig({
      siteOptions: { fullname: "Fallback Site", locale: "fr" },
      steps: [],
    });
    assert.strictEqual(result.siteTitle, "Fallback Site");
    assert.strictEqual(result.locale, "fr");
  });

  it("falls back to top-level login when no installMoodle step", () => {
    const result = buildInstallConfig({
      login: { username: "teacher", password: "pass", email: "t@x.com" },
      steps: [],
    });
    assert.strictEqual(result.admin.username, "teacher");
    assert.strictEqual(result.admin.password, "pass");
    assert.strictEqual(result.admin.email, "t@x.com");
  });

  it("installMoodle options take precedence over top-level fields", () => {
    const result = buildInstallConfig({
      siteOptions: { fullname: "Top Level" },
      login: { username: "topuser" },
      steps: [
        {
          step: "installMoodle",
          options: { siteName: "Step Level", adminUser: "stepuser" },
        },
      ],
    });
    assert.strictEqual(result.siteTitle, "Step Level");
    assert.strictEqual(result.admin.username, "stepuser");
  });

  it("provides defaults for missing admin fields", () => {
    const result = buildInstallConfig({
      steps: [{ step: "installMoodle", options: { adminUser: "custom" } }],
    });
    assert.strictEqual(result.admin.username, "custom");
    assert.strictEqual(result.admin.password, "password");
    assert.strictEqual(result.admin.email, "admin@example.com");
  });

  it("does not set fields that are not present anywhere", () => {
    const result = buildInstallConfig({ steps: [] });
    assert.strictEqual(result.siteTitle, undefined);
    assert.strictEqual(result.locale, undefined);
    assert.strictEqual(result.timezone, undefined);
    assert.strictEqual(result.admin, undefined);
  });
});
