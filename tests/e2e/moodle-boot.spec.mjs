import { expect, test } from "@playwright/test";
import {
  captureDiagnostics,
  createDiagnosticsCollector,
  openPlayground,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------
// Moodle runtime boot tests
// ---------------------------------------------------------------------------

test("Moodle dashboard loads after boot", async ({
  page,
  browserName,
}, testInfo) => {
  test.fixme(
    browserName === "firefox",
    "SW bootstrap fails in Firefox — see KNOWN-ISSUES.md",
  );
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

    const address = await page.locator("#address-input").inputValue();
    expect(address).toMatch(/^\//);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});

test("PHP Info tab captures runtime diagnostics", async ({
  page,
  browserName,
}, testInfo) => {
  test.fixme(
    browserName === "firefox",
    "SW bootstrap fails in Firefox — see KNOWN-ISSUES.md",
  );
  const diagnostics = createDiagnosticsCollector(page);
  try {
    await openPlayground(page);
    await waitForShellReady(page);

    await page.locator("#panel-toggle-button").click();
    await page.locator("#phpinfo-tab").click();
    await page.locator("#refresh-phpinfo-button").click();

    const phpinfoFrame = page.locator("#phpinfo-frame");
    await expect(phpinfoFrame).toHaveAttribute("srcdoc", /PHP Version/, {
      timeout: 30_000,
    });
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});
