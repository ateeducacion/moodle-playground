import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { getStepHandler } from "../../src/blueprint/steps/index.js";
import { __testables } from "../../src/blueprint/steps/moodle-plugins.js";

// Handler tests without a php mock must stop at the download step, offline.
// Tests that need a successful download install their own fetch mock.
const NETWORK_DISABLED = /network disabled in tests/;
const realFetch = globalThis.fetch;
const realRetryDelays = [...__testables.retryDelaysMs];
before(() => {
  globalThis.fetch = async () => {
    throw new Error("network disabled in tests");
  };
  // Thrown download errors are retried with backoff; do not wait for it here.
  __testables.retryDelaysMs.fill(0);
});
after(() => {
  globalThis.fetch = realFetch;
  __testables.retryDelaysMs.splice(0, Infinity, ...realRetryDelays);
});

const SAMPLE_PLUGIN_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAhAAAAbW9vZGxlLW1vZF9ib2FyZC1tYWluL3ZlcnNpb24ucGhws7EvyCgAAFBLAwQUAAAACAB3AYFczmE/Ew8AAAANAAAAKQAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi9jbGFzc2VzL2V4YW1wbGUucGhws7EvyChQSE3OyFcwtAYAUEsBAhQDFAAAAAgAdwGBXK6ya6MHAAAABQAAACEAAAAAAAAAAAAAAIABAAAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi92ZXJzaW9uLnBocFBLAQIUAxQAAAAIAHcBgVzOYT8TDwAAAA0AAAApAAAAAAAAAAAAAACAAUYAAABtb29kbGUtbW9kX2JvYXJkLW1haW4vY2xhc3Nlcy9leGFtcGxlLnBocFBLBQYAAAAAAgACAKYAAACcAAAAAAA=";
const SAMPLE_THEME_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAeAAAAdGhlbWVfbW9vdmUtbWFzdGVyL3ZlcnNpb24ucGhws7EvyCgAAFBLAQIUAxQAAAAIAHcBgVyusmujBwAAAAUAAAAeAAAAAAAAAAAAAACAAQAAAAB0aGVtZV9tb292ZS1tYXN0ZXIvdmVyc2lvbi5waHBQSwUGAAAAAAEAAQBMAAAAQwAAAAAA";

// Serve one ZIP for every download and count them; restores the offline stub.
async function withPluginDownload(fn) {
  const offline = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = offline;
  }
  return fetched;
}

it("downloads a plugin again on reload, keeps no copy and does not upgrade the DB", async () => {
  let code;
  const files = [];
  const fetched = await withPluginDownload(() =>
    getStepHandler("installMoodlePlugin")(
      {
        pluginType: "mod",
        pluginName: "board",
        url: "https://example.invalid/moving.zip",
      },
      {
        restoreOnly: true,
        php: {
          // No archive copy is read from or written to /persist (ADR-0036).
          readFile: async () => assert.fail("must not read a saved copy"),
          writeFile: async () => assert.fail("must not save a copy"),
          _php: { mkdirTree() {}, writeFile: (path) => files.push(path) },
          run: async (script) => {
            code = script;
            return { text: '{"ok":true}' };
          },
        },
      },
    ),
  );
  assert.deepEqual(fetched, ["https://example.invalid/moving.zip"]);
  assert.ok(files.includes("/www/moodle/mod/board/version.php"));
  assert.match(code, /reset_caches\(\)/);
  const restoreCode = code.slice(0, code.indexOf("return;"));
  assert.match(restoreCode, /cache_helper::purge_all\(\)/);
  assert.match(restoreCode, /localcachedir .*hookcallbacks\.php/);
  assert.match(restoreCode, /cachedir .*hookcallbacks\.php/);
  assert.ok(code.indexOf("return;") < code.indexOf("upgrade_noncore(true)"));
});

