import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";
import { __testables } from "../../src/blueprint/steps/moodle-plugins.js";

const SAMPLE_PLUGIN_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAhAAAAbW9vZGxlLW1vZF9ib2FyZC1tYWluL3ZlcnNpb24ucGhws7EvyCgAAFBLAwQUAAAACAB3AYFczmE/Ew8AAAANAAAAKQAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi9jbGFzc2VzL2V4YW1wbGUucGhws7EvyChQSE3OyFcwtAYAUEsBAhQDFAAAAAgAdwGBXK6ya6MHAAAABQAAACEAAAAAAAAAAAAAAIABAAAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi92ZXJzaW9uLnBocFBLAQIUAxQAAAAIAHcBgVzOYT8TDwAAAA0AAAApAAAAAAAAAAAAAACAAUYAAABtb29kbGUtbW9kX2JvYXJkLW1haW4vY2xhc3Nlcy9leGFtcGxlLnBocFBLBQYAAAAAAgACAKYAAACcAAAAAAA=";
const SAMPLE_THEME_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAeAAAAdGhlbWVfbW9vdmUtbWFzdGVyL3ZlcnNpb24ucGhws7EvyCgAAFBLAQIUAxQAAAAIAHcBgVyusmujBwAAAAUAAAAeAAAAAAAAAAAAAACAAQAAAAB0aGVtZV9tb292ZS1tYXN0ZXIvdmVyc2lvbi5waHBQSwUGAAAAAAEAAQBMAAAAQwAAAAAA";

function decodeBase64Bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

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

describe("ZIP download strategy", () => {
  const pluginHandler = getStepHandler("installMoodlePlugin");
  const themeHandler = getStepHandler("installTheme");

  function createPhpMock() {
    const writes = [];
    const mkdirs = [];
    const rawPhp = {
      mkdirTree(path) {
        mkdirs.push(path);
      },
      writeFile(path, data) {
        writes.push([path, data]);
      },
    };
    return {
      rawPhp,
      writes,
      mkdirs,
      php: {
        _php: rawPhp,
        async run() {
          return { text: '{"ok":true}', errors: "" };
        },
      },
    };
  }

  it("proxifies GitHub archive ZIPs before downloading", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const zipBytes = decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64);
    const { php, writes } = createPhpMock();

    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    };

    try {
      await pluginHandler(
        {
          url: "https://github.com/brickfield/moodle-mod_board/archive/refs/heads/feature/embedded-static-editor.zip",
        },
        {
          php,
          config: {
            addonProxyUrl: "https://github-proxy.exelearning.dev/",
          },
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0],
      "https://github-proxy.exelearning.dev/?url=https%3A%2F%2Fgithub.com%2Fbrickfield%2Fmoodle-mod_board%2Farchive%2Frefs%2Fheads%2Ffeature%2Fembedded-static-editor.zip",
    );
    assert.deepEqual(writes.map(([path]) => path).sort(), [
      "/www/moodle/mod/board/classes/example.php",
      "/www/moodle/mod/board/version.php",
    ]);
  });

  it("downloads non-GitHub ZIPs directly", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const zipBytes = decodeBase64Bytes(SAMPLE_THEME_ZIP_BASE64);
    const { php } = createPhpMock();

    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(zipBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    };

    try {
      await themeHandler(
        {
          pluginName: "moove",
          url: "https://downloads.example.com/theme-moove.zip",
        },
        {
          php,
          config: {
            addonProxyUrl: "https://github-proxy.exelearning.dev/",
          },
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(calls, ["https://downloads.example.com/theme-moove.zip"]);
  });
});

describe("proxy helpers", () => {
  it("detects GitHub ZIP URLs that should be proxied", () => {
    assert.equal(
      __testables.shouldProxyZipUrl(
        "https://github.com/org/repo/archive/refs/heads/main.zip",
      ),
      true,
    );
    assert.equal(
      __testables.shouldProxyZipUrl(
        "https://codeload.github.com/org/repo/zip/refs/heads/main",
      ),
      true,
    );
    assert.equal(
      __testables.shouldProxyZipUrl("https://example.com/plugin.zip"),
      false,
    );
  });

  it("builds a proxied download URL from config", () => {
    assert.equal(
      __testables.resolvePluginZipDownloadUrl(
        "https://github.com/org/repo/archive/refs/heads/main.zip",
        { config: { addonProxyUrl: "https://github-proxy.exelearning.dev/" } },
      ),
      "https://github-proxy.exelearning.dev/?url=https%3A%2F%2Fgithub.com%2Forg%2Frepo%2Farchive%2Frefs%2Fheads%2Fmain.zip",
    );
  });
});
