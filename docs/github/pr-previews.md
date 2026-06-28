# PR previews with GitHub Actions

The [`ateeducacion/action-moodle-playground-pr-preview`](https://github.com/ateeducacion/action-moodle-playground-pr-preview)
action posts an **Open in Moodle Playground** button on every pull request, so
reviewers can boot the PR's plugin (or Moodle core changes) in the browser with
one click. No checkout, no local Moodle, no server.

This page is a task-focused how-to. For the full input/output list see the
[Action reference](action-reference.md).

## Smallest useful workflow

For a plugin that lives at the repository root, this is all you need:

```yaml
name: PR Preview
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

jobs:
  preview:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Post Moodle Playground preview button
        uses: ateeducacion/action-moodle-playground-pr-preview@v1
        with:
          plugin-path: "."
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action detects the plugin type and name from the repository name (the
`moodle-TYPE_NAME` convention, e.g. `moodle-mod_board` becomes type `mod`, name
`board`), builds a blueprint that installs the plugin from the PR branch, and
appends the preview button to the PR description.

!!! tip "Pin the version"
    Always pin the action to `@v1`. This keeps your workflow stable across
    action releases.

## Scenarios

Each snippet below shows only the `with:` block that changes. Keep the rest of
the workflow (trigger, `permissions`, `runs-on`) as in the minimal example.

### Plugin in a subdirectory

Point `plugin-path` at the plugin directory:

```yaml
        with:
          plugin-path: "plugins/mod_myplugin"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Inline blueprint

Provide a blueprint as a JSON string. When `blueprint` is set, `plugin-path` is
ignored:

```yaml
        with:
          blueprint: |
            {
              "steps": [
                { "step": "installMoodle" },
                { "step": "login", "username": "admin" }
              ]
            }
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Blueprint from a file in the repo

Use `blueprint-file` to read a JSON file from the checked-out repository. This
requires `actions/checkout` first:

```yaml
    steps:
      - uses: actions/checkout@v4
      - name: Post Moodle Playground preview button
        uses: ateeducacion/action-moodle-playground-pr-preview@v1
        with:
          blueprint-file: ".github/preview.blueprint.json"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

!!! note "Branch rewriting"
    For `blueprint-file`, any `installMoodlePlugin` / `installTheme` GitHub
    archive URL that points at *this* repository is rewritten to the PR branch
    automatically, so reviewers test the PR code, not the base branch.

### Blueprint from a URL

Link to a remote blueprint. The preview link uses `?blueprint-url=`:

```yaml
        with:
          blueprint-url: "https://example.com/preview.blueprint.json"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Large blueprints via a proxy

Long inline blueprints can exceed URL limits and fail with **HTTP 414**. Serve
the blueprint through a GitHub proxy (a CORS-enabled endpoint that returns one
repo file) instead of inlining it:

```yaml
        with:
          blueprint-file: ".github/preview.blueprint.json"
          proxy-url: "https://your-github-proxy.example.com"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Comment vs. description

By default the button is appended to the PR description
(`mode: append-to-description`). To post it as a comment instead:

```yaml
        with:
          plugin-path: "."
          mode: "comment"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Moodle core PR overlay

To preview changes to **Moodle core** (not a plugin), set `preview-type: core`.
The action boots a prebuilt base for the target branch and overlays the PR's
changed files at runtime — no per-PR bundle is built:

```yaml
        with:
          preview-type: "core"
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The base version is inferred from the target branch (for example
`MOODLE_404_STABLE` maps to 4.4). Override it with `base-version` if needed.

!!! warning "Core overlay limits"
    Core overlays replace whole files only and are capped (80 files, 256 KiB
    each by default; binary files skipped). There is no Composer install,
    asset build, or full database upgrade, so fidelity is lower than a real
    core build. Use it for quick visual/behavioral review, not deep testing.

## Required permissions

The job must grant:

```yaml
    permissions:
      contents: read
      pull-requests: write
```

`github-token` defaults to the workflow's `GITHUB_TOKEN`; passing
`${{ secrets.GITHUB_TOKEN }}` explicitly is recommended for clarity.

## Limitations

- **Ephemeral runtime.** The preview holds no data after the tab closes — it is
  for review, not storage.
- **Outbound network.** Plugin/theme/language downloads happen in the browser;
  Firefox and Safari cannot make outbound calls from WASM PHP, so Chromium is
  the most reliable browser for previews. A proxy may be needed for ZIP fetches.
- **Branch must be pushed.** The plugin install URL points at the PR's remote
  branch, so the branch has to exist on the remote (not just locally).
- **Core overlay fidelity.** See the warning above.
- **SQLite via an experimental PDO driver patch** — not full production parity.

## Common errors

| Symptom | Cause and fix |
|---------|---------------|
| `Resource not accessible by integration` | The job is missing `pull-requests: write`. Add it to `permissions`. |
| Plugin missing in the preview | The PR branch is not on the remote. The install URL needs the pushed branch — push it. |
| **HTTP 414** (URL too long) | The inline blueprint is too large. Use `blueprint-url`, or `blueprint-file` with `proxy-url`. |
| Core overlay incomplete | Hitting the overlay caps (file count / size, skipped binaries) or missing a DB upgrade. Reduce the changeset or test those parts locally. |

## See also

- [Action reference](action-reference.md) — full inputs and outputs tables.
- [Blueprints overview](../blueprints/index.md) — what blueprints can do.
- [Action repository](https://github.com/ateeducacion/action-moodle-playground-pr-preview)
  — README with advanced options.
