# "Open in Moodle Playground" Tampermonkey button

A small [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/)
userscript that adds an **"Open in Moodle Playground"** badge on Moodle core
**GitHub pull requests** (and on Moodle **tracker** issues that link a PR). Clicking
it opens the PR in Moodle Playground using a runtime [`applyPrOverlay`](blueprint-json.md#applyproverlay)
overlay — booting a prebuilt base and applying the PR's changed files in the browser.

It is inspired by Sara Arjona's ["Open in Gitpod" tracker userscript](https://gist.github.com/sarjona/9fc728eb2d2b41a783ea03afd6a6161e)
([documented in the Moodle dev docs](https://moodledev.io/general/development/tools/gitpod)),
which adds a Gitpod badge on tracker issues. This one targets pull requests and the
Playground overlay instead.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the raw script to trigger a one-click install:

   **[`scripts/moodle-playground-pr-button.user.js`](https://raw.githubusercontent.com/ateeducacion/moodle-playground/main/scripts/moodle-playground-pr-button.user.js)**

   (Tampermonkey detects the `.user.js` URL and shows its install screen.)
3. Open any Moodle core PR, e.g. <https://github.com/moodle/moodle/pull/532>, and the
   badge appears in the PR header.

The source lives at [`scripts/moodle-playground-pr-button.user.js`](../scripts/moodle-playground-pr-button.user.js).

## Configure

Edit the constants at the top of the script:

```js
// Your deployment. Use a branch preview or your own GitHub Pages host.
const PLAYGROUND_HOST = "https://ateeducacion.github.io/moodle-playground";
const RUN_UPGRADE = "auto"; // off | on | auto
```

Point `PLAYGROUND_HOST` at whichever Moodle Playground you run — the production host, a
GitHub Pages deployment, or a branch preview such as
`https://feat-pr-overlay-preview.moodle-playground.pages.dev`.

## How it works

The button builds the **same compact `repo` + `pr` blueprint** the GitHub Action emits for
large PRs, so the URL stays small no matter how many files the PR changes — the runtime
fetches the changed files itself:

```js
function buildPlaygroundUrl(repo, pr, baseRef) {
  const version = BASE_REF_TO_VERSION[baseRef] || "dev";
  const blueprint = {
    preferredVersions: { php: "8.3", moodle: version },
    landingPage: "/admin/index.php",
    steps: [
      { step: "installMoodle", options: { siteName: `Moodle core PR #${pr} preview`,
          adminUser: "admin", adminPass: "password" } },
      { step: "applyPrOverlay", repo, pr: Number(pr), baseRef: baseRef || "main",
          runUpgrade: RUN_UPGRADE },
      { step: "login", username: "admin" },
    ],
  };
  return `${PLAYGROUND_HOST}/?blueprint=${toBase64Url(JSON.stringify(blueprint))}`;
}
```

Key behaviours:

- **Runs under the page CSP** (`@grant GM_xmlhttpRequest`): GitHub and Atlassian send a strict
  `Content-Security-Policy` (`script-src 'self'`). With `@grant none` Tampermonkey injects the
  userscript as a page `<script>`, which that CSP **blocks** (you would see
  `Loading the script … violates … script-src` in the console and the button never appears).
  Declaring a real `@grant` makes Tampermonkey run the script in its sandboxed content-script
  world instead, which is not subject to the page CSP. The badge is a **CSS-only** element (no
  external `<img>`), so it is also immune to the page's `img-src`.
- **GitHub PR pages** (`https://github.com/<owner>/moodle/pull/<n>`): reads the owner, repo,
  and PR number from the URL (only repositories **named `moodle`**, so `moodle/moodle` and
  its forks), resolves the **base branch** from the PR header branch chips (or the public REST
  API), maps it to a base version, and injects the badge into the first **visible** header
  region of GitHub's Primer React `PageHeader` (the title row), with a floating bottom-right
  button as a last-resort fallback if the header markup changes again.
- **Action link preference**: if the GitHub Action already posted a preview link in the PR
  description or a comment, the button reuses that (reproducible, pre-resolved) URL instead
  of generating its own — `findExistingActionLink()` compares hosts by parsing the URL, not
  by substring.
- **Moodle tracker** (`https://moodle.atlassian.net/*`): Moodle's peer review does not use
  pull requests — an issue's **Pull from Repository** is a GitHub fork and the **Pull … Diff
  URL** fields render GitHub **compare** links (`…/moodle/compare/<base>...<head>`), one per
  Moodle version. The script detects those compare links (and any `/pull/` links), derives the
  base version from the branch suffix (`-main`→dev, `-501`→5.1, `-500`→5.0, …), and adds a badge
  next to each — the tracker equivalent of Sara Arjona's button. Each unique `repo/base/head` is
  shown once. (Earlier the script only matched `/pull/` links, so most tracker issues had no
  button.)
- **Forks**: fully supported — the overlay resolves the PR head (the fork) from the base
  repo + PR number, so a fork PR against `moodle/moodle` previews the fork's changes.
- **SPA-safe**: GitHub and Jira are single-page apps, so the script re-runs on DOM mutations
  (debounced) and on a short interval, and guards against inserting duplicate buttons.

## Base branch → base version

| PR target branch (`base.ref`) | Base version |
|-------------------------------|--------------|
| `MOODLE_404_STABLE`           | 4.4 |
| `MOODLE_405_STABLE`           | 4.5 |
| `MOODLE_500_STABLE`           | 5.0 |
| `MOODLE_501_STABLE`           | 5.1 |
| `MOODLE_502_STABLE`           | 5.2 |
| `main` / `master`             | dev |

## Limitations

- The button uses the public GitHub REST API only to read the base branch when it is not in
  the page DOM (unauthenticated, ~60 requests/hour). The overlay itself runs entirely in your
  browser.
- GitHub's and Jira's DOM markup changes over time; the script targets GitHub's current Primer
  React `PageHeader` and falls back to a floating button, but if the badge stops appearing the
  selectors in `ghInsertionPoint()` / the tracker scan may need updating.
- **Moodle tracker**: the badge appears next to the GitHub **compare** links the tracker renders
  in the "Pull … Diff URL" fields (and any `/pull/` links). Moodle does **not** use Gerrit, and
  `git.moodle.org` is only the read-only mirror — the actual review branch lives on the fork named
  in "Pull from Repository". If an issue has no such GitHub link yet (e.g. before peer review is
  requested), no button is shown there.
- This previews changed **files** over a prebuilt base; the same
  [limitations as the overlay](blueprint-json.md#limitations) apply (Composer, frontend
  builds, generated assets, DB upgrades, SQLite/WASM fidelity).
- It only adds a button for repositories named `moodle`; previewing arbitrary plugin PRs is
  the job of the [GitHub Action](https://github.com/ateeducacion/action-moodle-playground-pr-preview).

## Credits

Inspired by Sara Arjona ([@sarjona](https://github.com/sarjona)) and Pau Ferrer's
["Open in Gitpod" tracker userscript](https://gist.github.com/sarjona/9fc728eb2d2b41a783ea03afd6a6161e).
