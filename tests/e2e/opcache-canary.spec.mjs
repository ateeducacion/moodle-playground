import { MOODLE_BRANCHES } from "../../src/shared/version-resolver.js";
import { expect, test } from "./fixtures.mjs";
import {
  buildBlueprintParam,
  findMoodleFrame,
  specTimeoutMs,
  waitForMoodleContent,
  waitForPlaygroundReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

// ADR-0038: OPcache's file cache is inert under the `wasm` SAPI on PHP 8.3/8.4
// but live on PHP 8.5, where opcache_reset()/opcache_invalidate() are no-ops.
// A PHP file compiled once and then rewritten must execute its new code on the
// next request. The 8.3 row only proves the plumbing; the 8.5 row is the real
// canary and additionally asserts that the cache is active, so it cannot pass
// vacuously. OPCACHE_CANARY_MATRIX="5.3:8.5" overrides the rows (used against an
// isolated copy that allows PHP 8.5 on a stable branch).
const matrix = (process.env.OPCACHE_CANARY_MATRIX || "5.3:8.3,dev:8.5")
  .split(",")
  .map((row) => row.split(":"));

const canaryIndex = `<?php
require(__DIR__ . '/../../config.php');
header('Content-Type: application/json');
$target = __DIR__ . '/target.php';
if (($_GET['step'] ?? '1') === '1') {
    // Older than opcache.file_update_protection so the first compile is stored.
    touch($target, time() - 10);
} else {
    file_put_contents($target, "<?php return 'v2';");
}
clearstatcache();
$value = include $target;
$status = function_exists('opcache_get_status') ? opcache_get_status(false) : null;
echo json_encode([
    'value' => $value,
    'fileCacheOnly' => is_array($status) && !empty($status['file_cache_only']),
    'php' => PHP_VERSION,
    'sapi' => PHP_SAPI,
]);`;

for (const [moodle, php] of matrix) {
  test(`rewritten PHP files recompile on Moodle ${moodle} / PHP ${php}`, async ({
    page,
  }) => {
    const branch = MOODLE_BRANCHES.find((entry) => entry.version === moodle);
    expect(branch, `unknown Moodle version ${moodle}`).toBeTruthy();
    const manifest = await page.request.get(
      `assets/manifests/${branch.manifestFile}`,
    );
    test.skip(!manifest.ok(), `${branch.manifestFile} is not built here`);

    const dir = `${branch.webRoot}/local/opcanary`;
    const bp = buildBlueprintParam({
      steps: [
        {
          step: "installMoodle",
          options: {
            adminUser: "admin",
            adminPass: "password",
            adminEmail: "admin@example.com",
            siteName: "OPcache canary",
          },
        },
        { step: "mkdir", path: dir },
        { step: "writeFile", path: `${dir}/index.php`, data: canaryIndex },
        {
          step: "writeFile",
          path: `${dir}/target.php`,
          data: "<?php return 'v1';",
        },
      ],
    });
    await page.goto(
      `/?moodle=${moodle}&php=${php}&scope=opcanary-${crypto.randomUUID()}&blueprint=${bp}`,
      { waitUntil: "domcontentloaded" },
    );
    await waitForPlaygroundReady(page);
    const frame = await waitForMoodleContent(
      () => findMoodleFrame(page),
      ["#page-content", "[role=main]"],
    );
    const call = (step) =>
      frame.evaluate(async (step) => {
        const prefix = location.pathname.match(
          /^.*\/playground\/[^/]+\/[^/]+/,
        )[0];
        const response = await fetch(
          `${prefix}/local/opcanary/index.php?step=${step}`,
          { cache: "no-store" },
        );
        return { status: response.status, body: await response.text() };
      }, step);

    const first = await call(1);
    expect(first.status, first.body).toBe(200);
    const compiled = JSON.parse(first.body);
    expect(compiled.php.startsWith(php)).toBe(true);
    expect(compiled.value).toBe("v1");
    if (php === "8.5") {
      expect(compiled.fileCacheOnly, "OPcache file cache live on 8.5").toBe(
        true,
      );
    }

    const second = await call(2);
    expect(second.status, second.body).toBe(200);
    expect(JSON.parse(second.body).value).toBe("v2");
  });
}
