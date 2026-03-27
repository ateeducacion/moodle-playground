import { expect, test } from "@playwright/test";
import {
  captureDiagnostics,
  createDiagnosticsCollector,
  openPlayground,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

/**
 * Encode a blueprint object as base64url for the ?blueprint= query param.
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

// ---------------------------------------------------------------------------
// Shell UI tests
// ---------------------------------------------------------------------------

test("loads the shell and boots the Moodle runtime", async ({
  page,
}, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

    const address = await page.locator("#address-input").inputValue();
    expect(address).toBeTruthy();
    expect(address.startsWith("/")).toBe(true);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("side panel opens and shows tabs", async ({ page }, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

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
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("logs tab displays runtime log entries", async ({ page }, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

    await page.locator("#panel-toggle-button").click();
    await page.locator("#logs-tab").click();
    await expect(page.locator("#log-panel")).toBeVisible();

    const logText = await page.locator("#log-panel").textContent();
    expect(logText.length).toBeGreaterThan(0);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("blueprint tab shows the active blueprint JSON", async ({
  page,
}, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

    await page.locator("#panel-toggle-button").click();
    await page.locator("#blueprint-tab").click();
    await expect(page.locator("#blueprint-textarea")).toBeVisible();

    const blueprintText = await page
      .locator("#blueprint-textarea")
      .inputValue();
    expect(blueprintText).toContain('"steps"');
    expect(blueprintText).toContain('"installMoodle"');
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("settings popover opens and shows version selectors", async ({
  page,
}, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

    await page.locator("#settings-button").click();
    await expect(page.locator("#settings-popover")).toHaveClass(/is-open/);

    const moodleOptions = await page
      .locator("#settings-moodle-version option")
      .count();
    expect(moodleOptions).toBeGreaterThan(0);

    const phpOptions = await page
      .locator("#settings-php-version option")
      .count();
    expect(phpOptions).toBeGreaterThan(0);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

// ---------------------------------------------------------------------------
// Blueprint override test
// ---------------------------------------------------------------------------

test("accepts blueprint via ?blueprint= query param", async ({
  page,
}, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);
  try {
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
    await waitForShellReady(page);

    await page.locator("#panel-toggle-button").click();
    await page.locator("#blueprint-tab").click();
    await expect(page.locator("#blueprint-textarea")).toHaveValue(
      /E2E Custom Site/,
    );
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});