it("surfaces a failed plugin upgrade so it cannot receive a successful checkpoint", async () => {
  await assert.rejects(
    withPluginDownload(() =>
      getStepHandler("installMoodlePlugin")(
        {
          pluginType: "mod",
          pluginName: "board",
          url: "https://example.invalid/plugin.zip",
        },
        {
          restoreOnly: true,
          php: {
            _php: { mkdirTree() {}, writeFile() {} },
            run: async () => ({
              text: '{"ok":false,"error":"fixture failure"}',
            }),
          },
        },
      ),
    ),
    /registration did not complete/,
  );
});

function decodeBase64Bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pluginZip = (version, extra = {}) =>
  zipSync({
    "plugin-main/version.php": strToU8(`<?php $plugin->version = ${version};`),
    ...Object.fromEntries(
      Object.entries(extra).map(([name, text]) => [
        `plugin-main/${name}`,
        strToU8(text),
      ]),
    ),
  });
const STEP = {
  pluginType: "local",
  pluginName: "drift",
  url: "https://example.invalid/plugin.zip",
};

// A completed plugin step on a persisted reload (ADR-0037): the registry
// query answers with the installed version, every other PHP run succeeds.
function reloadContext({ archives, installedVersion = "2026101600" }) {
  const files = [];
  const scripts = [];
  const messages = [];
  let saves = 0;
  const checkpoint = {
    fingerprint: "f",
    resuming: true,
    completed: new Set([3]),
    archives,
    save: async () => {
      saves++;
    },
  };
  const context = {
    restoreOnly: true,
    previouslyCompleted: true,
    dbFile: "/persist/db",
    stepIndex: 3,
    checkpoint,
    publish: (message) => messages.push(message),
    php: {
      _php: { mkdirTree() {}, writeFile: (path) => files.push(path) },
      run: async (code) => {
        scripts.push(code);
        return {
          text: code.includes("mdl_config_plugins")
            ? JSON.stringify(installedVersion)
            : '{"ok":true}',
        };
      },
    },
  };
  return { context, files, scripts, messages, saves: () => saves };
}

async function serving(zip, fn) {
  const offline = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(zip);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = offline;
  }
  return calls;
}

it("records the archive hash on first install so the checkpoint can verify reloads", async () => {
  const zip = pluginZip(2026101600);
  const archives = new Map();
  await serving(zip, () =>
    getStepHandler("installMoodlePlugin")(STEP, {
      stepIndex: 2,
      checkpoint: {
        resuming: false,
        archives,
        save: async () => assert.fail("the executor saves completed steps"),
      },
      php: {
        _php: { mkdirTree() {}, writeFile() {} },
        run: async () => ({ text: '{"ok":true}' }),
      },
    }),
  );
  assert.deepEqual([...archives], [[2, sha256Hex(zip)]]);
});

it("reload with the same archive restores it without warnings", async () => {
  const zip = pluginZip(2026101600);
  const fixture = reloadContext({ archives: new Map([[3, sha256Hex(zip)]]) });
  await serving(zip, () =>
    getStepHandler("installMoodlePlugin")(STEP, fixture.context),
  );
  assert.ok(fixture.files.includes("/www/moodle/local/drift/version.php"));
  assert.equal(fixture.saves(), 0);
  assert.ok(!fixture.messages.some((m) => /changed|newer/.test(m)));
  const restore = fixture.scripts.at(-1);
  assert.doesNotMatch(
    restore.slice(0, restore.indexOf("return;")),
    /allversionshash/,
  );
});

it("reload with a changed archive but no newer version warns and does not extract it", async () => {
  const installed = pluginZip(2026101600);
  const changed = pluginZip(2026101600, { "lib.php": "<?php // edited" });
  const fixture = reloadContext({
    archives: new Map([[3, sha256Hex(installed)]]),
  });
  const result = await (async () => {
    let value;
    await serving(changed, async () => {
      value = await getStepHandler("installMoodlePlugin")(
        STEP,
        fixture.context,
      );
    });
    return value;
  })();
  assert.deepEqual(result, { skipped: true });
  assert.deepEqual(fixture.files, []);
  assert.equal(fixture.scripts.length, 1, "only the registry query ran");
  assert.equal(fixture.saves(), 0);
  const warning = fixture.messages.find((m) => /changed since/.test(m));
  assert.match(warning, /local_drift/);
  assert.match(warning, /https:\/\/example\.invalid\/plugin\.zip/);
  assert.match(warning, /archive version 2026101600, installed 2026101600/);
});

