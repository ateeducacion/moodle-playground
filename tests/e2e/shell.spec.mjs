import { expect, test } from "./fixtures.mjs";
import { buildBlueprintParam, waitForShellReady } from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

function buildDefaultBlueprintParam(overrides = {}) {
  return buildBlueprintParam({
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
  });
}

// ---------------------------------------------------------------------------
// Shell UI tests
// ---------------------------------------------------------------------------

test("loads the shell and boots the Moodle runtime", async ({
  page,
  playground,
}) => {
  await playground.open();

  const address = await page.locator("#address-input").inputValue();
  expect(address).toBeTruthy();
  expect(address.startsWith("/")).toBe(true);
});

test("side panel opens and shows tabs", async ({ page, playground }) => {
  await playground.open();

  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#panel-toggle-button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("#side-panel")).not.toHaveClass(/is-collapsed/);

  await expect(page.locator("#current-moodle-label")).not.toHaveText("-");
  await expect(page.locator("#current-php-label")).not.toHaveText("-");
  await expect(page.locator("#current-runtime-label")).not.toHaveText("-");
});

test("logs tab displays runtime log entries", async ({ page, playground }) => {
  await playground.open();

  await page.locator("#panel-toggle-button").click();
  await page.locator("#logs-tab").click();
  await expect(page.locator("#log-panel")).toBeVisible();

  const logText = await page.locator("#log-panel").textContent();
  expect(logText.length).toBeGreaterThan(0);
});

test("blueprint tab shows the active blueprint JSON", async ({
  page,
  playground,
}) => {
  await playground.open();

  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toBeVisible();

  const blueprintText = await page.locator("#blueprint-textarea").inputValue();
  expect(blueprintText).toContain('"steps"');
  expect(blueprintText).toContain('"installMoodle"');
});

test("settings popover opens and shows version selectors", async ({
  page,
  playground,
}) => {
  await playground.open();

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
  const bp = buildDefaultBlueprintParam({
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
  await waitForShellReady(page);

  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toHaveValue(
    /E2E Custom Site/,
  );
});
