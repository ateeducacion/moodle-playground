import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The userscript must stay a single standalone file (Tampermonkey installs it
// directly), so it cannot export ES modules. It exposes its pure helpers to
// tests through a __MPP_TEST__ hook: when the sandbox defines that function,
// the script hands over its API and skips all DOM wiring.
const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/moodle-playground-pr-button.user.js", import.meta.url),
);
const source = readFileSync(SCRIPT_PATH, "utf8");

function loadUserscript() {
  let api = null;
  const context = {
    __MPP_TEST__: (exported) => {
      api = exported;
    },
    TextEncoder,
    btoa: globalThis.btoa,
    console,
  };
  vm.runInNewContext(source, context, {
    filename: "moodle-playground-pr-button.user.js",
  });
  if (!api) {
    throw new Error(
      "Userscript did not call __MPP_TEST__ — the test hook is missing.",
    );
  }
  return api;
}

const rawApi = loadUserscript();

// Objects created inside the vm sandbox carry that realm's prototypes, which
// assert.deepEqual (strict) rejects. Clone extraction results into this realm;
// everything else the tests consume is primitives or re-parsed JSON.
const clone = (value) =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));
const api = {
  ...rawApi,
  extractPlaygroundScenario: (text) =>
    clone(rawApi.extractPlaygroundScenario(text)),
};

