import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "8085";
const webRoot = process.env.PLAYWRIGHT_WEB_ROOT || ".";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
const reportDir = process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report";

export default defineConfig({
  testDir: "./tests/e2e",
  // Test-level parallelism is required for balanced Playwright shards. Keep the
  // local default unchanged while allowing CI to distribute tests evenly.
  fullyParallel: process.env.CI === "true",
  workers: Number(process.env.PLAYWRIGHT_WORKERS) || (process.env.CI ? 2 : 3),
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  preserveOutput: "always",
  outputDir,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer:
    process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1"
      ? undefined
      : {
          // Probe the manifest inside the SERVED root: in CI that is the
          // downloaded _site artifact (which always contains the manifests),
          // so the static server starts in seconds. The old repo-relative
          // check always missed in CI (manifests are gitignored) and fell
          // back to `make up`, whose npm install + builds burned 3-4 of the
          // 5 timeout minutes and made every e2e job a coin toss.
          command: `sh -lc 'if [ -f ${JSON.stringify(webRoot)}/assets/manifests/latest.json ]; then PORT=${port} npx http-server ${JSON.stringify(webRoot)} -p ${port} -c-1; else PORT=${port} make up; fi'`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 600_000,
        },
  reporter: process.env.CI
    ? [["line"]]
    : [["list"], ["html", { open: "never", outputFolder: reportDir }]],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
    {
      name: "firefox",
      use: { browserName: "firefox" },
    },
  ],
});
