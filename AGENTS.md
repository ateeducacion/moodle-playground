# AGENTS.md

Moodle Playground runs Moodle in the browser with PHP WebAssembly and SQLite.
Keep this file focused on repository-wide constraints; update the relevant skill or
reference when domain behavior changes. Read only the material needed for the task.

## Working conventions

- Git branch names must be English and start with `feature/` or `hotfix/`.
  Rename nonconforming branches before pushing or opening a PR; never use `codex/`.
- For library, framework, SDK, API, CLI, or cloud-service questions, use Context7:
  resolve the library ID, then query the relevant current documentation. Prefer it
  over web search. General code review, refactoring, and business logic do not need it.
- Complete the requested change and relevant local verification without asking for
  approval between routine edits and checks. Report what was verified and any blocker.
- Existing code and accepted ADRs establish current behavior. If a guide disagrees,
  verify the implementation and correct the guide instead of restoring obsolete behavior.

## Runtime map

```text
index.html → src/shell/main.js
  → remote.html → src/remote/main.js
  → sw.bundle.js (from sw.js)
  → dist/php-worker.bundle.js (from php-worker.js)
  → src/runtime/php-loader.js → php-compat.js → bootstrap.js
```

The shell hosts `#site-frame`; the remote host contains the Moodle `#remote-frame`.
Core files stream from a prebuilt tar.zst bundle into writable MEMFS at `/www/moodle`.
Generated assets live in `assets/moodle/`, `assets/manifests/`, `dist/`, and
`sw.bundle.js`; do not hand-edit them unless the task is specifically about build output.

## Build and verification

Requirements: Node.js 18+, npm, Python 3, Git. Native `make up-local` also needs PHP
8.3 with `pdo_sqlite`. Building Moodle 5.1+ needs Composer because upstream no longer
commits `vendor/`. See [local development](docs/local-development.md) for setup.

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Rebuild PHP worker and service worker | `npm run build-worker` |
| Prepare worker and Moodle assets | `make prepare` |
| Build all Moodle branches | `make prepare-all` |
| Serve existing assets (port 8080) | `make serve` |
| Prepare and serve | `make up` |
| Run patched native Moodle | `make up-local` |
| Unit tests | `make test` or `npm run test:blueprint` |
| Browser tests | `make test-e2e` |
| Browser-specific tests | `make test-e2e-chrome` / `make test-e2e-firefox` |
| Lint / format | `make lint` / `make format` |

`package.json` and `Makefile` are the command inventory. Use
[testing and CI](.agents/references/testing-and-ci.md) for CI-specific work.

After changing `php-worker.js`, `sw.js`, or their imports (including **all
`src/blueprint/**` code**), rebuild with `npm run build-worker`. Unit tests import
source directly and cannot detect a stale bundle. Before browser verification,
clear Service Worker caches; Reset Playground and `?clean=1` do not refresh the bundle.
Keep `sw.bundle.js` at the app root and registered as a classic worker so its scope
covers the app, including Firefox.

For browser debugging, start with `?debug=true`. Use existing readiness and frame
helpers in `tests/e2e/helpers.mjs`; shell readiness does not prove Moodle has rendered.
Do not run sibling playground checkouts against the same dev-server port.

## Runtime invariants

- SQLite runs against a **MEMFS file**, not `:memory:`: each `php.run()` resets PHP
  state and PDO connections. Do not reintroduce PGlite or move the active DB out of MEMFS.
- The DB path is `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`.
  `/persist` changes are journaled to IndexedDB (`moodle-fs-journal:<scope>`) and
  restored before bootstrap, so reloads can retain data. This is not an entirely
  ephemeral runtime. Scope normally comes from `sessionStorage`; a fresh tab gets
  a new scope, while duplication or an explicit `?scope=` can reuse one. Closing a
  tab is not a guarantee that the underlying IndexedDB data has been deleted.
- A different blueprint source or Reset Playground forces a clean boot; reloading
  the same source retains the journal. Keep journaling active after clearing it.
  See `src/shell/main.js`, `src/shared/paths.js`, and `src/runtime/fs-persistence.js`.
