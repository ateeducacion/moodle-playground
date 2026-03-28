import { expect, test } from "@playwright/test";
import {
  captureDiagnostics,
  clickFirstVisible,
  createDiagnosticsCollector,
  fillFirstVisible,
  getMoodleFrame,
  navigateWithinPlayground,
  openPlayground,
  tryFillFirstVisible,
  uniqueSuffix,
  waitForShellReady,
} from "./helpers.mjs";

// This test interacts with Moodle forms inside a 2-level iframe served by a
// Service Worker. The frameLocator chain is unreliable in CI (resource
// contention causes the nested iframe content check to timeout). Skip in CI;
// run locally with: npx playwright test admin-flows
test("creates a course and a user, then renders an admin system information page", async ({
  page,
}, testInfo) => {
  test.skip(
    !!process.env.CI,
    "Nested iframe interaction is unreliable in CI — run locally",
  );
  const diagnostics = createDiagnosticsCollector(page);
  const suffix = uniqueSuffix(testInfo);
  const courseName = `Playwright Course ${suffix}`;
  // Keep generated identifiers short for readability in Moodle admin tables.
  const courseShortName = `PW-${Date.now()}`.slice(0, 20);
  // Moodle accepts much longer usernames, but a compact value keeps test data readable.
  const username = `pwuser_${Date.now()}`.slice(0, 30);
  const userPassword = "TempPassword1!";
  const userFirstName = "Playwright";
  const userLastName = `User ${suffix}`;
  const userEmail = `${username}@example.com`;

  try {
    await openPlayground(page);
    await waitForShellReady(page);

    const moodle = getMoodleFrame(page);

    await test.step("create a course through the Moodle UI", async () => {
      await navigateWithinPlayground(page, "/course/edit.php?category=1");
      await fillFirstVisible(
        [
          () => moodle.locator("#id_fullname"),
          () => moodle.locator('input[name="fullname"]'),
          () => moodle.getByLabel(/Course full name/i),
        ],
        courseName,
      );
      await fillFirstVisible(
        [
          () => moodle.locator("#id_shortname"),
          () => moodle.locator('input[name="shortname"]'),
          () => moodle.getByLabel(/Course short name/i),
        ],
        courseShortName,
      );
      await clickFirstVisible([
        () =>
          moodle.getByRole("button", {
            name: /Save and display|Save changes|Save and return/i,
          }),
        () => moodle.locator("#id_saveanddisplay"),
        () => moodle.locator("#id_savechanges"),
      ]);

      await expect(
        moodle.getByRole("heading", { name: courseName }),
      ).toBeVisible();
    });

    await test.step("create a user through the Moodle UI", async () => {
      await navigateWithinPlayground(page, "/user/editadvanced.php?id=-1");
      await fillFirstVisible(
        [
          () => moodle.locator("#id_username"),
          () => moodle.locator('input[name="username"]'),
          () => moodle.getByLabel(/^Username$/i),
        ],
        username,
      );
      if (await moodle.locator('[data-passwordunmask="edit"]').count()) {
        await moodle.locator('[data-passwordunmask="edit"]').first().click();
      }
      const filledPassword = await tryFillFirstVisible(
        [
          () => moodle.locator("#id_newpassword"),
          () => moodle.locator("#id_password"),
          () => moodle.locator('input[name="newpassword"]'),
          () => moodle.locator('input[name="password"]'),
          () => moodle.getByLabel(/New password|Password/i),
        ],
        userPassword,
      );
      if (!filledPassword) {
        await clickFirstVisible([
          () => moodle.locator("#id_createpassword"),
          () =>
            moodle.getByRole("checkbox", {
              name: /Generate password and notify user/i,
            }),
        ]);
      }
      await fillFirstVisible(
        [
          () => moodle.locator("#id_firstname"),
          () => moodle.locator('input[name="firstname"]'),
          () => moodle.getByLabel(/First name/i),
        ],
        userFirstName,
      );
      await fillFirstVisible(
        [
          () => moodle.locator("#id_lastname"),
          () => moodle.locator('input[name="lastname"]'),
          () => moodle.getByLabel(/Surname|Last name/i),
        ],
        userLastName,
      );
      await fillFirstVisible(
        [
          () => moodle.locator("#id_email"),
          () => moodle.locator('input[name="email"]'),
          () => moodle.getByLabel(/Email address/i),
        ],
        userEmail,
      );
      await clickFirstVisible([
        () =>
          moodle.getByRole("button", {
            name: /Create user|Update profile|Save changes/i,
          }),
        () => moodle.locator("#id_submitbutton"),
      ]);

      await expect(moodle.locator("body")).toContainText(username);
    });

    await test.step("open an admin system information page", async () => {
      await navigateWithinPlayground(page, "/admin/environment.php");
      await expect(
        moodle.getByRole("heading", {
          name: /Server environment|Environment|System/i,
        }),
      ).toBeVisible();
      await expect(
        moodle.locator("#serverstatus, #otherserverstatus").first(),
      ).toBeVisible();
      await expect(moodle.locator("body")).toContainText(/PHP/i);
    });
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});
