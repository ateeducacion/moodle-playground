import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

// A captured-call PHP mock that records every php.run() body and writeFile path.
function createPhpMock(runResult = { text: '{"ok":true}', errors: "" }) {
  const runs = [];
  const writes = [];
  return {
    runs,
    writes,
    php: {
      async run(code) {
        runs.push(code);
        return runResult;
      },
      async writeFile(path, data) {
        writes.push({ path, data });
      },
    },
  };
}

// A minimal ResourceRegistry stub returning fixed bytes for any reference.
function createResources(bytes = new Uint8Array([1, 2, 3])) {
  return {
    async resolve() {
      return bytes;
    },
  };
}

describe("setConfigFile / setConfigFiles steps", () => {
  it("registers both steps", () => {
    assert.strictEqual(typeof getStepHandler("setConfigFile"), "function");
    assert.strictEqual(typeof getStepHandler("setConfigFiles"), "function");
  });

  describe("setConfigFile", () => {
    const handler = getStepHandler("setConfigFile");

    function validStep(overrides = {}) {
      return {
        plugin: "theme_adaptable",
        name: "logo",
        filename: "logo.png",
        data: { url: "https://example.com/logo.png" },
        ...overrides,
      };
    }

    it("throws without plugin", async () => {
      await assert.rejects(
        () => handler(validStep({ plugin: undefined }), { php: {} }),
        /plugin/,
      );
    });

    it("throws without name", async () => {
      await assert.rejects(
        () => handler(validStep({ name: undefined }), { php: {} }),
        /name/,
      );
    });

    it("throws without filename", async () => {
      await assert.rejects(
        () => handler(validStep({ filename: undefined }), { php: {} }),
        /filename/,
      );
    });

    it("throws without data", async () => {
      await assert.rejects(
        () => handler(validStep({ data: undefined }), { php: {} }),
        /data/,
      );
    });

    it("resolves the file to a temp path and runs the generated PHP", async () => {
      const { php, runs, writes } = createPhpMock();
      await handler(validStep(), { php, resources: createResources() });
      assert.strictEqual(writes.length, 1);
      assert.ok(writes[0].path.startsWith("/tmp/blueprint-configfile-"));
      assert.strictEqual(runs.length, 1);
      assert.ok(runs[0].includes("context_system::instance()"));
      assert.ok(runs[0].includes("$component = 'theme_adaptable';"));
      // filearea defaults to the setting name
      assert.ok(runs[0].includes("$filearea = 'logo';"));
      assert.ok(
        runs[0].includes(
          "set_config('logo', $filepath . $filename, $component)",
        ),
      );
    });

    it("uses an explicit filearea override", async () => {
      const { php, runs } = createPhpMock();
      await handler(validStep({ filearea: "banner" }), {
        php,
        resources: createResources(),
      });
      assert.ok(runs[0].includes("$filearea = 'banner';"));
    });

    it("omits set_config when setConfigValue is false", async () => {
      const { php, runs } = createPhpMock();
      await handler(validStep({ setConfigValue: false }), {
        php,
        resources: createResources(),
      });
      assert.ok(!runs[0].includes("set_config("));
    });

    it("adds cache purge calls when purgeCaches is true", async () => {
      const { php, runs } = createPhpMock();
      await handler(validStep({ purgeCaches: true }), {
        php,
        resources: createResources(),
      });
      assert.ok(runs[0].includes("purge_all_caches()"));
    });

    it("surfaces a PHP failure as a thrown error", async () => {
      const { php } = createPhpMock({
        text: '{"ok":false,"error":"boom"}',
        errors: "",
      });
      await assert.rejects(
        () => handler(validStep(), { php, resources: createResources() }),
        /boom/,
      );
    });
  });

  describe("setConfigFiles", () => {
    const handler = getStepHandler("setConfigFiles");

    function validStep(overrides = {}) {
      return {
        plugin: "theme_adaptable",
        name: "adaptablemarkettingimages",
        files: [
          { filename: "m1.jpg", data: { url: "https://example.com/m1.jpg" } },
          { filename: "m2.jpg", data: { url: "https://example.com/m2.jpg" } },
        ],
        ...overrides,
      };
    }

    it("throws without plugin", async () => {
      await assert.rejects(
        () => handler(validStep({ plugin: undefined }), { php: {} }),
        /plugin/,
      );
    });

    it("throws without name", async () => {
      await assert.rejects(
        () => handler(validStep({ name: undefined }), { php: {} }),
        /name/,
      );
    });

    it("throws on an empty files array", async () => {
      await assert.rejects(
        () => handler(validStep({ files: [] }), { php: {} }),
        /non-empty array/,
      );
    });

    it("throws when a file is missing filename", async () => {
      await assert.rejects(
        () =>
          handler(validStep({ files: [{ data: { url: "x" } }] }), { php: {} }),
        /filename/,
      );
    });

    it("throws when a file is missing data", async () => {
      await assert.rejects(
        () =>
          handler(validStep({ files: [{ filename: "m1.jpg" }] }), {
            php: {},
            resources: createResources(),
          }),
        /data/,
      );
    });

    it("writes one temp file per entry and stores them in one area", async () => {
      const { php, runs, writes } = createPhpMock();
      await handler(validStep(), { php, resources: createResources() });
      assert.strictEqual(writes.length, 2);
      assert.strictEqual(runs.length, 1);
      assert.ok(runs[0].includes("'filename'=>'m1.jpg'"));
      assert.ok(runs[0].includes("'filename'=>'m2.jpg'"));
      assert.ok(runs[0].includes("'count' => $stored"));
      // filearea defaults to the setting name
      assert.ok(runs[0].includes("$filearea = 'adaptablemarkettingimages';"));
    });
  });
});