// Decode the ?blueprint= value the same way the app's parser does
// (base64url → base64, re-pad, UTF-8 JSON).
function decodeBlueprintParam(url) {
  const value = new URL(url).searchParams.get("blueprint");
  assert.ok(value, "URL must carry a ?blueprint= value");
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

const VALID_SCENARIO = {
  landingPage: "/course/view.php?id=2",
  preferredVersions: { php: "8.3", moodle: "5.0" },
  runtime: { debug: 0 },
  constants: { COURSE: "REPRO" },
  resources: { readme: { literal: "hi" } },
  steps: [
    { step: "createCourse", fullname: "Repro course", shortname: "REPRO" },
  ],
};

const FENCED = `Steps to reproduce:\n1. Do things.\n\n\`\`\`moodle-playground\n${JSON.stringify(VALID_SCENARIO, null, 2)}\n\`\`\`\n\nExpected result: no error.`;

describe("extractPlaygroundScenario", () => {
  it("finds a fenced moodle-playground JSON block", () => {
    const result = api.extractPlaygroundScenario(FENCED);
    assert.equal(result.found, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.blueprint, VALID_SCENARIO);
  });

  it("preserves landingPage, preferredVersions, runtime, constants, resources and steps", () => {
    const { blueprint } = api.extractPlaygroundScenario(FENCED);
    assert.equal(blueprint.landingPage, "/course/view.php?id=2");
    assert.deepEqual(blueprint.preferredVersions, {
      php: "8.3",
      moodle: "5.0",
    });
    assert.deepEqual(blueprint.runtime, { debug: 0 });
    assert.deepEqual(blueprint.constants, { COURSE: "REPRO" });
    assert.deepEqual(blueprint.resources, { readme: { literal: "hi" } });
    assert.equal(blueprint.steps.length, 1);
  });

  it("finds the marker-phrase form (heading + code block, markdown source)", () => {
    const text = `Some intro.\n\n### Moodle Playground Scenario\n\n{ "landingPage": "/my/", "steps": [] }\n\nMore text.`;
    const result = api.extractPlaygroundScenario(text);
    assert.equal(result.found, true);
    assert.deepEqual(result.blueprint, { landingPage: "/my/", steps: [] });
  });

  it("finds the marker-phrase form in flattened textContent (no line breaks)", () => {
    // Jira's renderer concatenates block elements without newlines in
    // textContent: <h3>…</h3><pre>{…}</pre> → "…Scenario{…}".
    const text = `DescriptionMoodle Playground Scenario{"steps":[{"step":"installMoodle"}]}Attachments`;
    const result = api.extractPlaygroundScenario(text);
    assert.equal(result.found, true);
    assert.deepEqual(result.blueprint, {
      steps: [{ step: "installMoodle" }],
    });
  });

  it("ignores unrelated code fences", () => {
    const text = `Look at this config:\n\n\`\`\`json\n{ "steps": [ { "step": "installMoodle" } ] }\n\`\`\`\n`;
    assert.deepEqual(api.extractPlaygroundScenario(text), { found: false });
  });

  it("returns found:false on plain text without a marker", () => {
    assert.deepEqual(
      api.extractPlaygroundScenario("1. Create a course\n2. Break it"),
      { found: false },
    );
  });

  it("returns found:false when the marker is mentioned without any JSON", () => {
    const text = "You could add a Moodle Playground Scenario to this issue.";
    assert.deepEqual(api.extractPlaygroundScenario(text), { found: false });
  });

  it("returns found:false on empty and non-string input", () => {
    assert.deepEqual(api.extractPlaygroundScenario(""), { found: false });
    assert.deepEqual(api.extractPlaygroundScenario(null), { found: false });
    assert.deepEqual(api.extractPlaygroundScenario(undefined), {
      found: false,
    });
  });

  it("does not match fence languages that merely start with moodle-playground", () => {
    const text = '```moodle-playground-config\n{ "steps": [] }\n```';
    assert.deepEqual(api.extractPlaygroundScenario(text), { found: false });
  });

  it("reports a clear error for invalid JSON", () => {
    const text = '```moodle-playground\n{ "steps": [ oops ] }\n```';
    const result = api.extractPlaygroundScenario(text);
    assert.equal(result.found, true);
    assert.equal(result.blueprint, undefined);
    assert.match(result.error, /JSON/iu);
  });

  it("reports an error for an unbalanced JSON object", () => {
    const text = '```moodle-playground\n{ "steps": [';
    const result = api.extractPlaygroundScenario(text);
    assert.equal(result.found, true);
    assert.match(result.error, /balanced|JSON/iu);
  });

  it("rejects JSON without a steps array", () => {
    const noSteps = api.extractPlaygroundScenario(
      '```moodle-playground\n{ "landingPage": "/my/" }\n```',
    );
    assert.equal(noSteps.found, true);
    assert.match(noSteps.error, /steps/iu);

    const badSteps = api.extractPlaygroundScenario(
      '```moodle-playground\n{ "steps": "installMoodle" }\n```',
    );
    assert.equal(badSteps.found, true);
    assert.match(badSteps.error, /steps/iu);
  });

  it("handles braces and escaped quotes inside JSON string values", () => {
    const scenario = {
      steps: [
        {
          step: "addModule",
          module: "label",
          course: "REPRO",
          intro: '<p style="x">{not \\"json\\"} áéí</p>',
        },
      ],
    };
    const text = `\`\`\`moodle-playground\n${JSON.stringify(scenario)}\n\`\`\`\ntrailing { brace } text`;
    const result = api.extractPlaygroundScenario(text);
    assert.equal(result.found, true);
    assert.deepEqual(result.blueprint, scenario);
  });

  it("uses the first scenario block when several are present", () => {
    const text = [
      '```moodle-playground\n{ "steps": [ { "step": "installMoodle" } ] }\n```',
      '```moodle-playground\n{ "steps": [ { "step": "login" } ] }\n```',
    ].join("\n\n");
    const result = api.extractPlaygroundScenario(text);
    assert.deepEqual(result.blueprint.steps, [{ step: "installMoodle" }]);
  });

  it("treats scenario content as data, never as code", () => {
    const sneaky = {
      constants: { X: "alert(1); require('fs')" },
      steps: [{ step: "runPhpCode", code: "phpinfo();" }],
    };
    const text = `\`\`\`moodle-playground\n${JSON.stringify(sneaky)}\n\`\`\``;
    const result = api.extractPlaygroundScenario(text);
    assert.deepEqual(result.blueprint, sneaky);
  });

  it("never uses eval or the Function constructor", () => {
    assert.equal(/\beval\s*\(/u.test(source), false);
    assert.equal(/new\s+Function\s*\(/u.test(source), false);
  });
});

describe("buildScenarioUrl", () => {
  it("encodes the blueprint as base64url on ?blueprint=", () => {
    const url = api.buildScenarioUrl(VALID_SCENARIO);
    assert.ok(url.startsWith(`${api.PLAYGROUND_HOST}/?blueprint=`));
    assert.deepEqual(decodeBlueprintParam(url), VALID_SCENARIO);
  });

  it("is deterministic for the same input", () => {
    assert.equal(
      api.buildScenarioUrl(VALID_SCENARIO),
      api.buildScenarioUrl(VALID_SCENARIO),
    );
  });

  it("round-trips special characters without double encoding", () => {
    const scenario = {
      steps: [
        {
          step: "createCourse",
          fullname:
            'Curso de reproducción — éèê 中文 \u{1f9ea} "quoted" & <tags>',
          shortname: "REPRO?&=#",
        },
      ],
    };
    const url = api.buildScenarioUrl(scenario);
    const value = new URL(url).searchParams.get("blueprint");
    // base64url alphabet only — nothing to percent-encode, no padding.
    assert.match(value, /^[A-Za-z0-9_-]+$/u);
    assert.ok(!url.includes("%"), "no percent-encoding needed");
    assert.deepEqual(decodeBlueprintParam(url), scenario);
  });
});

describe("buildStarterUrl", () => {
  it("points ?blueprint-url= at the bundled starter blueprint", () => {
    assert.equal(
      api.buildStarterUrl(),
      `${api.PLAYGROUND_HOST}/?blueprint-url=assets/blueprints/examples/tracker-starter.blueprint.json`,
    );
  });
});

describe("compare mode regression guard", () => {
  it("buildCompareUrl still produces an applyPrOverlay blueprint", () => {
    const url = api.buildCompareUrl("someone/moodle", "abc123", "MDL-1-501");
    const blueprint = decodeBlueprintParam(url);
    assert.equal(blueprint.preferredVersions.moodle, "5.1");
    const overlay = blueprint.steps.find((s) => s.step === "applyPrOverlay");
    assert.deepEqual(
      { repo: overlay.repo, base: overlay.base, head: overlay.head },
      { repo: "someone/moodle", base: "abc123", head: "MDL-1-501" },
    );
  });
});

describe("tracker button labels", () => {
  it("cannot be mistaken for a scenario marker (self-detection guard)", () => {
    // The tracker fallback reads document.body.textContent, which includes our
    // own injected button labels. No label may match the marker patterns or
    // the script would flip-flop between states on every tick.
    assert.ok(Array.isArray(api.SCENARIO_MARKER_SOURCES));
    assert.ok(api.SCENARIO_MARKER_SOURCES.length >= 2);
    assert.ok(typeof api.TRACKER_BUTTON_LABELS === "object");
    const labels = Object.values(api.TRACKER_BUTTON_LABELS);
    assert.ok(labels.length >= 2);
    for (const pattern of api.SCENARIO_MARKER_SOURCES) {
      const re = new RegExp(pattern, "iu");
      for (const label of labels) {
        assert.equal(
          re.test(label),
          false,
          `label "${label}" must not match marker ${re}`,
        );
      }
    }
  });
});