it("reload with an older archive than the persisted DB warns and does not extract it", async () => {
  const older = pluginZip(2026101500);
  const fixture = reloadContext({
    archives: new Map([[3, sha256Hex(pluginZip(2026101600))]]),
  });
  await serving(older, () =>
    getStepHandler("installMoodlePlugin")(STEP, fixture.context),
  );
  assert.deepEqual(fixture.files, []);
  assert.ok(fixture.messages.some((m) => /changed since/.test(m)));
});

it("reload with a newer archive installs it, warns and makes Moodle ask for the upgrade", async () => {
  const newer = pluginZip(2026101601);
  const archives = new Map([[3, sha256Hex(pluginZip(2026101600))]]);
  const fixture = reloadContext({ archives });
  await serving(newer, () =>
    getStepHandler("installMoodlePlugin")(STEP, fixture.context),
  );
  assert.ok(fixture.files.includes("/www/moodle/local/drift/version.php"));
  const warning = fixture.messages.find((m) => /newer than/.test(m));
  assert.match(warning, /2026101601 > 2026101600/);
  assert.match(warning, /run the Moodle upgrade/);
  const restore = fixture.scripts.at(-1);
  const restoreCode = restore.slice(0, restore.indexOf("return;"));
  assert.match(restoreCode, /set_config\('allversionshash', ''\)/);
  assert.doesNotMatch(restoreCode, /upgrade_noncore/);
  assert.equal(fixture.saves(), 1, "the accepted archive hash is persisted");
  assert.equal(archives.get(3), sha256Hex(newer));
});

it("reload with a checkpoint that predates archive hashes adopts the current archive", async () => {
  const zip = pluginZip(2026101600);
  const archives = new Map();
  const fixture = reloadContext({ archives });
  await serving(zip, () =>
    getStepHandler("installMoodlePlugin")(STEP, fixture.context),
  );
  assert.ok(fixture.files.includes("/www/moodle/local/drift/version.php"));
  assert.equal(fixture.saves(), 1);
  assert.equal(archives.get(3), sha256Hex(zip));
  assert.ok(!fixture.messages.some((m) => /changed|newer/.test(m)));
});

it("retries a thrown download error and then installs", async () => {
  const offline = globalThis.fetch;
  let calls = 0;
  const messages = [];
  globalThis.fetch = async () => {
    if (++calls < 3) throw new TypeError("Failed to fetch");
    return new Response(pluginZip(2026101600));
  };
  try {
    await getStepHandler("installMoodlePlugin")(STEP, {
      publish: (message) => messages.push(message),
      php: {
        _php: { mkdirTree() {}, writeFile() {} },
        run: async () => ({ text: '{"ok":true}' }),
      },
    });
  } finally {
    globalThis.fetch = offline;
  }
  assert.equal(calls, 3);
  assert.equal(
    messages.filter((m) => /retrying in/.test(m)).length,
    2,
    "each retry is announced",
  );
});

it("gives up after bounded retries with a message naming the archive", async () => {
  const offline = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  };
  try {
    await assert.rejects(
      () => getStepHandler("installMoodlePlugin")(STEP, {}),
      /Failed to download plugin ZIP from https:\/\/example\.invalid\/plugin\.zip: Failed to fetch\. Check the network and the addon proxy, then reload when online\./,
    );
  } finally {
    globalThis.fetch = offline;
  }
  assert.equal(calls, 1 + __testables.retryDelaysMs.length);
});

it("does not retry a definitive HTTP error", async () => {
  const offline = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("missing", { status: 404 });
  };
  try {
    await assert.rejects(
      () => getStepHandler("installMoodlePlugin")(STEP, {}),
      /plugin\.zip: HTTP 404\./,
    );
  } finally {
    globalThis.fetch = offline;
  }
  assert.equal(calls, 1);
});

