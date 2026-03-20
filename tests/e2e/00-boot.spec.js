import { test } from "@playwright/test";
import {
  captureDiagnostics,
  createDiagnosticsCollector,
  openPlayground,
  waitForPlaygroundReady,
} from "./helpers.js";

test("boots the playground and loads the default Moodle landing page", async ({
  page,
}, testInfo) => {
  const diagnostics = createDiagnosticsCollector(page);

  try {
    await openPlayground(page);
    await waitForPlaygroundReady(page);
  } finally {
    await captureDiagnostics(page, testInfo, diagnostics);
  }
});
