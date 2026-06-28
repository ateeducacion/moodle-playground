import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapePhp,
  phpAddModule,
  phpCreateCategory,
  phpCreateCourse,
  phpCreateUser,
  phpCreateUsers,
  phpEnrolUser,
  phpLogin,
  phpPurgeMoodleCaches,
  phpRunCoreUpgrade,
  phpSetAdminAccount,
  phpSetConfig,
  phpSetConfigFile,
  phpSetConfigFiles,
  phpSetConfigs,
  phpSetTheme,
} from "../../src/blueprint/php/helpers.js";

describe("PHP helpers: CLI header", () => {
  it("all CLI scripts define CLI_SCRIPT", () => {
    const scripts = [
      phpCreateUser({ username: "test" }),
      phpCreateCategory({ name: "Cat" }),
      phpCreateCourse({ fullname: "C", shortname: "C1" }),
      phpEnrolUser({ username: "u", course: "c" }),
      phpSetConfig("key", "val"),
    ];
    for (const script of scripts) {
      assert.ok(
        script.includes("define('CLI_SCRIPT', true)"),
        "Script must define CLI_SCRIPT",
      );
    }
  });

  it("all CLI scripts require config.php with absolute path", () => {
    const scripts = [
      phpCreateUser({ username: "test" }),
      phpSetConfig("key", "val"),
    ];
    for (const script of scripts) {
      assert.ok(
        script.includes("require('/www/moodle/config.php')"),
        "Script must use absolute path to config.php",
      );
    }
  });

  it("login script uses absolute config.php path too", () => {
    const script = phpLogin("admin");
    assert.ok(script.includes("require('/www/moodle/config.php')"));
  });
});

describe("PHP helpers: escaping", () => {
  it("escapes single quotes in user values", () => {
    const script = phpCreateUser({
      username: "test",
      firstname: "O'Brien",
    });
    assert.ok(script.includes("O\\'Brien"));
    assert.ok(!script.includes("O'Brien"));
  });

  it("escapes single quotes in config values", () => {
    const script = phpSetConfig("key", "it's a test");
    assert.ok(script.includes("it\\'s a test"));
  });

  it("escapes backslashes", () => {
    const script = phpCreateCategory({ name: "path\\to\\cat" });
    assert.ok(script.includes("path\\\\to\\\\cat"));
  });
});

describe("PHP helpers: escapePhp (single-quoted context)", () => {
  it("escapes backslash and single quote only", () => {
    assert.strictEqual(escapePhp("a'b"), "a\\'b");
    assert.strictEqual(escapePhp("a\\b"), "a\\\\b");
  });

  it("escapes a backslash before a quote correctly (no double-escape)", () => {
    // Input is a single backslash followed by a single quote: \'
    // Expected output: backslash escaped (\\) then quote escaped (\') => \\\'
    assert.strictEqual(escapePhp("\\'"), "\\\\\\'");
  });

  it("preserves real newlines verbatim (does NOT emit literal \\n)", () => {
    const out = escapePhp("line1\nline2");
    // The output must contain an actual newline character, not a backslash-n.
    assert.ok(out.includes("\n"), "newline must be preserved");
    assert.ok(!out.includes("\\n"), "must not emit literal backslash-n");
    assert.strictEqual(out, "line1\nline2");
  });

  it("preserves carriage returns verbatim (does NOT emit literal \\r)", () => {
    const out = escapePhp("a\r\nb");
    assert.ok(out.includes("\r"), "CR must be preserved");
    assert.ok(!out.includes("\\r"), "must not emit literal backslash-r");
    assert.strictEqual(out, "a\r\nb");
  });

  it("strips null bytes rather than emitting literal \\0", () => {
    const out = escapePhp("a\0b");
    assert.strictEqual(out, "ab");
    assert.ok(!out.includes("\0"));
    assert.ok(!out.includes("\\0"));
  });
});

describe("PHP helpers: multi-line blueprint text", () => {
  it("keeps multi-line course summaries intact (no \\n corruption)", () => {
    const script = phpCreateCourse({
      fullname: "Course",
      shortname: "C1",
      summary: "Line one\nLine two\nLine three",
    });
    // The summary literal must carry real newlines, not the two-char \n.
    assert.ok(script.includes("Line one\nLine two\nLine three"));
    assert.ok(!script.includes("Line one\\nLine two"));
  });
});

