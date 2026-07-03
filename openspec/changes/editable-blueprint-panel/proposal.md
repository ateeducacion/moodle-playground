# Editable Blueprint Panel

## Why

The Blueprint sidebar tab currently renders the active blueprint as read-only
JSON in a plain `<textarea>`. Users cannot iterate on a blueprint without
leaving the playground, editing a file externally, and re-importing it. There
is also no way to re-run the *currently displayed* blueprint from the panel
itself — only Import (from a file) and Export (to a file) exist.

## What Changes

- Replace the read-only textarea with an editable, syntax-highlighted JSON
  editor built on [CodeJar](https://medv.io/codejar/), with a plain-textarea
  fallback if CodeJar cannot be loaded.
- Add inline JSON/schema validation that runs on every edit and reports
  errors without touching the page.
- Add a `Run` button next to Export/Import that re-encodes the edited JSON
  into the existing `?blueprint=` URL flow and reloads the playground,
  exactly like Import already does for a picked file.
- Keep Export/Import working against the *live editor content*, not a stale
  in-memory copy.
- Add `src/shell/blueprint-editor-core.js` (pure helpers: HTML escaping, JSON
  highlighting, formatting, validation-result mapping, run-URL building,
  fallback encoding) and `src/shell/blueprint-editor.js` (CodeJar wiring /
  DOM glue) so the logic is unit-testable independent of the DOM.

## Impact

- Affected specs: `blueprint-panel` (new capability spec).
- Affected code: `index.html`, `src/styles/app.css` (+ new
  `src/styles/blueprint-editor.css`), `src/shell/main.js`, new
  `src/shell/blueprint-editor-core.js` and `src/shell/blueprint-editor.js`.
- No changes to blueprint execution semantics, the runtime/bootstrap flow, or
  the blueprint parser/validator/compressor — the shell only re-encodes JSON
  into the existing URL parameter contract (the same contract Import already
  uses).
- `tests/e2e/shell.spec.mjs`'s blueprint-tab assertions are updated to
  reflect that `#blueprint-textarea` becomes a hidden compatibility bridge
  once the CodeJar editor is active.
