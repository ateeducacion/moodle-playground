import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveBlueprint } from "../../src/blueprint/resolver.js";

const realFetch = globalThis.fetch;
const VALID = { steps: [{ step: "login", username: "admin" }] };
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("resolveBlueprint source precedence", () => {
  let requested;
  let routes;
  let saved;

  beforeEach(() => {
    requested = [];
    routes = new Map();
    saved = new Map();
    globalThis.fetch = async (url, init) => {
      requested.push({ url: String(url), cache: init?.cache });
      const handler = routes.get(String(url));
      if (!handler) throw new Error("offline");
      return handler();
    };
    globalThis.window = {
      sessionStorage: {
        setItem: (k, v) => saved.set(k, JSON.parse(v)),
        getItem: () => null,
        removeItem: () => {},
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete globalThis.window;
  });

  it("falls back from a broken ?blueprint= to ?blueprint-url= and persists the result", async () => {
    routes.set("https://pg.test/bp.json", () => json(VALID));
    const result = await resolveBlueprint({
      scopeId: "s1",
      location: {
        href: "https://pg.test/?blueprint=%7Bnot-json&blueprint-url=bp.json",
      },
    });
    assert.equal(result.steps[0].step, "login");
    assert.deepEqual(requested, [
      { url: "https://pg.test/bp.json", cache: "no-store" },
    ]);
    assert.deepEqual(saved.get("moodle-playground:blueprint:s1"), result);
  });

  it("ignores a ?blueprint-url= that fails or is invalid and uses the default URL", async () => {
    routes.set("https://pg.test/missing.json", () => json({}, 404));
    routes.set("https://pg.test/invalid.json", () => json({ steps: "nope" }));
    routes.set("https://pg.test/default.json", () => json(VALID));
    for (const bad of ["missing.json", "invalid.json"]) {
      const result = await resolveBlueprint({
        scopeId: "s",
        location: { href: `https://pg.test/?blueprint-url=${bad}` },
        defaultBlueprintUrl: "default.json",
      });
      assert.deepEqual(result.steps, VALID.steps);
    }
    assert.equal(requested.at(-1).url, "https://pg.test/default.json");
  });

  it("returns an invalid default blueprint as-is (warn only)", async () => {
    const invalid = { steps: "nope" };
    routes.set("https://pg.test/default.json", () => json(invalid));
    const result = await resolveBlueprint({
      scopeId: "s",
      location: { href: "https://pg.test/" },
      defaultBlueprintUrl: "default.json",
    });
    assert.deepEqual(result, invalid);
  });

  it("uses the built-in default when the default URL is unreachable or not OK", async () => {
    routes.set("https://pg.test/500.json", () => json({}, 500));
    for (const defaultBlueprintUrl of ["offline.json", "500.json"]) {
      const result = await resolveBlueprint({
        scopeId: "s",
        location: { href: "https://pg.test/" },
        defaultBlueprintUrl,
      });
      assert.deepEqual(
        result.steps.map((s) => s.step),
        ["installMoodle", "login", "setLandingPage"],
      );
      assert.equal(result.constants.ADMIN_USER, "admin");
    }
  });

  it("uses window.location when no location is passed and needs no base for an absolute default", async () => {
    window.location = { href: "https://pg.test/?repo=o/r" };
    routes.set("https://cdn.test/bp.json", () => json(VALID));
    const result = await resolveBlueprint({
      scopeId: "s",
      defaultBlueprintUrl: "https://cdn.test/bp.json",
    });
    assert.equal(result.constants.REPO, "o/r");
    assert.equal(result.constants.OWNER, "o");

    delete globalThis.window;
    const noLoc = await resolveBlueprint({
      scopeId: "s",
      defaultBlueprintUrl: "https://cdn.test/bp.json",
    });
    assert.deepEqual(noLoc, VALID);
  });

  it("derives REF from an explicit raw.githubusercontent refs/tags URL", async () => {
    const raw =
      "https://raw.githubusercontent.com/own/repo/refs/tags/v1.2/blueprint.json";
    routes.set(raw, () => json(VALID));
    const result = await resolveBlueprint({
      scopeId: "s",
      location: {
        href: `https://pg.test/?blueprint-url=${encodeURIComponent(raw)}`,
      },
    });
    assert.equal(result.constants.REPO, "own/repo");
    assert.equal(result.constants.REF, "v1.2");
  });

  it("survives an unparseable blueprint-url and rejects repos without a name", async () => {
    const result = await resolveBlueprint({
      scopeId: "s",
      location: {
        href: `https://pg.test/?blueprint-url=${encodeURIComponent("http://[bad")}&repo=owner/&owner=me`,
      },
    });
    assert.equal(result.constants.REPO, undefined);
    assert.equal(result.constants.OWNER, "me");
    assert.equal(result.steps[0].step, "installMoodle");
  });
});
