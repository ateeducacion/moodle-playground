import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeArchivePath } from "../../lib/moodle-loader.js";
import {
  getRegisteredStepNames,
  getStepHandler,
} from "../../src/blueprint/steps/index.js";

// A small but valid ZIP (shared with moodle-plugins.test.js) used to drive the
// plugin install handler past the download/extract phase into runMoodleUpgrade
// (where plugin-name validation lives) without hitting the network.
const SAMPLE_PLUGIN_ZIP_BASE64 =
  "UEsDBBQAAAAIAHcBgVyusmujBwAAAAUAAAAhAAAAbW9vZGxlLW1vZF9ib2FyZC1tYWluL3ZlcnNpb24ucGhws7EvyCgAAFBLAwQUAAAACAB3AYFczmE/Ew8AAAANAAAAKQAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi9jbGFzc2VzL2V4YW1wbGUucGhws7EvyChQSE3OyFcwtAYAUEsBAhQDFAAAAAgAdwGBXK6ya6MHAAAABQAAACEAAAAAAAAAAAAAAIABAAAAAG1vb2RsZS1tb2RfYm9hcmQtbWFpbi92ZXJzaW9uLnBocFBLAQIUAxQAAAAIAHcBgVzOYT8TDwAAAA0AAAApAAAAAAAAAAAAAACAAUYAAABtb29kbGUtbW9kX2JvYXJkLW1haW4vY2xhc3Nlcy9leGFtcGxlLnBocFBLBQYAAAAAAgACAKYAAACcAAAAAAA=";

function decodeBase64Bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

describe("step registry", () => {
  it("has all expected step names registered", () => {
    const expected = [
      "installMoodle",
      "setAdminAccount",
      "login",
      "setConfig",
      "setConfigs",
      "setTheme",
      "setLandingPage",
      "createUser",
      "createUsers",
      "createCategory",
      "createCategories",
      "createCourse",
      "createCourses",
      "createSection",
      "createSections",
      "enrolUser",
      "enrolUsers",
      "addModule",
      "installMoodlePlugin",
      "installTheme",
      "installLanguagePack",
      "mkdir",
      "rmdir",
      "writeFile",
      "writeFiles",
      "copyFile",
      "moveFile",
      "unzip",
      "request",
      "runPhpCode",
      "runPhpScript",
    ];
    const registered = getRegisteredStepNames();
    for (const name of expected) {
      assert.ok(registered.includes(name), `Missing step: ${name}`);
    }
  });

  it("returns null for unknown steps", () => {
    assert.strictEqual(getStepHandler("doesNotExist"), null);
  });

  it("returns functions for known steps", () => {
    const handler = getStepHandler("login");
    assert.strictEqual(typeof handler, "function");
  });

  it("installMoodle handler is a no-op", async () => {
    const handler = getStepHandler("installMoodle");
    // Should not throw
    await handler({}, {});
  });

  it("setLandingPage returns landingPage", async () => {
    const handler = getStepHandler("setLandingPage");
    const result = await handler({ path: "/course/view.php" }, {});
    assert.strictEqual(result.landingPage, "/course/view.php");
  });

  it("setLandingPage throws without path", async () => {
    const handler = getStepHandler("setLandingPage");
    await assert.rejects(() => handler({}, {}), /path/);
  });

  it("setTheme is registered", () => {
    const handler = getStepHandler("setTheme");
    assert.strictEqual(typeof handler, "function");
  });

  it("setTheme throws without name", async () => {
    const handler = getStepHandler("setTheme");
    await assert.rejects(
      () => handler({}, { php: { run: async () => ({}) } }),
      /name/,
    );
  });

  it("setTheme runs php.run with a set_config('theme', ...) script", async () => {
    const handler = getStepHandler("setTheme");
    const calls = [];
    await handler(
      { name: "moove" },
      {
        php: {
          async run(code) {
            calls.push(code);
            return { text: '{"ok":true}' };
          },
        },
      },
    );
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].includes("set_config('theme', 'moove'"));
    assert.ok(calls[0].includes("theme_reset_all_caches"));
  });
});

