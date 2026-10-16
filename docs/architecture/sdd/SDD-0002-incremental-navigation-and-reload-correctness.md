---
id: SDD-0002
title: "Incremental navigation and reload correctness"
status: In Review
date: 2026-10-16
authors: []
reviewers: []
related:
  issues: []
  prs: []
  adrs: [ADR-0033, ADR-0034, ADR-0035]
  sdds: []
supersedes: []
superseded_by: []
ai_assistance:
  tool: "Codex"
  model: "GPT-5"
---

# SDD-0002: Incremental navigation and reload correctness

## Status

In Review; the implementation is locally verified, not shipped or release-approved.

## Summary

First reconcile installed dependencies with the existing lock and regenerate
workers. Then restore Moodle-owned JavaScript revisions and add narrowly scoped
immutable ESM caching. Treat persisted blueprint replay as a separate correctness
change, not as an apparent performance improvement caused by skipped work.

## Problem statement

At `06bcd45a`, jsrev1 breaks production ESM caching on Moodle5.3; repeated requests
queue through PHP. The persisted reload also repeats course creation. The audit
found installed/generated PHP-WASM3.1.54 despite lock3.1.57, so old performance
numbers cannot substitute for a coherent new baseline.

## Goals

- Versioned, checked AMD seeds without overriding Moodle's jsrev.
- Cache only public immutable production ESM, with existing isolation/eviction.
- Preserve authentication, plugin modules, purges and persisted DB/filedir.
- Independently measure F1 and F2 with matching dependency/browser versions.

## Non-goals

No PHP-WASM3.1.58 upgrade, effective OPcache activation, direct MEMFS ESM map,
parallel PHP execution, new storage backend or Moodle core modification.

## Current state

Baseline at `06bcd45a`:

`config-template.js` pins revisions; snapshot generator writes sha1(1).
`bootstrap.js` restores seeds on snapshot-origin reloads and executes the whole
blueprint again. `sw.js` uses extension/PHP allowlists and build/scope/runtime keys.

## Proposed design

ADR-0033 changes the seed contract, not Moodle core. ADR-0034 changes only the
existing SW cache policy. Keep independently captured F1 and F2 builds and results.
The replay policy requires an explicit distinction between durable provisioning,
volatile core files/plugins and runtime-local login; skipping every step is unsafe.

## User experience

Navigation should use cached public code without hiding errors. Purges and plugin
updates may fall back to slower per-module delivery rather than serving stale code.
Reload correctness must be checked by retained content, not by shell readiness.

## Technical design

F1 touches snapshot generation, manifest metadata, generated config and seed
verification. F2 shares a tested pure cache policy with sw.js; rebuilt classic SW
remains at the app root. The PHP worker continues using the original serial path.

## Data model

Additive snapshot.jsrev and requirejs/revision seed entry. SchemaVersion stays1.
No DB or journal migration for F1/F2. ADR-0035 adds a private SQLite config row
with blueprint fingerprint/completed steps and saved plugin/overlay artifacts
under the existing /persist journal. It does not journal the core.

## Migration and compatibility

Legacy manifests remain accepted. An old sha1(1) combine misses the natural
revision and uses the existing per-module fallback; it is never renamed to newer
code. Rebuilt assets restore combine performance. Rollback F1 as a seed/config
unit; rollback F2 by removing its policy and changing the SW build identifier.

## Security and privacy

ESM requires the controller's public immutable declaration. Exclude personalized
HTML, AJAX, protected PHP file paths, cookies, errors and ambiguous paths. Keep
scope/runtime/build keys and redact credentials from diagnostic evidence.

## Accessibility

No UI controls or focus behavior change. Browser checks require visible rendered
Moodle, resolved initialization and successful interactions, not loading progress.

## Performance

Audit F1/F2 warm series showed4676→698ms dashboard and3114→595ms course, but these
are not guaranteed or cold-start claims. Measure coherent versions first and
report sample counts/dispersion/failures; do not add overlapping gains.

