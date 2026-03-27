import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 180_000 });

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
// Moodle runtime boot tests
// ---------------------------------------------------------------------------

test("Moodle dashboard loads after boot", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  // The address should point to a Moodle page
  const address = await page.locator("#address-input").inputValue();
  expect(address).toMatch(/^\//);
});

test("PHP Info tab captures runtime diagnostics", async ({ page }) => {
  await page.goto("/");
  await waitForRuntimeReady(page);

  await page.locator("#panel-toggle-button").click();
  await page.locator("#phpinfo-tab").click();

  // Click refresh to capture PHP info
  await page.locator("#refresh-phpinfo-button").click();

  // Wait for the phpinfo frame to contain PHP version info
  const phpinfoFrame = page.locator("#phpinfo-frame");
  await expect(phpinfoFrame).toHaveAttribute("srcdoc", /PHP Version/, {
    timeout: 30_000,
  });
});
