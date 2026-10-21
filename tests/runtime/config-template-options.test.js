import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildComponentCachePath,
  CHDIR_FIX_PRELOAD_PATH,
  createChdirFixPhp,
  createMoodleConfigPhp,
  createPhpIniEntries,
} from "../../src/runtime/config-template.js";

const base = {
  dbFile: "/persist/moodledata/m.sq3.php",
  dbHost: "localhost",
  dbName: "m",
  dbPassword: "",
  dbUser: "",
  prefix: "mdl_",
  wwwroot: "https://example.test",
};

describe("createMoodleConfigPhp phpConstants", () => {
  it("defines valid constants with PHP literals before lib/setup.php", () => {
    const php = createMoodleConfigPhp({
      ...base,
      phpConstants: {
        MY_FLAG: true,
        OFF_FLAG: false,
        LIMIT: 42,
        LABEL: "it's",
        "bad-name": "x",
        lower: "y",
      },
    });
    assert.match(php, /define\('MY_FLAG', true\);/);
    assert.match(php, /define\('OFF_FLAG', false\);/);
    assert.match(php, /define\('LIMIT', 42\);/);
    assert.match(php, /define\('LABEL', 'it\\'s'\);/);
    assert.match(php, /if \(!defined\('LIMIT'\)\) \{/);
    // Invalid names never reach the generated PHP.
    assert.doesNotMatch(php, /bad-name|'lower'/);
    assert.ok(php.indexOf("define('MY_FLAG'") < php.indexOf("lib/setup.php"));
  });

  it("emits no define blocks for a missing, non-object or all-invalid map", () => {
    const plain = createMoodleConfigPhp(base);
    for (const phpConstants of [null, "MY_FLAG", { "0BAD": 1 }]) {
      assert.equal(createMoodleConfigPhp({ ...base, phpConstants }), plain);
    }
  });
});

describe("createMoodleConfigPhp debug display and paths", () => {
  it("shows debug output only when debugdisplay is set", () => {
    const shown = createMoodleConfigPhp({ ...base, debugdisplay: 1 });
    assert.match(shown, /\$CFG->debugdisplay = 1;/);
    assert.match(shown, /define\('NO_DEBUG_DISPLAY', false\)/);
    const hidden = createMoodleConfigPhp({ ...base, debugdisplay: "0" });
    assert.match(hidden, /\$CFG->debugdisplay = 0;/);
    assert.match(hidden, /define\('NO_DEBUG_DISPLAY', true\)/);
  });

  it("derives the component cache from the Moodle root when not given", () => {
    const php = createMoodleConfigPhp({
      ...base,
      moodleRoot: "/www/moodle/public",
    });
    assert.equal(
      buildComponentCachePath("/www/moodle/public"),
      "/www/moodle/public/.playground/core_component.php",
    );
    assert.match(
      php,
      /alternative_component_cache = '\/www\/moodle\/public\/\.playground\/core_component\.php'/,
    );
    assert.match(
      php,
      /require_once\('\/www\/moodle\/public\/lib\/setup\.php'\)/,
    );
  });
});

describe("createPhpIniEntries", () => {
  it("turns error display on for debugdisplay runtimes", () => {
    const ini = createPhpIniEntries({
      timezone: "Europe/Madrid",
      debugdisplay: 1,
    });
    assert.equal(ini["date.timezone"], "Europe/Madrid");
    assert.equal(ini.display_errors, "1");
    assert.equal(ini.display_startup_errors, "1");
    assert.equal(createPhpIniEntries().display_errors, "0");
  });
});

describe("createChdirFixPhp", () => {
  it("chdirs to the script directory and installs a guarded glob fallback", () => {
    assert.equal(
      CHDIR_FIX_PRELOAD_PATH,
      "/internal/shared/preload/moodle_chdir.php",
    );
    const php = createChdirFixPhp();
    assert.ok(php.startsWith("<?php"));
    assert.match(php, /chdir\(\$dir\)/);
    // The polyfill is declared once even if the preload runs twice.
    assert.match(
      php,
      /if \(!function_exists\('playground_glob_polyfill_installed'\)\)/,
    );
    assert.match(
      php,
      /function playground_glob\(string \$pattern, int \$flags = 0\): array/,
    );
    // The template literal must emit a single backslash for the global glob().
    assert.match(php, /@\\glob\(\$pattern, \$flags\)/);
    assert.match(php, /fnmatch\(\$mask, \$entry\)/);
  });
});
