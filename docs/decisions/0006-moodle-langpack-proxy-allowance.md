# ADR-0006 Language pack installation via the CORS proxy and Moodle's lang_installer

* Status: Accepted
* Date: 2026-06-08

## Context and Problem

Moodle core bundles only the English language (`dirroot/lang/en`). Every other language is a
separate pack that must be downloaded into `dataroot/lang/<code>`. Playground users need to
install languages (e.g. Spanish) both interactively and from blueprints.

Moodle's own importer (`admin/tool/langimport`, backed by the `lang_installer` class in
`lib/componentlib.class.php`) downloads packs from `download.moodle.org/langpack`. In the
playground that download runs **inside PHP/WASM** and is translated to a browser `fetch()` by
`@php-wasm`'s `tcpOverFetch` bridge, which is configured with `phpCorsProxyUrl`
(`github-proxy.exelearning.dev`).

Two things blocked it:

1. **The proxy only authorized zip-like paths.** `tool_langimport` first fetches the langpack
   index `languages.md5` (a non-zip path), which the proxy's `isSupportedGenericProxyUrl`
   (`looksLikeZipUrl && isAllowlistedProxyHost`) rejected with `400`. The whole flow failed
   before reaching the `.zip`.
2. **A presumed Firefox/Safari limitation.** The project documents that outbound WASM HTTP
   fails on Firefox/Safari (`errno 23`, handled by `crash-recovery.js`). This suggested native
   install could only ever be Chromium-only.

On investigation (`tcp-over-fetch-websocket.ts`), the WASM-network limitation only applies to
requests with a streaming **request body** (`duplex: 'half'`, used for POST/PUT uploads).
Language pack downloads are plain **GET** requests, so they carry no streaming body and work in
every browser. The only real blocker was the proxy's zip-only rule.

## Options Considered

* **Option 1 — `installLanguagePack` step that downloads + extracts the ZIP client-side.**
  Fetch the pack in JS (worker `fetch()` through the proxy) and unzip it into `dataroot/lang`.
  Works cross-browser but reimplements what Moodle already does (parent-language resolution,
  version selection, index parsing) and only covers the blueprint path, not the admin UI.

* **Option 2 — Authorize Moodle langpack paths in the proxy and use Moodle's own
  `lang_installer`.** Allow `/langpack/` paths (incl. `languages.md5`) on `download.moodle.org`
  and `packaging.moodle.org`. Native `admin/tool/langimport` then works directly, and the
  blueprint step / auto-install are thin wrappers (`new lang_installer($codes))->run()`).

* **Option 3 — Allow CORS only and rely on the admin UI.** No blueprint automation; users must
  install languages by hand every session (state is ephemeral).

## Decision

**Option 2.** Authorize Moodle langpack paths through the `github-proxy` worker and build the
language features on top of Moodle's own `lang_installer`:

1. **Proxy (`scripts/github-proxy-worker.js`)**: add `packaging.moodle.org` and
   `download.moodle.org` to `isAllowlistedProxyHost` (zip downloads), and add
   `isMoodleLangpackUrl()` (authorizes any `/langpack/` path on those two hosts, regardless of
   extension, so `languages.md5` passes). The SSRF guard and per-redirect re-validation still
   run for every hop (`download.moodle.org` 302-redirects to `packaging.moodle.org`).
2. **`installLanguagePack` blueprint step** (`src/blueprint/steps/moodle-language.js`): validates
   language codes (`/^[a-z][a-z0-9_]*$/`) and calls `lang_installer` for one or more packs,
   optionally setting the site default (`setDefault`).
3. **Auto-install** (`src/runtime/bootstrap.js`, `runLanguageAutoInstall`): when the configured
   site language (`$CFG->lang`) is not English, install it automatically during boot. Idempotent
   (skips if the pack is already on disk — it persists in `dataroot`) and non-fatal (a download
   failure falls back to English strings).

## Consequences

### Positive
* **Works in every browser** — language downloads are GET requests, so they avoid the
  `duplex: 'half'` WASM-network limitation that affects Firefox/Safari.
* **Native admin flow works** — Site administration → Language → Language packs installs
  directly, no custom code.
* **Minimal code** — the step and auto-install are ~3 lines of PHP each; Moodle handles
  parent-language resolution, version selection and extraction.
* **Set-and-forget** — `locale: "es"` in config/blueprint auto-installs the pack on boot.

### Negative / Risks
* **Broader proxy surface** — the proxy now forwards non-zip paths on the two Moodle hosts.
  Scoped to `/langpack/` paths only; the SSRF guard and redirect re-validation still apply.
* **Boot-time network dependency** — a fresh boot with a non-English site language makes a
  network call. It is non-fatal and idempotent across reloads, but adds latency on first boot
  and depends on the proxy being reachable.
* **Relies on `tcpOverFetch` proxy routing** — if `phpCorsProxyUrl` is unset or upstream
  `@php-wasm` changes how the CORS proxy is applied, native install reverts to a direct
  (CORS-blocked) fetch.

## Implementation Notes

### Files modified / added
- `scripts/github-proxy-worker.js` — `isAllowlistedProxyHost` (+2 hosts), new
  `isMoodleLangpackUrl()` wired into `isSupportedGenericProxyUrl`. Deployed to the `github-proxy`
  and `zip-proxy` workers; mirrored to the sibling playground repos.
- `tests/shared/github-proxy-worker.test.js` — langpack ZIP, redirect, and `languages.md5` cases.
- `src/blueprint/steps/moodle-language.js` — new `installLanguagePack` handler.
- `src/blueprint/php/helpers.js` — `phpInstallLanguagePacks()` generator.
- `src/blueprint/steps/index.js`, `src/blueprint/schema.js` — register the step.
- `src/runtime/bootstrap.js` — `runLanguageAutoInstall()` invoked before blueprint execution.
- `tests/blueprint/language-pack.test.js`, `tests/blueprint/steps.test.js` — coverage.

## Review Criteria
- If `@php-wasm` changes `tcpOverFetch`'s CORS-proxy handling or a future Moodle changes the
  `lang_installer` API or langpack URL scheme, re-verify both the native flow and the step.
- If the proxy's allowlist model is reworked, fold `isMoodleLangpackUrl` into the new model.
- If boot latency from auto-install becomes a concern, consider gating it behind an explicit
  config flag instead of inferring from `$CFG->lang`.
