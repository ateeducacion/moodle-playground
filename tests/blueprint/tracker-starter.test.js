import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateBlueprint } from "../../src/blueprint/schema.js";

// The generic tracker starter scenario (issue #166): the deterministic
// pre-setup offered on Moodle Tracker issues that have no explicit
// "Moodle Playground Scenario" block. Single source of truth for the
// userscript's ?blueprint-url= link.
const BLUEPRINT_REPO_PATH =
  "assets/blueprints/examples/tracker-starter.blueprint.json";
const BLUEPRINT_PATH = fileURLToPath(
  new URL(`../../${BLUEPRINT_REPO_PATH}`, import.meta.url),
);
const USERSCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/moodle-playground-pr-button.user.js", import.meta.url),
);

const blueprint = JSON.parse(readFileSync(BLUEPRINT_PATH, "utf8"));
const steps = (name) => blueprint.steps.filter((s) => s.step === name);

describe("tracker-starter blueprint", () => {
  it("is a valid blueprint", () => {
    const { valid, errors } = validateBlueprint(blueprint);
    assert.deepEqual(errors, []);
    assert.equal(valid, true);
  });

  it("uses the stable documented admin credentials", () => {
    assert.equal(blueprint.constants.ADMIN_USER, "admin");
    assert.equal(blueprint.constants.ADMIN_PASS, "password");
    const [install] = steps("installMoodle");
    assert.ok(install, "must declare installMoodle");
    assert.ok(install.options.siteName, "must set a site name");
  });

  it("creates the REPRO reproduction course with 3 topic sections", () => {
    const [course] = steps("createCourse");
    assert.ok(course, "must create one course");
    assert.equal(course.shortname, "REPRO");
    assert.equal(course.fullname, "Reproduction course");
    assert.equal(course.format, "topics");
    assert.equal(course.numsections, 3);
  });

  it("creates teacher and student users with stable credentials", () => {
    const [create] = steps("createUsers");
    assert.ok(create, "must create users in one batch step");
    const byName = Object.fromEntries(create.users.map((u) => [u.username, u]));
    for (const username of ["teacher", "student"]) {
      assert.ok(byName[username], `must create '${username}'`);
      assert.equal(byName[username].password, "password");
      assert.ok(byName[username].email.includes("@"));
      assert.ok(byName[username].firstname);
      assert.ok(byName[username].lastname);
    }
  });

  it("enrols the teacher and student into REPRO with the right roles", () => {
    const [enrol] = steps("enrolUsers");
    assert.ok(enrol, "must enrol users in one batch step");
    const roles = Object.fromEntries(
      enrol.enrolments.map((e) => [e.username, e]),
    );
    assert.equal(roles.teacher.role, "editingteacher");
    assert.equal(roles.teacher.course, "REPRO");
    assert.equal(roles.student.role, "student");
    assert.equal(roles.student.course, "REPRO");
  });

  it("adds the sample activities from issue #166 (forum, assignment, quiz, page)", () => {
    const modules = steps("addModule");
    const types = modules.map((m) => m.module);
    for (const expected of ["forum", "assign", "quiz", "page"]) {
      assert.ok(types.includes(expected), `must add a ${expected}`);
    }
    for (const mod of modules) {
      assert.equal(mod.course, "REPRO");
      assert.ok(mod.name, `${mod.module} must have a name`);
      assert.ok(
        Number.isInteger(mod.section) && mod.section >= 1,
        `${mod.module} must target a section`,
      );
    }
  });

  it("logs in as admin and lands on the reproduction course", () => {
    const [login] = steps("login");
    assert.ok(login, "must log in");
    assert.match(login.username, /^(admin|\{\{ADMIN_USER\}\})$/u);
    assert.equal(blueprint.landingPage, "/course/view.php?id=2");
  });

  it("is the file the userscript starter button points at", () => {
    const source = readFileSync(USERSCRIPT_PATH, "utf8");
    assert.ok(
      source.includes(BLUEPRINT_REPO_PATH),
      "userscript must reference the bundled starter blueprint path",
    );
  });
});
