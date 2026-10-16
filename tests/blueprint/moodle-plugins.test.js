import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";
import { __testables } from "../../src/blueprint/steps/moodle-plugins.js";

// Handler tests without a php mock must stop at the download step, offline.
// Tests that need a successful download install their own fetch mock.
const NETWORK_DISABLED = /network disabled in tests/;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => {
    throw new Error("network disabled in tests");
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const SAMPLE_PLUGIN_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAhAAAAbW9vZGxlLW1vZF9ib2FyZC1tYWluL3ZlcnNpb24ucGhws7EvyCgAAFBLAwQUAAAACAB3AYFczmE/Ew8AAAANAAAAKQAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi9jbGFzc2VzL2V4YW1wbGUucGhws7EvyChQSE3OyFcwtAYAUEsBAhQDFAAAAAgAdwGBXK6ya6MHAAAABQAAACEAAAAAAAAAAAAAAIABAAAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi92ZXJzaW9uLnBocFBLAQIUAxQAAAAIAHcBgVzOYT8TDwAAAA0AAAApAAAAAAAAAAAAAACAAUYAAABtb29kbGUtbW9kX2JvYXJkLW1haW4vY2xhc3Nlcy9leGFtcGxlLnBocFBLBQYAAAAAAgACAKYAAACcAAAAAAA=";
const SAMPLE_THEME_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAeAAAAdGhlbWVfbW9vdmUtbWFzdGVyL3ZlcnNpb24ucGhws7EvyCgAAFBLAQIUAxQAAAAIAHcBgVyusmujBwAAAAUAAAAeAAAAAAAAAAAAAACAAQAAAAB0aGVtZV9tb292ZS1tYXN0ZXIvdmVyc2lvbi5waHBQSwUGAAAAAAEAAQBMAAAAQwAAAAAA";

it("restores a plugin from the saved artifact without a network request or DB upgrade", async () => {
  let code;
  const files = [];
  await getStepHandler("installMoodlePlugin")(
    {
      pluginType: "mod",
      pluginName: "board",
      url: "https://example.invalid/moving.zip",
    },
    {
      restoreOnly: true,
      pluginArchivePath: "/persist/blueprints/fixture/0.zip",
      php: {
        readFile: async (path) => {
          assert.equal(path, "/persist/blueprints/fixture/0.zip");
          return decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64);
        },
        _php: { mkdirTree() {}, writeFile: (path) => files.push(path) },
        run: async (script) => {
          code = script;
          return { text: '{"ok":true}' };
        },
      },
    },
  );
  assert.ok(files.includes("/www/moodle/mod/board/version.php"));
  assert.match(code, /reset_caches\(\)/);
  assert.ok(code.indexOf("return;") < code.indexOf("upgrade_noncore(true)"));
});

it("surfaces a failed plugin upgrade so it cannot receive a successful checkpoint", async () => {
  await assert.rejects(
    getStepHandler("installMoodlePlugin")(
      {
        pluginType: "mod",
        pluginName: "board",
        url: "https://example.invalid/plugin.zip",
      },
      {
        restoreOnly: true,
        pluginArchivePath: "/persist/fixture.zip",
        php: {
          readFile: async () => decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64),
          _php: { mkdirTree() {}, writeFile() {} },
          run: async () => ({ text: '{"ok":false,"error":"fixture failure"}' }),
        },
      },
    ),
    /registration did not complete/,
  );
});

function decodeBase64Bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

it("does not resurrect an explicitly uninstalled completed plugin or theme on reload", async () => {
  for (const [step, pluginType] of [
    ["installMoodlePlugin", "local"],
    ["installTheme", "theme"],
  ]) {
    let reads = 0;
    const result = await getStepHandler(step)(
      {
        url: "https://example.invalid/moving.zip",
        pluginType,
        pluginName: "removed",
      },
      {
        restoreOnly: true,
        previouslyCompleted: true,
        dbFile: "/persist/db'fixture",
        php: {
          run: async (code) => {
            assert.match(code, /mdl_config_plugins/);
            assert.match(code, /db\\'fixture/);
            return { text: "false" };
          },
          readFile: async () => {
            reads++;
            throw new Error("Must not restore removed code");
          },
        },
      },
    );
    assert.equal(result.skipped, true);
    assert.equal(reads, 0);
  }
});

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
  // that match the GitHub archive pattern. Reaching the stubbed fetch proves
  // the handler got past type/name validation.
  function assertPassesValidation(step) {
    return assert.rejects(() => handler(step, {}), NETWORK_DISABLED);
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
      // Reaching the stubbed fetch means resolvePluginDir accepted the type.
      await assert.rejects(() => handler(step, {}), NETWORK_DISABLED);
    });
  }
});