- Do not journal derived `moodledata/{cache,localcache,temp,muc}` directories. A
  restored compiled DI cache can reference missing files. Normalize journal ops
  before hydration to avoid copying repeated SQLite writes. Do not persist the
  entire core or add an OPFS storage layer without an explicit requirement.
- `$CFG->wwwroot` uses the real app base URL, never the scoped runtime URL.
  Preserve subpaths such as `/moodle-playground` in CGI variables, redirects,
  links, forms, and HTML-escaped URLs under `/playground/<scope>/<runtime>/`.
- Keep MUC enabled (`CACHE_DISABLE_ALL = false`) and seed cache store/admin defaults
  to prevent upgrade-settings redirect loops. PHP WASM lacks `sodium`; retain the
  OpenSSL fallback in `patches/shared/lib/classes/encryption.php`.
- Use the prebuilt install snapshot when available, with CLI install as fallback.
  Snapshot localcache seeds are restored on boot; RequireJS combines are built
  ahead of time, never in WASM. Preserve legacy-manifest fallbacks; see
  [ADR 0013](docs/architecture/adr/ADR-0013-build-time-requirejs-combined-bundle-seed.md).
- Crash recovery must preserve DB/filedir coherence and must not replay mutating
  requests. See [ADR 0027](docs/architecture/adr/ADR-0027-selective-crash-recovery-snapshots.md).
- `addonProxyUrl` is for browser downloads; `phpCorsProxyUrl` is for PHP networking.
  Preserve their separation and the generated CA profile described in the PHP skill.

When changing documented runtime defaults, update the relevant sections of
[SQLite notes](docs/sqlite-wasm-migration-notes.md),
[troubleshooting](docs/TROUBLESHOOTING.md), and [known issues](docs/KNOWN-ISSUES.md).

## Skills and focused references

Read a skill when the task needs its domain guidance. Load additional skills and
references only for the parts of the task that need them; apply relevant checks,
not every checklist to every edit.

| Task | Skill |
|------|-------|
| Moodle APIs, install/upgrade, patches, MUC | [moodle-internals](.agents/skills/moodle-internals/SKILL.md) |
| PHP lifecycle, adapter, ini, outbound networking | [wp-playground-php-wasm](.agents/skills/wp-playground-php-wasm/SKILL.md) |
| WASM memory/crashes, SW routing, journal/recovery | [wasm-browser-runtime](.agents/skills/wasm-browser-runtime/SKILL.md) |
| Moodle blueprint schema, steps, provisioning | [blueprint-provisioning](.agents/skills/blueprint-provisioning/SKILL.md) |
| Node unit tests | [unit-testing](.agents/skills/unit-testing/SKILL.md) |
| Authoring or debugging `tests/e2e/` | [e2e-playwright](.agents/skills/e2e-playwright/SKILL.md) |
| Driving a browser from the terminal | [playwright-cli](.agents/skills/playwright-cli/SKILL.md) |
| Application vulnerability audits | [security-audit](.agents/skills/security-audit/SKILL.md) |
| Writing/reviewing `.github/workflows/*.yml` | [github-actions-hardening](.agents/skills/github-actions-hardening/SKILL.md) |

Check [upstream projects](.agents/references/upstream-projects.md) before inventing
PHP-runtime or shell/remote/SW architecture solutions: WordPress Playground supplies
`@php-wasm/*`; Omeka S Playground supplies the architecture pattern.
For slow provisioning, use [blueprint profiling](docs/profiling-slow-blueprints.md).

### Skill maintenance

Canonical copies live in `.agents/skills/`; `.claude/skills/` contains symlinks to
those directories. Keep one copy. `gh skills` is an alias of `gh skill`.

```bash
gh skill list --scope project
gh skill update --dir .agents/skills --dry-run
gh skill add cloudflare/security-audit-skill security-audit --agent github-copilot
ln -s ../../.agents/skills/security-audit .claude/skills/security-audit
```

- `security-audit`, `github-actions-hardening`, and `playwright-cli` are vendored.
  Keep them verbatim, including `metadata.github-*` provenance. Fix upstream and
  reinstall instead of editing the local copy. The domain skills stay local. The four technical
  skills are maintained here as the shared source for sibling playgrounds.
