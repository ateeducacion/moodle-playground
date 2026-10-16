import { createServer } from "node:http";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "./fixtures.mjs";
import {
  findMoodleFrame,
  readyTimeoutMs,
  specTimeoutMs,
  waitForMoodleContent,
  waitForShellReady,
} from "./helpers.mjs";

async function ready(page, selector) {
  await waitForShellReady(page);
  const frame = await waitForMoodleContent(
    () => findMoodleFrame(page),
    [selector],
  );
  await frame.waitForFunction(
    () => globalThis.M?.util?.pending_js?.length === 0,
    undefined,
    { timeout: readyTimeoutMs },
  );
  return frame;
}

async function serve(handler) {
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("cache-control", "no-store");
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

async function waitForPersistedText(page, suffix, text) {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ suffix, text }) => {
          const info = (await indexedDB.databases()).find((db) =>
            db.name.startsWith("moodle-fs-journal:"),
          );
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const ops = await new Promise((resolve, reject) => {
            const request = db.transaction("ops").objectStore("ops").getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return ops.some(
            (op) =>
              op.operation === "WRITE" &&
              op.path.endsWith(suffix) &&
              new TextDecoder().decode(op.data).includes(text),
          );
        },
        { suffix, text },
      ),
    )
    .toBe(true);
}

test("an uninstalled plugin is not resurrected from a completed blueprint archive", async ({
  page,
}) => {
  test.setTimeout(specTimeoutMs + readyTimeoutMs);
  const zip = zipSync({
    "reviewremoved/version.php": strToU8(
      "<?php defined('MOODLE_INTERNAL') || die(); $plugin->component='local_reviewremoved'; $plugin->version=2026101600; $plugin->requires=2024100700;",
    ),
    "reviewremoved/lang/en/local_reviewremoved.php": strToU8(
      "<?php $string['pluginname']='Uninstall fixture';",
    ),
  });
  const blueprint = {
    landingPage: "/review-uninstall.php",
    steps: [
      { step: "installMoodle", options: { locale: "en" } },
      {
        step: "installMoodlePlugin",
        pluginType: "local",
        pluginName: "reviewremoved",
        url: `data:application/zip;base64,${Buffer.from(zip).toString("base64")}`,
      },
      {
        step: "writeFile",
        path: "/www/moodle/public/review-uninstall.php",
        data: `<?php
require(__DIR__.'/config.php'); require_login();
$PAGE->set_context(context_system::instance()); $PAGE->set_url('/review-uninstall.php');
if ($_SERVER['REQUEST_METHOD']==='POST') {
 require_sesskey(); require_capability('moodle/site:config',context_system::instance());
 require_once($CFG->libdir.'/upgradelib.php'); require_once($CFG->libdir.'/adminlib.php');
 ob_start(); uninstall_plugin('local','reviewremoved'); ob_end_clean();
 remove_dir(__DIR__.'/local/reviewremoved');
 file_put_contents('/persist/review-uninstalled','removed'); echo 'removed'; exit;
}
echo $OUTPUT->header(); echo '<pre id="uninstall-state">'.s(json_encode([
'installed'=>get_config('local_reviewremoved','version'),
'code'=>is_dir(__DIR__.'/local/reviewremoved'),'user'=>$USER->username])).'</pre>'; echo $OUTPUT->footer();`,
      },
      { step: "login" },
    ],
  };
  await page.goto(
    `./?moodle=5.3&blueprint=${encodeURIComponent(Buffer.from(JSON.stringify(blueprint)).toString("base64"))}`,
    { waitUntil: "domcontentloaded" },
  );
  let frame = await ready(page, "#uninstall-state");
  const before = JSON.parse(
    await frame.locator("#uninstall-state").textContent(),
  );
  expect(Number(before.installed)).toBe(2026101600);
  const removed = await frame.evaluate(async () => {
    const response = await fetch(location.href, {
      method: "POST",
      body: new URLSearchParams({ sesskey: M.cfg.sesskey }),
    });
    return { status: response.status, body: await response.text() };
  });
  expect(removed).toEqual({ status: 200, body: "removed" });
  await waitForPersistedText(page, "/review-uninstalled", "removed");
  await page.reload({ waitUntil: "domcontentloaded" });
  frame = await ready(page, "#uninstall-state");
  expect(
    JSON.parse(await frame.locator("#uninstall-state").textContent()),
  ).toEqual({ installed: false, code: false, user: "admin" });
  await expect(page.locator("#log-panel")).toContainText(
    "Not restoring uninstalled plugin local_reviewremoved",
  );
});

