import { test as base, expect } from "@playwright/test";
import {
  captureDiagnostics,
  createDiagnosticsCollector,
  getMoodleFrame,
  openPlayground,
  waitForPlaygroundReady,
  waitForShellReady,
} from "./helpers.mjs";

export { expect };

export const test = base.extend({
  /**
   * Auto fixture: attaches a diagnostics collector and captures diagnostics
   * on teardown. Eliminates the try/finally pattern in every test.
   */
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const diagnostics = createDiagnosticsCollector(page);
      await use(diagnostics);
      await captureDiagnostics(page, testInfo, diagnostics);
    },
    { auto: true },
  ],

  /**
   * Provides a playground helper with an open() method.
   * open() calls openPlayground + waitForShellReady by default.
   * Pass { waitForMoodle: true } to also wait for Moodle content.
   */
  playground: async ({ page }, use) => {
    await use({
      open: async (options = {}) => {
        await openPlayground(page);
        if (options.waitForMoodle) {
          await waitForPlaygroundReady(page);
        } else {
          await waitForShellReady(page);
        }
      },
    });
  },

  /**
   * Provides the Moodle iframe frame locator directly.
   */
  moodle: async ({ page }, use) => {
    await use(getMoodleFrame(page));
  },
});
