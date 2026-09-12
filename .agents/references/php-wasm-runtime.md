# Moodle runtime reference

Local details used by the shared PHP-WASM and browser-runtime skills. Keep this
file outside installed skill directories. Read the section needed for the task.

## PHP integration

- Loader: `src/runtime/php-loader.js`; adapter: `src/runtime/php-compat.js`;
  bootstrap: `src/runtime/bootstrap.js`. The raw instance is `php._php`.
- Provisioning defines `CLI_SCRIPT` before requiring Moodle config. Login uses
  HTTP; do not substitute Nextcloud's occ wrapper.
- `sodium` is unavailable; retain the OpenSSL fallback in
  `patches/shared/lib/classes/encryption.php`. Extension/ini configuration belongs
  in the loader and `src/runtime/config-template.js`; sessions use `/tmp/moodle/sessions`.
- `SCRIPT_NAME`, `PHP_SELF`, and `REQUEST_URI` carry the deployment base path.
  Moodle derives FULLME/FULLSCRIPT from scheme+host plus these variables.
  Preserve PATH_INFO for theme resources and `pluginfile.php`.
- Keep `tcpOverFetch`, `openssl.cafile`, and `curl.cainfo` aligned. The generated
  CA avoids explicit keyUsage, nsCertType, and SAN IP extensions because of the
  upstream ASN.1 encoder issue. Preserve the current CA profile.
- `addonProxyUrl` is for browser downloads; `phpCorsProxyUrl` is for PHP fallback.
  `MOODLE_PLAYGROUND_PROXY_URL` stays scope-aware; the SW `__playground_proxy__`
  endpoint preserves the query string. For request-body compatibility see
  [ADR 0015](../../docs/architecture/adr/ADR-0015-firefox-request-body-buffering.md).

## Storage and recovery

- Core streams into `/www/moodle`. SQLite remains the MEMFS file
  `/persist/moodledata/moodle_<scope>_<runtime>.sq3.php`.
- `src/runtime/fs-persistence.js` journals `/persist` to
  `moodle-fs-journal:<scope>`. OPcache is not journaled.
- Exclude `moodledata/{cache,localcache,temp,muc}`. Replaying a compiled DI cache
  can reference absent files. Preserve normalize-before-hydrate behavior.
- Keep MUC enabled and cache/admin defaults seeded to avoid settings redirects.
  Snapshot localcache/RequireJS seeds are restored at boot; legacy manifests keep
  their fallback behavior. See [ADR 0013](../../docs/architecture/adr/ADR-0013-build-time-requirejs-combined-bundle-seed.md).
- Recovery checkpoints pending filedir changes before taking the DB snapshot;
  on failure prefer an older coherent checkpoint. Preserve bounded copying,
  restart guards, and plugin registration through alternative_component_cache.
  Read [ADR 0027](../../docs/architecture/adr/ADR-0027-selective-crash-recovery-snapshots.md)
  and `php-worker.js` for the current flow.
- `npm run build-worker` builds both workers, including blueprint imports.
  `sw.bundle.js` stays at the app root. Use `?debug=true` for browser debugging.
