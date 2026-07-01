// Tracker userscript injection tests (issue #166, ADR 0017).
//
// These tests run the real userscript against a routed, offline fixture page
// served as https://moodle.atlassian.net/browse/<KEY> — no live tracker, no
// network. They cover the scenario/starter/invalid button states, idempotent
// re-injection, SPA-style DOM changes, and non-regression of the PR #158
// compare badges.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const USERSCRIPT_SOURCE = readFileSync(
  fileURLToPath(
    new URL(
      "../../scripts/moodle-playground-pr-button.user.js",
      import.meta.url,
    ),
  ),
  "utf8",
);

const SCENARIO_BUTTON = "#moodle-playground-scenario-button";
const COMPARE_BADGE = `a.mpp-preview-button:not(${SCENARIO_BUTTON} a)`;

const VALID_SCENARIO = {
  landingPage: "/course/view.php?id=2",
  steps: [
    { step: "installMoodle", options: { siteName: "MDL repro" } },
    { step: "createCourse", fullname: "Repro", shortname: "REPRO" },
    { step: "login", username: "admin" },
  ],
};

function issuePage({ description = "", extraHtml = "" } = {}) {
  return `<!DOCTYPE html>
<html>
  <head><title>[MDL-77777] Something is broken</title></head>
  <body>
    <h1>Something is broken</h1>
    <div data-testid="issue.views.field.rich-text.description">${description}</div>
    ${extraHtml}
  </body>
</html>`;
}

// Jira renders a code block as a <pre> without the markdown fence, so the
// tracker-friendly form is the marker phrase (heading) + code block.
function scenarioDescription(json = VALID_SCENARIO) {
  return `<p>Steps to reproduce: create a course, break it.</p>
    <h3>Moodle Playground Scenario</h3>
    <div class="code-block"><pre>${JSON.stringify(json, null, 2)}</pre></div>`;
}

async function openIssue(page, html, path = "/browse/MDL-77777") {
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith("https://moodle.atlassian.net/")) {
      return route.fulfill({ contentType: "text/html", body: html });
    }
    return route.abort();
  });
  await page.goto(`https://moodle.atlassian.net${path}`);
  // Evaluate the script source directly (like Tampermonkey's sandboxed world,
  // it does not become a DOM <script> node).
  await page.evaluate(USERSCRIPT_SOURCE);
}

