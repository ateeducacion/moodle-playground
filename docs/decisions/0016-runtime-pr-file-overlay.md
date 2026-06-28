# ADR-0016 Runtime PR file overlay for Moodle core PR previews

* Status: Accepted
* Date: 2026-06-28

## Context and Problem

Moodle previously had a Gitpod-based workflow that let reviewers open a tracker issue or
pull request and get a quickly running Moodle instance. Moodle Playground already previews
**plugin** PRs (the GitHub Action generates a blueprint that installs the plugin ZIP from the
PR branch), but **core** PRs cannot be previewed that way because core *is* the base
application — there is no plugin to install.

Building a custom Moodle WASM bundle per core PR is far too slow and expensive for a preview.
We need a way to preview a core PR on top of an existing, prebuilt Moodle Playground base
without rebuilding the runtime.

## Options Considered

* **Per-PR bundle builder** — build a fresh Moodle WASM bundle for every PR. Most faithful,
  but minutes-to-build and heavy infrastructure; wrong tool for a fast preview.
* **Unified-diff patching at runtime** — fetch the PR `.diff` and apply hunks in the browser.
  Brittle: hunk failures, fuzzy matching, `.rej` files, context drift, no binary support, and a
  diff parser to maintain.
* **Whole-file overlay at runtime** — boot a prebuilt base selected from the PR target branch,
  then replace each changed file with its *final* contents fetched at the PR head commit.

## Decision

Implement **whole-file overlay at runtime**. A new blueprint step `applyPrOverlay` overlays a
PR's changed files onto the booted Moodle base in the browser filesystem, purges caches, and
optionally runs Moodle's upgrade. Supporting steps `deleteFile`, `deleteFiles`, and
`purgeMoodleCaches` are added. The base version is selected from the PR target branch
(`base.ref`); the GitHub Action generates the blueprint (preferring a pre-resolved `files`
manifest), and a runtime `repo`+`pr` fetch mode remains for manual/Tampermonkey use.

Whole-file replacement is chosen because GitHub exposes both the changed-file metadata and the
final file contents at the head SHA, and it handles add/modify/remove/rename uniformly without a
patch engine. This is a preview system, not a source-control engine.

## Consequences

### Positive

* Core PRs become previewable in seconds on top of existing prebuilt bases — no per-PR build.
* No diff/patch engine: add/modify/remove/rename are predictable; binary files work (within caps).
* Reuses the existing blueprint engine, resource model, and the Action's preview-URL plumbing.
* Path sanitization and size/count caps bound the runtime cost and block traversal writes.

### Negative / Risks

* **Base drift.** Whole-file overlay assumes the prebuilt base is reasonably close to the branch
  tip; a stale base may miss files the PR depends on. Mitigated by a scheduled base rebuild.
* **Lower DB fidelity.** Schema/upgrade-heavy PRs run against SQLite-in-WASM, which has lower
  fidelity than a full Moodle environment (nested savepoints, ADR-0003). `runUpgrade` is a
  best-effort attempt and failures are reported honestly, never faked.
* **Out of scope.** Composer installs, frontend/grunt builds, and generated assets are not
  reproduced — only changed source files are overlaid.

## Implementation Notes

* `src/blueprint/pr-overlay.js` — pure helpers (path validation, manifest normalization,
  upgrade detection, `runUpgrade` normalization, GitHub/proxy URL builders).
* `src/blueprint/steps/pr-overlay.js` — `purgeMoodleCaches` and `applyPrOverlay` handlers
  (fetch, write, delete, purge, upgrade).
* `src/blueprint/steps/filesystem.js` — `deleteFile` / `deleteFiles`.
* `src/blueprint/php/helpers.js` — `phpPurgeMoodleCaches()`, `phpRunCoreUpgrade()`.
* Allowlists updated in `src/blueprint/schema.js`, `assets/blueprints/blueprint-schema.json`,
  and `tests/blueprint/steps.test.js`. Docs in `docs/blueprint-json.md`; example at
  `assets/blueprints/examples/pr-overlay.blueprint.json`.
* Overlay root is `/www/moodle`; the `public/` prefix (Moodle 5.1+) comes from the PR path and
  is never auto-prepended. Remember to `npm run build-worker` after editing `src/blueprint/**`.
* Companion change: the `action-moodle-playground-pr-preview` Action gains a `core` preview type
  that resolves the manifest and emits the `applyPrOverlay` blueprint.

## Review Criteria

Revisit if: base drift makes overlays unreliable in practice (consider tightening the rebuild
cadence or a lightweight per-PR build); core upgrades under SQLite/WASM prove too lossy to be
useful (consider gating or disabling `runUpgrade=auto`); GitHub changes its PR files API or CORS
behavior; or demand appears for a Tampermonkey integration or an in-browser editor (both
currently out of scope).
