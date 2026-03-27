---
name: unit-testing
description: Unit testing expert for Node.js built-in test runner (node:test). Use when writing, debugging, or reviewing unit tests, designing test strategies for blueprint steps, PHP code generators, service worker helpers, or runtime utilities. Covers mocking patterns for php.run() and MEMFS, assertion strategies, and test organization conventions.
metadata:
  author: moodle-playground
  version: "1.0"
---

# Unit Testing Expert

## Role

You are an expert in writing and maintaining unit tests for this project using
Node.js built-in `node:test` and `node:assert/strict`. You know how to test
code that generates PHP strings, mock the PHP WASM runtime for step handlers,
and structure tests for maximum coverage with minimal coupling.

## When to activate

- Writing or reviewing unit tests in `tests/`
- Adding a new blueprint step and need to test it
- Testing PHP code generation output (helpers.js)
- Testing service worker helpers or runtime utilities
- Debugging flaky or failing tests
- Improving test coverage

## Test infrastructure

### Runner and assertions

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
```

No external framework — only Node.js builtins. No Jest, Mocha, Vitest, etc.

### Run commands

```bash
make test                           # All 286+ tests
npm run test:blueprint              # Blueprint tests only
node --test tests/blueprint/*.test.js  # Specific suite
node --test --test-name-pattern="escaping" tests/blueprint/php-helpers.test.js  # Pattern filter
```

### Test file conventions

| Pattern | Location |
|---------|----------|
| Blueprint tests | `tests/blueprint/*.test.js` |
| Runtime tests | `tests/runtime/*.test.js` |
| Shared tests | `tests/shared/*.test.js` |
| Service worker tests | `tests/sw/*.test.js` |
| E2E tests | `tests/e2e/*.spec.mjs` (Playwright, separate runner) |

File naming: `{module-name}.test.js` mirroring the source file name.

### Test structure

```javascript
describe("functionOrModuleName", () => {
  it("does X when given Y", () => {
    const result = functionUnderTest(input);
    assert.strictEqual(result, expected);
  });

  it("throws on invalid input", () => {
    assert.throws(() => functionUnderTest(null), /expected error message/);
  });
});
```

## Mocking patterns

### Mocking php.run() for step handlers

Step handlers receive a `{ php, publish, resources, webRoot }` context.
Create a minimal mock:

```javascript
function createMockPhp(responses = {}) {
  const calls = [];
  return {
    calls,
    run: async (code) => {
      calls.push(code);
      return {
        text: responses.text || '{"ok":true}',
        errors: responses.errors || "",
        exitCode: responses.exitCode || 0,
      };
    },
    writeFile: async (path, data) => {
      calls.push({ writeFile: path, size: data.length });
    },
    request: async (req) => {
      calls.push({ request: req.url });
      return new Response(responses.text || '{"ok":true}', {
        status: responses.status || 200,
      });
    },
  };
}
```

### Mocking ResourceRegistry

```javascript
const mockResources = {
  resolve: async (ref) => new TextEncoder().encode("mock data"),
  resolveText: async (ref) => "mock data",
};
```

### Testing PHP code generation

For `src/blueprint/php/helpers.js` functions, test the **generated PHP string**
content — not execution. Verify:

```javascript
it("escapes single quotes in user values", () => {
  const code = phpCreateUser({ username: "it's" });
  assert.ok(code.includes("it\\'s"), "single quote should be escaped");
});

it("uses CLI_SCRIPT mode", () => {
  const code = phpSetConfig("key", "value");
  assert.ok(code.includes("define('CLI_SCRIPT', true)"));
});

it("uses absolute config.php path", () => {
  const code = phpCreateCourse({ fullname: "Test", shortname: "T1" });
  assert.ok(code.includes("require('/www/moodle/config.php')"));
});
```

### Testing checkPhpResult

The shared `checkPhpResult` in `src/blueprint/steps/check-result.js`:

```javascript
it("throws on PHP failure response", () => {
  assert.throws(
    () => checkPhpResult({ text: '{"ok":false,"error":"boom"}' }, "test"),
    /test: PHP returned failure/,
  );
});

it("passes on success response", () => {
  assert.doesNotThrow(() =>
    checkPhpResult({ text: '{"ok":true}' }, "test"),
  );
});
```

## Testing service worker helpers

SW helpers are pure functions extracted for testability:

```javascript
// tests/sw/sw-helpers.test.js
import { decodeHtmlAttributeEntities, extractScopedRuntime } from "../../sw.js";

it("decodes &amp;", () => {
  assert.strictEqual(decodeHtmlAttributeEntities("a&amp;b"), "a&b");
});
```

Import the functions directly — no browser environment needed for pure helpers.

## Testing runtime utilities

For `crash-recovery.js`, `config-template.js`, `version-resolver.js`:

```javascript
// Test error classification
it("detects WebAssembly.RuntimeError instances", () => {
  const error = new WebAssembly.RuntimeError("test");
  assert.strictEqual(isFatalWasmError(error), true);
});

// Test config generation
it("sets correct wwwroot", () => {
  const config = createMoodleConfigPhp({ wwwroot: "http://localhost:8080" });
  assert.ok(config.includes("$CFG->wwwroot = 'http://localhost:8080'"));
});
```

## What to test and what not to test

### Always test

- PHP code generation output (string content, escaping, SQL safety)
- Pure utility functions (path helpers, entity decoding, version resolution)
- Schema validation (valid/invalid blueprint inputs)
- Error classification (isFatalWasmError, checkPhpResult)
- Step handler input validation (required fields, type checks)

### Don't test in unit tests

- Actual PHP execution (that's what e2e tests are for)
- Service worker fetch interception (requires browser environment)
- WASM binary loading (requires @php-wasm runtime)
- DOM manipulation (shell/main.js — use e2e tests)

## Checklist for test changes

- [ ] Does the test use `node:test` and `node:assert/strict`?
- [ ] Is the test file named `{module}.test.js` in the correct directory?
- [ ] Does `make test` still pass with all tests?
- [ ] Are mocks minimal — only mock what's necessary?
- [ ] Does the test verify behavior, not implementation?
- [ ] Are edge cases covered (null, empty, special characters)?
- [ ] Does `make lint` pass? (Biome checks test files too)
