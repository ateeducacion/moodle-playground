import { expect, test } from "@playwright/test";
import {
  captureDiagnostics,
  createDiagnosticsCollector,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

function buildBlueprintParam(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

// ---------------------------------------------------------------------------
// Blueprint: course creation with users, enrollment, and modules
// ---------------------------------------------------------------------------

test("blueprint creates a course with a user and enrollment", async ({
  page,
  browserName,
}, testInfo) => {
  test.fixme(
    browserName === "firefox",
    "SW bootstrap fails in Firefox — see KNOWN-ISSUES.md",
  );
  const diagnostics = createDiagnosticsCollector(page);

  const bp = buildBlueprintParam({
    landingPage: "/course/view.php?id=2",
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName: "E2E Course Test",
        },
      },
      { step: "login", username: "admin" },
      {
        step: "createUser",
        username: "student1",
        password: "Student1!",
        email: "student1@example.com",
        firstname: "Alice",
        lastname: "Test",
      },
      {
        step: "createCourse",
        fullname: "E2E Test Course",
        shortname: "E2ETEST",
        summary: "Created by Playwright e2e test",
      },
      {
        step: "enrolUser",
        username: "student1",
        course: "E2ETEST",
        role: "student",
      },
      {
        step: "addModule",
        module: "label",
        course: "E2ETEST",
        section: 1,
        name: "Welcome Label",
        intro: "<p>Welcome to the E2E test course!</p>",
      },
      {
        step: "addModule",
        module: "assign",
        course: "E2ETEST",
        section: 1,
        name: "E2E Assignment",
        intro: "This assignment was created by the Playwright e2e test suite.",
      },
      { step: "setLandingPage", path: "/course/view.php?id=2" },
    ],
  });

  try {
    await page.goto(`/?blueprint=${bp}`);
    await waitForShellReady(page);

    // Verify the address bar shows the course view
    const address = await page.locator("#address-input").inputValue();
    expect(address).toContain("/course/view.php");

    // Verify the blueprint tab contains our custom data
    await page.locator("#panel-toggle-button").click();
    await page.locator("#blueprint-tab").click();
    await expect(page.locator("#blueprint-textarea")).toHaveValue(
      /E2E Test Course/,
    );
    await expect(page.locator("#blueprint-textarea")).toHaveValue(
      /E2E Assignment/,
    );

    // Verify logs show successful bootstrap
    await page.locator("#logs-tab").click();
    const logText = await page.locator("#log-panel").textContent();
    expect(logText).toContain("Moodle");
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});
