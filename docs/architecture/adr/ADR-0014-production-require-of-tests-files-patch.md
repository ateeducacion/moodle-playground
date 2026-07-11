# 0014 — Patch production code that require_once()s files under tests/

## Status

Accepted (2026-06).

## Context and Problem

The core bundle excludes every `*/tests/*` directory from the ZIP (ADR 0011 /
PR #141, `scripts/build-moodle-bundle.sh`), which halves the download and the
MEMFS extraction cost. That exclusion assumes the runtime never reads test code
— a safe assumption for PHPUnit/Behat suites, but **Moodle 5.0+ ships an
upstream architectural violation**: production code `require_once()`s a file
that lives under `tests/`.

Concretely, opening `/admin/plugins.php` fatals with:

```
Exception - Failed opening required
'[dirroot]/analytics/tests/classes/mlbackend_helper_trait.php'
```

Trigger chain:

1. `/admin/plugins.php` builds the admin tree, which includes
   `admin/settings/analytics.php`.
2. That page calls `\core_analytics\manager::get_all_prediction_processors()`
   (`analytics/classes/manager.php`), which **instantiates every `mlbackend`
   plugin**, including `mlbackend_python`.
3. Declaring `\mlbackend_python\processor`
   (`lib/mlbackend/python/classes/processor.php:30`) runs
   `require_once($CFG->dirroot . '/analytics/tests/classes/mlbackend_helper_trait.php');`
   and `use mlbackend_helper_trait;` in the class body.
4. The trait file was excluded by `*/tests/*` → fatal.

The trait (`@category test`, namespace `core_analytics\tests`) declares two
methods. Only `is_mlbackend_python_configured()` is used by the class itself
(in the constructor), and only inside an
`if (defined('BEHAT_SITE_RUNNING') || (defined('PHPUNIT_TEST') && PHPUNIT_TEST)) && …`
guard — never reached in the playground (short-circuited away). `generate_courses()`
is test-only (uses `phpunit_util`). `mlbackend_python` cannot function in WASM at
all (no `python`/`exec()`, no remote ML server); the class only needs to **load**
cleanly so the analytics admin page can enumerate prediction processors.

A repo-wide scan found `processor.php` is the **only** production consumer of
this trait across the affected branches (5.0, 5.01, 5.02, main; 4.04/4.05 do not
have it). Other production→`tests/` references exist but are **latent** —
unreachable in the playground:

* `cache/classes/factory.php` → `cache/tests/fixtures/lib.php` (test-mode only).
* `admin/tool/generator/.../runner.php` and
  `admin/tool/behat/.../get_entity_generator.php` →
  `lib/tests/behat/…`, `admin/tests/behat/…`, `course/tests/behat/…`
  (Behat data-generator scenarios only).

## Options Considered

* **Re-add the referenced `tests/` files to the bundle** (allowlist / build-time
  scan in `build-moodle-bundle.sh`) + a tripwire. General, but re-introduces the
  per-branch count-parity bookkeeping and keeps shipping test code.
* **Revert the `*/tests/*` exclusion.** Throws away ~52 MB / ~6,100 files to
  paper over a handful of upstream bugs. Rejected.
* **Patch `processor.php`** to drop the test-trait dependency and inline the one
  method the class uses. Chosen.
* **Full-file copy** of `processor.php` into `patches/shared/`. Rejected: would
  pin a copy that silently drifts from upstream across six branches.

## Decision

A guarded in-place edit in `scripts/patch-moodle-source.sh` (the repo's dominant
patch pattern: a `python3` `str.replace` block that `raise SystemExit`s if a
needle is missing). The block:

1. Removes `require_once($CFG->dirroot . '/analytics/tests/classes/mlbackend_helper_trait.php');`.
2. Removes the file-level `use core_analytics\tests\mlbackend_helper_trait;`.
3. Replaces the class-body `use mlbackend_helper_trait;` with an inline copy of
   `is_mlbackend_python_configured()` (the only method the class itself calls).

It is gated by `grep -q "analytics/tests/classes/mlbackend_helper_trait"`, so it
applies only where the dependency exists (no-op on 4.04/4.05) and is idempotent
(the needle is gone after the first run; the surviving mention is a `\`-separated
reference inside a doc comment, which the `/`-separated guard does not match).

`generate_courses()` is intentionally **not** inlined — it is test-only and
references `phpunit_util`, which does not exist at runtime.

The latent `cache`/`behat` references are left untouched: they are unreachable in
the playground, and patching dead code would add maintenance surface for no
runtime benefit.

## Consequences

### Positive

* `/admin/plugins.php` and the analytics admin settings page load cleanly on
  every affected branch, with the `*/tests/*` exclusion (and its ~52 MB saving)
  fully preserved.
* The patch is surgical and version-tolerant: it edits only three localized
  lines that are byte-identical across 5.0/5.01/5.02/main, and the `raise
  SystemExit` makes any future upstream reformatting fail the build loudly
  instead of shipping a broken bundle.
* The build pipeline re-applies it automatically: `build-moodle-bundle.sh` runs
  `patch-moodle-source.sh` on every build, and the snapshot fingerprint hashes
  that script, so editing it invalidates the snapshot cache.

### Negative / Risks

* `mlbackend_python`'s prediction methods are now subtly diverged from upstream
  (the trait's `generate_courses()` is absent). Irrelevant in the playground —
  the backend cannot run — but noted for anyone porting this elsewhere.
* If a **new** Moodle release adds another production→`tests/` `require_once`,
  the bundle will fatal the same way at a different entry point. There is no
  generic tripwire for this class of bug yet (see Review Criteria).

## Implementation Notes

* `scripts/patch-moodle-source.sh`: new `PROCESSORPHP` path var (respecting the
  `${PUB}` 5.1+ `public/` prefix) and the guarded Python block.
* No `npm run build-worker` needed (no `src/blueprint/**` or worker JS change).
* Verify by rebuilding the bundle (`make bundle`) — `make up-local` does **not**
  reproduce the bug because it serves the full checkout with `tests/` present.
* Watch for the `*/` trap: a `/** … */` PHP doc comment must not contain the glob
  literal `*/tests/*` (the `*/` closes the comment early).

## Review Criteria

* If a future Moodle branch fatals on a different `[dirroot]/…/tests/…` require,
  generalize this into a build-time detector in `build-moodle-bundle.sh` that
  greps production PHP for `require/include` of `tests/…\.php` and asserts each
  referenced path is present in the bundle (a suffix match against the zip
  listing avoids `dirroot`/`libdir` resolution).
* Revisit if `mlbackend_python` is ever removed from the bundle outright, which
  would make this patch unnecessary.
* Revisit the latent `cache`/`behat` references if any playground feature ever
  reaches Behat data generators or the test cache factory at runtime.
