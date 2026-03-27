import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  phpAddModule,
  phpCreateCategory,
  phpCreateCourse,
  phpCreateUser,
  phpCreateUsers,
  phpEnrolUser,
  phpLogin,
  phpSetAdminAccount,
  phpSetConfig,
  phpSetConfigs,
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
});
