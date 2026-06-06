import assert from "node:assert/strict";
import { describe, it } from "node:test";

// resolveBlueprint depends on window/fetch — test the parser-level fallback path
import { parseBlueprint } from "../../src/blueprint/parser.js";
import { resolveBlueprint } from "../../src/blueprint/resolver.js";

describe("resolver: parseBlueprint integration", () => {
  it("parses inline JSON from what ?blueprint= would provide", () => {
    const json = '{"steps":[{"step":"login","username":"admin"}]}';
    const result = parseBlueprint(json);
    assert.deepStrictEqual(result.steps[0].step, "login");
  });

  it("parses base64 from what ?blueprint= would provide", () => {
    const obj = { steps: [{ step: "installMoodle" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(b64);
    assert.strictEqual(result.steps[0].step, "installMoodle");
  });

  it("parses data: URL from what ?blueprint= would provide", () => {
    const obj = { steps: [{ step: "login" }] };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    const result = parseBlueprint(`data:application/json;base64,${b64}`);
    assert.strictEqual(result.steps[0].step, "login");
  });
});

describe("resolver: context constants (REPO/REF) from URL", () => {
  // A committed blueprint authored with defaults that should be overridable.
  const authored = JSON.stringify({
    constants: { REPO: "ateeducacion/mod_exelearning", REF: "main" },
    steps: [{ step: "login", username: "admin" }],
  });
  const inlineHref = (qs) =>
    `https://moodle-playground.com/?blueprint=${encodeURIComponent(authored)}${qs}`;

  it("injects REPO/REF/OWNER/BRANCH from explicit ?repo=&ref= (overriding defaults)", async () => {
    const href = inlineHref("&repo=fork-owner/mod_exelearning&ref=feat/x");
    const bp = await resolveBlueprint({ scopeId: "t", location: { href } });
    assert.equal(bp.constants.REPO, "fork-owner/mod_exelearning");
    assert.equal(bp.constants.OWNER, "fork-owner");
    assert.equal(bp.constants.REF, "feat/x");
    assert.equal(bp.constants.BRANCH, "feat/x");
  });

  it("derives REPO/REF from a github-proxy ?blueprint-url= (slash-safe ref)", async () => {
    const bpurl =
      "https://github-proxy.exelearning.dev/?repo=ateeducacion/mod_exelearning&branch=feat/playground&path=blueprint.json";
    const href = inlineHref(`&blueprint-url=${encodeURIComponent(bpurl)}`);
    const bp = await resolveBlueprint({ scopeId: "t", location: { href } });
    assert.equal(bp.constants.REPO, "ateeducacion/mod_exelearning");
    assert.equal(bp.constants.REF, "feat/playground");
  });

  it("derives REPO/REF from a raw.githubusercontent ?blueprint-url=", async () => {
    const bpurl =
      "https://raw.githubusercontent.com/owner/repo/branchx/blueprint.json";
    const href = inlineHref(`&blueprint-url=${encodeURIComponent(bpurl)}`);
    const bp = await resolveBlueprint({ scopeId: "t", location: { href } });
    assert.equal(bp.constants.REPO, "owner/repo");
    assert.equal(bp.constants.REF, "branchx");
  });

  it("derives REF from the explicit raw refs/heads/<branch> shape (not 'refs')", async () => {
    const bpurl =
      "https://raw.githubusercontent.com/ateeducacion/mod_exelearning/refs/heads/main/blueprint.json";
    const href = inlineHref(`&blueprint-url=${encodeURIComponent(bpurl)}`);
    const bp = await resolveBlueprint({ scopeId: "t", location: { href } });
    assert.equal(bp.constants.REPO, "ateeducacion/mod_exelearning");
    assert.equal(bp.constants.REF, "main");
  });

  it("leaves authored constants untouched when no context is present", async () => {
    const bp = await resolveBlueprint({
      scopeId: "t",
      location: { href: inlineHref("") },
    });
    assert.equal(bp.constants.REPO, "ateeducacion/mod_exelearning");
    assert.equal(bp.constants.REF, "main");
    assert.equal(bp.constants.OWNER, undefined);
  });
});
