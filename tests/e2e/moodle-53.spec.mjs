import { expect, test } from "./fixtures.mjs";
import {
  getMoodleFrame,
  navigateWithinPlayground,
  specTimeoutMs,
  waitForPlaygroundReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

for (const php of ["8.3", "8.4"]) {
  test(`Moodle 5.3 renders with PHP ${php}`, async ({ page }) => {
    await page.goto(`/?moodle=5.3&php=${php}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForPlaygroundReady(page);
    await expect(page.locator("#runtime-id-value")).toHaveText(
      `php${php.replace(".", "")}-moodle53`,
    );
    await expect(getMoodleFrame(page).locator("#page")).toBeVisible();
    const body = await getMoodleFrame(page).locator("body").innerText();
    expect(body).not.toContain("Failed opening required");
    expect(body).not.toContain("Exception - ");
    const manifest = await page.evaluate(async () => {
      const response = await fetch("assets/manifests/MOODLE_503_STABLE.json");
      return response.json();
    });
    expect(manifest.release).toMatch(/^5\.3(?:\.\d+)?\+?(?: |$)/);
    expect(manifest.snapshot).toBeTruthy();
  });
}

// Moodle 5.3 reads composer.lock (core\composer) whenever the admin tree is
// built (admin/settings/server.php, OAuth 2 server); the bundle must ship it.
test("Moodle 5.3 site administration renders without composer errors", async ({
  page,
}) => {
  await page.goto("/?moodle=5.3", { waitUntil: "domcontentloaded" });
  await waitForPlaygroundReady(page);
  await navigateWithinPlayground(page, "/admin/search.php");
  await expect(getMoodleFrame(page).locator("#page")).toBeVisible();
  const body = await getMoodleFrame(page).locator("body").innerText();
  expect(body).not.toContain("not found in composer.lock");
  expect(body).not.toContain("Exception - ");
});
