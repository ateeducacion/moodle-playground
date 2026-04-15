import { expect, test } from "./fixtures.mjs";
import { buildBlueprintParam, waitForShellReady } from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------
// Blueprint: setTheme with the bundled `classic` theme.
//
// This spec deliberately uses a theme that ships with Moodle core so it does
// not rely on any outbound HTTP request. It validates the activation path
// (setTheme handler → set_config('theme', ...) → theme_reset_all_caches →
// front page renders) without the flakiness of fetching a third-party ZIP
// from github.com in CI.
//
// Live-download coverage of `installTheme` with a real third-party theme
// (Moove) is opt-in via the `E2E_LIVE_THEMES=1` environment variable.
// ---------------------------------------------------------------------------

test("setTheme activates the bundled classic theme", async ({ page }) => {
  const bp = buildBlueprintParam({
    landingPage: "/",
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: "password",
          adminEmail: "admin@example.com",
          siteName: "Classic Theme Test",
        },
      },
      { step: "setTheme", name: "classic" },
      { step: "login", username: "admin" },
    ],
  });

  await page.goto(`/?blueprint=${bp}`);
  await waitForShellReady(page);

  // The shell should load without errors after setTheme runs.
  const address = await page.locator("#address-input").inputValue();
  expect(address.length).toBeGreaterThan(0);

  // Blueprint tab should echo the setTheme step back to the user.
  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/"setTheme"/);
  await expect(page.locator("#blueprint-textarea")).toHaveValue(/"classic"/);

  // Logs should show successful bootstrap — if setTheme crashed, the executor
  // would surface the error here.
  await page.locator("#logs-tab").click();
  const logText = await page.locator("#log-panel").textContent();
  expect(logText).toContain("Moodle");
  expect(logText).not.toContain("setTheme failed");
});

test.describe("live theme download", () => {
  test.skip(
    !process.env.E2E_LIVE_THEMES,
    "Set E2E_LIVE_THEMES=1 to run live third-party theme downloads",
  );

  test("installTheme + setTheme activates Moove from github.com", async ({
    page,
  }) => {
    const bp = buildBlueprintParam({
      landingPage: "/",
      steps: [
        {
          step: "installMoodle",
          options: {
            adminUser: "admin",
            adminPass: "password",
            adminEmail: "admin@example.com",
            siteName: "Moove Live Test",
          },
        },
        {
          step: "installTheme",
          url: "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/MOODLE_500_STABLE.zip",
        },
        { step: "setTheme", name: "moove" },
        { step: "login", username: "admin" },
      ],
    });

    await page.goto(`/?blueprint=${bp}`);
    await waitForShellReady(page);

    await page.locator("#panel-toggle-button").click();
    await page.locator("#logs-tab").click();
    const logText = await page.locator("#log-panel").textContent();
    expect(logText).toContain("moove");
  });
});
