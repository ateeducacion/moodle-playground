---
id: ADR-0029
title: "Timestamped Build IDs for deployment identification and cache versioning"
status: Proposed
date: 2026-08-16
deciders:
  - "@erseco"
reviewers:
  - ""
related:
  issues: []
  prs: []
  sdds: []
  adrs: ["ADR-0001", "ADR-0016", "ADR-0028"]
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5"
---

# ADR-0029: Timestamped Build IDs for deployment identification and cache versioning

## Status

Proposed

## Context

Moodle Playground ships a rolling release: `main` deploys continuously to GitHub
Pages and Cloudflare Pages, and there is no release train to attach a semantic
version to. Two properties of the project make an identifier for the *deployed
artifact* necessary:

1. **Rebuilds change the artifact without changing the source.** The scheduled
   base rebuild (`.github/workflows/scheduled-base-rebuild.yml`, weekly) exists
   precisely to re-cut Moodle core bundles from upstream branch tips while this
   repository is unchanged (ADR-0016). Two deployments from the same commit are
   genuinely different artifacts, so a git SHA alone cannot name a deployment.
2. **A stale cache mixes builds.** The Service Worker caches application static
   assets (ADR-0001). Without a per-deployment cache namespace, a returning
   browser can serve last week's shell against this week's runtime.

The repository already had a partial mechanism: `scripts/write-build-version.mjs`
generated `src/generated/build-version.js` and `assets/build-version.json`, and
`sw.js` used the value in its cache names. It had three gaps: the identifier used
a 12-character SHA, `npm run build:version` ran independently in the
`lint-and-test` and `build` jobs (so one pipeline run produced two different
identifiers), and on `pull_request` the SHA came from the throwaway merge commit
`actions/checkout` resolves rather than the PR head.

## Problem

What identifies one deployed Playground artifact, how is it guaranteed to be
singular per pipeline run, and how does it invalidate stale caches?

## Decision drivers

- Must distinguish two builds of the same commit (periodic rebuilds).
- Must be human-readable in a bug report and sortable at a glance.
- Must not imply semantic versioning; this project has no release train.
- Must be identical across every job and every deployment target of one run.
- Must not depend on CI-specific counters, so local builds behave the same.
- Must invalidate application code caches without touching user data.

## Options considered

### Option 1: Git SHA alone

- Pros: trivially traceable to source; no generation step.
- Cons: a scheduled rebuild of an unchanged commit produces an identical ID for
  a different artifact — the primary requirement fails.

### Option 2: Semantic version, bumped per deploy

- Pros: familiar.
- Cons: dishonest for a rolling release (no compatibility contract to express),
  and requires a bump commit or a tag per deployment.

### Option 3: CI run number / run ID

- Pros: unique per pipeline.
- Cons: meaningless locally, resets or diverges across workflows, and encodes no
  build time or provenance.

### Option 4: UTC build timestamp + short git SHA (chosen)

- Pros: unique per build *and* traceable to source; sorts chronologically as a
  plain string; identical semantics in CI and on a laptop; no new dependency.
- Cons: longer than a bare SHA; requires the value to be generated once and
  propagated deliberately through the pipeline.

## Evidence

- Scheduled rebuild of unchanged source: `.github/workflows/scheduled-base-rebuild.yml`
  dispatches `ci.yml` weekly on `main` (ADR-0016 explains why the bases drift).
- Service Worker static caching: `sw.js`, ADR-0001.
- One artifact, two deployment targets: `ci.yml` uploads `site-build` once in the
  `build` job; `deploy-pages` and `deploy-cloudflare` both consume that artifact.
- `actions/checkout` checks out a merge commit for `pull_request` events by
  default — <https://github.com/actions/checkout#checkout-pull-request-head-commit-instead-of-merge-commit>.
- Sentry release identifiers: ADR-0028 and <https://docs.sentry.io/product/releases/>.

## Decision

We will identify every build with a **Build ID** in the canonical format:

```text
YYYYMMDDTHHMMSSZ-<sha8>[-dirty]
```

for example `20260816T065012Z-9e39f37d`. The timestamp is the UTC **build** time,
never the commit time, so a rebuild of an unchanged commit yields a new ID:

```text
20260816T065012Z-9e39f37d   # weekly rebuild
20260823T060003Z-9e39f37d   # same source, new artifact
```

Concretely:

