import { test } from "@playwright/test";

test("inspect plugin installer page", async ({ page }) => {
  page.on("console", (msg) => {
    console.log(`PAGE_CONSOLE ${msg.type()} ${msg.text()}`);
  });

  await page.goto("http://localhost:8080/?debug=true&profile=vfs-plugins", {
    waitUntil: "networkidle",
    timeout: 120000,
  });

  await page.goto(
    "http://localhost:8080/playground/main/php83-moodle50/admin/tool/installaddon/index.php",
    {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    },
  );

  await page.waitForLoadState("networkidle", { timeout: 120000 });

  const bodyText = await page.locator("body").innerText();
  const fileInputs = await page
    .locator('input[type="file"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: node.getAttribute("name"),
        id: node.getAttribute("id"),
        accept: node.getAttribute("accept"),
      })),
    );
  const buttons = await page
    .locator("button, input[type=submit]")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent?.trim() || node.getAttribute("value") || "",
        id: node.getAttribute("id"),
        name: node.getAttribute("name"),
        type: node.getAttribute("type"),
      })),
    );

  console.log("INSTALL_URL", page.url());
  console.log("INSTALL_TITLE", await page.title());
  console.log("FILE_INPUTS", JSON.stringify(fileInputs));
  console.log("BUTTONS", JSON.stringify(buttons));
  console.log("BODY_START", bodyText.slice(0, 4000));
});
