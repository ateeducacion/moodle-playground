import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:8085";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer:
    process.env.PLAYWRIGHT_EXTERNAL_SERVER === "1"
      ? undefined
      : {
          command:
            "sh -lc 'if [ -f assets/manifests/latest.json ]; then PORT=8085 make serve; else PORT=8085 make up; fi'",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
        },
  reporter: process.env.CI ? "line" : "list",
});
