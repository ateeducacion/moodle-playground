# Blueprint Panel Specification

## ADDED Requirements

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
