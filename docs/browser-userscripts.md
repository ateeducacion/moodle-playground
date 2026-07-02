# Browser userscripts

The **"Open in Moodle Playground"** userscript adds a one-click preview button to
Moodle **core** pull requests on GitHub and to Moodle **tracker** peer-review issues.
Click it to boot the proposed change in the browser — no checkout, no local Moodle.

It targets Moodle **core** only (repositories named `moodle`). For plugin and theme
PRs, use the [GitHub Action](github/pr-previews.md) instead.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or
   [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw script URL — the manager detects the `.user.js` file and shows a
   one-click install screen:

   ```text
   https://raw.githubusercontent.com/ateeducacion/moodle-playground/main/scripts/moodle-playground-pr-button.user.js
   ```

3. Confirm the install. Open any Moodle core PR (for example
   `https://github.com/moodle/moodle/pull/532`) and the button appears in the PR header.

!!! tip
    The script also runs on the Moodle tracker and adds a button to issues that
    link a GitHub compare or pull-request URL — see [Compare mode](#compare-mode) below.

## GitHub core-PR flow

On a `https://github.com/<owner>/moodle/pull/<n>` page the script:

1. Reads the owner, repo, and PR number from the URL (only repositories named
   `moodle`, so `moodle/moodle` and its forks).
2. Resolves the PR base branch from the page, mapping it to a base Moodle version
   (`MOODLE_500_STABLE` → 5.0, `main`/`master` → development, and so on).
3. Builds a blueprint with `installMoodle` + `applyPrOverlay` + `login` and opens the
   playground with `?blueprint=<inline>`.

The playground boots a prebuilt base for that version and overlays the PR's changed
files at runtime, then logs in as `admin`. If the [GitHub Action](github/pr-previews.md)
already posted a preview link on the PR, the button reuses that link instead.

## Compare mode

Moodle's peer-review workflow does not always use pull requests — reviewers often
post a GitHub **compare** link on the tracker issue instead. The script also runs on
the Moodle tracker (`https://moodle.atlassian.net/*`) and adds a button next to each
GitHub link it finds in an issue's diff-URL fields:

- **Compare links** (`github.com/<owner>/moodle/compare/<base>...<head>`) — builds an
  `applyPrOverlay` blueprint that diffs `base...head`, deriving the base version from
  the head branch suffix (`-main` → development, `-501` → 5.1, `-500` → 5.0, and so on).
- **Pull-request links** (`github.com/<owner>/moodle/pull/<n>`) — builds the same
  `applyPrOverlay` blueprint as the GitHub PR flow above.

Only repositories named `moodle` are matched, and one button is shown per unique
comparison. The button is **not** injected on GitHub `/compare/` pages directly — on
GitHub the script only runs on `/pull/` pages.

!!! note
    The compare/PR badges only appear when an issue actually links a GitHub compare or
    pull-request URL. Before peer review is requested there may be no such link, so no
    badge is shown.

## Tracker scenario button

On tracker **issue pages** the script also adds one floating button at the
bottom-right that boots a playground preconfigured for reproducing the issue:

- If the issue description contains an explicit **Moodle Playground Scenario**
  block, the button opens the playground with that scenario.
- Otherwise it opens the bundled **starter site** (course + teacher + student +
  sample activities).
- A scenario block that exists but cannot be parsed shows a warning badge with
  the error in its tooltip.

See [Moodle Tracker scenarios](tracker-scenarios.md) for the exact scenario
syntax, the starter site contents, and the limitations.

## Configure

Edit the constants at the top of the script (via your userscript manager's editor):

```js
const PLAYGROUND_HOST = "https://ateeducacion.github.io/moodle-playground";
const RUN_UPGRADE = "auto"; // off | on | auto
const STARTER_SCENARIO = true;
```

- **`PLAYGROUND_HOST`** — which deployment the button opens. Point it at the production
  host, a GitHub Pages host, or a branch preview.
- **`RUN_UPGRADE`** — whether the overlay runs the Moodle upgrade after applying the
  changed files: `off`, `on`, or `auto`.
- **`STARTER_SCENARIO`** — whether tracker issues without a scenario block get the
  starter-site button. Set to `false` to only show scenario buttons.

## Permissions and why they are needed

The script declares two permissions in its metadata:

| Directive | Value | Why |
|-----------|-------|-----|
| `@grant` | `GM_xmlhttpRequest` | GitHub and Atlassian send a strict Content-Security-Policy (`script-src 'self'`). Declaring a real grant makes the manager run the script in its sandboxed content-script world, which the page CSP does not block. With `@grant none` the button never appears. |
| `@connect` | `api.github.com` | Lets the script read a PR's base branch via the GitHub REST API when it is not already in the page DOM. |

The badge itself is a CSS-only element (no external image), so the page's `img-src`
policy does not affect it.

## Limitations

- **Moodle core only.** The button activates on repositories named `moodle`.
  Plugin and theme PRs are handled by the [GitHub Action](github/pr-previews.md).
- **DOM-dependent.** GitHub and Jira markup changes over time; if the button stops
  appearing, the script's selectors may need updating.
- **Compare/PR badges need a GitHub link.** No GitHub compare/PR link in the issue
  means no preview badge there (the scenario/starter button appears regardless).
- **GitHub API rate limit.** The base-branch lookup is unauthenticated
  (~60 requests/hour). The overlay itself runs entirely in your browser.
- **Overlay fidelity.** Previews replace changed files whole over a prebuilt base.
  Composer installs, frontend builds, generated assets, and real database upgrades
  are not reproduced. See `applyPrOverlay` in the
  [blueprint reference](blueprints/reference.md) for the full overlay caps.

## Disable or remove

Open your userscript manager's dashboard and toggle **"Open in Moodle Playground"** off,
or delete it. No other cleanup is needed.

## See also

- [Moodle Tracker scenarios](tracker-scenarios.md) — the scenario block format and starter site.
- [PR previews](github/pr-previews.md) — automated previews for plugin and theme PRs.
- [Blueprint reference](blueprints/reference.md) — the `applyPrOverlay` step the button uses.
