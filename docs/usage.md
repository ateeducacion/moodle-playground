# Basic usage

This page explains how to drive the hosted app at
[moodle-playground.com](https://moodle-playground.com) from the browser: the
toolbar, the side panel, loading blueprints, and resetting state.

If you just want the fastest path to a running site, see
[Quick start](getting-started.md). To run the app on your own machine, see
[Run it locally](local-development.md).

## Open the playground

1. Go to [https://moodle-playground.com](https://moodle-playground.com)
   (mirrors: `https://moodle-playground.pages.dev/` and
   `https://ateeducacion.github.io/moodle-playground/`).
2. Wait for the first boot. A full Moodle site is compiled to WebAssembly and
   installed in memory, so the first load takes a few seconds. Boot progress is
   shown in the **Logs** tab.
3. The app is ready when the **address bar** becomes editable. By default you
   land logged in as the site administrator on the site home page.

!!! note "Default credentials"
    Username `admin`, password `password`. A blueprint can override these via an
    `installMoodle` step — see [Blueprints](blueprints/index.md).

## The toolbar

The top bar is a minimal browser chrome for the Moodle site running inside the
iframe:

- **Home** (house icon) — go to the site root (`/`).
- **Refresh** (↻) — reload the current Moodle page.
- **Address bar** — the URL *inside* Moodle. Type a path and press Enter to
  navigate. For example:

    ```text
    /admin/index.php
    /course/management.php
    /user/preferences.php
    ```

- **Documentation** — opens these docs in a new tab.
- **Toggle sidebar** (panel icon, far right) — show or hide the side panel.

!!! tip
    The address bar takes paths relative to the Moodle site, not full URLs.
    Internal runtime routing (scope, runtime, service worker) is handled for you;
    see [URL parameters](url-parameters.md) for the parameters on the *app* URL.

## The side panel

Click the **Toggle sidebar** button to open the panel. It has four tabs.

### Info — choose Moodle and PHP versions

The **Info** tab holds the runtime configuration:

- **Moodle version** — pick a built branch (4.4, 4.5, 5.0 default, 5.1, 5.2, or
  `main`).
- **PHP version** — pick a PHP version compatible with the selected branch
  (8.1–8.5; the list updates automatically, default 8.3).
- **Apply & Reset** — appears only after you change a version. Applying is
  destructive: it boots a fresh, clean install on the new versions and wipes the
  current site.
- **Runtime ID** — a copyable identifier for the active runtime.
- **Reset Playground** — see [Reset the playground](#reset-the-playground).

!!! warning
    Switching the Moodle or PHP version reinstalls from scratch. All current
    courses, users, and data are lost.

You can also set versions from the app URL without opening the panel:

```text
https://moodle-playground.com/?moodle=4.4&php=8.3
```

See [URL parameters](url-parameters.md) for the full list.

### Logs — runtime log

The **Logs** tab streams boot and runtime messages, including blueprint step
progress and errors. Use **Copy** to grab the full log or **Clear** to empty it.
For more verbose tracing, open the app with `?debug=true`:

```text
https://moodle-playground.com/?debug=true
```

### PHP Info — diagnostics

The **PHP Info** tab captures the running runtime's `phpinfo()` output (PHP
version, loaded extensions, limits). Use **Refresh** to re-capture it.

### Blueprint — view, import, export

The **Blueprint** tab shows the active blueprint as JSON (read-only):

- **Export** — download the active blueprint as `moodle-playground.blueprint.json`.
- **Import** — load a `.json` blueprint from your computer (see below).

## Load a blueprint

A blueprint is a JSON file that provisions the site at boot (courses, users,
plugins, and more). See [Blueprints](blueprints/index.md) for the format.

=== "From a file"

    1. Open the **Blueprint** tab in the side panel.
    2. Click **Import** and choose a `.json` blueprint.

    The app reloads with the blueprint applied to a fresh runtime.

=== "From a URL"

    Pass `blueprint-url` on the app URL (relative or absolute):

    ```text
    https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/minimal.blueprint.json
    ```

=== "Inline"

    Pass the blueprint directly with `blueprint` (raw JSON, base64, or a
    `data:` URL). Inline blueprints take the highest precedence:

    ```text
    https://moodle-playground.com/?blueprint=%7B%22steps%22%3A%5B%7B%22step%22%3A%22installMoodle%22%7D%5D%7D
    ```

Ready-made examples live under
`assets/blueprints/examples/` — see the
[Blueprint examples](blueprints/examples.md).

## Reset the playground

Click **Reset Playground** in the **Info** tab to discard the current site and
boot a clean install of the active configuration. Unless a blueprint was supplied
via `?blueprint=` or `?blueprint-url=`, reset also clears any imported blueprint
so you start from the default.

!!! note
    Reset is the supported way to recover a stuck or broken session. Do not add
    `?clean=1` to the app URL — that is an internal parameter the shell manages
    itself.

## Ephemeral state

The playground is fully in-memory. Keep this model in mind:

- **Within a tab session**, your data survives a page reload — but only for the
  **same blueprint source**. Loading a different blueprint, or clicking **Reset
  Playground**, starts fresh.
- **Each tab is independent** (the session scope lives in `sessionStorage`).
  Opening the app in a new tab starts clean.
- **Closing the tab loses everything.** Nothing is written to disk. This is a
  sandbox, not a place to store real data.

## Limitations & troubleshooting

- **Ephemeral by design** — there is no persistence after the tab closes. Export
  a blueprint if you want to reproduce a setup later.
- **Browser support** — Chromium-based browsers work best. On Firefox and Safari,
  outbound network calls from WASM PHP are restricted, so installing plugins,
  themes, or language packs from external URLs may fail or fall back to a proxy.
- **Memory-bound** — very large courses, backups, or plugins can exhaust WASM
  memory and crash the runtime. Prefer smaller fixtures.
- **Experimental SQLite driver** — the database runs on an experimental SQLite
  PDO patch, so behavior is not a full production-parity Moodle.

If a boot gets stuck or a page misbehaves:

1. Open the **Logs** tab (and reload with `?debug=true`) to read what failed.
2. Click **Reset Playground** to force a clean boot.
3. Try a Chromium-based browser if network-dependent steps fail.

For how the pieces fit together, see [Architecture](architecture.md).
