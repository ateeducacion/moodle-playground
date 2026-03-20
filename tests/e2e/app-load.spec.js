import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const workflowLabel = process.env.PLAYWRIGHT_WORKFLOW_LABEL || "local";
const readyTimeoutMs = 5 * 60 * 1000;

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

test("loads the Moodle playground shell and default landing page", async ({
  page,
  request,
}, testInfo) => {
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const baseUrl =
    process.env.PLAYWRIGHT_BASE_URL || testInfo.project.use.baseURL;
  const blueprintUrl = new URL(
    "assets/blueprints/default.blueprint.json",
    baseUrl,
  );
  const blueprint = await request
    .get(blueprintUrl.toString())
    .then((response) => response.json());
  const expectedPath = blueprint?.landingPage || "/login/index.php";
  const expectedPathname = new URL(expectedPath, "https://playground.local/")
    .pathname;

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

  const diagnosticsDir = testInfo.outputPath("diagnostics");
  await mkdir(diagnosticsDir, { recursive: true });

  try {
    await test.step("open the built application shell", async () => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('body[data-app="shell"]')).toBeVisible({
        timeout: readyTimeoutMs,
      });
    });

    await test.step("wait for the runtime host and default Moodle landing page", async () => {
      await expect(page.locator("#current-runtime-label")).not.toHaveText("-", {
        timeout: readyTimeoutMs,
      });
      await expect(page.locator("#address-input")).toBeEnabled({
        timeout: readyTimeoutMs,
      });
      await expect(page.locator("#address-input")).toHaveValue(expectedPath, {
        timeout: readyTimeoutMs,
      });

      const remoteHost = page.frameLocator("#site-frame");
      await expect(remoteHost.locator('body[data-app="remote"]')).toBeVisible({
        timeout: readyTimeoutMs,
      });
      await expect(remoteHost.locator(".remote-boot__card")).toHaveClass(
        /is-hidden/u,
        { timeout: readyTimeoutMs },
      );

      const moodleSite = remoteHost.frameLocator("#remote-frame");
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

      const primaryUi = moodleSite.locator(
        "main, [role='main'], input[name='username'], input#username",
      );
      await expect
        .poll(
          () =>
            primaryUi.evaluateAll((elements) =>
              elements.some((element) => {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              }),
            ),
          { timeout: readyTimeoutMs },
        )
        .toBeTruthy();
    });
  } finally {
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
          addressInput instanceof HTMLInputElement
            ? addressInput.disabled
            : null,
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
    await writeFile(
      `${diagnosticsDir}/shell.html`,
      await page.content(),
      "utf8",
    );
    await writeFile(
      `${diagnosticsDir}/shell-state.json`,
      JSON.stringify(
        {
          workflowLabel,
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
      JSON.stringify(consoleMessages, null, 2),
      "utf8",
    );
    await writeFile(
      `${diagnosticsDir}/page-errors.json`,
      JSON.stringify(pageErrors, null, 2),
      "utf8",
    );
    await writeFile(
      `${diagnosticsDir}/request-failures.json`,
      JSON.stringify(requestFailures, null, 2),
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
});
