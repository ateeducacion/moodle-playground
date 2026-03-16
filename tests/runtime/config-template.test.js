import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMoodleConfigPhp,
  createPhpIniEntries,
  MOODLE_ROOT,
  MOODLEDATA_ROOT,
  TEMP_ROOT,
} from "../../src/runtime/config-template.js";

describe("createMoodleConfigPhp", () => {
  const baseParams = {
    adminDirectory: "admin",
    moodleRoot: MOODLE_ROOT,
    dbFile: "/persist/moodledata/moodle_main_php83.sq3.php",
    dbHost: "localhost",
    dbName: "moodle_main_php83",
    dbPassword: "",
    dbUser: "",
    prefix: "mdl_",
    wwwroot: "https://example.com/playground",
  };

  it("generates valid PHP starting with <?php", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.startsWith("<?php"));
  });

  it("sets correct dbtype", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("$CFG->dbtype = 'sqlite3'"));
  });

  it("sets correct wwwroot", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("https://example.com/playground"));
  });

  it("sets correct dataroot", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes(`$CFG->dataroot = '${MOODLEDATA_ROOT}'`));
  });

  it("sets correct admin directory", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("$CFG->admin = 'admin'"));
  });

  it("escapes single quotes in wwwroot", () => {
    const config = createMoodleConfigPhp({
      ...baseParams,
      wwwroot: "http://it's-a-test.com",
    });
    assert.ok(config.includes("it\\'s-a-test.com"));
    assert.ok(!config.includes("it's-a-test.com"));
  });

  it("escapes backslashes", () => {
    const config = createMoodleConfigPhp({
      ...baseParams,
      dbFile: "C:\\path\\to\\db",
    });
    assert.ok(config.includes("C:\\\\path\\\\to\\\\db"));
  });

  it("includes CACHE_DISABLE_ALL", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("CACHE_DISABLE_ALL"));
  });

  it("disables debug by default", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("$CFG->debug = 0"));
  });

  it("requires lib/setup.php", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("require_once"));
    assert.ok(config.includes("lib/setup.php"));
  });

  it("sets database file path in dboptions", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes(baseParams.dbFile));
  });

  it("includes fallback autoloader", () => {
    const config = createMoodleConfigPhp(baseParams);
    assert.ok(config.includes("spl_autoload_register"));
  });
});

describe("createPhpIniEntries", () => {
  it("returns an object with required keys", () => {
    const entries = createPhpIniEntries();
    assert.ok(entries["date.timezone"]);
    assert.ok(entries.memory_limit);
    assert.ok(entries.upload_max_filesize);
    assert.ok(entries["session.save_handler"]);
  });

  it("defaults timezone to UTC", () => {
    const entries = createPhpIniEntries();
    assert.strictEqual(entries["date.timezone"], "UTC");
  });

  it("accepts custom timezone", () => {
    const entries = createPhpIniEntries({ timezone: "Europe/Madrid" });
    assert.strictEqual(entries["date.timezone"], "Europe/Madrid");
  });

  it("disables display_errors", () => {
    const entries = createPhpIniEntries();
    assert.strictEqual(entries.display_errors, "0");
  });

  it("sets temp dir to TEMP_ROOT", () => {
    const entries = createPhpIniEntries();
    assert.strictEqual(entries.sys_temp_dir, TEMP_ROOT);
  });

  it("sets session save path under TEMP_ROOT", () => {
    const entries = createPhpIniEntries();
    assert.ok(entries["session.save_path"].startsWith(TEMP_ROOT));
  });
});
