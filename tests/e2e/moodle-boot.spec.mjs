import { expect, test } from "./fixtures.mjs";
import { specTimeoutMs } from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

// ---------------------------------------------------------------------------
// Moodle runtime boot tests
// ---------------------------------------------------------------------------

test("Moodle dashboard loads after boot", async ({ page, playground }) => {
  await playground.open();

  const address = await page.locator("#address-input").inputValue();
  expect(address).toMatch(/^\//);
});

// Invariant: when the manifest advertises a build-time localcache seed
// (snapshot.localcache, see ADR 0010), every snapshot-origin boot must apply
// it and skip the in-browser SCSS warmup — including journaled reloads, since
// fs-persistence never journals localcache. Legacy manifests (no seed field)
// must keep the warmup behavior.
test("boot consumes the localcache seed when the manifest advertises it", async ({
  page,
  playground,
}) => {
  await playground.open();

  const manifest = await page.evaluate(async () => {
    const response = await fetch("assets/manifests/latest.json", {
      cache: "no-store",
    });
    return response.ok ? response.json() : null;
  });

  const logText = (await page.locator("#log-panel").textContent()) || "";
  const seeded = Boolean(manifest?.snapshot?.localcache);

  if (seeded) {
    expect(logText).toContain("Localcache seed applied");
    expect(logText).toContain("skipping SCSS warmup");
    expect(logText).not.toContain("Compiling theme CSS");

    // A reload boots from the journaled DB (source: "snapshot") and must
    // re-apply the seed — localcache is rebuilt from the artifact each boot.
    await page.reload({ waitUntil: "domcontentloaded" });
    await playground.open();
    const reloadLog = (await page.locator("#log-panel").textContent()) || "";
    expect(reloadLog).toContain("Localcache seed applied");
    expect(reloadLog).not.toContain("Compiling theme CSS");
  } else {
    expect(logText).toContain("Compiling theme CSS");
  }
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
