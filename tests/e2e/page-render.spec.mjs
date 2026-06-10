import { expect, test } from "./fixtures.mjs";
import { specTimeoutMs } from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

// Guard: the booted playground must render a real themed Moodle page.
// The boot/blueprint specs validate the worker pipeline but never render a
// page in the browser, so a bundle missing a runtime-required file (e.g.
// lib/behat/lib.php, which theme/boost layouts require unconditionally)
// sailed through CI while every page 500'd for real users. This spec fails
// on any Moodle exception page.
test("dashboard renders a themed page without Moodle exceptions", async ({
  playground,
  moodle,
  browserName,
}) => {
  // Same Firefox-on-CI readiness flakiness as the PHP Info spec: parallel
  // WASM boots overrun the content wait. A missing-file exception page is
  // browser-independent, so the chromium run fully covers this guard.
  test.fixme(
    browserName === "firefox",
    "Temporarily disabled due to Firefox CI runtime readiness flakiness.",
  );

  await playground.open({ waitForMoodle: true });

  const bodyText = await moodle.locator("body").innerText();
  expect(bodyText).not.toContain("Failed opening required");
  expect(bodyText).not.toContain("Exception - ");

  // A themed Boost page exposes the #page region; an exception page does not.
  await expect(moodle.locator("#page")).toBeVisible();
});
