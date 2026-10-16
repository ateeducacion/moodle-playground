import { strToU8, zipSync } from "fflate";
import { createPhpBridgeChannel } from "../../src/shared/protocol.js";
import { buildScopedCacheKey } from "../../src/shared/sw-url-rewrite.js";
import { expect, test } from "./fixtures.mjs";
import {
  findMoodleFrame,
  readyTimeoutMs,
  specTimeoutMs,
  waitForMoodleContent,
  waitForPlaygroundReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

async function ready(page) {
  await waitForPlaygroundReady(page);
  const frame = await waitForMoodleContent(
    () => findMoodleFrame(page),
    ["#page-content", "[role=main]"],
  );
  await frame.waitForLoadState("load", { timeout: readyTimeoutMs });
  await frame.waitForFunction(
    () => typeof M !== "undefined" && M.util.pending_js.length === 0,
    undefined,
    { timeout: readyTimeoutMs },
  );
  return frame;
}

for (const [version, branch] of [
  ["5.3", "MOODLE_503_STABLE"],
  ["5.0", "MOODLE_500_STABLE"],
]) {
  test(`JavaScript seed and jsrev agree on Moodle ${version}`, async ({
    page,
  }) => {
    await page.goto(`./?moodle=${version}`, { waitUntil: "domcontentloaded" });
    const frame = await ready(page);
    const manifest = await page.evaluate(
      async (branch) => (await fetch(`assets/manifests/${branch}.json`)).json(),
      branch,
    );
    const revision = await frame.evaluate(() => Number(M.cfg.jsrev));
    expect(revision).toBeGreaterThan(1);
    if (manifest.snapshot.jsrev) expect(revision).toBe(manifest.snapshot.jsrev);
    const asset = await frame.evaluate(async (revision) => {
      const prefix = location.pathname.match(
        /^.*\/playground\/[^/]+\/[^/]+/,
      )[0];
      const response = await fetch(
        `${prefix}/lib/requirejs.php/${revision}/core/first.js`,
      );
      const body = await response.text();
      return {
        status: response.status,
        bytes: body.length,
        coreFirst: /define\(["']core\/first["']/.test(body),
      };
    }, revision);
    expect(asset.status).toBe(200);
    expect(asset.coreFirst).toBe(true);
    // Legacy seeds still load per-module; rebuilt seeds must serve the combine.
    if (manifest.snapshot.jsrev) expect(asset.bytes).toBeGreaterThan(1_000_000);
  });
}

test("public immutable ESM uses the scoped SW cache, development ESM does not", async ({
  page,
}) => {
  const scope = `esm-cache-${crypto.randomUUID()}`;
  await page.goto(`./?moodle=5.3&scope=${scope}`, {
    waitUntil: "domcontentloaded",
  });
  const frame = await ready(page);
  const revision = await frame.evaluate(() => Number(M.cfg.jsrev));
  const asset = `/r.php/core/esm/${revision}/react`;
  const frameUrl = new URL(frame.url());
  const runtime = frameUrl.pathname.match(/\/playground\/[^/]+\/([^/]+)/)[1];
  const cacheKey = (path) =>
    buildScopedCacheKey(frameUrl.origin, scope, runtime, path);
  const cached = async (path) =>
    page.evaluate(async (path) => {
      for (const name of await caches.keys()) {
        if (!name.includes("scoped-static")) continue;
        if (
          await (await caches.open(name)).match(new URL(path, location.origin))
        )
          return true;
      }
      return false;
    }, cacheKey(path));
  await page.evaluate(async (path) => {
    for (const name of await caches.keys()) {
      if (name.includes("scoped-static"))
        await (await caches.open(name)).delete(new URL(path, location.origin));
    }
  }, cacheKey(asset));
  const worker = page
    .workers()
    .find((worker) => worker.url().includes("php-worker"));
  await worker.evaluate(
    ({ channel, asset }) => {
      globalThis.__esmRequests = 0;
      globalThis.__esmObserver = new BroadcastChannel(channel);
      __esmObserver.addEventListener("message", (event) => {
        if (
          event.data.kind === "http-request" &&
          new URL(event.data.request.url).pathname === asset
        )
          __esmRequests++;
      });
    },
    { channel: createPhpBridgeChannel(scope), asset },
  );
  const fetchAsset = (path) =>
    frame.evaluate(async (path) => {
      const prefix = location.pathname.match(
        /^.*\/playground\/[^/]+\/[^/]+/,
      )[0];
      const response = await fetch(prefix + path, { cache: "no-store" });
      return {
        status: response.status,
        cache: response.headers.get("cache-control"),
        body: await response.text(),
      };
    }, path);
  const first = await fetchAsset(asset);
  expect(first.status).toBe(200);
  expect(first.cache).toContain("immutable");
  await expect.poll(() => cached(asset)).toBe(true);
  expect(await fetchAsset(asset)).toEqual(first);
  expect(await worker.evaluate(() => __esmRequests)).toBe(1);
  const development = "/r.php/core/esm/-1/react";
  expect((await fetchAsset(development)).status).toBe(200);
  expect(await cached(development)).toBe(false);
});

function pluginFixture() {
  const version = (number) =>
    `<?php defined('MOODLE_INTERNAL') || die(); $plugin->component='local_playgroundassets'; $plugin->version=${number}; $plugin->requires=2024100700;`;
  const amd = (value) =>
    `define("local_playgroundassets/probe",[],function(){return {init:function(){document.getElementById("plugin-version").textContent="${value}";}};});`;
  const files = {
    "version.php": version(2026101600),
    "lang/en/local_playgroundassets.php":
      "<?php $string['pluginname']='Asset regression fixture';",
    "amd/build/probe.min.js": amd("v1"),
    "amd/build/probe.min.js.map": '{"version":3}',
    "db/upgrade.php":
      "<?php function xmldb_local_playgroundassets_upgrade($oldversion){if($oldversion<2026101601){upgrade_plugin_savepoint(true,2026101601,'local','playgroundassets');}return true;}",
    "index.php": `<?php
require(__DIR__.'/../../config.php'); require_login();
$PAGE->set_context(context_system::instance());
$PAGE->set_url('/local/playgroundassets/index.php');
$PAGE->set_title('Asset regression fixture');
$PAGE->requires->js_call_amd('local_playgroundassets/probe','init');
echo $OUTPUT->header(); echo '<div id="plugin-version">waiting</div><div id="stored-revision">'.$CFG->jsrev.'</div>'; echo $OUTPUT->footer();`,
    "upgrade.php": `<?php
require(__DIR__.'/../../config.php'); require_login(); require_sesskey();
require_capability('moodle/site:config',context_system::instance());
require_once($CFG->libdir.'/upgradelib.php');
file_put_contents(__DIR__.'/version.php',base64_decode('${Buffer.from(version(2026101601)).toString("base64")}'));
file_put_contents(__DIR__.'/amd/build/probe.min.js',base64_decode('${Buffer.from(amd("v2")).toString("base64")}'));
ob_start(); upgrade_noncore(true); ob_end_clean(); js_reset_all_caches();
echo "\\nUPGRADE_JSON".json_encode(['version'=>get_config('local_playgroundassets','version')]);`,
  };
  return (
    "data:application/zip;base64," +
    Buffer.from(
      zipSync(
        Object.fromEntries(
          Object.entries(files).map(([name, data]) => [
            `playgroundassets/${name}`,
            strToU8(data),
          ]),
        ),
      ),
    ).toString("base64")
  );
}

for (const version of ["5.3", "5.0"]) {
  test(`runtime plugin AMD updates after upgrade on Moodle ${version}`, async ({
    page,
  }) => {
    // Two fully initialized pages, including a real cache purge/upgrade.
    test.setTimeout(specTimeoutMs + readyTimeoutMs);
    const blueprint = {
      landingPage: "/local/playgroundassets/index.php",
      steps: [
        { step: "installMoodle" },
        {
          step: "installMoodlePlugin",
          pluginType: "local",
          pluginName: "playgroundassets",
          url: pluginFixture(),
        },
        { step: "login" },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(blueprint)).toString("base64");
    await page.goto(
      `./?moodle=${version}&blueprint=${encodeURIComponent(encoded)}`,
      { waitUntil: "domcontentloaded" },
    );
    const frame = await ready(page);
    await expect(frame.locator("#plugin-version")).toHaveText("v1");
    const before = Number(
      await frame.locator("#stored-revision").textContent(),
    );
    const upgraded = await frame.evaluate(async () => {
      const response = await fetch("upgrade.php", {
        method: "POST",
        body: new URLSearchParams({ sesskey: M.cfg.sesskey }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: JSON.parse(text.split("UPGRADE_JSON").at(-1)),
      };
    });
    expect(upgraded.status).toBe(200);
    expect(Number(upgraded.body.version)).toBe(2026101601);
    // Exercise the same native iframe reload as a user, not Frame.goto's
    // Firefox lifecycle bookkeeping (which can stall after a SW navigation).
    await page.locator("#refresh-button").click();
    // Firefox's frame protocol can retain the old execution context even when
    // the screenshot shows v2. Read the actual same-origin DOM, not stale metadata.
    const rendered = () =>
      page.evaluate(() => {
        const app = document
          .querySelector("#site-frame")
          ?.contentDocument?.querySelector("#remote-frame")?.contentWindow;
        const probe = app?.document.querySelector("#plugin-version");
        if (!probe) return null;
        const rect = probe.getBoundingClientRect();
        return {
          version: probe.textContent,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            app.getComputedStyle(probe).visibility !== "hidden",
          readyState: app.document.readyState,
          pendingJs: app.M?.util?.pending_js,
          jsrev: Number(app.M?.cfg?.jsrev),
          storedRevision: Number(
            app.document.querySelector("#stored-revision")?.textContent,
          ),
        };
      });
    await expect.poll(rendered, { timeout: readyTimeoutMs }).toMatchObject({
      version: "v2",
      visible: true,
      readyState: "complete",
      pendingJs: [],
    });
    const state = await rendered();
    expect(state.storedRevision).not.toBe(before);
    expect(state.jsrev).toBeGreaterThan(1);
  });
}