Coherent 3.1.57 remeasurements (Chromium, ten repetitions per navigation) observed
dashboard medians 5558ms → 1884ms with F1 → 1362ms with F1+F2; course medians
3884ms → 899ms → 747ms. PHP request medians fall 57→7 and 41→2 with F1, but do
not fall further with F2. Do not assign the sequential-series latency difference
to F2 without controlling host variance. A no-store ESM fetch test independently
confirms the SW hit. Five final persisted reloads have no blueprint failures;
their median is 12066ms (MAD1852ms), with 193MiB linear memory versus 160.8125MiB
on fresh boots. After a purge, cachejs now stays on (per-module AMD under the
valid revision) instead of switching to development mode; this was not part of
the measured series. Post-purge SCSS remains expensive.

## Testing strategy

Red/green unit tests for config, manifest and cache policy. Native/generated PHP
seed checks where available, plus actual browser tests. Chromium and Firefox;
Moodle5.3 and a previous branch; root/subpath, plugin install/upgrade AMD, purge,
POST/AJAX, protected files and persisted reload. Do not benchmark concurrently.

## Rollout plan

P0 coherent locked dependencies/build metadata; F1 independently verified; F2
independently verified; replay correctness separately. Submit the implementation
for PR review; do not deploy or merge automatically. Keep reports and raw
measurements outside the checkout.

## Risks and mitigations

Seed mismatch fails loudly. Legacy assets may load more slowly until rebuilt.
Plugin/purge invalidation must change revisions normally. Blueprint filesystem
steps cannot be skipped indiscriminately because core is remounted each boot.
Firefox runs exposed stale frame metadata/diagnostic hangs and one CSS request
failure. Keep the original failed samples; bounded diagnostics and per-page
readiness must not turn a partial render into a successful measurement. Multi-page
cases have an overall budget for both pages, not a longer per-page deadline.

## Open questions

The maintainer approved checkpointed provisioning on 2026-10-16. Arbitrary PHP/POST
and incomplete mutations are never retried on reload; declared volatile files are
restored and login repeats. See ADR-0035 for legacy and partial-state limitations.

## ADRs required or referenced

| Decision | ADR | Status |
|---|---|---|
| Moodle-owned JS revisions | ADR-0033 | Proposed |
| Public immutable ESM cache | ADR-0034 | Proposed |
| Durable blueprint replay semantics | ADR-0035 | Proposed |

## Evidence

2026-10-16 audit, raw data and diffs in the user's external audit package;
`06bcd45a` source paths above; exact Moodle controller/configonlylib source linked
from ADR-0033. Coherent remeasurements are separate from the original audit.

## Acceptance criteria

- [x] Seed metadata and combined filename agree; no forced jsrev.
- [x] Public ESM hits avoid PHP, invalid/private/protected responses do not cache.
- [x] Browser scenarios verified; original failures and Firefox navigation flakiness retained.
- [x] Five persisted default reloads complete without blueprint failures.

## Implementation checklist

- [x] Align installed packages with lock3.1.57 and rebuild workers/metadata.
- [x] Verify F1 and F2 separately with rebuilt assets.
- [x] Resolve replay policy and test retained Moodle data.

Local verification: 880 Node tests; root and subpath Chromium/Firefox scenarios on
Moodle5.3 and5.0; native seed match/mismatch/legacy checks; ten successful Chromium
form saves and eleven Firefox saves across two interrupted series. Do not claim a
clean first-pass browser suite: Firefox exposed navigation/iframe lifecycle stalls,
and the earlier fixture/assertion failures remain in the external evidence package.
Locale replay is skipped on retained installs; tests preserve a local fixture pack
without external downloads, with a direct unit guard for non-English install locales.

The pre-PR rerun reproduced the Firefox5.0 retained-reload locator failure:
the screenshot shows the retained course/config/file fixture, while Playwright
reports its app frame as `about:blank` and cannot find `#reload-state` within120s.
No page errors or failed requests were recorded. This narrows the investigation
but does not prove an automation-only cause; keep the PR draft until Firefox
verification is stable. Do not increase timeouts or bypass the content assertions.