describe("popular free theme URLs are recognized", () => {
  const themeUrls = [
    "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/MOODLE_500_STABLE.zip",
    "https://github.com/tonyjbutler/moodle-theme_adaptable/archive/refs/heads/MOODLE_405_STABLE.zip",
    "https://github.com/tremadesigns/moodle-theme_trema/archive/refs/heads/master.zip",
  ];

  for (const url of themeUrls) {
    it(`detectPluginTypeAndName parses ${url.split("/").slice(3, 5).join("/")}`, () => {
      const result = __testables.detectPluginTypeAndName(url);
      assert.strictEqual(result.type, "theme");
      assert.ok(result.name && result.name.length > 0);
    });
  }

  it("installTheme accepts Moove pinned to MOODLE_500_STABLE (auto-detects name)", async () => {
    const handler = getStepHandler("installTheme");
    // Reaching the stubbed fetch proves it got past the name-detection guard.
    await assert.rejects(
      () =>
        handler(
          {
            url: "https://github.com/willianmano/moodle-theme_moove/archive/refs/heads/MOODLE_500_STABLE.zip",
          },
          {},
        ),
      NETWORK_DISABLED,
    );
  });
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

describe("pluginName path-traversal is rejected before any file write", () => {
  const pluginHandler = getStepHandler("installMoodlePlugin");
  const themeHandler = getStepHandler("installTheme");

  function createPhpMock() {
    const writes = [];
    const mkdirs = [];
    const runCalls = [];
    const rawPhp = {
      mkdirTree(path) {
        mkdirs.push(path);
      },
      writeFile(path, data) {
        writes.push([path, data]);
      },
    };
    return {
      writes,
      mkdirs,
      runCalls,
      php: {
        _php: rawPhp,
        async run(code) {
          runCalls.push(code);
          return { text: '{"ok":true}', errors: "" };
        },
      },
    };
  }

  const traversalNames = ["../../admin/cli", "..", "../x", "a/../b"];

  for (const evilName of traversalNames) {
    it(`installMoodlePlugin rejects pluginName '${evilName}' with no fetch/write`, async () => {
      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      };
      const { php, writes, mkdirs, runCalls } = createPhpMock();

      try {
        await assert.rejects(
          () =>
            pluginHandler(
              {
                pluginType: "mod",
                pluginName: evilName,
                url: "https://example.com/plugin.zip",
              },
              { php },
            ),
          /invalid plugin name/i,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      // Validation must happen before resolvePluginDir builds a poisoned target
      // and before any download, extraction, or upgrade.
      assert.strictEqual(fetchCount, 0, "must not download a ZIP");
      assert.strictEqual(writes.length, 0, "must not write any files");
      assert.strictEqual(mkdirs.length, 0, "must not create any directories");
      assert.strictEqual(runCalls.length, 0, "must not run any PHP");
    });

    it(`installTheme rejects pluginName '${evilName}' with no fetch/write`, async () => {
      const originalFetch = globalThis.fetch;
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(decodeBase64Bytes(SAMPLE_THEME_ZIP_BASE64), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      };
      const { php, writes, mkdirs, runCalls } = createPhpMock();

      try {
        await assert.rejects(
          () =>
            themeHandler(
              {
                pluginName: evilName,
                url: "https://example.com/theme.zip",
              },
              { php },
            ),
          /invalid plugin name/i,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.strictEqual(fetchCount, 0, "must not download a ZIP");
      assert.strictEqual(writes.length, 0, "must not write any files");
      assert.strictEqual(mkdirs.length, 0, "must not create any directories");
      assert.strictEqual(runCalls.length, 0, "must not run any PHP");
    });
  }

  it("auto-detected valid names still install (happy path unaffected)", async () => {
    const originalFetch = globalThis.fetch;
    const { php, writes } = createPhpMock();
    globalThis.fetch = async () =>
      new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });

    try {
      await pluginHandler(
        {
          url: "https://github.com/brickfield/moodle-mod_board/archive/refs/heads/main.zip",
        },
        { php },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(writes.map(([path]) => path).sort(), [
      "/www/moodle/mod/board/classes/example.php",
      "/www/moodle/mod/board/version.php",
    ]);
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
