---
name: unit-testing
description: Write or review browser-playground Node unit tests for normalization, request adapters, journaling, and generated PHP scripts.
metadata:
  author: playgrounds
  version: "2.0"
---

# Browser-playground unit tests

Use the unit-test section of the host repository's
[testing reference](../../references/playground-testing.md) for test paths, commands,
and app-specific contracts. This reference is outside the installed skill. If it
is absent, read `package.json` and the nearest tests; do not copy another host's
filename extensions or helper names.

The playgrounds use `node:test` and `node:assert/strict`, importing source directly.
Reuse existing setup and boundary mocks. Do not duplicate production logic in a
test or add another framework for the same work.

## Useful checks

- Normalization: the host's real blueprint shapes, defaults, aliases, and invalid
  inputs. Shared step names do not mean identical contracts between applications.
- PHP generation: escaping and argv/env encoding, application bootstrap/CLI setup,
  and explicit error handling. Assert a meaningful generated-code invariant;
  matching a string alone does not establish successful PHP execution.
- Adapters: method/body/header/status preservation and front-controller paths.
- Journaling: normalization before hydration, renamed paths, checkpoint failures,
  correct namespace isolation, and replay behavior.
- Routing: root/subpath handling, scope isolation, and HTML entity decoding.

Exercise the real function with minimal fakes for the boundary under test. Do not
only exercise a browser helper's early-return Node branch when its browser behavior
is the subject. Prefer behavior assertions over a fixed snapshot of implementation.

Actual application rendering, SW interception, and WASM boot need browser checks;
a Node/NODEFS PHP harness does not establish browser memory behavior. Run affected
unit tests, broadening for shared behavior changes. Source tests do not rebuild the
worker and cannot detect a stale browser bundle.
