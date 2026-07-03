# Tasks: Editable Blueprint Panel

## 1. Pure helpers (TDD)
- [x] 1.1 Write failing tests for `src/shell/blueprint-editor-core.js` in `tests/shell/blueprint-editor-core.test.js`
- [x] 1.2 Implement `escapeHtml`, `highlightJson`, `formatBlueprintText`, `getInitialBlueprintCode`
- [x] 1.3 Implement `createBlueprintValidationResult` (JSON stage + schema stage + valid stage)
- [x] 1.4 Implement `encodeBlueprintFallback` and `buildBlueprintRunUrl`
- [x] 1.5 Verify all tests pass (`npm test`)

## 2. Editor wiring
- [x] 2.1 Implement `src/shell/blueprint-editor.js`: CodeJar dynamic import + fallback textarea, live validation, Run button wiring, `setCode`/`getCode`/`getValidationResult`/`setLocked` API
- [x] 2.2 Update `index.html`: CodeJar mount element, Run button, status area, accessible labels
- [x] 2.3 Add `src/styles/blueprint-editor.css`: dark editor surface, token colors, status states
- [x] 2.4 Wire `src/shell/main.js`: initialize the editor once, delegate `updateBlueprintTextarea`/`exportBlueprint` to it, lock/unlock Run with the rest of the UI

## 3. Verification
- [x] 3.1 `npm test`
- [x] 3.2 `make lint`
- [x] 3.3 Manual verification in a real browser (`make serve`) — CodeJar rendering/highlighting, live JSON/schema validation, Run round-trip (real gzip encoding + reboot), Export using live content, and the plain-textarea fallback all confirmed working
- [x] 3.4 Update `tests/e2e/shell.spec.mjs` blueprint-tab assertions for the new editor
