import { expect, test } from "./fixtures.mjs";

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------
// Moodle runtime boot tests
// ---------------------------------------------------------------------------

test("Moodle dashboard loads after boot", async ({ page, playground }) => {
  await playground.open();

  const address = await page.locator("#address-input").inputValue();
  expect(address).toMatch(/^\//);
});

test("PHP Info tab captures runtime diagnostics", async ({
  page,
  playground,
  browserName,
}) => {
  test.fixme(
    browserName === "firefox",
    "Temporarily disabled due to Firefox CI runtime readiness flakiness.",
  );

  await playground.open();

  await page.locator("#panel-toggle-button").click();
  await page.locator("#phpinfo-tab").click();
  await page.locator("#refresh-phpinfo-button").click();

  const phpinfoFrame = page.locator("#phpinfo-frame");
  await expect(phpinfoFrame).toHaveAttribute("srcdoc", /PHP Version/, {
    timeout: 30_000,
  });
});