describe("PHP helpers: createUser", () => {
  it("uses user_create_user function", () => {
    const script = phpCreateUser({ username: "student1", password: "pass" });
    assert.ok(script.includes("user_create_user"));
    assert.ok(script.includes("student1"));
  });

  it("sets default values for optional fields", () => {
    const script = phpCreateUser({ username: "test" });
    assert.ok(script.includes("password")); // default password
    assert.ok(script.includes("test@example.com")); // default email
  });
});

describe("PHP helpers: createUsers (batch)", () => {
  it("creates multiple users in a single script", () => {
    const script = phpCreateUsers([
      { username: "u1", password: "p1", email: "u1@x.com" },
      { username: "u2", password: "p2", email: "u2@x.com" },
    ]);
    assert.ok(script.includes("u1"));
    assert.ok(script.includes("u2"));
    // Should have a single require, not two
    const requireCount = (script.match(/require\(/g) || []).length;
    assert.strictEqual(
      requireCount,
      1,
      "Batch should only require config once",
    );
  });
});

describe("PHP helpers: createCategory", () => {
  it("uses core_course_category::create", () => {
    const script = phpCreateCategory({ name: "Science" });
    assert.ok(script.includes("core_course_category::create"));
    assert.ok(script.includes("Science"));
  });
});

describe("PHP helpers: createCourse", () => {
  it("uses create_course function", () => {
    const script = phpCreateCourse({
      fullname: "Physics 101",
      shortname: "PHYS101",
      category: "Science",
    });
    assert.ok(script.includes("create_course"));
    assert.ok(script.includes("Physics 101"));
    assert.ok(script.includes("PHYS101"));
    assert.ok(script.includes("Science"));
  });

  it("defaults to topics format with 5 sections", () => {
    const script = phpCreateCourse({
      fullname: "Test",
      shortname: "T1",
    });
    assert.ok(script.includes("'topics'"));
    assert.ok(script.includes("numsections = 5"));
  });
});

describe("PHP helpers: enrolUser", () => {
  it("uses enrol_try_internal_enrol", () => {
    const script = phpEnrolUser({
      username: "student1",
      course: "PHYS101",
      role: "student",
    });
    assert.ok(script.includes("enrol_try_internal_enrol"));
    assert.ok(script.includes("student1"));
    assert.ok(script.includes("PHYS101"));
  });
});

describe("PHP helpers: setConfig", () => {
  it("uses set_config function", () => {
    const script = phpSetConfig("theme", "boost");
    assert.ok(script.includes("set_config"));
    assert.ok(script.includes("'theme'"));
    assert.ok(script.includes("'boost'"));
  });

  it("supports plugin-scoped config", () => {
    const script = phpSetConfig("enabled", "1", "mod_assign");
    assert.ok(script.includes("'mod_assign'"));
  });

  it("uses null for core config", () => {
    const script = phpSetConfig("theme", "boost");
    assert.ok(script.includes("null"));
  });
});

describe("PHP helpers: setTheme", () => {
  it("writes set_config('theme', name) and purges theme caches", () => {
    const script = phpSetTheme("moove");
    assert.ok(script.includes("define('CLI_SCRIPT', true)"));
    assert.ok(script.includes("set_config('theme', 'moove')"));
    assert.ok(script.includes("theme_reset_all_caches"));
  });

  it("escapes theme name with quotes", () => {
    const script = phpSetTheme("o'evil");
    assert.ok(script.includes("'o\\'evil'"));
  });

  it("works for bundled themes without install", () => {
    const script = phpSetTheme("boost");
    assert.ok(script.includes("set_config('theme', 'boost')"));
  });
});

describe("PHP helpers: setConfigs (batch)", () => {
  it("sets multiple configs in one script", () => {
    const script = phpSetConfigs([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
    assert.ok(script.includes("'a'"));
    assert.ok(script.includes("'b'"));
    const requireCount = (script.match(/require\(/g) || []).length;
    assert.strictEqual(requireCount, 1);
  });
});

describe("PHP helpers: login", () => {
  it("uses complete_user_login for HTTP login", () => {
    const script = phpLogin("teacher1");
    assert.ok(script.includes("complete_user_login"));
    assert.ok(script.includes("teacher1"));
  });

  it("does NOT define CLI_SCRIPT (runs via HTTP)", () => {
    const script = phpLogin("admin");
    assert.ok(!script.includes("CLI_SCRIPT"));
  });
});

describe("PHP helpers: setAdminAccount", () => {
  it("updates password when provided", () => {
    const script = phpSetAdminAccount({ password: "newpass" });
    assert.ok(script.includes("hash_internal_user_password"));
    assert.ok(script.includes("newpass"));
  });

  it("returns no-op when no fields provided", () => {
    const script = phpSetAdminAccount({});
    assert.ok(script.includes("'changed' => false"));
  });
});

describe("PHP helpers: addModule", () => {
  it("generates label module code", () => {
    const script = phpAddModule({
      module: "label",
      course: "PHYS101",
      section: 1,
      name: "Welcome",
      intro: "<p>Hello</p>",
    });
    assert.ok(script.includes("'label'"));
    assert.ok(script.includes("insert_record"));
    assert.ok(script.includes("PHYS101"));
    assert.ok(script.includes("course_add_cm_to_section"));
  });

  it("generates assign module code", () => {
    const script = phpAddModule({
      module: "assign",
      course: "C1",
      section: 2,
      name: "HW1",
    });
    assert.ok(script.includes("'assign'"));
    assert.ok(script.includes("insert_record"));
  });

  it("generates generic module without files by default", () => {
    const script = phpAddModule({
      module: "exeweb",
      course: "C1",
      section: 1,
      name: "Test",
    });
    assert.ok(script.includes("'exeweb'"));
    assert.ok(script.includes("insert_record"));
    assert.ok(!script.includes("get_file_storage"));
  });

  it("generates file attachment code when fileSpecs provided", () => {
    const script = phpAddModule(
      {
        module: "exeweb",
        course: "C1",
        section: 1,
        name: "Test",
      },
      [
        {
          filearea: "package",
          itemid: 1,
          filepath: "/",
          filename: "test.elpx",
          tmppath: "/tmp/blueprint-modfile-0-123.bin",
        },
      ],
    );
    assert.ok(script.includes("get_file_storage"));
    assert.ok(script.includes("create_file_from_pathname"));
    assert.ok(script.includes("'package'"));
    assert.ok(script.includes("test.elpx"));
    assert.ok(script.includes("/tmp/blueprint-modfile-0-123.bin"));
  });

  it("attaches multiple files when multiple fileSpecs given", () => {
    const script = phpAddModule(
      { module: "resource", course: "C1", section: 0, name: "R" },
      [
        { filearea: "content", filename: "a.pdf", tmppath: "/tmp/a.bin" },
        { filearea: "content", filename: "b.pdf", tmppath: "/tmp/b.bin" },
      ],
    );
    assert.ok(script.includes("a.pdf"));
    assert.ok(script.includes("b.pdf"));
    // Should only have one require
    const requireCount = (script.match(/require\(/g) || []).length;
    assert.strictEqual(requireCount, 1);
  });

  it("emits valid customField keys as PHP properties", () => {
    const script = phpAddModule({
      module: "exeweb",
      course: "C1",
      section: 1,
      name: "Test",
      exeorigin: "online",
      revision: 3,
      _flag: true,
    });
    assert.ok(script.includes("$moduleInfo->exeorigin = 'online';"));
    assert.ok(script.includes("$moduleInfo->revision = 3;"));
    assert.ok(script.includes("$moduleInfo->_flag = 1;"));
  });

  it("skips a malicious customField key (PHP injection via identifier)", () => {
    const evilKey = 'x=1;system("id");$y';
    const script = phpAddModule({
      module: "exeweb",
      course: "C1",
      section: 1,
      name: "Test",
      [evilKey]: "payload",
      revision: 7,
    });
    // The injected statement must not appear anywhere in the generated PHP.
    assert.ok(
      !script.includes('system("id")'),
      "must not interpolate an injected statement",
    );
    assert.ok(!script.includes(evilKey), "must not emit the raw evil key");
    assert.ok(!script.includes("payload"), "must not emit the skipped value");
    // A legitimate sibling key is still emitted.
    assert.ok(script.includes("$moduleInfo->revision = 7;"));
  });

  it("skips customField keys with dashes, dots, or spaces", () => {
    const script = phpAddModule({
      module: "exeweb",
      course: "C1",
      section: 1,
      name: "Test",
      "bad-key": "v1",
      "bad.key": "v2",
      "bad key": "v3",
      "9leading": "v4",
      good_key: "v5",
    });
    assert.ok(!script.includes("v1"));
    assert.ok(!script.includes("v2"));
    assert.ok(!script.includes("v3"));
    assert.ok(!script.includes("v4"));
    assert.ok(script.includes("$moduleInfo->good_key = 'v5';"));
  });
});

describe("PHP helpers: setConfigFile", () => {
  function baseOpts(overrides = {}) {
    return {
      plugin: "theme_adaptable",
      name: "logo",
      filename: "logo.png",
      filearea: "logo",
      tmppath: "/tmp/blueprint-configfile-1.bin",
      ...overrides,
    };
  }

  it("is a CLI script that requires config.php once", () => {
    const script = phpSetConfigFile(baseOpts());
    assert.ok(script.includes("define('CLI_SCRIPT', true)"));
    const requireCount = (script.match(/require\(/g) || []).length;
    assert.strictEqual(requireCount, 1);
  });

  it("stores the file in the system context via the File API", () => {
    const script = phpSetConfigFile(baseOpts());
    assert.ok(script.includes("context_system::instance()"));
    assert.ok(script.includes("get_file_storage()"));
    assert.ok(script.includes("create_file_from_pathname"));
    // component is the plugin name
    assert.ok(script.includes("$component = 'theme_adaptable';"));
  });

  it("applies defaults: itemid 0, filepath /, replace deletes the area", () => {
    const script = phpSetConfigFile(baseOpts());
    assert.ok(script.includes("$itemid = 0;"));
    assert.ok(script.includes("$filepath = '/';"));
    assert.ok(script.includes("$filearea = 'logo';"));
    assert.ok(
      script.includes(
        "$fs->delete_area_files($context->id, $component, $filearea, $itemid)",
      ),
    );
  });

  it("sets the config value to filepath . filename by default", () => {
    const script = phpSetConfigFile(baseOpts());
    assert.ok(
      script.includes("set_config('logo', $filepath . $filename, $component)"),
    );
  });

  it("falls back to the admin user id, then user id 2", () => {
    const script = phpSetConfigFile(baseOpts());
    assert.ok(script.includes("$admin = get_admin();"));
    assert.ok(script.includes("($admin ? $admin->id : 2)"));
  });

  it("uses an explicit userid when provided", () => {
    const script = phpSetConfigFile(baseOpts({ userid: 5 }));
    assert.ok(script.includes("'userid'    => 5,"));
    assert.ok(!script.includes("($admin ? $admin->id : 2)"));
  });

  it("honors explicit filearea, itemid and filepath overrides", () => {
    const script = phpSetConfigFile(
      baseOpts({ filearea: "banner", itemid: 3, filepath: "/sub/" }),
    );
    assert.ok(script.includes("$filearea = 'banner';"));
    assert.ok(script.includes("$itemid = 3;"));
    assert.ok(script.includes("$filepath = '/sub/';"));
  });

  it("skips the area delete when replace is false", () => {
    const script = phpSetConfigFile(baseOpts({ replace: false }));
    assert.ok(!script.includes("delete_area_files"));
  });

  it("skips set_config when setConfigValue is false", () => {
    const script = phpSetConfigFile(baseOpts({ setConfigValue: false }));
    assert.ok(!script.includes("set_config("));
  });

  it("does not purge caches by default", () => {
    const script = phpSetConfigFile(baseOpts());
    assert.ok(!script.includes("purge_all_caches"));
    assert.ok(!script.includes("theme_reset_all_caches"));
  });

  it("purges caches when purgeCaches is true", () => {
    const script = phpSetConfigFile(baseOpts({ purgeCaches: true }));
    assert.ok(script.includes("theme_reset_all_caches()"));
    assert.ok(script.includes("purge_all_caches()"));
  });

  it("emits optional author/license/source only when provided", () => {
    const without = phpSetConfigFile(baseOpts());
    assert.ok(!without.includes("'author'"));
    const withMeta = phpSetConfigFile(
      baseOpts({ author: "ACME", license: "cc", source: "logo.png" }),
    );
    assert.ok(withMeta.includes("'author'    => 'ACME',"));
    assert.ok(withMeta.includes("'license'   => 'cc',"));
    assert.ok(withMeta.includes("'source'    => 'logo.png',"));
  });

  it("escapes quotes and backslashes (no injection)", () => {
    const script = phpSetConfigFile(
      baseOpts({ name: "lo'go", filename: "a\\b'c.png" }),
    );
    assert.ok(script.includes("lo\\'go"));
    assert.ok(script.includes("a\\\\b\\'c.png"));
    // The raw, unescaped sequence must not appear.
    assert.ok(!script.includes("$filename = 'a\\b'c.png';"));
  });
});

describe("PHP helpers: setConfigFiles", () => {
  function baseOpts(overrides = {}) {
    return {
      plugin: "theme_adaptable",
      name: "adaptablemarkettingimages",
      filearea: "adaptablemarkettingimages",
      files: [
        { filename: "m1.jpg", filepath: "/", tmppath: "/tmp/a.bin" },
        { filename: "m2.jpg", filepath: "/", tmppath: "/tmp/b.bin" },
      ],
      ...overrides,
    };
  }

  it("requires config.php once and stores via the File API", () => {
    const script = phpSetConfigFiles(baseOpts());
    const requireCount = (script.match(/require\(/g) || []).length;
    assert.strictEqual(requireCount, 1);
    assert.ok(script.includes("context_system::instance()"));
    assert.ok(script.includes("create_file_from_pathname"));
  });

  it("includes every file and deletes the area exactly once", () => {
    const script = phpSetConfigFiles(baseOpts());
    assert.ok(script.includes("'filename'=>'m1.jpg'"));
    assert.ok(script.includes("'filename'=>'m2.jpg'"));
    const deleteCount = (script.match(/delete_area_files/g) || []).length;
    assert.strictEqual(deleteCount, 1);
  });

  it("points the config value at the first stored file", () => {
    const script = phpSetConfigFiles(baseOpts());
    assert.ok(
      script.includes(
        "set_config('adaptablemarkettingimages', $firstpath, $component)",
      ),
    );
    assert.ok(script.includes("$firstpath = $f['filepath'] . $f['filename'];"));
  });

  it("reports the stored file count", () => {
    const script = phpSetConfigFiles(baseOpts());
    assert.ok(script.includes("'count' => $stored"));
  });

  it("fails cleanly when no files were stored", () => {
    const script = phpSetConfigFiles(baseOpts());
    assert.ok(script.includes("no valid files stored"));
  });

  it("skips set_config when setConfigValue is false", () => {
    const script = phpSetConfigFiles(baseOpts({ setConfigValue: false }));
    assert.ok(!script.includes("set_config("));
  });

  it("purges caches only when requested", () => {
    assert.ok(!phpSetConfigFiles(baseOpts()).includes("purge_all_caches"));
    assert.ok(
      phpSetConfigFiles(baseOpts({ purgeCaches: true })).includes(
        "purge_all_caches()",
      ),
    );
  });

  it("escapes per-file values (no injection)", () => {
    const script = phpSetConfigFiles(
      baseOpts({
        files: [{ filename: "x'y.jpg", filepath: "/", tmppath: "/tmp/a.bin" }],
      }),
    );
    assert.ok(script.includes("x\\'y.jpg"));
  });
});

describe("PHP helpers: phpPurgeMoodleCaches", () => {
  it("bootstraps Moodle and purges caches + component registry", () => {
    const script = phpPurgeMoodleCaches();
    assert.ok(script.includes("require('/www/moodle/config.php')"));
    assert.ok(script.includes("purge_all_caches()"));
    assert.ok(script.includes("core_component::reset()"));
    assert.ok(script.includes("theme_reset_all_caches()"));
    assert.ok(script.includes("set_config('allversionshash', '')"));
    assert.ok(script.includes('"ok"') || script.includes("'ok'"));
  });
});

describe("PHP helpers: phpRunCoreUpgrade", () => {
  it("loads the overlaid version.php and runs core + noncore upgrade", () => {
    const script = phpRunCoreUpgrade();
    assert.ok(script.includes("require($CFG->dirroot . '/version.php')"));
    assert.ok(script.includes("upgrade_core($version, true)"));
    assert.ok(script.includes("upgrade_noncore(true)"));
    // Honest reporting: a Throwable becomes ok:false rather than faked success.
    assert.ok(script.includes("'ok' => false"));
    assert.ok(script.includes("'ok' => true"));
  });
});
