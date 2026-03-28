import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "8085";
const webRoot = process.env.PLAYWRIGHT_WEB_ROOT || ".";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
const reportDir = process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
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
          command: `sh -lc 'if [ -f assets/manifests/latest.json ]; then PORT=${port} npx http-server ${JSON.stringify(webRoot)} -p ${port} -c-1; else PORT=${port} make up; fi'`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
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
