import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

function buildBlueprintParam(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

async function waitForRuntimeReady(page) {
  await expect(page.locator("#address-input")).toBeEnabled({
    timeout: 120_000,
  });
  await expect(page.locator("#site-frame")).toHaveAttribute(
    "src",
    /scope=|playground\//,
  );
}

// ---------------------------------------------------------------------------
// Blueprint: course creation with users and enrollment
// ---------------------------------------------------------------------------

test("blueprint creates a course with a user and enrollment", async ({
  page,
}) => {
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

  // Capture browser console for debugging
  const consoleLogs = [];
  page.on("console", (msg) =>
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`),
  );

  await page.goto(`/?blueprint=${bp}`);
  await waitForRuntimeReady(page);

  // Dump runtime logs for debugging if address doesn't match
  const address = await page.locator("#address-input").inputValue();
  if (!address.includes("/course/view.php")) {
    await page.locator("#panel-toggle-button").click();
    await page.locator("#logs-tab").click();
    const runtimeLogs = await page.locator("#log-panel").textContent();
    console.log("=== RUNTIME LOGS (last 3000 chars) ===");
    console.log(runtimeLogs.slice(-3000));
    console.log("=== BROWSER CONSOLE (last 30 lines) ===");
    for (const line of consoleLogs.slice(-30)) console.log(line);
    console.log("=== ADDRESS BAR ===", address);
  }

  // Verify the address bar shows the course view
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
});
