# Plugin Install Notes For This Branch

This document summarizes the plugin-related work that exists in this branch and
is not yet the baseline in `main`.

It is meant to answer three practical questions:

1. What was fixed here compared with `main`?
2. How should plugins be installed and configured in the playground?
3. What requirements and caveats still apply?

## What This Branch Fixes

Compared with `main`, this branch hardens the plugin install/runtime path in a
few areas that were previously fragile:

- **Writable runtime patches**
  Runtime overrides in `src/runtime/bootstrap.js` are applied directly in
  writable MEMFS. All Moodle files are writable, so plugins can be extracted
  and patched without restrictions.

- **Crash recovery preserves plugins and user data**
  When the PHP WASM runtime crashes (OOM, file descriptor exhaustion), the
  worker snapshots the DB, plugin files, and user uploads from MEMFS before
  destroying the runtime. After a fresh bootstrap, the snapshot is restored
  and plugins are re-registered with Moodle's component cache.

- **Alternative component cache is refreshed after plugin install**
  Runtime patches to Moodle's `core_component` and `plugin_manager` update the
  component cache after installing a plugin ZIP so the new plugin appears in the
  runtime registry without requiring a broken full filesystem rescan.

- **Missing sodium no longer blocks plugin upgrades**
  The current PHP WASM runtime does not provide `sodium`. This branch keeps the
  OpenSSL fallback patch in place and downgrades the `admin/environment.xml`
  sodium requirement from `required` to `optional` so the plugin upgrade flow can
  continue.

- **Cache/admin defaults are seeded more aggressively**
  This reduces false redirects into `admin/index.php` and `upgradesettings.php`
  caused by missing cache store settings, stale `adminsetuppending`, and missing
  site defaults.

- **Worker diagnostics no longer cascade into runtime collapse as easily**
  `php-worker.js` now limits automatic bootstrap diagnostics to avoid repeated
  follow-up crashes after the first runtime failure.

## How To Install Plugins In This Branch

There are two supported paths.

### 1. Install through the UI

Use the real install tool:

- Go to `/admin/tool/installaddon/index.php`
- Upload a ZIP
- Continue the Moodle upgrade flow if prompted

Important:

- The top-level **Plugins** entry in Moodle's secondary navigation is **not**
  the installer. It is the generic site-admin/search navigation and typically
  resolves to `admin/search.php#linkmodules`.
- If you want the ZIP installer specifically, use the **Install plugins** tool
  or navigate directly to `/admin/tool/installaddon/index.php`.

### 2. Install through a blueprint

Use:

- `installMoodlePlugin`
- `installTheme`

See [`blueprint-json.md`](./blueprint-json.md) for the step reference.

This is the preferred path for repeatable demos/tests because it avoids manual
navigation and makes the plugin source explicit.

## Plugin ZIP Expectations

The ZIP still needs to be structurally correct for Moodle:

- one top-level plugin directory
- directory name matching the plugin name
- plugin placed under the right plugin type (`mod`, `block`, `local`, `theme`, etc.)
- valid Moodle plugin files such as `version.php`

Examples:

- `mod/exeweb`
- `theme/moove`
- `local/myplugin`

If the ZIP layout is wrong, the playground cannot infer the target directory
reliably and Moodle will still fail during install or upgrade.

## Configuration And Runtime Requirements

These are the main things the current branch still depends on.

- **Rebuild the worker after runtime changes**
  Run `npm run build:worker` after editing `src/runtime/*` or `php-worker.js`.

- **Hard reload after rebuilding**
  The browser can keep an old worker alive. After a new build, do a hard reload
  before validating plugin install behavior.

- **Moodle bundle and snapshot must match the current runtime code**
  If you change snapshot generation, component cache generation, or bundle-time
  patches, rebuild the bundle as well, not only the worker.

- **No sodium in the current WASM runtime**
  Encryption-sensitive plugin code must tolerate Moodle's OpenSSL fallback path.

- **Moodle core in writable MEMFS**
  All files under `/www/moodle` are writable in MEMFS. Plugins can be extracted
  directly into the correct subdirectory.

- **The runtime is ephemeral**
  Installed plugins survive PHP runtime crashes (via the crash recovery snapshot)
  but are lost on full page reload unless they are part of a blueprint.

## Current Caveats

These items are improved in this branch but not fully “desktop Moodle” parity yet.

- Some admin navigation paths still go through Moodle's generic `admin/search.php`
  flow rather than directly to the exact admin tool you may expect.

- The first admin page after boot is still a sensitive area. If bootstrap defaults
  are incomplete, Moodle can still fall back into `admin/index.php` or
  `upgradesettings.php`.

- A plugin can still break the worker if it depends on runtime behavior that the
  WASM environment does not provide, especially around PHP extensions, filesystem
  assumptions, or heavy admin settings pages.

- If a page starts returning `500` for `theme/image.php`, `javascript.php`,
  `require.js`, or admin endpoints after a plugin action, treat that as a runtime
  failure in the worker first, not as a static asset problem.

## Practical Validation Checklist

When testing plugin support in this branch:

1. Run `npm run build:worker`.
2. Hard reload the playground.
3. Confirm normal boot does not immediately bounce into `admin/index.php` or
   `admin/upgradesettings.php`.
4. Open `/admin/tool/installaddon/index.php`.
5. Install the ZIP.
6. Confirm the upgrade flow completes without the sodium environment check
   blocking progress.
7. Confirm the plugin appears in the relevant Moodle registry/page after install.

## Related Files

The main implementation points behind this branch work are:

- [`src/runtime/bootstrap.js`](../src/runtime/bootstrap.js)
- [`src/runtime/crash-recovery.js`](../src/runtime/crash-recovery.js)
- [`src/runtime/config-template.js`](../src/runtime/config-template.js)
- [`php-worker.js`](../php-worker.js)
- [`lib/moodle-loader.js`](../lib/moodle-loader.js)
- [`scripts/generate-install-snapshot.sh`](../scripts/generate-install-snapshot.sh)

