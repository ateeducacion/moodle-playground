import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Window } from "happy-dom";

// Runs the real userscript's DOM wiring (the part tracker-scenario.test.js
// skips through the __MPP_TEST__ hook) against happy-dom pages shaped like
// GitHub pull requests and Moodle tracker issues. The script is evaluated in
// a vm context exposing the window's globals, the same way Tampermonkey runs
// it in a sandbox next to the page.
const SCRIPT_PATH = fileURLToPath(
  new URL("../../scripts/moodle-playground-pr-button.user.js", import.meta.url),
);
const source = readFileSync(SCRIPT_PATH, "utf8");
const PLAYGROUND = "https://ateeducacion.github.io/moodle-playground/";

const windows = [];
afterEach(async () => {
  while (windows.length) await windows.pop().happyDOM.close();
});

function decodeBlueprintParam(url) {
  const value = new URL(url).searchParams.get("blueprint");
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

// Make an element "visible" for the script's layout check; happy-dom does no
// layout, so every element otherwise reports a 0x0 box.
function markVisible(el, window) {
  el.getBoundingClientRect = () => ({ width: 100, height: 20 });
  Object.defineProperty(el, "offsetParent", { value: window.document.body });
}

async function runUserscript(url, html, { globals = {}, prepare } = {}) {
  const window = new Window({ url });
  windows.push(window);
  window.document.body.innerHTML = html;
  prepare?.(window);
  const context = vm.createContext({
    window,
    document: window.document,
    location: window.location,
    MutationObserver: window.MutationObserver,
    NodeFilter: window.NodeFilter,
    // happy-dom leaves unset border longhands empty; browsers report the
    // initial values, which is what the script's border check expects.
    getComputedStyle: (el) => {
      const cs = window.getComputedStyle(el);
      return {
        borderTopWidth: cs.borderTopWidth || "0px",
        borderTopStyle: cs.borderTopStyle || "none",
      };
    },
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    URL,
    TextEncoder,
    btoa,
    console,
    ...globals,
  });
  vm.runInContext(source, context, { filename: SCRIPT_PATH });
  // Let the async GitHub injection (base-ref lookup) settle.
  await sleep(0);
  await sleep(0);
  return window;
}

const PR_URL = "https://github.com/moodle/moodle/pull/123";

describe("userscript on GitHub pull requests", () => {
  it("adds the badge to the visible header actions using the DOM base branch", async () => {
    const window = await runUserscript(
      PR_URL,
      `<div data-component="PH_Actions" id="hidden"></div>
       <div data-component="PH_Actions" id="actions"></div>
       <span data-component="BranchName">someone:MDL-1-main</span>
       <span data-component="BranchName">moodle:MOODLE_501_STABLE</span>`,
      {
        prepare: (w) => markVisible(w.document.getElementById("actions"), w),
      },
    );
    const button = window.document.getElementById(
      "moodle-playground-preview-button",
    );
    assert.ok(button, "badge is injected");
    assert.equal(button.parentElement.id, "actions");
    assert.equal(button.target, "_blank");
    assert.ok(button.href.startsWith(PLAYGROUND));
    const blueprint = decodeBlueprintParam(button.href);
    assert.equal(blueprint.preferredVersions.moodle, "5.1");
    const overlay = blueprint.steps.find((s) => s.step === "applyPrOverlay");
    assert.deepEqual(
      { repo: overlay.repo, pr: overlay.pr, baseRef: overlay.baseRef },
      { repo: "moodle/moodle", pr: 123, baseRef: "MOODLE_501_STABLE" },
    );
  });

  it("falls back to the first chip when no chip names the base owner", async () => {
    const window = await runUserscript(
      PR_URL,
      `<span class="commit-ref">MOODLE_405_STABLE</span>`,
    );
    const button = window.document.querySelector(
      "#moodle-playground-preview-button a",
    );
    assert.equal(
      decodeBlueprintParam(button.href).preferredVersions.moodle,
      "4.5",
    );
  });

  it("asks the GitHub API through GM_xmlhttpRequest and floats the badge when the header is hidden", async () => {
    const requests = [];
    const window = await runUserscript(PR_URL, "<main></main>", {
      globals: {
        GM_xmlhttpRequest: (req) => {
          requests.push(req);
          req.onload({
            responseText: JSON.stringify({
              base: { ref: "MOODLE_500_STABLE" },
            }),
          });
        },
      },
    });
    assert.equal(
      requests[0].url,
      "https://api.github.com/repos/moodle/moodle/pulls/123",
    );
    assert.equal(requests[0].headers.Accept, "application/vnd.github+json");
    const wrap = window.document.getElementById(
      "moodle-playground-preview-button",
    );
    assert.equal(wrap.parentElement, window.document.body);
    assert.match(wrap.style.cssText, /position: ?fixed/);
    const link = wrap.querySelector("a");
    assert.equal(
      decodeBlueprintParam(link.href).preferredVersions.moodle,
      "5.0",
    );
  });

  for (const [name, respond] of [
    ["malformed JSON", (req) => req.onload({ responseText: "nope" })],
    ["a network error", (req) => req.onerror()],
    ["a timeout", (req) => req.ontimeout()],
  ]) {
    it(`defaults to main/dev when the API lookup fails with ${name}`, async () => {
      const window = await runUserscript(PR_URL, "", {
        globals: { GM: { xmlHttpRequest: respond } },
      });
      const link = window.document.querySelector(
        "#moodle-playground-preview-button a",
      );
      const blueprint = decodeBlueprintParam(link.href);
      assert.equal(blueprint.preferredVersions.moodle, "dev");
      assert.equal(
        blueprint.steps.find((s) => s.step === "applyPrOverlay").baseRef,
        "main",
      );
    });
  }

  it("uses fetch when no GM API exists", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ base: { ref: "main" } }) };
    };
    const window = await runUserscript(PR_URL, "", { globals: { fetch } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.Accept, "application/vnd.github+json");
    const link = window.document.querySelector(
      "#moodle-playground-preview-button a",
    );
    assert.equal(decodeBlueprintParam(link.href).steps[1].baseRef, "main");
  });

  it("treats non-OK and rejected fetches as unknown base branches", async () => {
    for (const fetch of [
      async () => ({ ok: false }),
      async () => {
        throw new Error("offline");
      },
    ]) {
      const window = await runUserscript(PR_URL, "", { globals: { fetch } });
      const link = window.document.querySelector(
        "#moodle-playground-preview-button a",
      );
      assert.equal(decodeBlueprintParam(link.href).steps[1].baseRef, "main");
    }
  });

  it("prefers a preview link already posted by the GitHub Action", async () => {
    const posted = `${PLAYGROUND}?blueprint-url=posted.json`;
    const window = await runUserscript(
      PR_URL,
      `<a href="https://example.com/x">other</a><a href="${posted}">preview</a>
       <span data-component="BranchName">moodle:main</span>`,
    );
    const link = window.document.querySelector(
      "#moodle-playground-preview-button a",
    );
    assert.equal(link.href, posted);
  });

  it("ignores pull requests of repositories other than moodle", async () => {
    const window = await runUserscript(
      "https://github.com/moodle/devdocs/pull/5",
      `<span data-component="BranchName">moodle:main</span>`,
    );
    assert.equal(
      window.document.getElementById("moodle-playground-preview-button"),
      null,
    );
  });

  it("does not inject a second badge on later passes", async () => {
    const window = await runUserscript(
      PR_URL,
      `<span data-component="BranchName">moodle:main</span>`,
    );
    window.document.body.appendChild(window.document.createElement("p"));
    await sleep(450); // debounced MutationObserver re-run
    assert.equal(
      window.document.querySelectorAll("#moodle-playground-preview-button")
        .length,
      1,
    );
  });
});

