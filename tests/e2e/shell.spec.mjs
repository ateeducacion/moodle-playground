import { expect, test } from "./fixtures.mjs";
import {
  buildBlueprintParam,
  specTimeoutMs,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

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

test("persists mutable data to IndexedDB", async ({ page, playground }) => {
  await playground.open();

  // The persistence layer opens a "moodle-fs-journal:<scopeId>" IndexedDB and
  // journals /persist (the SQLite DB + moodledata), so a reload within the tab
  // session reuses the data instead of reinstalling. Its presence proves the
  // persistence wiring is active.
  const journaled = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name?.startsWith("moodle-fs-journal:"));
  });
  expect(journaled).toBe(true);
});

test("does not journal Moodle's derived caches (guards CompiledContainer regression)", async ({
  page,
  playground,
}) => {
  await playground.open();

  // Caches under moodledata (cache/localcache/temp/muc) — including Moodle's
  // compiled DI container — must NOT be persisted. Restoring a stale localcache
  // on reload crashed boot with `Class "CompiledContainer" not found`; only real
  // data (DB, filedir, config, sessions) is journaled and Moodle rebuilds caches.
  // Wait past the 1500ms debounced flush so boot's writes are in IndexedDB.
  await page.waitForTimeout(2500);

  const journal = await page.evaluate(async () => {
    const meta = (await indexedDB.databases()).find((d) =>
      d.name?.startsWith("moodle-fs-journal:"),
    );
    if (!meta) return { error: "no journal db" };
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(meta.name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const ops = await new Promise((res, rej) => {
      const rq = db.transaction("ops", "readonly").objectStore("ops").getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    // Match on the op's *path* only (not a stringified op, whose file contents
    // legitimately mention the cache dirs, e.g. config.php's $CFG->localcachedir).
    const re = /\/persist\/moodledata\/(cache|localcache|temp|muc)(\/|$)/u;
    const paths = ops
      .map((op) => op?.path)
      .filter((p) => typeof p === "string");
    const offenders = paths.filter((p) => re.test(p));
    return {
      total: ops.length,
      stringPaths: paths.length,
      sampleKeys: ops[0] ? Object.keys(ops[0]) : [],
      offenders: offenders.slice(0, 10),
      offenderCount: offenders.length,
    };
  });

  expect(journal.error).toBeUndefined();
  // Positive control: real data (DB/config/filedir) is journaled with paths.
  expect(journal.stringPaths).toBeGreaterThan(0);
  // The fix: no cache/localcache/temp/muc paths are persisted, so a reload can't
  // restore a stale compiled container.
  expect(
    journal.offenderCount,
    `journaled cache paths: ${JSON.stringify(journal.offenders)} (op keys: ${JSON.stringify(journal.sampleKeys)})`,
  ).toBe(0);
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

  await expect(page.locator("#info-moodle-version")).toBeVisible();
  await expect(page.locator("#info-php-version")).toBeVisible();
  await expect(page.locator("#runtime-id-value")).not.toHaveText("-");
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

test("info panel hosts the version config with a dirty-state apply", async ({
  page,
  playground,
}) => {
  await playground.open();

  // The floating settings popover and gear button are gone — the version config
  // now lives in the Info panel (single source of truth).
  await expect(page.locator("#settings-button")).toHaveCount(0);
  await expect(page.locator("#settings-popover")).toHaveCount(0);

  await page.locator("#panel-toggle-button").click();

  const moodleOptions = await page
    .locator("#info-moodle-version option")
    .count();
  expect(moodleOptions).toBeGreaterThan(0);
  const phpOptions = await page.locator("#info-php-version option").count();
  expect(phpOptions).toBeGreaterThan(0);

  // Clean state: no Apply button and no destructive warning.
  await expect(page.locator("#config-apply")).toBeHidden();
  await expect(page.locator("#config-warning")).toBeHidden();

  // Changing a version reveals the Apply button + the warning. Reselecting the
  // original value clears the dirty state (no Discard button needed).
  const current = await page.locator("#info-moodle-version").inputValue();
  const other = await page
    .locator("#info-moodle-version option")
    .evaluateAll(
      (opts, cur) => opts.find((o) => o.value !== cur)?.value,
      current,
    );
  if (other) {
    await page.locator("#info-moodle-version").selectOption(other);
    await expect(page.locator("#config-apply")).toBeVisible();
    await expect(page.locator("#config-warning")).toBeVisible();

    await page.locator("#info-moodle-version").selectOption(current);
    await expect(page.locator("#config-apply")).toBeHidden();
    await expect(page.locator("#config-warning")).toBeHidden();
  }
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