test("changed remote content retains data/login; Reset and a different source really re-provision", async ({
  page,
}) => {
  test.setTimeout(specTimeoutMs * 3);
  const scope = `source-policy-${crypto.randomUUID()}`;
  const makeBlueprint = (name) => ({
    landingPage: "/course/index.php",
    steps: [
      { step: "installMoodle", options: { locale: "en" } },
      {
        step: "createCourse",
        fullname: name,
        shortname: "REVIEW101",
        category: 1,
      },
      {
        step: "writeFile",
        path: "/www/moodle/public/review-edit.php",
        data: `<?php
require(__DIR__.'/config.php'); require_login(); require_sesskey();
require_capability('moodle/site:config', context_system::instance());
$DB->set_field('course','fullname','User retained',['shortname'=>'REVIEW101']);
echo 'saved';`,
      },
      { step: "login" },
      { step: "setLandingPage", path: "/course/index.php" },
    ],
  });
  let blueprint = makeBlueprint("Original course");
  let sourceUnavailable = false;
  let downloads = 0;
  const server = await serve((_request, response) => {
    downloads++;
    response.writeHead(sourceUnavailable ? 503 : 200);
    response.end(sourceUnavailable ? "unavailable" : JSON.stringify(blueprint));
  });
  const url = (source) =>
    `./?moodle=5.3&scope=${scope}&blueprint-url=${encodeURIComponent(`${server.url}/${source}`)}`;
  // Firefox can report about:blank after Reset/reload despite the rendered DOM.
  const courseState = (expected, previous) =>
    page.evaluate(
      ({ expected, previous }) => {
        const app = document
          .querySelector("#site-frame")
          ?.contentDocument?.querySelector("#remote-frame")?.contentWindow;
        return {
          expected: app?.document.body?.innerText.includes(expected),
          previous: app?.document.body?.innerText.includes(previous),
          visible: Boolean(
            app?.document.querySelector(".coursebox")?.getBoundingClientRect()
              .height,
          ),
          readyState: app?.document.readyState,
          pendingJs: app?.M?.util?.pending_js,
          loggedIn: Boolean(
            app?.document.querySelector('a[href*="/login/logout.php"]'),
          ),
        };
      },
      { expected, previous },
    );
  try {
    await page.goto(url("same.json"), { waitUntil: "domcontentloaded" });
    const frame = await ready(page, ".coursebox");
    await expect(frame.locator("body")).toContainText("Original course");
    const edited = await frame.evaluate(async () => {
      const prefix = location.pathname.match(
        /^.*\/playground\/[^/]+\/[^/]+/,
      )[0];
      const response = await fetch(`${prefix}/review-edit.php`, {
        method: "POST",
        body: new URLSearchParams({ sesskey: M.cfg.sesskey }),
      });
      return { status: response.status, body: await response.text() };
    });
    expect(edited).toEqual({ status: 200, body: "saved" });
    // Explicitly wait for a real DB write in IDB before reloading.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const info = (await indexedDB.databases()).find((db) =>
            db.name.startsWith("moodle-fs-journal:"),
          );
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const ops = await new Promise((resolve, reject) => {
            const request = db.transaction("ops").objectStore("ops").getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return ops.some(
            (op) =>
              op.operation === "WRITE" &&
              op.path.endsWith(".sq3.php") &&
              new TextDecoder().decode(op.data).includes("User retained"),
          );
        }),
      )
      .toBe(true);
    blueprint = makeBlueprint("Changed course");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForShellReady(page);
    await expect
      .poll(() => courseState("User retained", "Changed course"), {
        timeout: readyTimeoutMs,
      })
      .toMatchObject({
        expected: true,
        previous: false,
        visible: true,
        readyState: "complete",
        pendingJs: [],
        loggedIn: true,
      });
    await expect(page.locator("#address-input")).toHaveValue(
      "/course/index.php",
    );
    await expect(page.locator("#log-panel")).toContainText(
      "The blueprint changed",
    );
    // Reset must use the resolved blueprint even if its source is now offline.
    const downloadsBeforeReset = downloads;
    sourceUnavailable = true;
    await page.locator("#panel-toggle-button").click();
    await page.locator("#reset-button").click();
    await expect
      .poll(() => courseState("Changed course", "User retained"), {
        timeout: readyTimeoutMs,
      })
      .toMatchObject({
        expected: true,
        previous: false,
        visible: true,
        readyState: "complete",
        pendingJs: [],
        loggedIn: true,
      });
    expect(downloads).toBe(downloadsBeforeReset);
    sourceUnavailable = false;
    blueprint = makeBlueprint("Different source course");
    expect(
      await page.evaluate(
        (scope) => sessionStorage.getItem(`blueprint-source:${scope}`),
        scope,
      ),
    ).toBe(`url:${server.url}/same.json`);
    await page.goto(url("different.json"), { waitUntil: "domcontentloaded" });
    await waitForShellReady(page);
    await expect
      .poll(() => courseState("Different source course", "Changed course"), {
        timeout: readyTimeoutMs,
      })
      .toMatchObject({
        expected: true,
        previous: false,
        visible: true,
        readyState: "complete",
        pendingJs: [],
        loggedIn: true,
      });
  } finally {
    server.close();
  }
});