- `scripts/lib/build-version.mjs` owns the format (compose, parse, validate,
  resolve) and is the single source of truth. `scripts/write-build-version.mjs`
  is a thin CLI over it that writes `src/generated/build-version.js` and
  `assets/build-version.json`; `--print-version` prints the ID without writing.
- Both generated files stay git-ignored. Nothing hand-maintains an identifier.
- `BUILD_VERSION` overrides the ID outright; `BUILD_SHA` overrides only the
  revision. CI's `build-id` job computes the ID **once** and every downstream job
  consumes it via `needs.build-id.outputs.build_version`, so one pipeline run has
  exactly one Build ID and both deployment targets report the same value.
  `BUILD_SHA` is set to `github.event.pull_request.head.sha || github.sha` to keep
  pull request builds traceable to the source commit.
- Local builds derive the SHA from git and append `-dirty` when the working tree
  has uncommitted changes. CI builds are never dirty.
- Cache versioning: `src/shared/cache-names.js` derives the Service Worker's
  application cache namespaces from the Build ID, and `isStaleAppCacheName()`
  decides what activation purges — only this app's namespaces from previous
  builds. The Service Worker is registered with `?build=<Build ID>`
  (`src/shared/service-worker-version.js`), and because `sw.js` *imports* the
  generated module, its bundled bytes change every build, so browsers detect and
  install the new worker.
- The Build ID is the Sentry `release` (ADR-0028), appears in the Runtime info
  panel as "Playground build" (copyable), and is logged once at startup so a
  copied runtime log always names the deployed build.

We deliberately do **not** version individual CSS/JS URLs with query strings. The
shell loads native ES modules, so versioning only the entry point would leave the
rest of the import graph unversioned; the Service Worker cache namespace covers
the whole graph correctly instead.

The Build ID names the Playground artifact only. The Moodle release and PHP
version running inside it remain separate, independently displayed values.

## Consequences

### Positive

- A bug report that quotes a Build ID pins the exact deployed artifact, its build
  time and its source commit.
- Deploying a new build cannot leave a browser on a half-updated mix of assets.
- Periodic rebuilds are distinguishable, which is what ADR-0016's overlay
  feature needs.
- Sentry issues group by an identifier that maps to a real deployment.

### Negative

- The pipeline gains a small `build-id` job (a checkout plus one node command)
  ahead of the rest.
- Every deployment creates a new cache namespace; the previous one is purged on
  activation, so a returning visitor re-downloads static assets once per deploy.

### Neutral

- `make test` now depends on `build-version` so the git-ignored generated module
  exists for the tests that import it.

## Risks

- A future job that regenerates metadata without inheriting `BUILD_VERSION` would
  silently reintroduce a second ID in one run. The `build-id` job output is the
  documented mechanism, and the metadata derives its SHA and dirty flag from an
  explicit `BUILD_VERSION` so a mismatch is visible rather than silent.
- Persistent user state is deliberately **not** keyed by the Build ID: the
  IndexedDB journal stays keyed by scope, so a deploy invalidates code caches
  without destroying a visitor's site.

## Validation

- `tests/scripts/build-version.test.js` pins the format, the 8-character SHA, the
  metadata fields, `BUILD_VERSION`/`BUILD_SHA` overrides, dirty handling, and that
  two build times for one commit yield different IDs. Time and git are injected,
  so the suite never depends on the wall clock.
- `tests/sw/cache-names.test.js` pins Build-ID-derived cache namespaces and that
  purging never touches caches this Service Worker does not own.
- `tests/e2e/shell.spec.mjs` asserts the deployed site serves
  `assets/build-version.json` in canonical form and that the value matches the ID
  displayed in the info panel.
- Revisit if the format ever needs to encode a target/branch, or if a deployment
  target starts building its own artifact instead of consuming `site-build`.

## Follow-up work

- The sibling playgrounds (Omeka S, Nextcloud, FacturaScripts) adopt the same
  Build ID format so a report from any playground reads the same way.

## References

- ADR-0001 (Service Worker scoped static asset caching)
- ADR-0016 (runtime PR file overlay; motivates periodic base rebuilds)
- ADR-0028 (Sentry error monitoring; consumes the Build ID as `release`)
- `scripts/lib/build-version.mjs`, `scripts/write-build-version.mjs`,
  `src/shared/cache-names.js`, `src/shared/service-worker-version.js`,
  `sw.js`, `.github/workflows/ci.yml`
