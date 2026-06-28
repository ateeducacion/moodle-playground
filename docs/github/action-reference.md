# Action reference

Reference for the [`ateeducacion/action-moodle-playground-pr-preview`](https://github.com/ateeducacion/action-moodle-playground-pr-preview) inputs and outputs. For a task-focused walkthrough, see [PR previews](pr-previews.md).

The action needs `contents: read` and `pull-requests: write` permissions. All inputs are optional; `github-token` defaults to the workflow `GITHUB_TOKEN`.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `mode` | Where to publish the preview: `append-to-description` or `comment`. | `append-to-description` |
| `playground-host` | Base URL of the playground deployment to link to. | `https://moodle-playground.com` |
| `blueprint` | Inline blueprint JSON string. When set, `plugin-path` is ignored. | — |
| `blueprint-file` | Path to a blueprint JSON file in the repo (requires `actions/checkout`). The action rewrites `installMoodlePlugin`/`installTheme` archive URLs matching this repo to the PR branch. | — |
| `blueprint-url` | Remote blueprint URL; the link uses `?blueprint-url=`. | — |
| `proxy-url` | github-proxy base URL that serves one repo file with CORS. Use for large blueprints to avoid HTTP 414. | — |
| `plugin-path` | Plugin directory (e.g. `.` or `plugins/mod_myplugin`). Generates an `installMoodlePlugin` step. | — |
| `moodle-version` | Moodle branch/version for the preview. | `5.0` |
| `preview-type` | `auto`, `plugin`, or `core`. | `auto` |
| `base-version` | Override the base Moodle version for core overlays. | — |
| `run-upgrade` | Run the Moodle upgrade after a core overlay: `off`, `on`, or `auto`. | `auto` |
| `core-root` | Root path for core overlays. | `/www/moodle` |
| `max-core-files` | Maximum number of changed core files to overlay. | `80` |
| `max-core-file-bytes` | Maximum size per overlaid core file, in bytes. | `262144` |
| `allow-core-binary-files` | Include binary files in core overlays. | `false` |
| `core-pr-mode` | Core PR overlay mode. | `files` |
| `description-template` | Custom PR-description template with `{{VAR}}` interpolation. | — |
| `comment-template` | Custom comment template with `{{VAR}}` interpolation. | — |
| `extra-text` | Extra text appended to the rendered output. | — |
| `restore-button-if-removed` | Re-add the preview button if a reviewer removed it. | `true` |
| `github-token` | Token used to post the preview. | `${{ secrets.GITHUB_TOKEN }}` |
| `pr-number` | PR number to target (when not inferred from the event). | — |

## Outputs

| Name | Description |
|------|-------------|
| `preview-url` | The "Open in Moodle Playground" URL. |
| `blueprint-json` | The blueprint JSON used for the preview. |
| `rendered-description` | The rendered PR description (when `mode` is `append-to-description`). |
| `rendered-comment` | The rendered comment body (when `mode` is `comment`). |
| `mode` | The publish mode that was used. |
| `comment-id` | ID of the created/updated comment (when `mode` is `comment`). |

!!! tip
    See the [action README](https://github.com/ateeducacion/action-moodle-playground-pr-preview) for full details and the latest input list.
