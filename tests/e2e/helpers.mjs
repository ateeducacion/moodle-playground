import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";

export const DEFAULT_LANDING_PATH = "/my/";
export const readyTimeoutMs = process.env.CI ? 150_000 : 120_000;

export function createDiagnosticsCollector(page) {
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });
  page.on("pageerror", (error) => {
    pageErrors.push(serializeError(error));
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure(),
      resourceType: request.resourceType(),
    });
  });

  return {
    consoleMessages,
    pageErrors,
    requestFailures,
  };
}

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

export async function captureDiagnostics(page, testInfo, diagnostics) {
  const diagnosticsDir = testInfo.outputPath("diagnostics");
  await mkdir(diagnosticsDir, { recursive: true });

  if (!page || page.isClosed()) {
    await writeFile(
      `${diagnosticsDir}/page-closed.json`,
      JSON.stringify(
        {
          workflowLabel: process.env.PLAYWRIGHT_WORKFLOW_LABEL || "local",
          project: testInfo.project.name,
          pageClosed: true,
        },
        null,
        2,
      ),
      "utf8",
    );
    return;
  }

  const frames = page.frames();
  const remoteFrame = frames.find((frame) =>
    frame.url().includes("/remote.html"),
  );
  const moodleFrame = frames.find(
    (frame) => frame.parentFrame() === remoteFrame,
  );
  let shellState = null;
  try {
    shellState = await page.evaluate(() => {
      const addressInput = document.querySelector("#address-input");
      return {
        title: document.title,
        href: window.location.href,
        addressValue:
          addressInput instanceof HTMLInputElement ? addressInput.value : null,
        addressDisabled:
          addressInput instanceof HTMLInputElement ? addressInput.disabled : null,
        runtimeLabel: document.querySelector("#current-runtime-label")
          ?.textContent,
        logPanel: document.querySelector("#log-panel")?.textContent || "",
        siteFrameSrc:
          document.querySelector("#site-frame")?.getAttribute("src") || null,
      };
    });
  } catch {}

  try {
    await page.screenshot({
      path: `${diagnosticsDir}/final-page.png`,
      fullPage: true,
    });
  } catch {}
  try {
    await writeFile(`${diagnosticsDir}/shell.html`, await page.content(), "utf8");
  } catch {}
  await writeFile(
    `${diagnosticsDir}/shell-state.json`,
    JSON.stringify(
      {
        workflowLabel: process.env.PLAYWRIGHT_WORKFLOW_LABEL || "local",
        project: testInfo.project.name,
        shellState,
        frames: frames.map((frame) => ({
          name: frame.name(),
          url: frame.url(),
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    `${diagnosticsDir}/console.json`,
    JSON.stringify(diagnostics.consoleMessages, null, 2),
    "utf8",
  );
  await writeFile(
    `${diagnosticsDir}/page-errors.json`,
    JSON.stringify(diagnostics.pageErrors, null, 2),
    "utf8",
  );
  await writeFile(
    `${diagnosticsDir}/request-failures.json`,
    JSON.stringify(diagnostics.requestFailures, null, 2),
    "utf8",
  );

  if (remoteFrame) {
    try {
      await writeFile(
        `${diagnosticsDir}/remote-frame.html`,
        await remoteFrame.content(),
        "utf8",
      );
    } catch {}
  }

  if (moodleFrame) {
    try {
      await writeFile(
        `${diagnosticsDir}/moodle-frame.html`,
        await moodleFrame.content(),
        "utf8",
      );
    } catch {}
  }
}

export function getRemoteHost(page) {
  return page.frameLocator("#site-frame");
}

export function getMoodleFrame(page) {
  return getRemoteHost(page).frameLocator("#remote-frame");
}

export async function openPlayground(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('body[data-app="shell"]')).toBeVisible({
    timeout: readyTimeoutMs,
  });
}

/**
 * Light wait: shell UI is ready (address bar enabled, runtime label populated).
 * Use for tests that only interact with the shell, not Moodle content inside the iframe.
 */
export async function waitForShellReady(page) {
  await expect(page.locator("#current-runtime-label")).not.toHaveText("-", {
    timeout: readyTimeoutMs,
  });
  await expect(page.locator("#address-input")).toBeEnabled({
    timeout: readyTimeoutMs,
  });
}

async function waitForRemoteOverlayHidden(page, timeout = readyTimeoutMs) {
  const remoteHost = getRemoteHost(page);
  await expect(remoteHost.locator('body[data-app="remote"]')).toBeVisible({
    timeout,
  });
  await expect(remoteHost.locator(".remote-boot__card")).toHaveClass(
    /is-hidden/u,
    { timeout },
  );
}

/**
 * Full wait: shell ready + remote boot overlay hidden + Moodle content rendered.
 * Use for tests that need to interact with Moodle UI (forms, navigation).
 *
 * Readiness stages verified:
 * 1. Shell: runtime label populated + address bar enabled (= worker sent "ready")
 * 2. Remote: boot overlay hidden (= bootstrap complete, frame navigated)
 * 3. Moodle: content visible inside nested iframe (= PHP page rendered)
 */
/**
 * Poll the Moodle iframe until at least one of the given selectors is present.
 * Tolerates frame-not-ready errors while the nested iframe is still loading.
 */
async function waitForMoodleContent(
  moodleFrame,
  selectors,
  timeout = readyTimeoutMs,
) {
  await expect
    .poll(
      async () => {
        for (const selector of selectors) {
          try {
            if (await moodleFrame.locator(selector).count()) return true;
          } catch {
            /* frame not ready yet */
          }
        }
        return false;
      },
      { timeout },
    )
    .toBeTruthy();
}

const MOODLE_CONTENT_SELECTORS = [
  "main",
  "[role='main']",
  "#page-content",
  "input[name='username']",
  "#username",
];

export async function waitForPlaygroundReady(page) {
  // Stage 1: Shell is ready (worker sent "ready" message)
  await waitForShellReady(page);

  // Stage 2: Remote boot overlay is hidden (bootstrap complete)
  await waitForRemoteOverlayHidden(page);

  // Stage 3: Moodle content rendered inside the nested iframe.
  await waitForMoodleContent(getMoodleFrame(page), MOODLE_CONTENT_SELECTORS);
}

export async function navigateWithinPlayground(page, path) {
  await waitForPlaygroundReady(page);
  const addressInput = page.locator("#address-input");
  await expect(addressInput).toBeEnabled({ timeout: readyTimeoutMs });
  await addressInput.fill(path);
  await addressInput.press("Enter");

  // Wait for the Moodle frame to navigate to the expected path
  await waitForMoodlePath(page, path);

  // Wait for the remote overlay to disappear again after navigation.
  await waitForRemoteOverlayHidden(page, 30_000);

  // Wait for Moodle content to render after navigation
  await waitForMoodleContent(
    getMoodleFrame(page),
    [...MOODLE_CONTENT_SELECTORS, "form"],
    30_000,
  );
}

export async function waitForMoodlePath(page, expectedPath) {
  const expectedPathname = new URL(expectedPath, "https://playground.local/")
    .pathname;
  await expect
    .poll(
      async () => {
        const frameMatched = page.frames().some((frame) => {
          const parent = frame.parentFrame();
          if (!parent?.url().includes("/remote.html")) {
            return false;
          }

          try {
            return new URL(frame.url()).pathname.endsWith(expectedPathname);
          } catch {
            return false;
          }
        });
        if (frameMatched) {
          return true;
        }
        return false;
      },
      { timeout: readyTimeoutMs },
    )
    .toBeTruthy();
}

export async function fillFirstVisible(locatorFactories, value) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    for (const factory of locatorFactories) {
      const locator = factory();
      if (await locator.count()) {
        const candidate = locator.first();
        if (await candidate.isVisible()) {
          try {
            await candidate.fill(value);
            return candidate;
          } catch {
            // Try the next selector when the first visible match is a help icon or wrapper.
          }
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Unable to find a visible field for value ${value}. Tried ${locatorFactories.length} selector(s).`,
  );
}

export async function tryFillFirstVisible(locatorFactories, value) {
  try {
    await fillFirstVisible(locatorFactories, value);
    return true;
  } catch {
    return false;
  }
}

export async function clickFirstVisible(locatorFactories) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    for (const factory of locatorFactories) {
      const locator = factory();
      if (await locator.count()) {
        const candidate = locator.first();
        if (await candidate.isVisible()) {
          await candidate.click();
          return candidate;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("Unable to find a visible actionable element");
}

export function uniqueSuffix(testInfo) {
  return `${testInfo.project.name}-${Date.now()}`;
}
