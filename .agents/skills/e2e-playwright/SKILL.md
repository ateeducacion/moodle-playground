---
name: e2e-playwright
description: End-to-end testing expert with Playwright. Use when writing, debugging, or reviewing browser-based tests that verify the full Moodle Playground flow — shell boot, Moodle runtime loading, blueprint execution, iframe navigation, service worker routing, and UI interactions. Covers Playwright API, iframe handling, waiting strategies for WASM boot, and test patterns specific to this project.
metadata:
  author: moodle-playground
  version: "1.0"
---

# E2E Testing Expert (Playwright)

## Role

You are an expert in end-to-end browser testing with Playwright, specifically
for this project's unique architecture: a shell page hosting an iframe that
loads a service worker, which boots a PHP WASM runtime running Moodle. You
understand the timing complexities of waiting for WASM boot, how to interact
with content inside nested iframes, and how to write reliable tests for a
runtime that takes 10-30 seconds to fully initialize.

## When to activate

- Writing or debugging Playwright e2e tests in `tests/e2e/`
- Testing full user flows (boot → navigate → interact)
- Verifying blueprint execution results in the browser
- Testing service worker routing and HTML rewriting
- Debugging test flakiness related to WASM boot timing
- Adding e2e coverage for new features

## Infrastructure

### Configuration

**File:** `playwright.config.mjs`

```javascript
{
  testDir: "./tests/e2e",
  timeout: 180_000,       // 3 minutes per test (WASM boot is slow)
  expect: { timeout: 30_000 },
  webServer: {
    command: "PORT=8085 make serve",  // or "make up" if no bundle exists
    url: "http://127.0.0.1:8085",
    timeout: 300_000,     // 5 minutes for server start (includes bundling)
  },
}
```

### Run commands

```bash
make test-e2e                        # Run all e2e tests
npm run test:e2e                     # Same via npm
npx playwright test --headed         # Watch mode with browser visible
npx playwright test shell.spec.mjs   # Run specific spec file
npx playwright show-report           # View HTML report after run

# First time setup
npm run test:e2e:install             # Install Chromium browser
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PLAYWRIGHT_BASE_URL` | `http://127.0.0.1:8085` | Override the dev server URL |
| `PLAYWRIGHT_EXTERNAL_SERVER` | `0` | Set to `1` to skip auto-starting the server |
| `CI` | unset | Set in CI to use `line` reporter |

### Test file conventions

| File | What it covers |
|------|---------------|
| `shell.spec.mjs` | Shell UI: toolbar, panels, tabs, settings, blueprint loading |
| `moodle-boot.spec.mjs` | Moodle runtime: boot lifecycle, PHP info capture |
| `blueprint-courses.spec.mjs` | Blueprint execution: courses, users, modules, enrollment |

File naming: `{feature}.spec.mjs`

## Architecture awareness

### The boot timeline

```
t=0s    page.goto("/")
t=0.1s  Shell UI renders (toolbar, panels, iframe placeholder)
t=0.5s  Service worker registers
t=1s    PHP worker starts
t=2-5s  ZIP bundle downloads and extracts
t=5-15s Moodle install snapshot loads
t=15-20s Blueprint steps execute
t=20-30s Landing page renders in iframe
```

**Key insight**: Most of the wait time is WASM boot, not DOM rendering. Tests
must use long timeouts (120s+) for the initial boot but can use normal timeouts
(5-30s) for subsequent interactions.

### DOM structure

```
index.html (shell)
├── #address-input          — URL bar
├── #site-frame            — iframe hosting Moodle
├── #panel-toggle-button   — Open/close side panel
├── #side-panel            — Side panel container
│   ├── #info-tab / #info-panel     — Version info
│   ├── #logs-tab / #log-panel      — Runtime logs
│   ├── #phpinfo-tab / #phpinfo-frame — PHP info
│   └── #blueprint-tab / #blueprint-textarea — Blueprint JSON
├── #settings-button       — Open settings
├── #settings-popover      — Settings dialog
│   ├── #settings-moodle-version   — Moodle version select
│   └── #settings-php-version      — PHP version select
└── #reset-button          — Reset playground
```

### The iframe challenge

Moodle runs inside `#site-frame`, which loads `remote.html`, which creates
another nested iframe for the scoped runtime. Content inside Moodle is
**two iframes deep** from the test's page context.

