---
id: SDD-0001
title: "Editable blueprint panel"
status: Implemented
date: 2026-07-03
authors:
  - "@erseco"
reviewers: []
related:
  issues: []
  prs:
    - "https://github.com/ateeducacion/moodle-playground/pull/173"
  adrs: []
  sdds: []
supersedes: []
superseded_by: []
# ai_assistance refers to the migration/consolidation of this document; the
# original openspec change predates the disclosure convention.
ai_assistance:
  tool: "Claude Code"
  model: "claude-fable-5"
---

<!--
Provenance: this SDD was migrated from the former OpenSpec-style
`openspec/changes/editable-blueprint-panel/` tree (proposal.md, tasks.md,
specs/blueprint-panel/spec.md) when the ADR + SDD workflow was adopted.
The content consolidates those three documents; the design shipped in PR #173.
-->

# SDD-0001: Editable blueprint panel

## Status

Implemented (PR [#173](https://github.com/ateeducacion/moodle-playground/pull/173),
merged 2026-07-03).

## Summary

Replace the read-only blueprint JSON `<textarea>` in the shell's Blueprint
sidebar tab with an editable, syntax-highlighted editor, add inline
JSON/schema validation, and add a `Run` button that reboots the playground
with the edited blueprint through the existing `?blueprint=` URL flow.

## Problem statement

The Blueprint sidebar tab rendered the active blueprint as read-only JSON in a
plain `<textarea>`. Users could not iterate on a blueprint without leaving the
playground, editing a file externally, and re-importing it. There was also no
way to re-run the *currently displayed* blueprint from the panel itself — only
Import (from a file) and Export (to a file) existed.

## Goals

- Edit the active blueprint JSON directly in the sidebar, with syntax
  highlighting.
- Validate on every edit (JSON stage + blueprint schema stage) and report
  errors inline without touching the page.
- Re-run the edited blueprint from the panel via the existing `?blueprint=`
  URL contract.
- Keep Export/Import working against the *live editor content*, not a stale
  in-memory copy.

## Non-goals

- No changes to blueprint execution semantics, the runtime/bootstrap flow, or
  the blueprint parser/validator/compressor — the shell only re-encodes JSON
  into the existing URL parameter contract (the same contract Import already
  used).

## Proposed design

- Build the editor on [CodeJar](https://medv.io/codejar/), with a
  plain-textarea fallback if CodeJar cannot be loaded.
- Add inline JSON/schema validation that runs on every edit.
- Add a `Run` button next to Export/Import that re-encodes the edited JSON
  into the existing `?blueprint=` URL flow and reloads the playground,
  exactly like Import already does for a picked file.
- Split the logic so it is unit-testable independent of the DOM:
  - `src/shell/blueprint-editor-core.js` — pure helpers: HTML escaping, JSON
    highlighting, formatting, validation-result mapping, run-URL building,
    fallback encoding.
  - `src/shell/blueprint-editor.js` — CodeJar wiring / DOM glue.

## Technical design

Affected code: `index.html`, `src/styles/app.css` (+ new
`src/styles/blueprint-editor.css`), `src/shell/main.js`, new
`src/shell/blueprint-editor-core.js` and `src/shell/blueprint-editor.js`.

`tests/e2e/shell.spec.mjs`'s blueprint-tab assertions were updated to reflect
that `#blueprint-textarea` becomes a hidden compatibility bridge once the
CodeJar editor is active.

## Specification

### Requirement: Editable blueprint editor

The Blueprint sidebar tab SHALL display the active blueprint JSON in an
editable, syntax-highlighted code editor built on CodeJar, instead of a
read-only textarea.

#### Scenario: Opening the Blueprint tab

- **WHEN** the user opens the Blueprint tab
- **THEN** the panel shows the active blueprint JSON with visible syntax
  highlighting (keys, strings, numbers, booleans, null in distinct colors)
- **AND** the JSON text is editable via keyboard

#### Scenario: CodeJar fails to load

- **WHEN** the CodeJar module cannot be loaded (e.g. offline, CDN blocked)
- **THEN** the panel falls back to a plain editable textarea
- **AND** validation and the Run button continue to work

### Requirement: Inline validation

The Blueprint panel SHALL validate the editor's JSON content on every edit,
without reloading or navigating the page.

#### Scenario: Malformed JSON

- **WHEN** the editor content is not valid JSON
- **THEN** an inline status message describes the JSON error
- **AND** the Run button is disabled
- **AND** the page is not reloaded

#### Scenario: JSON valid but blueprint schema invalid

- **WHEN** the editor content parses as JSON but fails `validateBlueprint`
- **THEN** an inline status message lists the schema error(s)
- **AND** the Run button is disabled
- **AND** the page is not reloaded

#### Scenario: Valid blueprint

- **WHEN** the editor content is valid JSON and passes `validateBlueprint`
- **THEN** the inline status message confirms the blueprint is valid
- **AND** the Run button is enabled

### Requirement: Run action

The Blueprint panel SHALL provide a `Run` button, next to Export and Import,
that restarts the playground using the edited blueprint via the existing
`?blueprint=` URL flow.

#### Scenario: Running a valid edited blueprint

- **WHEN** the user clicks Run while the editor content is valid
- **THEN** the shell parses the JSON, normalizes it with `parseBlueprint`,
  and validates it with `validateBlueprint`
- **AND** the shell encodes the normalized blueprint with
  `compressBlueprint`, falling back to plain base64url JSON if compression
  is unavailable
- **AND** the shell sets `blueprint=<encoded>` on the current URL and
  deletes any `blueprint-url` parameter
- **AND** the browser navigates to that URL, causing the playground to
  reboot with the edited blueprint

#### Scenario: Running an invalid edited blueprint

- **WHEN** the user attempts to run while the editor content is invalid
- **THEN** the Run button is disabled and no navigation occurs

### Requirement: Export uses live editor content

Export SHALL serialize the current editor content (not a stale in-memory
copy captured at boot).

#### Scenario: Exporting after an edit

- **WHEN** the user edits the blueprint JSON and clicks Export
- **THEN** the downloaded file reflects the edited JSON, pretty-printed
- **AND** if the edited JSON is invalid, Export is blocked with an inline
  error instead of downloading a broken file

### Requirement: Import updates the editor

Import SHALL keep updating the editor content, including after the
full-page reload it triggers.

#### Scenario: Importing a blueprint file

- **WHEN** the user imports a blueprint JSON file
- **THEN** the playground reloads with the imported blueprint encoded in the
  `blueprint` URL parameter
- **AND** after reload, the editor displays the imported blueprint

### Requirement: Compatibility bridge

The panel SHALL keep a `#blueprint-textarea` element synchronized with the
editor content at all times, so existing code and tests that read the active
blueprint value keep working even when it is not visible.

#### Scenario: CodeJar active

- **WHEN** CodeJar has loaded successfully
- **THEN** `#blueprint-textarea` is hidden but its `value` always matches
  the CodeJar editor content

### Requirement: Accessibility

The editor SHALL be usable with assistive technology and the keyboard.

#### Scenario: Screen reader and keyboard access

- **WHEN** a screen reader or keyboard-only user reaches the Blueprint panel
- **THEN** the editor exposes `role="textbox"`, `aria-multiline="true"`, and
  a meaningful accessible name
- **AND** the status message is exposed via `role="status"` (or equivalent
  live region)
- **AND** the editor can be focused and edited with the keyboard alone

## ADRs required or referenced

| Decision | ADR | Status |
|---|---|---|
| No durable architecture decision — reuses the existing `?blueprint=` URL contract | — | — |

## Implementation checklist

### 1. Pure helpers (TDD)

- [x] 1.1 Write failing tests for `src/shell/blueprint-editor-core.js` in `tests/shell/blueprint-editor-core.test.js`
- [x] 1.2 Implement `escapeHtml`, `highlightJson`, `formatBlueprintText`, `getInitialBlueprintCode`
- [x] 1.3 Implement `createBlueprintValidationResult` (JSON stage + schema stage + valid stage)
- [x] 1.4 Implement `encodeBlueprintFallback` and `buildBlueprintRunUrl`
- [x] 1.5 Verify all tests pass (`npm test`)

### 2. Editor wiring

- [x] 2.1 Implement `src/shell/blueprint-editor.js`: CodeJar dynamic import + fallback textarea, live validation, Run button wiring, `setCode`/`getCode`/`getValidationResult`/`setLocked` API
- [x] 2.2 Update `index.html`: CodeJar mount element, Run button, status area, accessible labels
- [x] 2.3 Add `src/styles/blueprint-editor.css`: dark editor surface, token colors, status states
- [x] 2.4 Wire `src/shell/main.js`: initialize the editor once, delegate `updateBlueprintTextarea`/`exportBlueprint` to it, lock/unlock Run with the rest of the UI

### 3. Verification

- [x] 3.1 `npm test`
- [x] 3.2 `make lint`
- [x] 3.3 Manual verification in a real browser (`make serve`) — CodeJar rendering/highlighting, live JSON/schema validation, Run round-trip (real gzip encoding + reboot), Export using live content, and the plain-textarea fallback all confirmed working
- [x] 3.4 Update `tests/e2e/shell.spec.mjs` blueprint-tab assertions for the new editor

## References

- PR [#173](https://github.com/ateeducacion/moodle-playground/pull/173) — implementation
- [CodeJar](https://medv.io/codejar/) — embeddable code editor
- [Blueprints overview](../../blueprints/index.md)
