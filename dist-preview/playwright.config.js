import { defineConfig } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT || "4173";
const webRoot = process.env.PLAYWRIGHT_WEB_ROOT || ".";
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}/`;
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || "test-results";
const reportDir = process.env.PLAYWRIGHT_REPORT_DIR || "playwright-report";
const serverLog = process.env.PLAYWRIGHT_SERVER_LOG;

function shellQuote(value) {
  return JSON.stringify(String(value));
}

let webServerCommand = `npx http-server ${shellQuote(webRoot)} -p ${port} -c-1`;
if (serverLog) {
  webServerCommand += ` > ${shellQuote(serverLog)} 2>&1`;
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 8 * 60 * 1000,
  expect: {
    timeout: 5 * 60 * 1000,
  },
  preserveOutput: "always",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: reportDir }],
  ],
  outputDir,
  use: {
    baseURL,
    trace: "on",
  },
  webServer: {
    command: webServerCommand,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 2 * 60 * 1000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
    {
      name: "firefox",
      use: {
        browserName: "firefox",
      },
    },
  ],
});