Accessing Moodle content:

```javascript
// Get the first-level iframe (remote.html)
const remoteFrame = page.frame({ url: /playground\// })
  || await page.locator("#site-frame").contentFrame();

// Moodle content is inside remoteFrame or a nested iframe within it
```

**Warning**: Cross-origin restrictions may prevent direct frame access in some
configurations. For most tests, verify behavior through the shell UI (address
bar, logs, blueprint tab) rather than inspecting iframe content directly.

## Waiting strategies

### Wait for runtime ready

The most critical wait — the runtime has fully booted and Moodle is usable:

```javascript
async function waitForRuntimeReady(page) {
  // Address bar is enabled = UI is unlocked = boot complete
  await expect(page.locator("#address-input")).toBeEnabled({ timeout: 120_000 });
  // Frame has a src = runtime is mounted
  await expect(page.locator("#site-frame")).toHaveAttribute(
    "src", /scope=|playground\//
  );
}
```

### Wait for specific log entry

```javascript
async function waitForLogEntry(page, pattern, timeout = 30_000) {
  await page.locator("#panel-toggle-button").click();
  await page.locator("#logs-tab").click();
  await expect(page.locator("#log-panel")).toContainText(pattern, { timeout });
}
```

### Wait for address bar change

```javascript
async function waitForNavigation(page, pathPattern) {
  await expect(page.locator("#address-input")).toHaveValue(pathPattern, {
    timeout: 30_000,
  });
}
```

## Blueprint test pattern

The standard pattern for testing blueprint execution:

```javascript
import { buildBlueprintParam } from "./helpers.mjs";

test("blueprint does X", async ({ page }) => {
  const bp = buildBlueprintParam({
    landingPage: "/course/view.php?id=2",
    steps: [
      { step: "installMoodle", options: { siteName: "Test" } },
      { step: "login", username: "admin" },
      // ... your steps ...
      { step: "setLandingPage", path: "/course/view.php?id=2" },
    ],
  });

  await page.goto(`/?blueprint=${bp}`);
  await waitForRuntimeReady(page);

  // Verify through shell UI, not iframe content
  const address = await page.locator("#address-input").inputValue();
  expect(address).toContain("/course/view.php");
});
```

## Anti-patterns

### Don't wait with fixed timeouts

```javascript
// BAD — fragile, slow on CI
await page.waitForTimeout(30_000);

// GOOD — condition-based, fast when possible
await expect(page.locator("#address-input")).toBeEnabled({ timeout: 120_000 });
```

### Don't access Moodle content directly

```javascript
// BAD — two iframe levels, cross-origin issues
const moodleBody = await page.frameLocator("#site-frame")
  .frameLocator("iframe").locator("body").textContent();

// GOOD — verify through shell UI
await expect(page.locator("#address-input")).toHaveValue(/\/course\/view\.php/);
```

### Don't assume boot order

```javascript
// BAD — may not exist yet during boot
await page.locator("#reset-button").click();

// GOOD — ensure boot is complete first
await waitForRuntimeReady(page);
await page.locator("#panel-toggle-button").click();
await page.locator("#reset-button").click();
```

### Don't run tests in parallel

Tests share the browser and the dev server. The Moodle runtime is
single-threaded. Use `fullyParallel: false` in the config.

## Debugging tips

1. **Run headed**: `npx playwright test --headed` to watch the browser
2. **Trace viewer**: `npx playwright show-trace trace.zip` after failure
3. **Slow motion**: Add `use: { launchOptions: { slowMo: 500 } }` to config
4. **Screenshots**: `await page.screenshot({ path: "debug.png" })` mid-test
5. **Check logs**: Open the Logs tab in the side panel — bootstrap errors show there
6. **Console**: `page.on("console", msg => console.log(msg.text()))` to capture browser console

## Checklist for e2e test changes

- [ ] Does the test wait for `waitForRuntimeReady()` before interacting?
- [ ] Are timeouts appropriate? (120s+ for boot, 30s for interactions)
- [ ] Does the test verify through shell UI, not deep iframe content?
- [ ] Is `fullyParallel: false` maintained in the config?
- [ ] Does `make test-e2e` pass locally?
- [ ] Is the blueprint minimal? (fewer steps = faster boot)
- [ ] Does the test clean up any state it creates? (usually not needed — ephemeral runtime)
