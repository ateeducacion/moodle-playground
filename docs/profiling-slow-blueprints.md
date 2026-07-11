# Profiling a slow blueprint

Heavy blueprints (many plugins, a large theme config import, a `.mbz` course restore,
SCORM/H5P modules) can make provisioning take tens of seconds. This guide explains how to
find *which step* is slow, using the per-step timing diagnostics added in
[ADR-0021](architecture/adr/ADR-0021-blueprint-per-step-timing-diagnostics.md).

## The `[blueprint-perf]` line

After a blueprint finishes provisioning, the runtime prints two lines on the normal progress
channel (visible in the shell **Logs** side panel):

```
Blueprint timing: 34 step(s) in 49704ms. Slowest: #17 restoreCourse (31760ms), #10 installMoodlePlugin (3198ms), #11 installMoodlePlugin (2137ms).
[blueprint-perf] {"totalMs":49704,"steps":[{"i":1,"step":"installMoodle","label":"","ms":0,"status":"success"}, ...]} [/blueprint-perf]
```

* The **human summary** ranks the three slowest steps — usually all you need.
* The **`[blueprint-perf] … [/blueprint-perf]`** line is machine-readable JSON. Each entry has:

  | Field | Meaning |
  |-------|---------|
  | `i` | 1-based step index |
  | `step` | step type (e.g. `restoreCourse`) |
  | `label` | sanitized `comment`/`label` from the step (never payload — no passwords/tokens) |
  | `ms` | step duration in milliseconds |
  | `status` | `success` \| `skipped` \| `failed` |

  `totalMs` is the total provisioning time (sum of step durations, relative to blueprint
  start — immune to boot-clock resets on a runtime restart).

Durations are provisioning-relative, so `#17 restoreCourse (31760ms)` means that step alone
took ~32 s. The **Boot timing summary** line (`Config … | PHP refresh … | Bootstrap … |
Total …`) gives the surrounding boot cost.

## In the browser (by hand)

1. `make serve` and open `http://localhost:8080/?blueprint-url=<your-blueprint-url>`
   (or `?blueprint=<base64>`).
2. Open the side panel → **Logs** tab.
3. Wait until the URL bar re-enables (provisioning done), then read the
   `Blueprint timing:` and `[blueprint-perf]` lines. Copy the JSON into a formatter to sort by
   `ms`.

Tip: add `?debug=true` first if you also want Moodle's own debug output.

## With Playwright

`tests/e2e/blueprint-perf.spec.mjs` contains two tests:

* **CI-safe** (`… emits a structured, secret-free per-step timing report`): a small local
  blueprint that verifies the report exists, has the expected step names, and redacts
  passwords. Runs on every `make test-e2e`.
* **Opt-in baseline** (`external Adaptable blueprint produces a timing report`): loads the
  heavy external Adaptable demo blueprint and attaches the full report + console errors as
  test artifacts. It is `test.skip`ped unless you set `RUN_EXTERNAL_PERF=1`, because it needs
  outbound network (GitHub + the CORS proxies) and takes ~1 min:

  ```bash
  RUN_EXTERNAL_PERF=1 npx playwright test blueprint-perf.spec.mjs --project=chromium
  # inspect the attached report:
  npx playwright show-report
  ```

The perf report is read from the shell `#log-panel` (see `readPerfReport` in the spec) — no
deep-iframe access. Assertions check that timing data *exists* with the expected step names,
never exact durations, so they are stable across machines.

### Local bundles must match the streaming runtime

The runtime streams a `tar.zst` core bundle into MEMFS (ADR-0018/0019). If a locally-built
`assets/moodle/<branch>/` still ships only the older `.zip` (its manifest `bundle.format` is
`zip`), boot stalls at *"Writing Moodle bundle into MEMFS"* because the streaming decoder is
fed ZIP bytes. Rebuild the branch (`make bundle BRANCH=<branch>`) so the manifest advertises
`tar.zst`.

## What tends to dominate (measured on the Adaptable demo)

Real Chromium measurements of the Adaptable demo blueprint (34 steps) put the cost here:

1. **Course restore (`.mbz`)** — originally ~64% of provisioning in the measured run, but
   sub-timing showed ~97% of that was the *download of the backup inside PHP*
   (`download_file_content` over the `tcpOverFetch` bridge), not Moodle's restore (~1s). Since
   [ADR-0022](architecture/adr/ADR-0022-browser-side-course-backup-download.md) the `.mbz` is downloaded
   **browser-side** (native streaming fetch, with a progress bar), so `restoreCourse` now runs
   in ~1–3s for a CORS-accessible backup. Non-CORS or > 50 MB backups fall back to the slower
   in-PHP download. Backup size still matters (download + import both scale with it), and very
   large backups can hit WASM SQLite memory limits (see [TROUBLESHOOTING](TROUBLESHOOTING.md)).
2. **Plugin/theme ZIP installs** — download + unzip + `upgrade_noncore()`. With the restore
   download fixed, these are typically the largest remaining steps. A full-repo
   `archive/refs/heads/main.zip` (e.g. `mod_exelearning`) is the slowest; prefer a pinned
   release ZIP.
3. Everything else — role imports, module adds, config writes, the front-page `runPhpCode`
   fixups — is comparatively cheap (sub-second each).

Notably, the repeated `purge_all_caches()` calls inside custom `runPhpCode` steps were **not**
a dominant cost in the measured run (tens to low-hundreds of ms each), and an explicit
`installLanguagePack` for a locale already installed at boot is a near-no-op.

Tip: `restoreCourse` also emits a `[restore-perf] {json} [/restore-perf]` line with the
per-phase breakdown (`download` / `extract` / `precheck` / `execute` / `finalize`), so you can
see whether a slow restore is the download or Moodle's import.

## Recommendations for blueprint authors

* Keep `.mbz` course backups reasonably small and served from a CORS-accessible host (e.g.
  `raw.githubusercontent.com`) so the fast browser-side download applies. Non-CORS or > 50 MB
  backups fall back to the slower in-PHP download.
* Prefer pinned release ZIPs over moving `main` archives (reproducible, cacheable, smaller) —
  plugin ZIP installs are the largest remaining steps once the restore download is fast.
* Put `debug=DEVELOPER` (32767) as the *last* step, or omit it and use `?debug=true` ad hoc —
  enabling it early makes every later step (including the restore) run in Moodle's most
  expensive diagnostic mode.
* Don't repeat `installLanguagePack` for the site locale already set on install.
* Prefer targeted `theme_reset_all_caches()` / `rebuild_course_cache()` over a full
  `purge_all_caches()` in custom PHP, and only where a following step needs fresh caches.