## Review follow-up (working tree, 2026-10-16)

The follow-up preserves the maintainer's fixes for changed-blueprint login/landing,
partial overlays, nonfatal persistence and production JS after purges. Additional
coverage requires early snapshot checkpoints, unfinished plugin code restoration,
uninstall preservation, declared journal-excluded cache files and critical flags.
Do not delete failed plugin artifacts blindly or restore legacy code from moving
URLs. ADR-0035 records those boundaries; ADR-0034 distinguishes actual ESM hits
from warm HTML/AJAX requests that F2 cannot eliminate.

Browser tests exposed two real shell gaps as well as stale-frame automation:
Refresh was wired to same-URL navigation instead of the existing refresh-site
handler; Reset did not save the requested blueprint source again. refresh-site
performs a forced GET of the current path, never `location.reload()`, which would
resubmit a page rendered from a POST. Reset re-saves the source resolved on page
load for `?blueprint`/`?blueprint-url` instead of re-fetching it, because the
resolver silently falls back to the default blueprint on a network error.
Consume the blueprint-source key only after SW control and assigning the remote
URL, so a control-related shell reload cannot swallow a pending clean boot.
Tests require retained data/login on same-source edits, fresh data on Reset/source
changes, retained shell identity when Moodle clears shared sessionStorage,
the applied overlay subset with stable revisions, real uninstall and v2
plugin AMD after clicking Refresh. Earlier failed/interrupted batches remain
evidence; verification is not a claim that all browser lifecycle issues are fixed.

Local Node checks cover flush failure/rejection/unavailable persistence, and log
elapsed flush time, hydrated bytes and operation count. These byte counts are not
physical IndexedDB I/O measurements.
The synthetic post-commit crash probe also found stale MUC values after live DB
restore: direct SQLite read1 but `get_config()` false. Clear MUC only after DB
restore and before re-login; do not bump JS/theme revisions or replay the POST.

## Second-review follow-up (2026-10-16)

Reload tests now register real `after_config` hooks in both a plugin (Moodle 5.3
and 5.0) and a core overlay. On the unmodified `f1b43cf` worker, Chromium preserves
the files but loses both hook effects after reload. The overlay test explicitly
loads its synthetic callback class before config, isolating registry invalidation
from core class-map discovery. Moodle 5.3's `core\hook\manager` stores registrations
in both `cachedir/hookcallbacks.php` and `localcachedir/hookcallbacks.php`, outside
MUC. ADR-0035 requires invalidating both files as well as MUC/DI/bytecode in the
shared plugin/overlay restore block, without a full purge or revision bump.

The browser run also reproduced Firefox's two stale-frame timeouts: source Reset
and overlay reload. Screenshots showed the correct course/hook result and DOM
diagnostics reported complete/no pending JS, while the protocol said about:blank.
Those polls now inspect the actual same-origin DOM, preserving content, visibility,
readiness and login assertions. The Reset case has no overlay: it is not evidence
that overlay MUC purging breaks Moodle. No timeout increase or content bypass.
Local validation: 895 unit tests pass. The initial targeted browser batch was
20/22 (those two Firefox polls failed); after the harness fix, both changed cases
pass in Chromium and Firefox, 4/4 in one sequential no-retry invocation. All 22
distinct targeted cases have passing results across these batches, not one
clean 22/22 invocation. Full e2e and untested browser/runtime paths remain CI/design gates.

Coverage also includes toolbar Refresh after a real form POST (GET afterwards,
mutation count stays one), and Reset while the remote blueprint source returns 503
(uses the resolved content, no new download). These are correctness regressions,
not new performance measurements. Automatic continuation of unknown unfinished
steps, changed/legacy plugin migration and shell-identity redesign remain out of
this fix; they need an explicit design rather than replaying unknown mutations.

## References

- [ADR-0033](../adr/ADR-0033-moodle-owned-javascript-revisions.md)
- [ADR-0034](../adr/ADR-0034-public-immutable-esm-cache.md)
- [ADR-0035](../adr/ADR-0035-blueprint-reload-checkpoints.md)
