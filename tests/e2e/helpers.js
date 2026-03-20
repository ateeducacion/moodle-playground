import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";

export const DEFAULT_LANDING_PATH = "/my/";
export const readyTimeoutMs = 5 * 60 * 1000;

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

  const frames = page.frames();
  const remoteFrame = frames.find((frame) =>
    frame.url().includes("/remote.html"),
  );
  const moodleFrame = frames.find(
    (frame) => frame.parentFrame() === remoteFrame,
  );
  const shellState = await page.evaluate(() => {
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

  await page.screenshot({
    path: `${diagnosticsDir}/final-page.png`,
    fullPage: true,
  });
  await writeFile(`${diagnosticsDir}/shell.html`, await page.content(), "utf8");
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
    await writeFile(
      `${diagnosticsDir}/remote-frame.html`,
      await remoteFrame.content(),
      "utf8",
    );
  }

  if (moodleFrame) {
    await writeFile(
      `${diagnosticsDir}/moodle-frame.html`,
      await moodleFrame.content(),
      "utf8",
    );
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

export async function waitForPlaygroundReady(
  page,
  expectedPath = DEFAULT_LANDING_PATH,
) {
  await expect(page.locator("#current-runtime-label")).not.toHaveText("-", {
    timeout: readyTimeoutMs,
  });
  await expect(page.locator("#address-input")).toBeEnabled({
    timeout: readyTimeoutMs,
  });
  await expect(page.locator("#address-input")).toHaveValue(expectedPath, {
    timeout: readyTimeoutMs,
  });

  const remoteHost = getRemoteHost(page);
  await expect(remoteHost.locator('body[data-app="remote"]')).toBeVisible({
    timeout: readyTimeoutMs,
  });
  await expect(remoteHost.locator(".remote-boot__card")).toHaveClass(
    /is-hidden/u,
    {
      timeout: readyTimeoutMs,
    },
  );

  await waitForMoodlePath(page, expectedPath);

  const moodleFrame = getMoodleFrame(page);
  await expect(
    moodleFrame.locator(
      "main, [role='main'], input[name='username'], input#username",
    ),
  ).toBeVisible({
    timeout: readyTimeoutMs,
  });
}

export async function navigateWithinPlayground(page, path) {
  const addressInput = page.locator("#address-input");
  await expect(addressInput).toBeEnabled({ timeout: readyTimeoutMs });
  await addressInput.fill(path);
  await addressInput.press("Enter");
  await expect(addressInput).toHaveValue(path, {
    timeout: readyTimeoutMs,
  });
  await waitForMoodlePath(page, path);
}

export async function waitForMoodlePath(page, expectedPath) {
  const expectedPathname = new URL(expectedPath, "https://playground.local/")
    .pathname;
  await expect
    .poll(
      () =>
        page.frames().some((frame) => {
          const parent = frame.parentFrame();
          if (!parent || !parent.url().includes("/remote.html")) {
            return false;
          }

          try {
            return new URL(frame.url()).pathname.endsWith(expectedPathname);
          } catch {
            return false;
          }
        }),
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

  throw new Error(`Unable to find a visible field for value ${value}`);
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