const ISSUE_URL = "https://moodle.atlassian.net/browse/MDL-77777";
const SCENARIO = { steps: [{ step: "login", username: "admin" }] };

function issueHtml({ description = "", extra = "" } = {}) {
  return `<div data-testid="issue.views.field.rich-text.description">${description}</div>${extra}`;
}

describe("userscript on the Moodle tracker", () => {
  it("adds one compare badge per comparison after the bordered field box", async () => {
    const compare =
      "https://github.com/someone/moodle/compare/abc123...MDL-77777-501?w=1";
    const window = await runUserscript(
      ISSUE_URL,
      issueHtml({
        extra: `<div id="box" style="border:1px solid #ccc">
          <span data-testid="hover-card-trigger-wrapper"><a href="${compare}">diff</a></span>
        </div>
        <div><a href="${compare}">same diff</a></div>`,
      }),
    );
    const box = window.document.getElementById("box");
    const badge = box.nextElementSibling;
    assert.equal(badge.className, "mpp-preview-button");
    assert.match(badge.style.cssText, /display: ?flex/);
    const blueprint = decodeBlueprintParam(badge.href);
    assert.equal(blueprint.preferredVersions.moodle, "5.1");
    assert.deepEqual(
      blueprint.steps.find((s) => s.step === "applyPrOverlay"),
      {
        step: "applyPrOverlay",
        repo: "someone/moodle",
        base: "abc123",
        head: "MDL-77777-501",
        runUpgrade: "auto",
      },
    );
    const compareBadges = [
      ...window.document.querySelectorAll("a.mpp-preview-button"),
    ].filter(
      (a) =>
        a.href.includes("blueprint=") &&
        !a.closest("#moodle-playground-scenario-button"),
    );
    assert.equal(compareBadges.length, 1);
  });

  it("adds a PR badge after a GitHub pull request link and reinserts it when removed", async () => {
    const window = await runUserscript(
      ISSUE_URL,
      issueHtml({
        extra: `<p><a id="pr" href="https://github.com/moodle/moodle/pull/42">PR</a></p>
          <p><a href="https://github.com/moodle/devdocs/pull/1">docs</a></p>
          <p><a href="https://example.com/x/moodle/pull/9">elsewhere</a></p>
          <p><a href="https://github.com/moodle/devdocs/compare/a...b">docs diff</a></p>
          <p><a href="https://github.com/moodle/moodle/compare/nodots">bad</a></p>`,
      }),
    );
    const prLink = window.document.getElementById("pr");
    let badge = prLink.nextElementSibling;
    const overlay = decodeBlueprintParam(badge.href).steps[1];
    assert.deepEqual(
      { repo: overlay.repo, pr: overlay.pr, baseRef: overlay.baseRef },
      { repo: "moodle/moodle", pr: 42, baseRef: "main" },
    );
    // Only the moodle/moodle PR got a badge (plus the floating scenario one).
    assert.equal(
      window.document.querySelectorAll("a.mpp-preview-button").length,
      2,
    );

    badge.remove();
    await sleep(450);
    badge = prLink.nextElementSibling;
    assert.equal(badge?.className, "mpp-preview-button");
  });

  it("offers the starter scenario when the description has none", async () => {
    const window = await runUserscript(ISSUE_URL, issueHtml());
    const wrap = window.document.getElementById(
      "moodle-playground-scenario-button",
    );
    const link = wrap.querySelector("a");
    assert.equal(
      link.href,
      `${PLAYGROUND}?blueprint-url=assets/blueprints/examples/tracker-starter.blueprint.json`,
    );
    assert.equal(
      link.textContent,
      "▶ Open in Moodle Playground (starter site)",
    );
    assert.equal(wrap.dataset.mppState.split("|")[0], "starter");
  });

  it("opens the description's scenario, ignoring script text", async () => {
    const window = await runUserscript(
      ISSUE_URL,
      issueHtml({
        description: `<script>var x = "Moodle Playground Scenario {\\"steps\\":5}";</script>
          <h3>Moodle Playground Scenario</h3><pre>${JSON.stringify(SCENARIO)}</pre>`,
      }),
    );
    const link = window.document.querySelector(
      "#moodle-playground-scenario-button a",
    );
    assert.deepEqual(decodeBlueprintParam(link.href), SCENARIO);
    assert.match(link.title, /MDL-77777 scenario/);
  });

  it("shows a non-clickable badge with the error for a broken scenario", async () => {
    const window = await runUserscript(
      ISSUE_URL,
      issueHtml({
        description:
          '<h3>Moodle Playground Scenario</h3><pre>{"steps": 1}</pre>',
      }),
    );
    const wrap = window.document.getElementById(
      "moodle-playground-scenario-button",
    );
    assert.equal(wrap.querySelector("a"), null);
    const badge = wrap.querySelector("span.mpp-preview-button");
    assert.match(badge.title, /must have a 'steps' array/);
  });

  it("swaps the scenario button when the description changes and keeps it otherwise", async () => {
    const window = await runUserscript(ISSUE_URL, issueHtml());
    const first = window.document.getElementById(
      "moodle-playground-scenario-button",
    );
    // An unrelated mutation re-runs the injector without replacing the button.
    window.document.body.appendChild(window.document.createElement("p"));
    await sleep(450);
    assert.equal(
      window.document.getElementById("moodle-playground-scenario-button"),
      first,
    );

    window.document.querySelector(
      '[data-testid="issue.views.field.rich-text.description"]',
    ).innerHTML =
      `<pre>\`\`\`moodle-playground ${JSON.stringify(SCENARIO)}</pre>`;
    await sleep(450);
    const swapped = window.document.getElementById(
      "moodle-playground-scenario-button",
    );
    assert.notEqual(swapped, first);
    assert.equal(swapped.dataset.mppState.split("|")[0], "scenario");
  });

  it("removes the scenario button after navigating away from an issue", async () => {
    const window = await runUserscript(ISSUE_URL, issueHtml());
    assert.ok(
      window.document.getElementById("moodle-playground-scenario-button"),
    );
    window.history.pushState({}, "", "/jira/dashboards");
    window.document.body.appendChild(window.document.createElement("p"));
    await sleep(450);
    assert.equal(
      window.document.getElementById("moodle-playground-scenario-button"),
      null,
    );
  });

  it("does nothing on unrelated hosts", async () => {
    const window = await runUserscript(
      "https://example.org/browse/MDL-1",
      `<a href="https://github.com/moodle/moodle/pull/1">x</a>`,
    );
    assert.equal(window.document.querySelector(".mpp-preview-button"), null);
  });
});
