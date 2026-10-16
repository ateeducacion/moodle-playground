import { createServer } from "node:http";
import { strToU8, zipSync } from "fflate";
import { buildScopedCacheKey } from "../../src/shared/sw-url-rewrite.js";
import { expect, test } from "./fixtures.mjs";
import {
  findMoodleFrame,
  readyTimeoutMs,
  specTimeoutMs,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

const files = {
  "version.php":
    "<?php defined('MOODLE_INTERNAL') || die(); $plugin->component='local_checkpointrestore'; $plugin->version=2026101600; $plugin->requires=2024100700;",
  "lang/en/local_checkpointrestore.php":
    "<?php $string['pluginname']='Reload regression fixture';",
  "lib.php": `<?php
function local_checkpointrestore_pluginfile($course,$cm,$context,$filearea,$args,$forcedownload,$options=[]) {
require_login(); require_capability('moodle/site:config',context_system::instance());
$file=get_file_storage()->get_file($context->id,'local_checkpointrestore','private',0,'/',array_pop($args));
if (!$file) send_file_not_found(); send_stored_file($file,0,0,false,$options);
}`,
  "index.php": `<?php
require(__DIR__.'/../../config.php'); require_login();
$context=context_system::instance(); $PAGE->set_context($context);
$PAGE->set_url('/local/checkpointrestore/index.php'); $PAGE->set_title('Reload regression fixture');
if ($_SERVER['REQUEST_METHOD']==='POST') {
    require_sesskey(); require_capability('moodle/site:config',$context);
    set_config('checkpoint_value','user-edited');
    file_put_contents('/persist/checkpoint-marker','user-edited');
    $fs=get_file_storage(); $fs->delete_area_files($context->id,'local_checkpointrestore','private');
    $fs->create_file_from_string(['contextid'=>$context->id,'component'=>'local_checkpointrestore','filearea'=>'private','itemid'=>0,'filepath'=>'/','filename'=>'protected.js'], 'protected-user-edited');
    echo 'saved'; exit;
}
$file=get_file_storage()->get_file($context->id,'local_checkpointrestore','private',0,'/','protected.js');
$state=['courses'=>$DB->count_records('course',['shortname'=>'CHECKPOINT101']),
    'categories'=>$DB->count_records('course_categories',['name'=>'Checkpoint category']),
    'phpRuns'=>get_config('core','checkpoint_runs'),'posts'=>get_config('core','checkpoint_posts'),
    'value'=>get_config('core','checkpoint_value'),'lang'=>get_config('core','lang'),'marker'=>file_get_contents('/persist/checkpoint-marker'),
    'file'=>$file ? $file->get_content() : null,'user'=>$USER->username];
echo $OUTPUT->header();
echo '<pre id="reload-state">'.s(json_encode($state)).'</pre>';
echo '<a id="protected-file" href="'.$CFG->wwwroot.'/pluginfile.php/'.$context->id.'/local_checkpointrestore/private/0/protected.js">Protected fixture</a>';
echo $OUTPUT->footer();`,
  // Synthetic fixture only: allows testing arbitrary blueprint POST without embedding a session token.
  "counter.php":
    "<?php require(__DIR__.'/../../config.php'); set_config('checkpoint_posts',(int)get_config('core','checkpoint_posts')+1); echo 'posted';",
};

async function ready(page) {
  await waitForShellReady(page);
  await expect
    .poll(() => Boolean(findMoodleFrame(page)), { timeout: readyTimeoutMs })
    .toBe(true);
  const frame = findMoodleFrame(page);
  await expect(frame.locator("#reload-state")).toBeVisible({
    timeout: readyTimeoutMs,
  });
  await frame.waitForFunction(
    () => typeof M !== "undefined" && M.util.pending_js.length === 0,
    undefined,
    { timeout: readyTimeoutMs },
  );
  return frame;
}

for (const [version, root] of [
  ["5.3", "/www/moodle/public"],
  ["5.0", "/www/moodle"],
]) {
  test(`persisted reload retains data and restores blueprint files/plugins on Moodle ${version}`, async ({
    page,
  }) => {
    // Initial boot and persisted boot each keep their own readiness deadline.
    test.setTimeout(specTimeoutMs + readyTimeoutMs);
    const zip = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [
          `checkpointrestore/${name}`,
          strToU8(text),
        ]),
      ),
    );
    let downloads = 0;
    const server = createServer((_request, response) => {
      downloads++;
      response.writeHead(200, {
        "content-type": "application/zip",
        "access-control-allow-origin": "*",
      });
      response.end(zip);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const pluginUrl = `http://127.0.0.1:${server.address().port}/checkpoint-plugin.zip`;
    try {
      const blueprint = {
        landingPage: "/local/checkpointrestore/index.php",
        steps: [
          { step: "installMoodle", options: { locale: "en" } },
          { step: "createCategory", name: "Checkpoint category" },
          {
            step: "createCourse",
            fullname: "Retained course",
            shortname: "CHECKPOINT101",
            category: "Checkpoint category",
          },
          {
            step: "installMoodlePlugin",
            pluginType: "local",
            pluginName: "checkpointrestore",
            url: pluginUrl,
          },
          { step: "mkdir", path: "/persist/moodledata/lang/en_custom" },
          {
            step: "writeFiles",
            files: [
              {
                path: `${root}/checkpoint-static.txt`,
                data: "restored-volatile-file",
              },
              { path: "/persist/checkpoint-marker", data: "blueprint-initial" },
              {
                path: "/persist/moodledata/lang/en_custom/langconfig.php",
                data: "<?php $string['parentlanguage']='en'; $string['thislanguage']='Retained test English'; $string['thislanguageint']='Retained test English'; $string['iso6391']='en';",
              },
            ],
          },
          {
            step: "setConfig",
            name: "checkpoint_value",
            value: "blueprint-initial",
          },
          { step: "setConfig", name: "lang", value: "en_custom" },
          {
            step: "setConfigFile",
            plugin: "local_checkpointrestore",
            name: "fixture",
            filename: "protected.js",
            filearea: "private",
            data: { literal: "protected-initial" },
            setConfigValue: false,
          },
          {
            step: "runPhpCode",
            code: `define('CLI_SCRIPT',true); require('${root}/config.php'); set_config('checkpoint_runs',(int)get_config('core','checkpoint_runs')+1);`,
          },
          {
            step: "request",
            method: "POST",
            url: "http://localhost:8080/local/checkpointrestore/counter.php",
            body: "fixture=1",
          },
          { step: "login" },
        ],
      };
      const encoded = Buffer.from(JSON.stringify(blueprint)).toString("base64");
      await page.goto(
        `./?moodle=${version}&blueprint=${encodeURIComponent(encoded)}`,
        { waitUntil: "domcontentloaded" },
      );
      let frame = await ready(page);
      const initial = JSON.parse(
        await frame.locator("#reload-state").textContent(),
      );
      expect(initial).toEqual({
        courses: 1,
        categories: 1,
        phpRuns: "1",
        posts: "1",
        value: "blueprint-initial",
        lang: "en_custom",
        marker: "blueprint-initial",
        file: "protected-initial",
        user: "admin",
      });
      const saved = await frame.evaluate(async () => {
        const response = await fetch(location.href, {
          method: "POST",
          body: new URLSearchParams({ sesskey: M.cfg.sesskey }),
        });
        return { status: response.status, text: await response.text() };
      });
      expect(saved).toEqual({ status: 200, text: "saved" });
      // Wait for the actual late write to appear in IndexedDB, not a fixed sleep.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            for (const info of await indexedDB.databases()) {
              if (!info.name.startsWith("moodle-fs-journal:")) continue;
              const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(info.name);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const ops = await new Promise((resolve, reject) => {
                const request = db
                  .transaction("ops")
                  .objectStore("ops")
                  .getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              db.close();
              if (
                ops.some(
                  (op) =>
                    op.operation === "WRITE" &&
                    op.path === "/persist/checkpoint-marker" &&
                    new TextDecoder().decode(op.data) === "user-edited",
                )
              )
                return true;
            }
            return false;
          }),
        )
        .toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      frame = await ready(page);
      const retained = JSON.parse(
        await frame.locator("#reload-state").textContent(),
      );
      expect(retained).toEqual({
        ...initial,
        value: "user-edited",
        marker: "user-edited",
        file: "protected-user-edited",
      });
      expect(downloads).toBe(1);
      expect(
        await frame.evaluate(async () =>
          (await fetch("../../checkpoint-static.txt")).text(),
        ),
      ).toBe("restored-volatile-file");
      const protectedFile = await frame
        .locator("#protected-file")
        .getAttribute("href");
      const fetched = await frame.evaluate(async (url) => {
        const response = await fetch(url);
        return { status: response.status, text: await response.text() };
      }, protectedFile);
      expect(fetched).toEqual({ status: 200, text: "protected-user-edited" });
      const fileUrl = new URL(protectedFile, frame.url());
      const [, scope, runtime, path] = fileUrl.pathname.match(
        /\/playground\/([^/]+)\/([^/]+)(\/.*)$/,
      );
      const fileCacheKey = buildScopedCacheKey(
        fileUrl.origin,
        scope,
        runtime,
        path + fileUrl.search,
      );
      expect(
        await page.evaluate(
          async (urls) => {
            for (const name of await caches.keys())
              if (name.includes("scoped-static"))
                for (const url of urls) {
                  if (await (await caches.open(name)).match(url)) return true;
                }
            return false;
          },
          [protectedFile, fileCacheKey],
        ),
      ).toBe(false);
      expect(await page.locator("#log-panel").textContent()).not.toMatch(
        /Blueprint failed|Blueprint execution error|Legacy persisted instance/,
      );
    } finally {
      server.close();
    }
  });
}
