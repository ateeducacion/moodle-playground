import assert from "node:assert/strict";
import { it } from "node:test";
import { runSiteLanguageConfigure } from "../../src/runtime/bootstrap.js";

it("does not overwrite a retained site's language with the installation locale", async () => {
  const php = {
    run: async () => {
      throw new Error("Must not modify retained language");
    },
  };
  const result = await runSiteLanguageConfigure(php, "es", true);
  assert.equal(result.action, "skipped");
});

it("still applies a non-English installation locale on a fresh boot", async () => {
  let code;
  const result = await runSiteLanguageConfigure(
    {
      run: async (script) => {
        code = script;
        return { text: '{"ok":true,"action":"applied","lang":"es"}' };
      },
    },
    "es",
    false,
  );
  assert.equal(result.action, "applied");
  assert.match(code, /set_config\('lang', \$lang\)/);
  assert.match(code, /\$lang = 'es'/);
});
