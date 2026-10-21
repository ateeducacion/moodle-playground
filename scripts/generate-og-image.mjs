#!/usr/bin/env node

// Generates og-image.png (1200x630) from an inline HTML template using Playwright.
// Run with: node scripts/generate-og-image.mjs
// Output: og-image.png at the repository root.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const OUTPUT = resolve(__dirname, "..", "og-image.png");

export const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
  html, body { margin: 0; padding: 0; }
  body {
    width: 1200px;
    height: 630px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: radial-gradient(circle at 20% 20%, #ff9a3c 0%, #f98012 40%, #c75a00 100%);
    color: white;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 80px;
    box-sizing: border-box;
    position: relative;
    overflow: hidden;
  }
  .grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(circle at 70% 50%, black 0%, transparent 80%);
  }
  .tag {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 12px;
    background: rgba(0,0,0,0.25);
    backdrop-filter: blur(6px);
    padding: 12px 22px;
    border-radius: 999px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    align-self: flex-start;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #7CFF6B;
    box-shadow: 0 0 12px #7CFF6B;
  }
  .title {
    position: relative;
    font-size: 92px;
    font-weight: 800;
    line-height: 1.05;
    letter-spacing: -0.02em;
    margin: 0;
    text-shadow: 0 4px 30px rgba(0,0,0,0.25);
  }
  .title span { color: #FFE066; }
  .subtitle {
    position: relative;
    font-size: 34px;
    font-weight: 400;
    line-height: 1.35;
    opacity: 0.95;
    max-width: 900px;
    margin: 0;
  }
  .footer {
    position: relative;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    font-size: 22px;
    font-weight: 600;
  }
  .badges {
    display: flex;
    gap: 14px;
  }
  .badge {
    background: rgba(0,0,0,0.3);
    padding: 10px 18px;
    border-radius: 10px;
    backdrop-filter: blur(6px);
  }
  .url { opacity: 0.85; }
</style>
</head>
<body>
  <div class="grid"></div>
  <div class="tag"><span class="dot"></span>Open Source · Runs in your browser</div>
  <h1 class="title">Moodle <span>Playground</span></h1>
  <p class="subtitle">A full Moodle site running in your browser via PHP WebAssembly. Instant demos, plugin &amp; theme testing, reproducible JSON blueprints. No install, no server.</p>
  <div class="footer">
    <div class="badges">
      <div class="badge">WebAssembly</div>
      <div class="badge">PHP 8.3</div>
      <div class="badge">SQLite</div>
      <div class="badge">Blueprints</div>
    </div>
    <div class="url">moodle-playground.com</div>
  </div>
</body>
</html>`;

// Render HTML in a 1200x630 page and save the PNG screenshot to `output`.
export async function generateOgImage({
  browserType = chromium,
  output = OUTPUT,
} = {}) {
  const browser = await browserType.launch();
  const context = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.setContent(HTML, { waitUntil: "networkidle" });
  // Extra wait for web font to render.
  await page.waitForTimeout(500);
  await page.screenshot({ path: output, type: "png", omitBackground: false });
  await browser.close();
  console.log(`Wrote ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateOgImage();
}