test("partial overlay restores the applied subset without re-fetching or bumping revisions", async ({
  page,
}) => {
  test.setTimeout(specTimeoutMs + readyTimeoutMs);
  const requests = [];
  const server = await serve((request, response) => {
    requests.push(request.url);
    const resources = {
      "/good.txt": "applied-overlay",
      "/moodle.php":
        "<?php include(__DIR__.'/moodle.review-base.php'); $string['yes']='Overlay answer';",
      "/hooks.php":
        "<?php include(__DIR__.'/hooks.review-base.php'); $callbacks[]=['hook'=>\\core\\hook\\after_config::class,'callback'=>'\\core\\review_hook::after_config'];",
      "/review_hook.php":
        "<?php namespace core; class review_hook { public static function after_config(\\core\\hook\\after_config $hook): void { $GLOBALS['review_overlay_hook']='hook-applied'; } }",
    };
    response.writeHead(Object.hasOwn(resources, request.url) ? 200 : 404);
    response.end(resources[request.url] ?? "not found");
  });
  const blueprint = {
    landingPage: "/review-state.php",
    steps: [
      { step: "installMoodle", options: { locale: "en" } },
      {
        step: "copyFile",
        from: "/www/moodle/public/lang/en/moodle.php",
        to: "/www/moodle/public/lang/en/moodle.review-base.php",
      },
      {
        step: "copyFile",
        from: "/www/moodle/public/lib/db/hooks.php",
        to: "/www/moodle/public/lib/db/hooks.review-base.php",
      },
      {
        step: "writeFile",
        path: "/www/moodle/public/review-state.php",
        data: `<?php
require_once(__DIR__.'/lib/classes/review_hook.php');
require(__DIR__.'/config.php'); require_login();
$PAGE->set_context(context_system::instance()); $PAGE->set_url('/review-state.php');
echo $OUTPUT->header(); echo '<pre id="overlay-state">'.s(json_encode([
'jsrev'=>$CFG->jsrev,'themerev'=>get_config('core','themerev'),
'answer'=>get_string('yes','moodle',null,'en'),
'hook'=>$GLOBALS['review_overlay_hook'] ?? null,
'value'=>file_get_contents(__DIR__.'/review-overlay.txt')])).'</pre>'; echo $OUTPUT->footer();`,
      },
      {
        step: "applyPrOverlay",
        runUpgrade: "on",
        files: [
          {
            path: "public/lib/classes/review_hook.php",
            status: "added",
            rawUrl: `${server.url}/review_hook.php`,
          },
          {
            path: "public/lib/db/hooks.php",
            status: "modified",
            rawUrl: `${server.url}/hooks.php`,
          },
          {
            path: "public/lang/en/moodle.php",
            status: "modified",
            rawUrl: `${server.url}/moodle.php`,
          },
          {
            path: "public/review-overlay.txt",
            status: "added",
            rawUrl: `${server.url}/good.txt`,
          },
          {
            path: "public/missing.txt",
            status: "added",
            rawUrl: `${server.url}/missing.txt`,
          },
        ],
      },
      { step: "login" },
    ],
  };
  try {
    await page.goto(
      `./?moodle=5.3&blueprint=${encodeURIComponent(Buffer.from(JSON.stringify(blueprint)).toString("base64"))}`,
      { waitUntil: "domcontentloaded" },
    );
    const frame = await ready(page, "#overlay-state");
    const first = JSON.parse(
      await frame.locator("#overlay-state").textContent(),
    );
    expect(first.value).toBe("applied-overlay");
    expect(first.answer).toBe("Overlay answer");
    expect(first.hook).toBe("hook-applied");
    await expect(page.locator("#log-panel")).toContainText(
      "Running Moodle upgrade after overlay",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForShellReady(page);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const app = document
              .querySelector("#site-frame")
              ?.contentDocument?.querySelector("#remote-frame")?.contentWindow;
            const state = app?.document.querySelector("#overlay-state");
            return {
              state: state ? JSON.parse(state.textContent) : null,
              visible: Boolean(state?.getBoundingClientRect().height),
              readyState: app?.document.readyState,
              pendingJs: app?.M?.util?.pending_js,
            };
          }),
        { timeout: readyTimeoutMs },
      )
      .toEqual({
        state: first,
        visible: true,
        readyState: "complete",
        pendingJs: [],
      });
    expect(requests).toEqual([
      "/review_hook.php",
      "/hooks.php",
      "/moodle.php",
      "/good.txt",
      "/missing.txt",
    ]);
    await expect(page.locator("#log-panel")).not.toContainText(
      "Blueprint failed",
    );
  } finally {
    server.close();
  }
});