- `.github/workflows/update-agent-skills.yml` checks weekly and opens update PRs.
  Review prompt changes as behavior changes. Scope manual update commands to
  `.agents/skills` to avoid updating unrelated user-level skills.
- Repository conventions override vendored advice: first-party `actions/*` use
  major tags maintained by Dependabot; third-party actions use commit SHAs with
  version comments. Apply hardening edits when requested.
- Use `e2e-playwright` for test authoring; do not adopt the vendored CLI skill's
  plan/generate flow. Do not install WordPress Blueprint skills: overlapping step
  names hide incompatible schemas. Our blueprint skill is authoritative.
- `wp-playground-php-wasm`, `wasm-browser-runtime`, `e2e-playwright`, and
  `unit-testing` are the shared source in `ateeducacion/moodle-playground`.
  Keep their bodies application-neutral. Moodle-specific behavior belongs in
  [runtime references](.agents/references/php-wasm-runtime.md) and
  [testing references](.agents/references/playground-testing.md), outside skill
  directories. Siblings install these four with `gh skills install` and update
  through GitHub provenance; do not copy Moodle's local references into them.
- Keep in-house descriptions short and specific. Retain non-obvious constraints;
  link to existing docs/source for conditional details instead of copying manuals,
  line counts, test inventories, or API catalogs into each skill.

## Architecture Decision Records (ADRs) and Software Design Documents (SDDs)

Significant technical work is documented before or alongside the code, following the
ADR + SDD workflow (same shape as
[eXeLearning PR #2149](https://github.com/exelearning/exelearning/pull/2149)).
Full policy: [ADR guide](docs/architecture/adr/README.md),
[SDD guide](docs/architecture/sdd/README.md).

- **Create or update an ADR** when a change introduces or modifies a **durable
  architecture decision**. In this repo that means decisions affecting: the request
  pipeline (shell/remote/SW/worker routing, HTML rewriting, caching), the storage and
  persistence model, the SQLite driver and DB invariants, the core bundle format and
  build pipeline, blueprint format/semantics, crash recovery, outbound networking
  (proxies), deployment behavior (GitHub Pages subpaths), or new dependencies.
  When in doubt, write one — a short ADR is better than no ADR.
- **Create an SDD** for significant features, major refactors, design gates,
  cross-cutting changes, or proposals with multiple implementation phases. SDDs
  describe the feature plan, but **durable decisions inside an SDD must link to an
  ADR** (existing or newly proposed) — don't bury the decision.
- **Locations**: ADRs live under `docs/architecture/adr/`
  (`ADR-NNNN-kebab-case-title.md`), SDDs under `docs/architecture/sdd/`
  (`SDD-NNNN-kebab-case-title.md`). IDs are zero-padded, monotonic and never reused.
- **Templates**: `docs/architecture/adr/ADR-0000-template.md` and
  `docs/architecture/sdd/SDD-0000-template.md`. Do not invent a new format.
  (ADR-0001…0023 predate the templates and keep their original lighter format —
  do not retrofit them.)
- **Indexes**: every ADR is listed in
  [`docs/architecture/adr/records.md`](docs/architecture/adr/records.md) and every
  SDD in [`docs/architecture/sdd/records.md`](docs/architecture/sdd/records.md).
  Update the index in the same PR that adds or changes a record.
- **Language**: English.
- **Statuses**: ADRs use `Proposed`, `Accepted`, `Rejected`, `Superseded`; SDDs use
  `Draft`, `In Review`, `Accepted`, `Implemented`, `Superseded`, `Abandoned`.
- **Append-only**: do not rewrite accepted ADRs — supersede them with a new ADR
  (`supersedes` / `superseded_by`). Do not rewrite implemented SDDs except for
  typo/link fixes; supersede them if the design changes substantially.
- **AI assistance**: record it in the ADR/SDD frontmatter
  (`ai_assistance.tool` / `ai_assistance.model`; `none` if not used).
- **Link from code**: when code implements an ADR, add a brief comment referencing it
  (e.g., `// See docs/architecture/adr/ADR-0001-sw-level-scoped-static-asset-caching.md`).
- **Mention in PRs**: list any ADRs or SDDs a PR creates or updates in the PR
  description.