function decodeBlueprintParam(url) {
  const value = new URL(url).searchParams.get("blueprint");
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

test.describe("tracker scenario button", () => {
  test("adds one scenario button when the description has a valid scenario", async ({
    page,
  }) => {
    await openIssue(page, issuePage({ description: scenarioDescription() }));

    const button = page.locator(SCENARIO_BUTTON);
    await expect(button).toHaveCount(1);
    const link = button.locator("a");
    await expect(link).toContainText("Open issue scenario");
    const href = await link.getAttribute("href");
    expect(decodeBlueprintParam(href)).toEqual(VALID_SCENARIO);
  });

  test("detects a literal fenced block too", async ({ page }) => {
    const description = `<pre>\`\`\`moodle-playground
${JSON.stringify(VALID_SCENARIO)}
\`\`\`</pre>`;
    await openIssue(page, issuePage({ description }));

    const link = page.locator(`${SCENARIO_BUTTON} a`);
    await expect(link).toHaveCount(1);
    expect(decodeBlueprintParam(await link.getAttribute("href"))).toEqual(
      VALID_SCENARIO,
    );
  });

  test("offers the starter scenario when no scenario block exists", async ({
    page,
  }) => {
    await openIssue(
      page,
      issuePage({ description: "<p>1. Create a course. 2. Break it.</p>" }),
    );

    const link = page.locator(`${SCENARIO_BUTTON} a`);
    await expect(link).toHaveCount(1);
    await expect(link).toContainText("starter site");
    const href = await link.getAttribute("href");
    expect(new URL(href).searchParams.get("blueprint-url")).toBe(
      "assets/blueprints/examples/tracker-starter.blueprint.json",
    );
  });

  test("shows a warning badge (and no launch button) for a broken scenario", async ({
    page,
  }) => {
    const description = `<h3>Moodle Playground Scenario</h3>
      <pre>{ "steps": [ oops ] }</pre>`;
    await openIssue(page, issuePage({ description }));

    const badge = page.locator(SCENARIO_BUTTON);
    await expect(badge).toHaveCount(1);
    await expect(badge).toContainText("invalid scenario block");
    await expect(badge.locator("a[href]")).toHaveCount(0);
    const title = await badge.locator("span").getAttribute("title");
    expect(title).toMatch(/JSON/iu);
  });

  test("does not duplicate the button on repeated injection passes", async ({
    page,
  }) => {
    await openIssue(page, issuePage({ description: scenarioDescription() }));
    await expect(page.locator(SCENARIO_BUTTON)).toHaveCount(1);

    // Trigger several mutation-observer passes and a re-evaluation of the
    // whole script (as SPA re-renders and Tampermonkey re-runs would).
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        const div = document.createElement("div");
        div.textContent = "spa re-render";
        document.body.appendChild(div);
      });
      await page.waitForTimeout(500);
    }
    await expect(page.locator(SCENARIO_BUTTON)).toHaveCount(1);
    await expect(page.locator(`${SCENARIO_BUTTON} a`)).toHaveCount(1);
  });

  test("refreshes the button when the description changes (SPA)", async ({
    page,
  }) => {
    await openIssue(
      page,
      issuePage({ description: "<p>No scenario here.</p>" }),
    );
    await expect(page.locator(`${SCENARIO_BUTTON} a`)).toContainText(
      "starter site",
    );

    // Jira loads/updates the description asynchronously: simulate it.
    await page.evaluate((html) => {
      document.querySelector(
        '[data-testid="issue.views.field.rich-text.description"]',
      ).innerHTML = html;
    }, scenarioDescription());

    await expect(page.locator(`${SCENARIO_BUTTON} a`)).toContainText(
      "Open issue scenario",
      { timeout: 10_000 },
    );
    await expect(page.locator(SCENARIO_BUTTON)).toHaveCount(1);
  });

  test("keeps the PR #158 compare badges working alongside the scenario button", async ({
    page,
  }) => {
    const extraHtml = `
      <div data-testid="hover-card-trigger-wrapper">
        <a href="https://github.com/someone/moodle/compare/abc123...MDL-77777-501">
          https://github.com/someone/moodle/compare/abc123...MDL-77777-501
        </a>
      </div>`;
    await openIssue(
      page,
      issuePage({ description: scenarioDescription(), extraHtml }),
    );

    const compareBadge = page.locator(COMPARE_BADGE);
    await expect(compareBadge).toHaveCount(1);
    const compare = decodeBlueprintParam(
      await compareBadge.getAttribute("href"),
    );
    const overlay = compare.steps.find((s) => s.step === "applyPrOverlay");
    expect(overlay).toMatchObject({
      repo: "someone/moodle",
      base: "abc123",
      head: "MDL-77777-501",
    });
    expect(compare.preferredVersions.moodle).toBe("5.1");

    const scenarioLink = page.locator(`${SCENARIO_BUTTON} a`);
    await expect(scenarioLink).toHaveCount(1);
    expect(
      decodeBlueprintParam(await scenarioLink.getAttribute("href")),
    ).toEqual(VALID_SCENARIO);
  });

  test("falls back to page text when the description container is missing", async ({
    page,
  }) => {
    const html = `<!DOCTYPE html>
<html><head><title>[MDL-77777] Bug</title></head>
<body><main><pre>\`\`\`moodle-playground
${JSON.stringify(VALID_SCENARIO)}
\`\`\`</pre></main></body></html>`;
    await openIssue(page, html);

    const link = page.locator(`${SCENARIO_BUTTON} a`);
    await expect(link).toHaveCount(1);
    expect(decodeBlueprintParam(await link.getAttribute("href"))).toEqual(
      VALID_SCENARIO,
    );
  });

  test("ignores marker-like text inside page scripts and our own button", async ({
    page,
  }) => {
    // Marker text inside a <script> (e.g. an analytics payload) must not be
    // mistaken for a scenario; the injected button labels must not be either.
    const extraHtml = `<script type="application/json">
      { "log": "\`\`\`moodle-playground { broken" }
    </script>`;
    await openIssue(
      page,
      issuePage({ description: "<p>Nothing here.</p>", extraHtml }),
    );

    const link = page.locator(`${SCENARIO_BUTTON} a`);
    await expect(link).toHaveCount(1);
    await expect(link).toContainText("starter site");
    // Stays on the starter state across later passes (no flip-flop).
    await page.waitForTimeout(2500);
    await expect(link).toContainText("starter site");
  });

  test("does not inject the scenario button on non-issue tracker pages", async ({
    page,
  }) => {
    await openIssue(
      page,
      "<!DOCTYPE html><html><body><p>Dashboard</p></body></html>",
      "/jira/dashboards/12345",
    );
    await page.waitForTimeout(1000);
    await expect(page.locator(SCENARIO_BUTTON)).toHaveCount(0);
  });
});