it("reads the plugin version from the archive's root version.php", () => {
  const entries = (files) =>
    Object.entries(files).map(([path, text]) => ({
      path,
      data: strToU8(text),
    }));
  const { readPluginVersion } = __testables;
  assert.equal(
    readPluginVersion(
      entries({
        "repo-main/version.php": "<?php\n$plugin->version   = 2024042200.01;",
        "repo-main/sub/version.php": "<?php $plugin->version = 1;",
      }),
      "repo-main/",
    ),
    "2024042200.01",
  );
  assert.equal(
    readPluginVersion(
      entries({ "version.php": "<?php $plugin->version='2026101600';" }),
      "",
    ),
    "2026101600",
  );
  assert.equal(readPluginVersion(entries({ "lib.php": "<?php" }), ""), null);
});

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

describe("plugin upgrade reporting", () => {
  const install = (run, publish) =>
    getStepHandler("installMoodlePlugin")(
      {
        pluginType: "local",
        pluginName: "flat",
        url: "https://example.invalid/p.zip",
      },
      {
        restoreOnly: true,
        publish,
        php: { _php: { mkdirTree() {}, writeFile() {} }, run },
      },
    );

  it("publishes and rethrows an upgrade crash", async () => {
    const messages = [];
    await assert.rejects(
      serving(zipSync({ "version.php": strToU8("<?php") }), () =>
        install(
          async () => {
            throw new Error("exit(1)");
          },
          (m) => messages.push(m),
        ),
      ),
      /exit\(1\)/,
    );
    assert.ok(messages.includes("Plugin upgrade crashed: exit(1)"));
  });

  it("publishes PHP errors and an ok:false payload before failing", async () => {
    const messages = [];
    await assert.rejects(
      serving(pluginZip(1), () =>
        install(
          async () => ({
            text: '{"ok":false,"error":"x"}',
            errors: "Warning: y",
          }),
          (m) => messages.push(m),
        ),
      ),
      /registration did not complete/,
    );
    assert.ok(messages.includes("Plugin upgrade errors: Warning: y"));
    assert.ok(
      messages.some((m) => m.startsWith('Plugin upgrade failed: {"ok":false')),
    );
  });
});

describe("plugin URL helpers", () => {
  it("parses GitHub archive URLs in all supported shapes", () => {
    const { parseGitHubUrl } = __testables;
    assert.deepEqual(
      parseGitHubUrl("https://github.com/o/r/archive/refs/heads/feat/x.zip"),
      {
        owner: "o",
        repo: "r",
        ref: "feat/x",
      },
    );
    assert.deepEqual(
      parseGitHubUrl("https://github.com/o/r/archive/refs/tags/v1.zip"),
      {
        owner: "o",
        repo: "r",
        ref: "v1",
      },
    );
    assert.deepEqual(
      parseGitHubUrl("https://github.com/o/r/archive/main.zip"),
      {
        owner: "o",
        repo: "r",
        ref: "main",
      },
    );
    assert.equal(parseGitHubUrl("https://github.com/o/r"), null);
    assert.equal(
      parseGitHubUrl("https://gitlab.com/o/r/archive/main.zip"),
      null,
    );
    assert.equal(parseGitHubUrl("not a url"), null);
  });

  it("finds a shared root folder only when every entry has it", () => {
    const { findCommonPrefix } = __testables;
    assert.equal(findCommonPrefix([]), "");
    assert.equal(findCommonPrefix(["version.php"]), "");
    assert.equal(findCommonPrefix(["a/x", "a/y"]), "a/");
    assert.equal(findCommonPrefix(["a/x", "b/y"]), "");
  });

  it("keeps the original URL for an invalid proxy base or URL", () => {
    const zip = "https://github.com/o/r/archive/main.zip";
    assert.equal(
      __testables.resolvePluginZipDownloadUrl(zip, { addonProxyUrl: "::bad" }),
      zip,
    );
    assert.equal(__testables.shouldProxyZipUrl("::bad"), false);
    assert.equal(__testables.resolveAddonProxyUrl({ addonProxyUrl: "  " }), "");
  });
});
