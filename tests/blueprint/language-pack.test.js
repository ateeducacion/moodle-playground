import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";
import { __testables } from "../../src/blueprint/steps/moodle-language.js";

const { normalizeLanguageCodes } = __testables;

function createPhpMock() {
  const runCalls = [];
  return {
    runCalls,
    php: {
      async run(code) {
        runCalls.push(code);
        return { text: '{"ok":true,"installed":["es"],"failed":[]}' };
      },
    },
  };
}

describe("installLanguagePack: code normalization", () => {
  it("accepts a single code", () => {
    assert.deepEqual(normalizeLanguageCodes({ language: "es" }), ["es"]);
  });

  it("accepts a comma-separated string", () => {
    assert.deepEqual(normalizeLanguageCodes({ language: "es, fr ,de" }), [
      "es",
      "fr",
      "de",
    ]);
  });

  it("accepts an array and de-duplicates", () => {
    assert.deepEqual(normalizeLanguageCodes({ language: ["es", "fr", "es"] }), [
      "es",
      "fr",
    ]);
  });

  it("accepts the `languages` and `lang` aliases", () => {
    assert.deepEqual(normalizeLanguageCodes({ languages: ["pt_br"] }), [
      "pt_br",
    ]);
    assert.deepEqual(normalizeLanguageCodes({ lang: "ca" }), ["ca"]);
  });

  it("returns an empty list when nothing is provided", () => {
    assert.deepEqual(normalizeLanguageCodes({}), []);
  });
});

describe("installLanguagePack: handler", () => {
  const handler = getStepHandler("installLanguagePack");

  it("is registered", () => {
    assert.strictEqual(typeof handler, "function");
  });

  it("throws when no language is provided", async () => {
    const { php, runCalls } = createPhpMock();
    await assert.rejects(() => handler({}, { php }), /language' is required/i);
    assert.strictEqual(runCalls.length, 0);
  });

  it("rejects a malicious language code before generating PHP", async () => {
    const { php, runCalls } = createPhpMock();
    await assert.rejects(
      () => handler({ language: "es'); system('id'); //" }, { php }),
      /invalid language code/i,
    );
    // No PHP must have been generated/run for an unsafe code.
    assert.strictEqual(runCalls.length, 0);
  });

  it("rejects an uppercase / hyphenated code (Moodle uses es, pt_br)", async () => {
    const { php } = createPhpMock();
    await assert.rejects(
      () => handler({ language: "pt-BR" }, { php }),
      /invalid language code/i,
    );
  });

  it("calls lang_installer with the requested codes", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ language: ["es", "fr"] }, { php });
    assert.strictEqual(runCalls.length, 1);
    assert.ok(runCalls[0].includes("new lang_installer"));
    assert.ok(runCalls[0].includes("$requested = ['es', 'fr'];"));
    // The dataroot/lang dir must be created up front, otherwise
    // component_installer::check_requisites() throws installer_requisites_check_failed.
    assert.ok(runCalls[0].includes("make_upload_directory('lang');"));
    // Without setDefault, the site language must not be changed.
    assert.ok(!runCalls[0].includes("set_config('lang'"));
  });

  it("sets the site language when setDefault is true", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ language: "es", setDefault: true }, { php });
    assert.ok(runCalls[0].includes("set_config('lang', 'es');"));
  });

  it("repoints users on the previous default when setDefault is true", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ language: "es", setDefault: true }, { php });
    // Setting only the site default is not enough — the snapshot bakes
    // admin.lang='en' and a logged-in user's lang overrides $CFG->lang, so the
    // step must also repoint pre-existing users still on the old default.
    assert.ok(
      runCalls[0].includes("$previousLang = get_config('moodle', 'lang')"),
    );
    assert.ok(
      runCalls[0].includes(
        "$DB->set_field_select('user', 'lang', 'es', 'lang = ? AND deleted = 0', [$previousLang]);",
      ),
    );
  });

  it("does not repoint users when setDefault is omitted", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ language: "es" }, { php });
    assert.ok(!runCalls[0].includes("set_field_select"));
  });

  it("does not throw when lang_installer crashes the runtime", async () => {
    const runCalls = [];
    const php = {
      async run(code) {
        runCalls.push(code);
        throw new Error("Network call failed in WebAssembly runtime");
      },
    };
    // A crashed install is non-fatal — the step resolves without throwing.
    await handler({ language: "es" }, { php });
    assert.strictEqual(runCalls.length, 1);
  });
});
