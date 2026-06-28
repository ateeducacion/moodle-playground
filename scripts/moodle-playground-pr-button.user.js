// ==UserScript==
// @name         Open in Moodle Playground
// @namespace    https://github.com/ateeducacion/moodle-playground
// @version      0.2
// @description  Add an "Open in Moodle Playground" button on Moodle core GitHub pull requests (and Moodle tracker issues that link a PR) to preview the PR with a runtime file overlay. Inspired by Sara Arjona's "Open in Gitpod" tracker userscript.
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
  const BUTTON_ID = "moodle-playground-preview-button";
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

  // A CSS-only badge (no external image, so it is immune to the page's img-src
  // CSP). Returns the anchor element.
  function makeButton(url, { id, block = false } = {}) {
    const a = document.createElement("a");
    if (id) a.id = id;
    a.className = BUTTON_CLASS;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "▶ Open in Moodle Playground";
    a.title = "Preview this pull request in Moodle Playground";
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
  // (some hidden, e.g. PH_Actions is empty when logged out). Pick the first
  // VISIBLE container; the PR title row is the most reliable anchor.
  function ghInsertionPoint() {
    const candidates = [
      '[data-component="PH_Title"]',
      '[data-component="PH_Actions"]',
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
    const anchor =
      a.closest('[data-testid="hover-card-trigger-wrapper"]') ||
      a.closest('[data-testid="smart-links-container"]') ||
      a;
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

  function tick() {
    if (location.host === "github.com") injectGithub();
    else if (location.host === "moodle.atlassian.net") injectTracker();
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
