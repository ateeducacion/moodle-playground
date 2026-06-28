// ==UserScript==
// @name         Open in Moodle Playground
// @namespace    https://github.com/ateeducacion/moodle-playground
// @version      0.1
// @description  Add an "Open in Moodle Playground" button on Moodle core GitHub pull requests (and Moodle tracker issues that link a PR) to preview the PR with a runtime file overlay. Inspired by Sara Arjona's "Open in Gitpod" tracker userscript.
// @author       ateeducacion
// @match        https://github.com/*/pull/*
// @match        https://moodle.atlassian.net/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=moodle.org
// @grant        none
// ==/UserScript==

(() => {
  // ─────────────────────────────────────────────────────────────────────────
  // Configuration — change PLAYGROUND_HOST to your deployment if needed, e.g.
  // a branch preview (https://feat-x.moodle-playground.pages.dev) or your own
  // GitHub Pages host.
  // ─────────────────────────────────────────────────────────────────────────
  const PLAYGROUND_HOST = "https://ateeducacion.github.io/moodle-playground";
  const RUN_UPGRADE = "auto"; // off | on | auto
  const BUTTON_IMG =
    "https://raw.githubusercontent.com/ateeducacion/moodle-playground/main/assets/playground-preview-button.svg";
  const BUTTON_ID = "moodle-playground-preview-button";

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

  // Build the badge anchor element.
  function makeButton(url, { block = false } = {}) {
    const a = document.createElement("a");
    a.id = BUTTON_ID;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = "Preview this pull request in Moodle Playground";
    a.style.cssText = `display:inline-block;${block ? "margin-top:8px;" : "margin-left:8px;"}vertical-align:middle;`;
    const img = document.createElement("img");
    img.src = BUTTON_IMG;
    img.alt = "Open in Moodle Playground";
    img.style.cssText = "height:30px;max-width:100%;";
    a.appendChild(img);
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
    for (const a of document.querySelectorAll(
      ".js-comment-body a, .markdown-body a, .comment-body a",
    )) {
      if (isPlaygroundLink(a.href)) return a.href;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GitHub pull request pages
  // ─────────────────────────────────────────────────────────────────────────
  function githubPrInfo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/u);
    if (!m) return null;
    const [, owner, repo, pr] = m;
    // Only Moodle core repositories (moodle/moodle and forks named "moodle").
    if (repo.toLowerCase() !== "moodle") return null;
    return { owner, repo, repoFullName: `${owner}/${repo}`, pr };
  }

  // The base branch shown in the PR header ("base ← compare").
  function readBaseRefFromDom() {
    const el = document.querySelector(".base-ref, .commit-ref.base-ref");
    return el ? el.textContent.trim() : null;
  }

  async function resolveBaseRef(info) {
    const fromDom = readBaseRefFromDom();
    if (fromDom) return fromDom;
    // Fall back to the public REST API (unauthenticated, CORS-enabled, 60/hour).
    try {
      const res = await fetch(
        `https://api.github.com/repos/${info.repoFullName}/pulls/${info.pr}`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (res.ok) {
        const data = await res.json();
        return data?.base?.ref || null;
      }
    } catch {
      /* offline / rate-limited — fall through */
    }
    return null;
  }

  function ghInsertionPoint() {
    return (
      document.querySelector(".gh-header-actions") ||
      document.querySelector(".gh-header-meta") ||
      document.querySelector(".gh-header-show") ||
      null
    );
  }

  async function injectGithub() {
    const info = githubPrInfo();
    if (!info) return;
    if (document.getElementById(BUTTON_ID)) return; // already injected

    const target = ghInsertionPoint();
    if (!target) return; // header not rendered yet; the observer will retry

    const baseRef = await resolveBaseRef(info);
    // Re-check after the await in case another tick already injected it.
    if (document.getElementById(BUTTON_ID)) return;

    const url =
      findExistingActionLink() ||
      buildPlaygroundUrl(info.repoFullName, info.pr, baseRef);
    target.appendChild(makeButton(url));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Moodle tracker (Jira) — add a button next to each linked GitHub PR.
  // Mirrors Sara Arjona's tracker userscript, but resolves a PR (repo + number)
  // rather than a Gitpod branch, because the overlay previews a pull request.
  // ─────────────────────────────────────────────────────────────────────────
  function injectTracker() {
    for (const a of document.querySelectorAll('a[href*="/pull/"]')) {
      const m = (() => {
        try {
          const u = new URL(a.href, location.href);
          if (u.host !== "github.com") return null;
          return u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/u);
        } catch {
          return null;
        }
      })();
      if (!m) continue;
      const [, owner, repo, pr] = m;
      if (repo.toLowerCase() !== "moodle") continue;
      if (a.dataset.mppButton) continue; // already decorated this link
      a.dataset.mppButton = "1";
      const url = buildPlaygroundUrl(`${owner}/${repo}`, pr, null);
      a.insertAdjacentElement("afterend", makeButton(url, { block: true }));
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
