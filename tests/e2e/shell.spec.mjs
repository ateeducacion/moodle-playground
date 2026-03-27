import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

/**
 * Encode a blueprint object as base64 for the ?blueprint= query param.
 */
function buildBlueprintParam(overrides = {}) {
  const payload = {
    landingPage: "/my/",
    preferredVersions: { php: "8.3", moodle: "5.0" },
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName: "Playwright E2E",
        },
      },
      { step: "login", username: "admin" },
      { step: "setLandingPage", path: "/my/" },
    ],
    ...overrides,
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Wait until the Moodle runtime has fully booted:
 * - address bar is enabled (UI unlocked)
 * - site-frame has a src pointing to the scoped runtime
 */
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
// Shell UI tests
// ---------------------------------------------------------------------------

test("loads the shell and boots the Moodle runtime", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // The address bar should show a Moodle path after boot
  const address = await page.locator("#address-input").inputValue();
  expect(address).toBeTruthy();
  expect(address.startsWith("/")).toBe(true);
});

test("side panel opens and shows tabs", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // Panel starts collapsed
  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  // Open panel
  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#side-panel")).not.toHaveClass(/is-collapsed/);

  // Info tab shows version labels
  await expect(page.locator("#current-moodle-label")).not.toHaveText("-");
  await expect(page.locator("#current-php-label")).not.toHaveText("-");
  await expect(page.locator("#current-runtime-label")).not.toHaveText("-");
});

test("logs tab displays runtime log entries", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await page.locator("#panel-toggle-button").click();
  await page.locator("#logs-tab").click();
  await expect(page.locator("#log-panel")).toBeVisible();

  // The log panel should have at least one entry from the bootstrap
  const logText = await page.locator("#log-panel").textContent();
  expect(logText.length).toBeGreaterThan(0);
});

test("blueprint tab shows the active blueprint JSON", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toBeVisible();

  const blueprintText = await page.locator("#blueprint-textarea").inputValue();
  expect(blueprintText).toContain('"steps"');
  expect(blueprintText).toContain('"installMoodle"');
});

test("settings popover opens and shows version selectors", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await page.locator("#settings-button").click();
  await expect(page.locator("#settings-popover")).toHaveClass(/is-open/);

  const moodleOptions = await page
    .locator("#settings-moodle-version option")
    .count();
  expect(moodleOptions).toBeGreaterThan(0);

  const phpOptions = await page.locator("#settings-php-version option").count();
  expect(phpOptions).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Blueprint override test
// ---------------------------------------------------------------------------

test("accepts blueprint via ?blueprint= query param", async ({ page }) => {
  const bp = buildBlueprintParam({
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName: "E2E Custom Site",
        },
      },
      { step: "login", username: "admin" },
      { step: "setLandingPage", path: "/my/" },
    ],
  });

  await page.goto(`/?blueprint=${bp}`);
  await waitForRuntimeReady(page);

  // Blueprint tab should contain our custom site name
  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toHaveValue(
    /E2E Custom Site/,
  );
});
