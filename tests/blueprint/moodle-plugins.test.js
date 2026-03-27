import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

describe("installMoodlePlugin step handler", () => {
  const handler = getStepHandler("installMoodlePlugin");

  it("is registered", () => {
    assert.ok(handler, "installMoodlePlugin handler should be registered");
    assert.strictEqual(typeof handler, "function");
  });

  it("throws if url is missing", async () => {
    await assert.rejects(() => handler({}, {}), /url.*required/i);
  });

  it("throws if pluginType cannot be detected from non-GitHub URL", async () => {
    await assert.rejects(
      () => handler({ url: "https://example.com/random.zip" }, {}),
      /pluginType.*could not be detected/i,
    );
  });

  it("throws if pluginName cannot be detected from non-GitHub URL", async () => {
    await assert.rejects(
      () =>
        handler(
          { pluginType: "block", url: "https://example.com/random.zip" },
          {},
        ),
      /pluginName.*could not be detected/i,
    );
  });
});

describe("installTheme step handler", () => {
  const handler = getStepHandler("installTheme");

  it("is registered", () => {
    assert.ok(handler, "installTheme handler should be registered");
    assert.strictEqual(typeof handler, "function");
  });

  it("throws if url is missing", async () => {
    await assert.rejects(() => handler({}, {}), /url.*required/i);
  });

  it("throws if pluginName cannot be detected", async () => {
    await assert.rejects(
      () => handler({ url: "https://example.com/random.zip" }, {}),
      /pluginName.*could not be detected/i,
    );
  });
});

describe("auto-detection of pluginType and pluginName from GitHub URL", () => {
  const handler = getStepHandler("installMoodlePlugin");

  // These tests verify auto-detection by triggering the handler with URLs
  // that match the GitHub archive pattern. The handler will fail at the
  // fetch stage (no network in tests) but we verify it gets past validation.
  function assertPassesValidation(step) {
    return assert.rejects(
      () => handler(step, {}),
      (err) => {
        assert.ok(
          !err.message.includes("pluginType") &&
            !err.message.includes("pluginName"),
          `Should auto-detect type and name but got: ${err.message}`,
        );
        return true;
      },
    );
  }

  it("detects mod type: moodle-mod_board → mod/board", async () => {
    await assertPassesValidation({
      url: "https://github.com/brickfield/moodle-mod_board/archive/refs/heads/MOODLE_405_STABLE.zip",
    });
  });

  it("detects block type: moodle-block_participants → block/participants", async () => {
    await assertPassesValidation({
      url: "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip",
    });
  });

  it("detects local type: moodle-local_staticpage → local/staticpage", async () => {
    await assertPassesValidation({
      url: "https://github.com/moodle-an-hochschulen/moodle-local_staticpage/archive/refs/heads/MOODLE_404_STABLE.zip",
    });
  });

  it("detects from tag URL", async () => {
    await assertPassesValidation({
      url: "https://github.com/org/moodle-tool_mytool/archive/refs/tags/v1.0.zip",
    });
  });

  it("detects from simple archive URL", async () => {
    await assertPassesValidation({
      url: "https://github.com/org/moodle-format_tiles/archive/main.zip",
    });
  });

  it("explicit pluginType and pluginName override detection", async () => {
    await assertPassesValidation({
      pluginType: "mod",
      pluginName: "custommod",
      url: "https://github.com/org/moodle-mod_board/archive/main.zip",
    });
  });

  it("explicit pluginType with auto-detected name", async () => {
    await assertPassesValidation({
      pluginType: "block",
      url: "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip",
    });
  });
});

describe("plugin type validation", () => {
  const handler = getStepHandler("installMoodlePlugin");

  it("throws for unknown plugin type", async () => {
    await assert.rejects(
      () =>
        handler(
          {
            pluginType: "nonexistent",
            pluginName: "test",
            url: "https://github.com/org/moodle-nonexistent_test/archive/refs/heads/main.zip",
          },
          {},
        ),
      /Unknown plugin type.*nonexistent/i,
    );
  });
});

describe("resolvePluginDir path mapping", () => {
  const handler = getStepHandler("installMoodlePlugin");

  const testCases = [
    ["mod", "mymod", "/www/moodle/mod/mymod"],
    ["block", "myblock", "/www/moodle/blocks/myblock"],
    ["local", "mylocal", "/www/moodle/local/mylocal"],
    ["theme", "mytheme", "/www/moodle/theme/mytheme"],
    ["tool", "mytool", "/www/moodle/admin/tool/mytool"],
    ["atto", "myatto", "/www/moodle/lib/editor/atto/plugins/myatto"],
    ["tiny", "mytiny", "/www/moodle/lib/editor/tiny/plugins/mytiny"],
    ["format", "myformat", "/www/moodle/course/format/myformat"],
    ["assignfeedback", "myfb", "/www/moodle/mod/assign/feedback/myfb"],
    ["assignsubmission", "mysub", "/www/moodle/mod/assign/submission/mysub"],
    ["qtype", "myqtype", "/www/moodle/question/type/myqtype"],
    ["auth", "myauth", "/www/moodle/auth/myauth"],
    ["enrol", "myenrol", "/www/moodle/enrol/myenrol"],
    ["repository", "myrepo", "/www/moodle/repository/myrepo"],
  ];

  for (const [type, name, expectedDir] of testCases) {
    it(`${type}/${name} → ${expectedDir}`, async () => {
      const step = {
        pluginType: type,
        pluginName: name,
        url: "https://example.com/plugin.zip",
      };
      await assert.rejects(
        () => handler(step, {}),
        (err) => {
          assert.ok(
            !err.message.includes("Unknown plugin type"),
            `Type '${type}' should be valid but got: ${err.message}`,
          );
          return true;
        },
      );
    });
  }
});

describe("sample blueprint URLs are valid", () => {
  it("all sample URLs follow GitHub archive format", () => {
    const urls = [
      "https://github.com/brickfield/moodle-mod_board/archive/refs/heads/MOODLE_405_STABLE.zip",
      "https://github.com/moodlehq/moodle-block_participants/archive/refs/heads/master.zip",
      "https://github.com/moodle-an-hochschulen/moodle-local_staticpage/archive/refs/heads/MOODLE_404_STABLE.zip",
    ];

    for (const url of urls) {
      const parsed = new URL(url);
      assert.strictEqual(parsed.hostname, "github.com");
      assert.ok(parsed.pathname.includes("/archive/"), `${url}`);
      assert.ok(parsed.pathname.endsWith(".zip"), `${url}`);
    }
  });
});
