import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { executeBlueprint } from "../../src/blueprint/executor.js";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

describe("archive validation before destination writes", () => {
  const valid = zipSync({
    "plugin/version.php": strToU8("<?php $plugin->version=1;"),
    "plugin/lib.php": strToU8("<?php echo 'new code';"),
  });
  const badCrc = zipSync(
    {
      "plugin/version.php": strToU8("<?php $plugin->version=1;"),
      "plugin/lib.php": strToU8("<?php echo 'corrupt at the end';"),
    },
    { level: 0 },
  );
  badCrc[new DataView(badCrc.buffer).getUint32(badCrc.length - 6, true) - 1] ^=
    1;
  for (const [label, bytes] of [
    ["non-ZIP", strToU8("not a zip")],
    ["truncated ZIP", valid.slice(0, -8)],
    ["late CRC failure", badCrc],
    [
      "partial ZIP",
      valid.slice(
        0,
        new DataView(valid.buffer).getUint32(valid.length - 6, true),
      ),
    ],
  ]) {
    it(`unzip preserves existing files for ${label}`, async () => {
      const files = new Map([["/dest/plugin/version.php", "old code"]]);
      await assert.rejects(
        getStepHandler("unzip")(
          { destination: "/dest", data: "@archive" },
          {
            resources: { resolve: async () => bytes },
            php: {
              _php: {
                mkdirTree: () => assert.fail("must validate before mkdir"),
                writeFile: (path, data) => files.set(path, data),
              },
            },
          },
        ),
        /unzip @archive to \/dest: Invalid ZIP/,
      );
      assert.deepEqual([...files], [["/dest/plugin/version.php", "old code"]]);
    });

    it(`plugin ${label} neither writes nor checkpoints success`, async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(bytes);
      try {
        const checkpoint = {
          resuming: false,
          fingerprint: "fixture",
          save: () => assert.fail("must not checkpoint failure"),
        };
        const result = await executeBlueprint(
          {
            steps: [
              {
                step: "installMoodlePlugin",
                pluginType: "local",
                pluginName: "fixture",
                url: "https://example.invalid/plugin.zip",
              },
            ],
          },
          {
            checkpoint,
            php: {
              _php: {
                mkdirTree: () => assert.fail("must validate first"),
                writeFile: () => assert.fail("must preserve existing code"),
              },
              run: () => assert.fail("must not register an invalid plugin"),
            },
          },
        );
        assert.equal(result.success, false);
        assert.match(
          result.error,
          /installMoodlePlugin https:\/\/example.invalid\/plugin.zip: Invalid ZIP/,
        );
        assert.equal(result.timings[0].status, "failed");
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }
});
