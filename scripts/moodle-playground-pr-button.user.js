// ==UserScript==
// @name         Open in Moodle Playground
// @namespace    https://github.com/ateeducacion/moodle-playground
// @version      0.3
// @description  Add an "Open in Moodle Playground" button on Moodle core GitHub pull requests (and Moodle tracker issues that link a PR) to preview the PR with a runtime file overlay. On tracker issues it also detects an explicit "Moodle Playground Scenario" blueprint block in the description (or offers a starter scenario) so the instance boots preconfigured for reproducing the issue. Inspired by Sara Arjona's "Open in Gitpod" tracker userscript.
// @author       ateeducacion
// @match        https://github.com/*/pull/*
// @match        https://moodle.atlassian.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=moodle.org
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

// IMPORTANT: this script declares a @grant (GM_xmlhttpRequest) on purpose. With
// `@grant none` Tampermonkey injects the script as a page <script>, which GitHub
// and Atlassian block via their Content-Security-Policy (script-src 'self'). A
// real grant makes Tampermonkey run the script in its sandboxed content-script
// world instead, which is not subject to the page CSP. The badge is also a pure
// CSS element (no external <img>) so it does not depend on the page's img-src.

(() => {
  // ─────────────────────────────────────────────────────────────────────────
  // Configuration — change PLAYGROUND_HOST to your deployment if needed, e.g.
  // a branch preview (https://feat-x.moodle-playground.pages.dev) or your own
  // GitHub Pages host.
  // ─────────────────────────────────────────────────────────────────────────
  const PLAYGROUND_HOST = "https://ateeducacion.github.io/moodle-playground";
  const RUN_UPGRADE = "auto"; // off | on | auto
  // Offer a generic starter scenario on tracker issues without an explicit
  // scenario block (1 course, teacher + student enrolled, sample activities).
  const STARTER_SCENARIO = true;
  const BUTTON_ID = "moodle-playground-preview-button";
  const SCENARIO_BUTTON_ID = "moodle-playground-scenario-button";
  const BUTTON_CLASS = "mpp-preview-button";
  // Unique repo/base/head comparisons already decorated on the tracker.
  const seenCompares = new Set();

  // Map a PR target branch (base.ref) to a Moodle Playground base version. Kept
  // identical to the action/runtime so the button picks the same base bundle.
  const BASE_REF_TO_VERSION = {
    MOODLE_404_STABLE: "4.4",
    MOODLE_405_STABLE: "4.5",
    MOODLE_500_STABLE: "5.0",
    MOODLE_501_STABLE: "5.1",
    MOODLE_502_STABLE: "5.2",
    main: "dev",
    master: "dev",
  };

  // Derive a base version from a Moodle peer-review branch suffix. The tracker
  // names branches like MDL-12345-main / -501 / -500 / -405 / -404, one per
  // Moodle version. "-main" → dev; "-NNN" → N.(rest), e.g. 501 → 5.1, 405 → 4.5.
  function branchSuffixToVersion(branch) {
    const m = String(branch).match(/-(main|master|\d{3})$/u);
    if (!m) return "dev";
    const suffix = m[1];
    if (suffix === "main" || suffix === "master") return "dev";
    return `${suffix[0]}.${Number(suffix.slice(1))}`;
  }

  // URL-safe base64 (RFC 4648 §5) of a UTF-8 string, matching how the playground
  // decodes the ?blueprint= parameter.
  function toBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  }

  // GET a JSON document, preferring GM_xmlhttpRequest (bypasses the page CSP's
  // connect-src and CORS), falling back to fetch. Resolves null on any failure.
  function apiGetJson(url) {
    return new Promise((resolve) => {
      const gm =
        typeof GM_xmlhttpRequest === "function"
          ? GM_xmlhttpRequest
          : typeof GM !== "undefined" && GM && GM.xmlHttpRequest;
      if (gm) {
        gm({
          method: "GET",
          url,
          headers: { Accept: "application/vnd.github+json" },
          timeout: 8000,
          onload: (r) => {
            try {
              resolve(JSON.parse(r.responseText));
            } catch {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } else if (typeof fetch === "function") {
        fetch(url, { headers: { Accept: "application/vnd.github+json" } })
          .then((r) => (r.ok ? r.json() : null))
          .then(resolve)
          .catch(() => resolve(null));
      } else {
        resolve(null);
      }
    });
  }

  // Build a compact repo+pr applyPrOverlay blueprint URL. The runtime fetches the
  // PR's changed files itself, so the URL stays small regardless of PR size.
  function buildPlaygroundUrl(repo, pr, baseRef) {
    const version = BASE_REF_TO_VERSION[baseRef] || "dev";
    const blueprint = {
      preferredVersions: { php: "8.3", moodle: version },
      landingPage: "/admin/index.php",
      steps: [
        {
          step: "installMoodle",
          options: {
            siteName: `Moodle core PR #${pr} preview`,
            adminUser: "admin",
            adminPass: "password",
          },
        },
        {
          step: "applyPrOverlay",
          repo,
          pr: Number(pr),
          baseRef: baseRef || "main",
          runUpgrade: RUN_UPGRADE,
        },
        { step: "login", username: "admin" },
      ],
    };
    return `${PLAYGROUND_HOST}/?blueprint=${toBase64Url(JSON.stringify(blueprint))}`;
  }

  // Build a compact compare-mode blueprint URL (Moodle peer-review: repo + base
  // SHA/branch + head branch). The runtime diffs base...head itself, so the URL
  // stays small.
  function buildCompareUrl(repo, base, head) {
    const version = branchSuffixToVersion(head);
    const blueprint = {
      preferredVersions: { php: "8.3", moodle: version },
      landingPage: "/admin/index.php",
      steps: [
        {
          step: "installMoodle",
          options: {
            siteName: `Moodle preview ${head}`,
            adminUser: "admin",
            adminPass: "password",
          },
        },
        {
          step: "applyPrOverlay",
          repo,
          base,
          head,
          runUpgrade: RUN_UPGRADE,
        },
        { step: "login", username: "admin" },
      ],
    };
    return `${PLAYGROUND_HOST}/?blueprint=${toBase64Url(JSON.stringify(blueprint))}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Moodle Playground Scenario extraction (issue #166, ADR 0017).
  //
  // A tracker issue description may embed an explicit blueprint block. Two
  // documented forms, both detected on plain text (Jira's renderer strips
  // markdown fences, so detection cannot rely on DOM structure):
  //   A. a fenced code block:      ```moodle-playground\n{ ...blueprint... }
  //   B. the marker phrase "Moodle Playground Scenario" (e.g. a heading)
  //      followed by a code block containing the blueprint JSON object.
  // Content is parsed with JSON.parse only — never evaluated.
  // ─────────────────────────────────────────────────────────────────────────
  const SCENARIO_MARKER_SOURCES = [
    "```\\s*moodle-playground(?![\\w-])",
    "moodle\\s+playground\\s+scenario",
  ];

  // NOTE: the tracker injector falls back to document.body.textContent, which
  // includes these labels once injected. None of them may match a scenario
  // marker or the injector would flip-flop between states on every tick
  // (guarded by a unit test).
  const TRACKER_BUTTON_LABELS = {
    scenario: "▶ Open issue scenario in Moodle Playground",
    starter: "▶ Open in Moodle Playground (starter site)",
    invalid: "⚠ Moodle Playground: invalid scenario block",
  };

  // Return the balanced JSON object substring starting at text[start] ("{"),
  // or null when the braces never balance. String-aware: braces inside JSON
  // string values (and escaped quotes) are ignored.
  function scanJsonObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  // Extract a Moodle Playground scenario blueprint from description text.
  // Returns { found: false } when there is no scenario block,
  // { found: true, blueprint } for a valid one, or { found: true, error }
  // when a block exists but is broken (so the author gets a clear signal).
  function extractPlaygroundScenario(text) {
    if (typeof text !== "string" || !text) return { found: false };
    let marker = null;
    for (const sourcePattern of SCENARIO_MARKER_SOURCES) {
      const m = new RegExp(sourcePattern, "iu").exec(text);
      if (m && (!marker || m.index < marker.index)) marker = m;
    }
    if (!marker) return { found: false };
    const start = text.indexOf("{", marker.index + marker[0].length);
    // A marker with no JSON after it is a mere mention, not a scenario.
    if (start === -1) return { found: false };
    const jsonText = scanJsonObject(text, start);
    if (jsonText === null) {
      return {
        found: true,
        error: "Scenario block is not a balanced JSON object.",
      };
    }
    let blueprint;
    try {
      blueprint = JSON.parse(jsonText);
    } catch (error) {
      return {
        found: true,
        error: `Scenario block is not valid JSON: ${error.message}`,
      };
    }
    if (
      !blueprint ||
      typeof blueprint !== "object" ||
      Array.isArray(blueprint)
    ) {
      return { found: true, error: "Scenario must be a JSON object." };
    }
    if (!Array.isArray(blueprint.steps)) {
      return { found: true, error: "Scenario must have a 'steps' array." };
    }
    return { found: true, blueprint };
  }

  // Encode a scenario blueprint verbatim into a playground URL, using the
  // same base64url ?blueprint= convention as the PR/compare buttons.
  function buildScenarioUrl(blueprint) {
    return `${PLAYGROUND_HOST}/?blueprint=${toBase64Url(JSON.stringify(blueprint))}`;
  }

  // The starter scenario is a bundled example blueprint (single source of
  // truth), referenced relative to the playground URL so it works on any
  // deployment, including subpath hosting.
  function buildStarterUrl() {
    return `${PLAYGROUND_HOST}/?blueprint-url=assets/blueprints/examples/tracker-starter.blueprint.json`;
  }

  // A CSS-only badge (no external image, so it is immune to the page's img-src
  // CSP). Returns the anchor element.
  function makeButton(url, { id, block = false, label, title } = {}) {
    const a = document.createElement("a");
    if (id) a.id = id;
    a.className = BUTTON_CLASS;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label || "▶ Open in Moodle Playground";
    a.title = title || "Preview this pull request in Moodle Playground";
    a.style.cssText = [
      // Block badges sit on their own line, sized to content (used on the
      // tracker, after the smart-link wrapper); inline badges sit beside the
      // PR-header title.
      block
        ? "display:flex;width:max-content;margin-top:8px"
        : "display:inline-flex;margin-left:8px",
      "align-items:center",
      "gap:6px",
      "padding:5px 12px",
      "border-radius:6px",
      "font:600 12px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "color:#fff",
      "background:#f98012",
      "text-decoration:none",
      "border:1px solid rgba(27,31,36,.15)",
      "white-space:nowrap",
      "vertical-align:middle",
      "cursor:pointer",
    ].join(";");
    return a;
  }

  // True when an href points at the configured playground host (parsed, not a
  // substring match).
  function isPlaygroundLink(href) {
    try {
      return (
        new URL(href, location.href).host === new URL(PLAYGROUND_HOST).host
      );
    } catch {
      return false;
    }
  }

  // Prefer a preview link already posted by the GitHub Action (in the PR body or
  // a comment) so the button matches the action-generated, reproducible preview.
  function findExistingActionLink() {
    for (const a of document.querySelectorAll("a[href]")) {
      if (isPlaygroundLink(a.getAttribute("href"))) return a.href;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GitHub pull request pages (Primer React PageHeader UI)
  // ─────────────────────────────────────────────────────────────────────────
  function githubPrInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/u);
    if (!m) return null;
    const [, owner, repo, pr] = m;
    // Only Moodle core repositories (moodle/moodle and forks named "moodle").
    if (repo.toLowerCase() !== "moodle") return null;
    return { owner, repo, repoFullName: `${owner}/${repo}`, pr };
  }

  // Read the PR base branch from the header BranchName chips ("owner:branch").
  // The base branch is the first BranchName and is prefixed with the base owner.
  function readBaseRefFromDom(baseOwner) {
    const chips = [
      ...document.querySelectorAll(
        '[data-component="BranchName"], .commit-ref',
      ),
    ].map((e) => e.textContent.trim());
    if (chips.length === 0) return null;
    const ownerMatch = chips.find((t) =>
      t.toLowerCase().startsWith(`${baseOwner.toLowerCase()}:`),
    );
    const chosen = ownerMatch || chips[0];
    const colon = chosen.indexOf(":");
    return colon >= 0 ? chosen.slice(colon + 1) : chosen;
  }

  async function resolveBaseRef(info) {
    const fromDom = readBaseRefFromDom(info.owner);
    if (fromDom) return fromDom;
    // Fall back to the public REST API.
    const data = await apiGetJson(
      `https://api.github.com/repos/${info.repoFullName}/pulls/${info.pr}`,
    );
    return data?.base?.ref || null;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }

  // GitHub's Primer header renders several responsive copies of each region
  // (some hidden). Prefer the actions row (next to the "Code" button) when it is
  // visible — i.e. when signed in — and fall back to the title row (PH_Actions is
  // empty/hidden when signed out). Pick the first VISIBLE container.
  function ghInsertionPoint() {
    const candidates = [
      '[data-component="PH_Actions"]',
      '[data-component="PH_Title"]',
      '[data-component="PageHeader.Description"]',
      '[data-component="PageHeader"]',
      ".gh-header-actions",
    ];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  // Last-resort floating button so the badge always appears even if GitHub's
  // header markup changes again.
  function mountFloating(url) {
    const wrap = document.createElement("div");
    wrap.id = BUTTON_ID;
    wrap.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    wrap.appendChild(makeButton(url));
    document.body.appendChild(wrap);
  }

  async function injectGithub() {
    const info = githubPrInfo();
    if (!info) return;
    if (document.getElementById(BUTTON_ID)) return; // already injected

    const baseRef = await resolveBaseRef(info);
    if (document.getElementById(BUTTON_ID)) return; // re-check after await

    const url =
      findExistingActionLink() ||
      buildPlaygroundUrl(info.repoFullName, info.pr, baseRef);

    const target = ghInsertionPoint();
    if (target) {
      target.appendChild(makeButton(url, { id: BUTTON_ID }));
    } else {
      mountFloating(url);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Moodle tracker (Jira) — add a button next to each linked GitHub PR.
  // Mirrors Sara Arjona's tracker userscript, but resolves a PR (repo + number)
  // rather than a Gitpod branch, because the overlay previews a pull request.
  // ─────────────────────────────────────────────────────────────────────────
  // Insert a badge for a tracker link. The tracker renders GitHub URLs as
  // Atlassian "smart links" wrapped in a hover-card trigger (and the link itself
  // has overflow:hidden). Insert the badge AFTER that wrapper so it is not
  // clipped and hovering it does not pop the GitHub hover-card preview.
  function trackerInsert(a, url) {
    let anchor =
      a.closest('[data-testid="hover-card-trigger-wrapper"]') ||
      a.closest('[data-testid="smart-links-container"]') ||
      a;
    // Climb to the bordered field-value box, if one is nearby, so the badge sits
    // cleanly on its own line BELOW the field instead of squeezed inside the
    // smart link's clipped, hover-card box.
    let box = anchor;
    for (let i = 0; i < 6 && box; i++) {
      const cs = getComputedStyle(box);
      if (cs.borderTopWidth !== "0px" && cs.borderTopStyle !== "none") {
        anchor = box;
        break;
      }
      box = box.parentElement;
    }
    anchor.insertAdjacentElement("afterend", makeButton(url, { block: true }));
  }

  function injectTracker() {
    // GitHub PR links (rare for core, but supported).
    for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
      let m = null;
      try {
        const u = new URL(a.href, location.href);
        if (u.host === "github.com") {
          m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/u);
        }
      } catch {
        m = null;
      }
      if (!m) continue;
      const [, owner, repo, pr] = m;
      if (repo.toLowerCase() !== "moodle") continue;
      if (a.dataset.mppButton) continue; // already decorated this link
      a.dataset.mppButton = "1";
      const url = buildPlaygroundUrl(`${owner}/${repo}`, pr, null);
      trackerInsert(a, url);
    }

    // GitHub compare links — the actual Moodle peer-review format. The tracker's
    // "Pull … Diff URL" fields render links like
    // github.com/<owner>/moodle/compare/<base>...<head> (optionally with ?w=1).
    for (const a of document.querySelectorAll('a[href*="/compare/"]')) {
      let parsed = null;
      try {
        const u = new URL(a.href, location.href);
        if (u.host === "github.com") {
          const m = u.pathname.match(
            /^\/([^/]+)\/([^/]+)\/compare\/(.+?)\.\.\.(.+)$/u,
          );
          if (m) {
            parsed = {
              owner: m[1],
              repo: m[2],
              base: decodeURIComponent(m[3]),
              head: decodeURIComponent(m[4]),
            };
          }
        }
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      if (parsed.repo.toLowerCase() !== "moodle") continue;
      if (a.dataset.mppButton) continue;
      a.dataset.mppButton = "1";
      // The same comparison is often rendered in several tracker fields; show
      // only one button per unique repo/base/head.
      const key = `${parsed.owner}/${parsed.repo}|${parsed.base}|${parsed.head}`;
      if (seenCompares.has(key)) continue;
      seenCompares.add(key);
      const url = buildCompareUrl(
        `${parsed.owner}/${parsed.repo}`,
        parsed.base,
        parsed.head,
      );
      trackerInsert(a, url);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Moodle tracker — scenario / starter button (issue #166, ADR 0017).
  //
  // On issue pages, look for an explicit "Moodle Playground Scenario" block in
  // the description and offer to open the playground preconfigured with it.
  // Without one, offer the documented starter scenario instead. The button
  // floats bottom-right: it needs no Atlassian layout hooks, so tracker markup
  // changes cannot break it (only the page text is read).
  // ─────────────────────────────────────────────────────────────────────────
  function trackerIssueKey() {
    const m = location.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)/u);
    return m ? m[1] : null;
  }

  // Concatenated text of a subtree, like textContent, but skipping script,
  // style, and our own injected button — page scripts may embed marker-like
  // strings and must never be mistaken for a scenario.
  function collectVisibleText(root) {
    if (!root) return "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(`#${SCENARIO_BUTTON_ID}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = "";
    while (walker.nextNode()) text += walker.currentNode.nodeValue;
    return text;
  }

  // Prefer the issue description container; fall back to the whole page so an
  // Atlassian markup change degrades to "scan all page text", not a breakage.
  function trackerDescriptionText() {
    const container = document.querySelector(
      '[data-testid="issue.views.field.rich-text.description"]',
    );
    return collectVisibleText(container || document.body);
  }

  // Grey, non-clickable badge shown when a scenario block exists but cannot be
  // used; the tooltip carries the parse/validation error for the author.
  function makeInvalidBadge(detail) {
    const s = document.createElement("span");
    s.className = BUTTON_CLASS;
    s.textContent = TRACKER_BUTTON_LABELS.invalid;
    s.title = `The scenario block in this issue cannot be used: ${detail}`;
    s.style.cssText = [
      "display:flex;width:max-content",
      "align-items:center",
      "gap:6px",
      "padding:5px 12px",
      "border-radius:6px",
      "font:600 12px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "color:#fff",
      "background:#6a737d",
      "border:1px solid rgba(27,31,36,.15)",
      "white-space:nowrap",
      "cursor:help",
    ].join(";");
    return s;
  }

  // What the scenario button should currently show, or null for none (not an
  // issue page, or no scenario and the starter is disabled).
  function desiredScenarioState() {
    const key = trackerIssueKey();
    if (!key) return null;
    const result = extractPlaygroundScenario(trackerDescriptionText());
    if (!result.found) {
      return STARTER_SCENARIO
        ? { key, kind: "starter", url: buildStarterUrl() }
        : null;
    }
    if (result.error) return { key, kind: "invalid", detail: result.error };
    return { key, kind: "scenario", url: buildScenarioUrl(result.blueprint) };
  }

  function injectTrackerScenario() {
    const state = desiredScenarioState();
    const existing = document.getElementById(SCENARIO_BUTTON_ID);
    if (!state) {
      if (existing) existing.remove();
      return;
    }
    // Idempotent render: a state stamp makes repeated passes no-ops, while SPA
    // navigation or a late-loading description swaps the button in place.
    const stamp = `${state.kind}|${state.key}|${state.url || state.detail}`;
    if (existing) {
      if (existing.dataset.mppState === stamp) return;
      existing.remove();
    }
    const wrap = document.createElement("div");
    wrap.id = SCENARIO_BUTTON_ID;
    wrap.dataset.mppState = stamp;
    wrap.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    if (state.kind === "invalid") {
      wrap.appendChild(makeInvalidBadge(state.detail));
    } else {
      wrap.appendChild(
        makeButton(state.url, {
          label: TRACKER_BUTTON_LABELS[state.kind],
          title:
            state.kind === "scenario"
              ? `Open Moodle Playground preconfigured with the ${state.key} scenario`
              : "Open Moodle Playground with a generic reproduction site (course, teacher, student, sample activities)",
        }),
      );
    }
    document.body.appendChild(wrap);
  }

  function tick() {
    if (location.host === "github.com") injectGithub();
    else if (location.host === "moodle.atlassian.net") {
      injectTracker();
      injectTrackerScenario();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Test hook — tests/scripts/tracker-scenario.test.js evaluates this file in
  // a node:vm sandbox that defines __MPP_TEST__. Hand over the pure helpers
  // and skip the DOM wiring below. Tampermonkey never defines this, so the
  // hook is inert in the browser.
  // ─────────────────────────────────────────────────────────────────────────
  if (typeof __MPP_TEST__ === "function") {
    __MPP_TEST__({
      PLAYGROUND_HOST,
      SCENARIO_MARKER_SOURCES,
      TRACKER_BUTTON_LABELS,
      branchSuffixToVersion,
      toBase64Url,
      buildPlaygroundUrl,
      buildCompareUrl,
      scanJsonObject,
      extractPlaygroundScenario,
      buildScenarioUrl,
      buildStarterUrl,
    });
    return;
  }

  // GitHub and Jira are SPAs: re-run on DOM mutations (debounced) and on a short
  // interval so the button survives client-side navigation between PRs/issues.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tick();
    }, 400);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(tick, 2000);
  tick();
})();
