import { createServer } from "node:http";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "./fixtures.mjs";
import {
  buildBlueprintParam,
  findMoodleFrame,
  specTimeoutMs,
  waitForPlaygroundReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

test("invalid plugin ZIPs preserve files and never checkpoint success", async ({
  page,
}) => {
  const zip = zipSync({
    "plugin/version.php": strToU8("<?php $plugin->version=2026101800;"),
    "plugin/lib.php": strToU8("<?php echo 'must not be installed';"),
  });
  const directory = new DataView(zip.buffer).getUint32(zip.length - 6, true);
  const archives = [
    strToU8("not a zip"),
    zip.slice(0, -8),
    zip.slice(0, directory),
  ];
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "application/zip",
      "access-control-allow-origin": "*",
    });
    response.end(archives[Number(request.url.slice(1))]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const names = ["guardbad", "guardtruncated", "guardpartial"];
  try {
    const root = "/www/moodle/public";
    const blueprint = {
      steps: [
        { step: "installMoodle", options: { locale: "en" } },
        ...names.map((name) => ({
          step: "mkdir",
          path: `${root}/local/${name}`,
        })),
        {
          step: "writeFiles",
          files: [
            ...names.map((name) => ({
              path: `${root}/local/${name}/sentinel.txt`,
              data: "original",
            })),
            {
              path: `${root}/zipguard.php`,
              data: `<?php
$db=glob('/persist/moodledata/moodle_*.sq3.php')[0];
$pdo=new PDO('sqlite:'.$db);
$checkpoint=json_decode($pdo->query("SELECT value FROM mdl_config WHERE name='playground_blueprint_checkpoint'")->fetchColumn(),true);
$state=[];
foreach (['guardbad','guardtruncated','guardpartial'] as $name) {
    $dir=__DIR__.'/local/'.$name;
    $state[$name]=['sentinel'=>file_get_contents($dir.'/sentinel.txt'),'installed'=>file_exists($dir.'/version.php')||file_exists($dir.'/lib.php')];
}
header('Content-Type: application/json');
echo json_encode(['files'=>$state,'completed'=>$checkpoint['completed'],'archives'=>$checkpoint['archives']??[]]);`,
            },
          ],
        },
        ...names.map((name, index) => ({
          step: "installMoodlePlugin",
          pluginType: "local",
          pluginName: name,
          url: `http://127.0.0.1:${server.address().port}/${index}`,
        })),
      ],
    };
    await page.goto(`./?blueprint=${buildBlueprintParam(blueprint)}`);
    await waitForPlaygroundReady(page);
    const state = await findMoodleFrame(page).evaluate(
      async () => await (await fetch("../zipguard.php")).json(),
    );
    for (const name of names)
      expect(state.files[name]).toEqual({
        sentinel: "original",
        installed: false,
      });
    expect(state.completed).toEqual([0, 1, 2, 3, 4]);
    expect(state.archives).toEqual([]);
    const log = await page.locator("#log-panel").textContent();
    for (let index = 0; index < names.length; index++)
      expect(log).toContain(
        `installMoodlePlugin http://127.0.0.1:${server.address().port}/${index}: Invalid ZIP`,
      );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
