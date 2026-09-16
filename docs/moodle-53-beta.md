# Moodle 5.3 beta playground

Select **Moodle 5.3 beta (experimental)** or use `?moodle=5.3&php=8.4`.
PHP 8.3 also works with the declared compatibility matrix; 8.2 and 8.5 are not
offered for this channel. The default remains Moodle 5.0/PHP 8.3.

`MOODLE_503_BETA` is our local asset/channel name, pinned to upstream
`v5.3.0-beta` through `gitRef` in `src/shared/version-resolver.js`. It is not an
upstream stable branch. `main` remains a separate moving development build.
The bundle includes the existing SQLite and WASM compatibility patches, Composer
dependencies, a native-generated SQLite install snapshot and localcache seeds.
This experimental SQLite/WASM environment is not a supported production Moodle DB.

## Build and test

```sh
npm ci
npm run build:version
npm run build-worker
make bundle BRANCH=MOODLE_503_BETA
make test
npx playwright test tests/e2e/moodle-53-beta.spec.mjs --workers=1
```

The native snapshot builder uses PHP 8.3; runtime selection in the browser can use
8.3 or 8.4 independently. Both `make prepare-all` (CI) and the colorized local
all-branch command include the beta. For a beta-only local build, start a server
on an unused port and set `PLAYWRIGHT_BASE_URL` / `PLAYWRIGHT_EXTERNAL_SERVER=1`
so Playwright does not try to build every stable branch.

## Next beta, RC and final

Change `gitRef`, the experimental label and the E2E release assertion together;
rebuild the bundle/snapshot and repeat both browser/runtime combinations. Keep
the channel explicitly experimental. Explicit `GIT_REF` remains available for
local experiments but does not change the advertised compatibility guarantee.
Add a distinct `MOODLE_503_STABLE` channel only after upstream publishes it;
changing the default is a separate decision. See [ADR-0030](architecture/adr/ADR-0030-pinned-moodle-prereleases.md).

## Verification

Verified locally on 2026-09-16 against upstream commit
`e68a1418bea512dd5992c29eb9e36570a3844e94` (`v5.3.0-beta`):

- Native PHP 8.3 bundle build: passed, including Composer, SQLite installation,
  task draining, theme/DI/RequireJS caches and archive parity checks.
- Bundle: 61,597 files, 56,098,370 bytes; SQLite snapshot: 8,192,000 bytes.
- `make test`: 838 passed, zero failed.
- Worker/service-worker rebuild: passed.
- Chromium and Firefox, each with PHP 8.3 and 8.4: all four browser tests passed,
  checking the selected runtime, visible themed Moodle page, no exception text,
  beta release manifest and snapshot presence.
- Changed JavaScript files pass Biome; shell syntax and `git diff --check` pass.
  Repository-wide lint exits successfully with existing schema/deprecation and
  formatting warnings outside these changes.

These checks cover fresh installation and rendering, not every plugin, blueprint
or an upgrade of a persisted older playground. Revalidate subsequent releases.
