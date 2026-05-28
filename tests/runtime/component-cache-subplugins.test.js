import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_PATH = fileURLToPath(
  new URL("../../src/runtime/bootstrap.js", import.meta.url),
);
const BOOTSTRAP_SOURCE = readFileSync(BOOTSTRAP_PATH, "utf8");

/**
 * Anchor the PHP patch applied to core_component.php so the subplugin-refresh
 * logic does not silently regress.
 *
 * Background: `playground_refresh_installed_plugin_cache()` is patched into
 * core_component by bootstrap.js after a plugin is installed via
 * `installMoodlePlugin`. The prebuilt alternative_component_cache was
 * generated before the plugin existed, so it has no mapping for the plugin or
 * for any subplugin types the plugin declares in `db/subplugins.json`.
 *
 * Without subplugin handling, plugins like mod_customcert (which ships
 * `customcertelement_*` subplugins) install successfully but every later
 * `class_exists('\customcertelement_text\element')` returns false, and
 * `customcert_add_instance()` fails with
 *   "Cannot register element type 'text': class ... does not exist".
 *
 * The same bug affects every Moodle plugin with subplugins: mod_quiz
 * (quizaccess_*), mod_assign (assignsubmission_*), mod_workshop (workshopform_*),
 * mod_qbank, etc.
 */
describe("playground_refresh_installed_plugin_cache PHP patch", () => {
  it("declares the public entry point that bootstrap.js patches in", () => {
    assert.match(
      BOOTSTRAP_SOURCE,
      /public static function playground_refresh_installed_plugin_cache\(/,
      "Expected the public entry point to exist in the patch.",
    );
  });

  it("processes db/subplugins.json after refreshing the parent plugin", () => {
    assert.match(
      BOOTSTRAP_SOURCE,
      /playground_refresh_subplugin_types\(/,
      "Expected the subplugin-types refresh to be wired in.",
    );
    assert.match(
      BOOTSTRAP_SOURCE,
      /db\/subplugins\.json/,
      "Expected the patch to read db/subplugins.json from the parent plugin.",
    );
  });

  it("supports the modern 'plugintypes' format (paths relative to dirroot)", () => {
    assert.match(
      BOOTSTRAP_SOURCE,
      /\$decoded\['plugintypes'\]/,
      "Expected the patch to read the modern 'plugintypes' key from subplugins.json.",
    );
    assert.match(
      BOOTSTRAP_SOURCE,
      /\$CFG->dirroot/,
      "Expected modern subplugin paths to be resolved against \\$CFG->dirroot.",
    );
  });

  it("supports the legacy 'subplugintypes' format (paths relative to parent dir)", () => {
    assert.match(
      BOOTSTRAP_SOURCE,
      /\$decoded\['subplugintypes'\]/,
      "Expected the patch to also accept the legacy 'subplugintypes' key.",
    );
  });

  it("registers discovered subplugins via the in-memory refresh helper", () => {
    assert.match(
      BOOTSTRAP_SOURCE,
      /protected static function playground_refresh_plugin_inmemory\(/,
      "Expected the in-memory refresh helper used to avoid rewriting the cache file per subplugin.",
    );
    assert.match(
      BOOTSTRAP_SOURCE,
      /playground_refresh_plugin_inmemory\(\$subcomponent, \$subdir\)/,
      "Expected each discovered subplugin to be refreshed via the in-memory helper.",
    );
  });

  it("only discovers subplugins that ship a version.php", () => {
    assert.match(
      BOOTSTRAP_SOURCE,
      /version\.php/,
      "Expected the patch to require version.php in each subplugin directory.",
    );
  });

  it("writes the alternative_component_cache exactly once per install", () => {
    const writes = BOOTSTRAP_SOURCE.match(
      /file_put_contents\(\$CFG->alternative_component_cache,/g,
    );
    assert.ok(
      writes && writes.length === 1,
      `Expected exactly one cache-file write in the patch, found ${writes ? writes.length : 0}.`,
    );
  });
});
