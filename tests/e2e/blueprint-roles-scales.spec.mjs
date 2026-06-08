import { expect, test } from "./fixtures.mjs";
import { buildBlueprintParam, waitForShellReady } from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------
// Blueprint: roles, scales and cohorts provisioning.
//
// Exercises the role/scale/cohort generators against real Moodle (create_role,
// assign_capability, set_role_contextlevels, grade_scale, cohort_add_cohort).
// The decisive assertion is that boot completes WITHOUT a blueprint step
// failure in the logs: each step's generated PHP installs a graceful handler
// that returns {"ok":false} on error, which the executor turns into a
// "Blueprint step <name> failed" log. No such log ⇒ the steps ran successfully.
//
// This avoids nested-iframe Moodle UI interaction (flaky under CI — see
// admin-flows.spec.mjs), so it is safe to run in CI.
// ---------------------------------------------------------------------------

test("blueprint provisions roles, scales and cohorts", async ({ page }) => {
  const bp = buildBlueprintParam({
    landingPage: "/my/",
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName: "E2E Roles/Scales Test",
        },
      },
      { step: "login", username: "admin" },
      {
        step: "createUsers",
        users: [
          { username: "alice", firstname: "Alice", lastname: "Coord" },
          { username: "bob", firstname: "Bob", lastname: "Teacher" },
        ],
      },
      // JSON-native role with capabilities, context levels and relationships.
      {
        step: "createRole",
        shortname: "coordinacion",
        name: "Coordinador",
        archetype: "editingteacher",
        contextlevels: ["course", "module"],
        capabilities: {
          "moodle/course:update": "allow",
          "moodle/course:viewhiddencourses": "allow",
        },
        allowAssign: ["student"],
      },
      // Batch roles.
      {
        step: "createRoles",
        roles: [
          {
            shortname: "guestviewer",
            name: "Hidden viewer",
            archetype: "student",
          },
        ],
      },
      // Site-wide scales, plain + export-envelope forms.
      {
        step: "createScale",
        name: "Competency",
        items: ["Not competent yet", "Competent"],
      },
      {
        step: "createScales",
        scales: {
          format: "moodle-scale-export",
          format_version: 1,
          scales: [{ name: "Three levels", items: "Low, Medium, High" }],
        },
      },
      // Cohort with members (users created above).
      {
        step: "createCohort",
        name: "Staff 2026",
        idnumber: "staff2026",
        members: ["alice", "bob"],
      },
      { step: "setLandingPage", path: "/my/" },
    ],
  });

  await page.goto(`/?blueprint=${bp}`);
  await waitForShellReady(page);

  // Boot reached the landing page.
  const address = await page.locator("#address-input").inputValue();
  expect(address).toContain("/my");

  // The blueprint loaded with our data.
  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/coordinacion/);
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/Competency/);

  // Decisive check: no blueprint step failed during boot.
  await page.locator("#logs-tab").click();
  const logText = (await page.locator("#log-panel").textContent()) || "";
  expect(logText).toContain("Moodle");
  expect(logText).not.toMatch(/Blueprint (step .+ failed|failed at step)/i);
});