describe("sanitizeArchivePath (ZIP-slip prevention)", () => {
  it("passes through a normal relative path unchanged", () => {
    assert.strictEqual(sanitizeArchivePath("a/b/c.php"), "a/b/c.php");
  });

  it("drops '.' and empty segments", () => {
    assert.strictEqual(sanitizeArchivePath("./a//b/./c"), "a/b/c");
  });

  it("returns null for an empty or dot-only path", () => {
    assert.strictEqual(sanitizeArchivePath(""), null);
    assert.strictEqual(sanitizeArchivePath("."), null);
    assert.strictEqual(sanitizeArchivePath("./"), null);
  });

  it("throws on a leading '..' traversal", () => {
    assert.throws(
      () => sanitizeArchivePath("../etc/passwd"),
      /path traversal/i,
    );
  });

  it("throws on an embedded '..' segment", () => {
    assert.throws(() => sanitizeArchivePath("a/../../b"), /path traversal/i);
  });

  it("does not treat '..' inside a filename as traversal", () => {
    // Only a whole segment equal to ".." is traversal; "..foo" is a real name.
    assert.strictEqual(sanitizeArchivePath("a/..foo/b"), "a/..foo/b");
  });
});

describe("unzip step handler (ZIP-slip containment)", () => {
  const handler = getStepHandler("unzip");

  function createPhpMock() {
    const writes = [];
    const rawPhp = {
      mkdirTree() {},
      writeFile(path, data) {
        writes.push([path, data]);
      },
    };
    return { writes, php: { _php: rawPhp } };
  }

  it("only writes entries that stay within the destination", async () => {
    const { php, writes } = createPhpMock();
    // Stub the resolved entries by intercepting resources.resolve to return
    // ZIP bytes, then rely on readZipEntries' own sanitization. The known-good
    // sample ZIP extracts two safe entries under a top-level dir.
    const resources = {
      async resolve() {
        return decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64);
      },
    };

    await handler(
      { destination: "/persist/moodledata/unzipped", data: "@dummy" },
      { php, resources },
    );

    // Every written path must be under the destination prefix.
    for (const [path] of writes) {
      assert.ok(
        path.startsWith("/persist/moodledata/unzipped/"),
        `Write escaped destination: ${path}`,
      );
    }
    assert.ok(writes.length > 0, "expected at least one safe write");
  });
});

describe("installMoodlePlugin plugin-name validation (code injection guard)", () => {
  const handler = getStepHandler("installMoodlePlugin");

  function createPhpMock() {
    const runCalls = [];
    const rawPhp = {
      mkdirTree() {},
      writeFile() {},
    };
    return {
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

  it("rejects a malicious pluginName before generating upgrade PHP", async () => {
    const originalFetch = globalThis.fetch;
    const { php, runCalls } = createPhpMock();
    globalThis.fetch = async () =>
      new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });

    try {
      await assert.rejects(
        () =>
          handler(
            {
              pluginType: "mod",
              pluginName: "evil', 'x'); evil();//",
              url: "https://example.com/plugin.zip",
            },
            { php },
          ),
        /invalid plugin name/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The upgrade script must never have been generated/run for a bad name.
    assert.strictEqual(runCalls.length, 0);
  });

  it("accepts a valid frankenstyle pluginName", async () => {
    const originalFetch = globalThis.fetch;
    const { php, runCalls } = createPhpMock();
    globalThis.fetch = async () =>
      new Response(decodeBase64Bytes(SAMPLE_PLUGIN_ZIP_BASE64), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });

    try {
      await handler(
        {
          pluginType: "mod",
          pluginName: "board",
          url: "https://example.com/plugin.zip",
        },
        { php },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Upgrade ran, and the generated component string is exactly mod_board.
    assert.strictEqual(runCalls.length, 1);
    assert.ok(
      runCalls[0].includes(
        "playground_refresh_installed_plugin_cache('mod_board'",
      ),
    );
  });
});