test("toolbar Refresh after a form POST performs GET without repeating the mutation", async ({
  page,
}) => {
  test.setTimeout(specTimeoutMs);
  const blueprint = {
    landingPage: "/review-post.php",
    steps: [
      { step: "installMoodle", options: { locale: "en" } },
      {
        step: "writeFile",
        path: "/www/moodle/public/review-post.php",
        data: `<?php
require(__DIR__.'/config.php'); require_login();
require_capability('moodle/site:config',context_system::instance());
$PAGE->set_context(context_system::instance()); $PAGE->set_url('/review-post.php');
if ($_SERVER['REQUEST_METHOD']==='POST') {
    require_sesskey();
    set_config('review_post_count',(int)get_config('core','review_post_count')+1);
}
echo $OUTPUT->header();
echo '<pre id="post-state">'.s(json_encode(['method'=>$_SERVER['REQUEST_METHOD'],
    'count'=>(int)get_config('core','review_post_count'),'user'=>$USER->username])).'</pre>';
echo '<form method="post"><input type="hidden" name="sesskey" value="'.sesskey().'">';
echo '<button id="submit-review">Save once</button></form>';
echo $OUTPUT->footer();`,
      },
      { step: "login" },
    ],
  };
  await page.goto(
    `./?moodle=5.3&blueprint=${encodeURIComponent(Buffer.from(JSON.stringify(blueprint)).toString("base64"))}`,
    { waitUntil: "domcontentloaded" },
  );
  await ready(page, "#post-state");
  const readState = () =>
    page.evaluate(() => {
      const app = document
        .querySelector("#site-frame")
        ?.contentDocument?.querySelector("#remote-frame")?.contentWindow;
      const text = app?.document.querySelector("#post-state")?.textContent;
      return text ? JSON.parse(text) : null;
    });
  await expect
    .poll(readState)
    .toEqual({ method: "GET", count: 0, user: "admin" });
  await page.evaluate(() =>
    document
      .querySelector("#site-frame")
      .contentDocument.querySelector("#remote-frame")
      .contentDocument.querySelector("#submit-review")
      .click(),
  );
  await expect.poll(readState, { timeout: readyTimeoutMs }).toEqual({
    method: "POST",
    count: 1,
    user: "admin",
  });
  await expect(page.locator("#refresh-button")).toBeEnabled();
  await page.locator("#refresh-button").click();
  await expect.poll(readState, { timeout: readyTimeoutMs }).toEqual({
    method: "GET",
    count: 1,
    user: "admin",
  });
});
