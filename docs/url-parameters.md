# URL parameters

Append query parameters to the main app URL to pick a Moodle/PHP version, load a
blueprint, or turn on debugging. For example:

```text
https://moodle-playground.com/?moodle=4.5&php=8.3
```

For everyday workflows, see [Basic usage](usage.md). To build your own setups, see
[Blueprints](blueprints/index.md).

## Reference

| Parameter | Example | What it does |
|-----------|---------|--------------|
| `moodle` | `?moodle=4.4` or `?moodle=MOODLE_500_STABLE` | Selects the Moodle version or branch to boot. |
| `php` | `?php=8.3` | Selects the PHP version. Must be compatible with the Moodle branch, otherwise it falls back to a supported version. |
| `blueprint` | `?blueprint=<inline>` | Loads an inline blueprint. Accepts raw JSON, base64, gzip+base64url, or a `data:` URL. Highest precedence. |
| `blueprint-url` | `?blueprint-url=/assets/blueprints/examples/minimal.blueprint.json` | Fetches a blueprint from a relative or absolute URL. |
| `debug` | `?debug=true` | Enables verbose runtime tracing and logs (any truthy value). |
| `profile` | `?profile=runtime-selection` | Profiles one or more subsystems (comma-separated list). Advanced. |
| `addonProxyUrl` | `?addonProxyUrl=https://proxy.example/` | Proxy base URL for browser-side plugin/theme ZIP downloads (works around CORS). |
| `phpCorsProxyUrl` | `?phpCorsProxyUrl=https://proxy.example/` | Proxy base URL for outbound PHP networking fallback (works around CORS). |
| `repo` / `owner` / `branch` (alias `ref`) | `?repo=org/plugin&branch=feature-x` | Sets the `{{REPO}}`, `{{OWNER}}`, and `{{BRANCH}}`/`{{REF}}` constants for the loaded blueprint. Use with `blueprint-url` to target a PR branch without hardcoding it. |

## Blueprint source precedence

When more than one source could provide a blueprint, the app picks the first match in
this order:

```text
blueprint  >  blueprint-url  >  saved session  >  project default  >  built-in minimal
```

!!! note "Internal parameters"
    `scope`, `runtime`, `path`, `clean`, and `reload` are internal plumbing set by the
    app itself (between the shell, the remote iframe, and the service worker). Do not set
    them by hand. To start fresh, use the **Reset Playground** button in the shell rather
    than a URL parameter.

## Examples

Boot a specific Moodle and PHP version:

```text
https://moodle-playground.com/?moodle=4.5&php=8.3
```

Load a blueprint by URL:

```text
https://moodle-playground.com/?blueprint-url=/assets/blueprints/examples/course-with-content.blueprint.json
```

Load an inline blueprint (raw JSON, URL-encoded):

```text
https://moodle-playground.com/?blueprint=%7B%22steps%22%3A%5B%7B%22step%22%3A%22installMoodle%22%7D%5D%7D
```

!!! tip
    Inline blueprints can also be base64 or gzip+base64url encoded, which keeps long URLs
    shorter. See [Blueprints](blueprints/index.md) for how to author and encode them.
