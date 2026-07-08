import { expect, test } from "./fixtures.mjs";
import {
  buildBlueprintParam,
  createDiagnosticsCollector,
  specTimeoutMs,
  waitForShellReady,
} from "./helpers.mjs";

test.describe.configure({ timeout: specTimeoutMs });

// ---------------------------------------------------------------------------
// Blueprint provisioning performance observability (issue #249)
//
// The blueprint executor emits a single machine-readable diagnostics line at
// the end of provisioning:
//   [blueprint-perf] {"totalMs":..,"steps":[{"i","step","label","ms","status"}]} [/blueprint-perf]
// It reaches the shell #log-panel via the normal progress channel, so Playwright
// can read it without inspecting deep iframe content. The line carries ONLY the
// step index, type, sanitized label, duration and status — never step payload.
// ---------------------------------------------------------------------------

const PERF_RE = /\[blueprint-perf\] ([\s\S]*?) \[\/blueprint-perf\]/u;

async function readPerfReport(page) {
  const logText = (await page.locator("#log-panel").textContent()) || "";
  const match = logText.match(PERF_RE);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function openLogsPanel(page) {
  await page.locator("#panel-toggle-button").click();
  await page.locator("#logs-tab").click();
}

// CI-safe: a small local blueprint (no external resources) proves the
// instrumentation end-to-end in the browser and that secrets are redacted.
test("blueprint executor emits a structured, secret-free per-step timing report", async ({
  page,
}, testInfo) => {
  const ADMIN_PASS = "SuperSecretAdmin123!";
  const STUDENT_PASS = "Student1SecretPass!";

  const bp = buildBlueprintParam({
    landingPage: "/my/",
    steps: [
      {
        step: "installMoodle",
        options: {
          adminUser: "admin",
          adminPass: ADMIN_PASS,
          adminEmail: "admin@example.com",
          siteName: "Perf Observability Test",
        },
      },
      { step: "login", username: "admin" },
      { step: "createCategory", name: "Perf Category" },
      {
        step: "createCourse",
        fullname: "Perf Course",
        shortname: "PERF1",
        comment: "demo course for perf test",
      },
      {
        step: "createUser",
        username: "student1",
        password: STUDENT_PASS,
        email: "student1@example.com",
        firstname: "Alice",
        lastname: "Test",
      },
      { step: "setLandingPage", path: "/my/" },
    ],
  });

  const diagnostics = createDiagnosticsCollector(page);
  await page.goto(`/?blueprint=${bp}`);
  await waitForShellReady(page);
  await openLogsPanel(page);

  // Condition-based wait for the report to appear (NOT a fixed timeout).
  let report = null;
  await expect
    .poll(
      async () => {
        report = await readPerfReport(page);
        return report?.steps?.length ?? 0;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // Structured shape assertions (existence + names, NOT exact durations).
  expect(typeof report.totalMs).toBe("number");
  const stepNames = report.steps.map((s) => s.step);
  for (const expected of [
    "installMoodle",
    "createCategory",
    "createCourse",
    "createUser",
    "setLandingPage",
  ]) {
    expect(
      stepNames,
      `expected step "${expected}" in ${stepNames.join(",")}`,
    ).toContain(expected);
  }
  for (const s of report.steps) {
    expect(["success", "skipped", "failed"]).toContain(s.status);
    expect(typeof s.i).toBe("number");
  }

  // Redaction: neither the parsed report nor the raw perf log line contains a password.
  const logText = (await page.locator("#log-panel").textContent()) || "";
  const perfLine = logText.match(PERF_RE)?.[0] ?? "";
  const serialized = JSON.stringify(report) + perfLine;
  expect(serialized).not.toContain(ADMIN_PASS);
  expect(serialized).not.toContain(STUDENT_PASS);

  await testInfo.attach("blueprint-perf-report.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("console.json", {
    body: JSON.stringify(diagnostics.consoleMessages, null, 2),
    contentType: "application/json",
  });
});

// Opt-in baseline measurement for the heavy external Adaptable blueprint.
// Requires outbound network to raw.githubusercontent.com + the CORS proxies, so
// it is NOT run in CI. Enable locally with:  RUN_EXTERNAL_PERF=1 npx playwright test blueprint-perf
const EXTERNAL_BLUEPRINT_URL =
  "https://raw.githubusercontent.com/HenarLG/Playground_pruebas/refs/heads/main/moodle-playground-adaptable_config_7_es_acc.json";

test("external Adaptable blueprint produces a timing report (opt-in baseline)", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.RUN_EXTERNAL_PERF,
    "Set RUN_EXTERNAL_PERF=1 to run the heavy external blueprint baseline measurement",
  );
  test.setTimeout(600_000);

  const diagnostics = createDiagnosticsCollector(page);
  const runtimeRestarts = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/runtime restart|resetRuntime|crash recovery/iu.test(text)) {
      runtimeRestarts.push(text);
    }
  });

  await page.goto(
    `/?blueprint-url=${encodeURIComponent(EXTERNAL_BLUEPRINT_URL)}`,
  );
  await waitForShellReady(page);
  await openLogsPanel(page);

  let report = null;
  await expect
    .poll(
      async () => {
        report = await readPerfReport(page);
        return report?.steps?.length ?? 0;
      },
      { timeout: 300_000 },
    )
    .toBeGreaterThan(0);

  const stepNames = report.steps.map((s) => s.step);
  for (const expected of ["installMoodle", "installTheme", "restoreCourse"]) {
    expect(
      stepNames,
      `expected step "${expected}" in ${stepNames.join(",")}`,
    ).toContain(expected);
  }

  // Build a slowest-first table as an artifact (baseline evidence).
  const ranked = [...report.steps]
    .filter((s) => typeof s.ms === "number")
    .sort((a, b) => b.ms - a.ms);

  const consoleErrors = diagnostics.consoleMessages.filter(
    (m) => m.type === "error",
  );

  await testInfo.attach("external-blueprint-perf-report.json", {
    body: JSON.stringify(
      {
        totalMs: report.totalMs,
        rankedBySlowest: ranked,
        steps: report.steps,
        consoleErrorCount: consoleErrors.length,
        runtimeRestarts,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await testInfo.attach("external-console.json", {
    body: JSON.stringify(diagnostics.consoleMessages, null, 2),
    contentType: "application/json",
  });
});
