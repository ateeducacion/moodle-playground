import { expect, test } from "./fixtures.mjs";
import {
  buildBlueprintParam,
  findMoodleFrame,
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

test("keeps an address being typed when the site frame navigates", async ({
  page,
  playground,
}) => {
  await playground.open({ waitForMoodle: true });
  const moodle = page.frameLocator("#site-frame").frameLocator("#remote-frame");

  // A page finishing its load in the frame reports its path to the shell.
  // That must not replace what the user is typing: the toolbar unlocks on the
  // worker's "ready", before the landing page has loaded, so typing can
  // overlap that load.
  await page.locator("#address-input").fill("/admin/search.php");
  await moodle
    .locator("body")
    .evaluate(() =>
      location.assign(location.href.replace(/\/my\/.*$/u, "/course/index.php")),
    );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter((key) => key.endsWith(":state"))
          .map((key) => JSON.parse(sessionStorage.getItem(key)).path),
      ),
    )
    .toContain("/course/index.php");
  await expect(page.locator("#address-input")).toHaveValue("/admin/search.php");

  await page.locator("#address-input").press("Enter");
  await expect
    .poll(() => findMoodleFrame(page)?.url() || "")
    .toContain("/admin/search.php");
});

test("Home and Back load the boot page again after an in-site click", async ({
  page,
  playground,
}) => {
  await playground.open({ waitForMoodle: true });
  const moodle = page.frameLocator("#site-frame").frameLocator("#remote-frame");
  const framePath = () => {
    try {
      return new URL(findMoodleFrame(page)?.url()).pathname;
    } catch {
      return "";
    }
  };
  const clickToCourseIndex = async () => {
    await moodle
      .locator("body")
      .evaluate(() =>
        location.assign(
          location.href.replace(/\/(my\/.*)?$/u, "/course/index.php"),
        ),
      );
    await expect.poll(framePath).toMatch(/\/course\/index\.php$/u);
    await expect(page.locator("#address-input")).toHaveValue(
      "/course/index.php",
    );
  };

  // The frame's boot URL must not be taken for the page it shows now: after
  // an in-site click, Home and Back to that URL have to load it again.
  await clickToCourseIndex();
  await page.locator("#home-button").click();
  await expect.poll(framePath).toMatch(/\/(my\/)?$/u);

  await clickToCourseIndex();
  await page.locator("#back-button").click();
  await expect.poll(framePath).toMatch(/\/my\/$/u);
  await expect(page.locator("#address-input")).toHaveValue("/my/");
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

test("serves build metadata matching the Build ID shown in the info panel", async ({
  page,
  playground,
}) => {
  await playground.open();

  const metadata = await page.evaluate(async () => {
    const response = await fetch(
      new URL("assets/build-version.json", window.location.href),
      { cache: "no-store" },
    );
    return response.ok ? response.json() : null;
  });

  expect(metadata).not.toBeNull();
  expect(metadata.buildVersion).toMatch(
    /^\d{8}T\d{6}Z-(?:[0-9a-f]{8}|nogit)(?:-dirty)?$/,
  );
  expect(metadata).toMatchObject({
    gitSha: expect.any(String),
    generatedAt: expect.any(String),
    dirty: expect.any(Boolean),
  });

  // The deployed artifact and the UI must report the same build.
  await page.locator("#panel-toggle-button").click();
  await expect(page.locator("#build-id-value")).toHaveText(
    metadata.buildVersion,
  );
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
  // The CodeJar editor visually supersedes the textarea; #blueprint-textarea
  // stays in the DOM as a hidden compatibility bridge (see
  // src/shell/blueprint-editor.js), so its value is still readable here.
  await expect(page.locator("#blueprint-editor")).toBeVisible();

  const blueprintText = await page.locator("#blueprint-textarea").inputValue();
  expect(blueprintText).toContain('"steps"');
  expect(blueprintText).toContain('"installMoodle"');
});

test("blueprint editor validates edits and gates the Run button", async ({
  page,
  playground,
}) => {
  await playground.open();

  await page.locator("#panel-toggle-button").click();
  await page.locator("#blueprint-tab").click();

  await expect(page.locator("#run-button")).toBeEnabled();
  await expect(page.locator("#blueprint-status")).toHaveText(/valid/i);

  const editor = page.locator("#blueprint-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("not json at all");

  await expect(page.locator("#blueprint-status")).toContainText(/invalid/i);
  await expect(page.locator("#run-button")).toBeDisabled();

  // Invalid content must never trigger a navigation/reload.
  expect(new URL(page.url()).searchParams.has("blueprint")).toBe(false);
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

  // The OPcache toggle alone is not destructive: it swaps the warning for the
  // reload note and relabels the button. Reverting clears it like the selects.
  const opcache = page.locator("#info-opcache");
  await expect(opcache).toBeChecked();
  await opcache.uncheck();
  await expect(page.locator("#config-apply")).toHaveText("Apply & Reload");
  await expect(page.locator("#config-apply")).not.toHaveClass(/danger/);
  await expect(page.locator("#config-reload-note")).toBeVisible();
  await expect(page.locator("#config-warning")).toBeHidden();
  if (other) {
    // A version change on top of it brings the destructive flow back.
    await page.locator("#info-moodle-version").selectOption(other);
    await expect(page.locator("#config-apply")).toHaveText("Apply & Reset");
    await expect(page.locator("#config-warning")).toBeVisible();
    await expect(page.locator("#config-reload-note")).toBeHidden();
    await page.locator("#info-moodle-version").selectOption(current);
  }
  await opcache.check();
  await expect(page.locator("#config-apply")).toBeHidden();
  await expect(page.locator("#config-reload-note")).toBeHidden();
});

test("turns OPcache off from the info panel and reloads without the cache", async ({
  page,
  playground,
  browserName,
}) => {
  test.fixme(
    browserName === "firefox",
    "Temporarily disabled due to Firefox CI runtime readiness flakiness.",
  );
  await playground.open();
  const frame = page.locator("#site-frame");
  const scope = (await frame.getAttribute("src")).match(/scope=([^&]+)/)[1];

  // phpinfo prints the SAPI's pretty name regardless of php_sapi_name(), so the
  // proof that the uwsgi name took effect is OPcache's own status row (ADR-0040).
  const expectOpcodeCaching = async (pattern) => {
    await page.locator("#phpinfo-tab").click();
    await page.locator("#refresh-phpinfo-button").click();
    await expect(page.locator("#phpinfo-frame")).toHaveAttribute(
      "srcdoc",
      pattern,
      { timeout: 30_000 },
    );
  };

  await page.locator("#panel-toggle-button").click();
  await expectOpcodeCaching(
    /Opcode Caching\s*<\/td>\s*<td[^>]*>\s*Up and Running/,
  );

  // The shell log is rebuilt on reload, so record the flush reply in
  // sessionStorage (same tab, survives the navigation) as it is logged.
  await page.evaluate(() => {
    const panel = document.querySelector("#log-panel");
    new MutationObserver(() => {
      if (panel.textContent.includes("Persistence journal flushed")) {
        sessionStorage.setItem("e2e:persistence-flushed", "1");
      }
    }).observe(panel, { childList: true, subtree: true });
  });

  await page.locator("#info-tab").click();
  await page.locator("#info-opcache").uncheck();
  await expect(page.locator("#config-apply")).toHaveText("Apply & Reload");
  await page.locator("#config-apply").click();

  // Same scope and runtime, no clean boot; the URL carries the flag.
  await page.waitForURL(/[?&]opcache=0/);
  await waitForShellReady(page);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("e2e:persistence-flushed"),
    ),
    "the journal was flushed before the reload",
  ).toBe("1");
  await expect(frame).toHaveAttribute("src", new RegExp(`scope=${scope}`));
  await expect(frame).toHaveAttribute("src", /opcache=0/);
  await expect(frame).not.toHaveAttribute("src", /clean=1/);

  if (
    await page
      .locator("#side-panel")
      .evaluate((el) => el.classList.contains("is-collapsed"))
  ) {
    await page.locator("#panel-toggle-button").click();
  }
  await expect(page.locator("#info-opcache")).not.toBeChecked();
  await expect(page.locator("#config-apply")).toBeHidden();
  await expectOpcodeCaching(/Opcode Caching\s*<\/td>\s*<td[^>]*>\s*Disabled/);
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
