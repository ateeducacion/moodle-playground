import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdminAccountSyncPhp } from "../../src/runtime/admin-account.js";

describe("createAdminAccountSyncPhp", () => {
  it("syncs the configured admin credentials into a restored snapshot", () => {
    const script = createAdminAccountSyncPhp({
      username: "admin",
      password: "password",
      email: "admin@example.com",
    });

    assert.ok(script.includes("require('/www/moodle/config.php')"));
    assert.ok(script.includes("$admin = get_admin();"));
    assert.ok(
      script.includes(
        "$admin->password = hash_internal_user_password('password');",
      ),
    );
    assert.ok(script.includes("$admin->username = 'admin';"));
    assert.ok(script.includes("$admin->email = 'admin@example.com';"));
    assert.ok(
      script.includes("set_config('supportemail', 'admin@example.com');"),
    );
  });

  it("does not try to rename the admin user to guest", () => {
    const script = createAdminAccountSyncPhp({
      username: "guest",
      password: "password",
    });

    assert.ok(!script.includes("$admin->username = 'guest';"));
    assert.ok(
      script.includes(
        "$admin->password = hash_internal_user_password('password');",
      ),
    );
  });
});
