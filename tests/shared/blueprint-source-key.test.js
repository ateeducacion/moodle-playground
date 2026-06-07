import assert from "node:assert/strict";
import { test } from "node:test";

import { blueprintSourceKey } from "../../src/shared/paths.js";

// The shell resets the persisted /persist when the blueprint *source* changes, so
// loading a different blueprint in a tab installs fresh instead of replaying the
// previous env. blueprintSourceKey is the stable per-source identity it compares.
test("blueprintSourceKey: different blueprint => different key, same => same, bare => default", () => {
  const a = "https://x/?blueprint-url=https://h/a.json";
  const b = "https://x/?blueprint-url=https://h/b.json";

  // A different blueprint-url => different key (triggers a clean boot).
  assert.notEqual(blueprintSourceKey(a), blueprintSourceKey(b));
  // The same blueprint-url => same key (keeps the persisted env).
  assert.equal(blueprintSourceKey(a), blueprintSourceKey(a));
  // No blueprint param => the default env.
  assert.equal(blueprintSourceKey("https://x/"), "default");

  // Inline blueprints are distinguished by content too.
  const i1 = "https://x/?blueprint-data=AAAA";
  const i2 = "https://x/?blueprint-data=BBBB";
  assert.notEqual(blueprintSourceKey(i1), blueprintSourceKey(i2));
  assert.notEqual(blueprintSourceKey(i1), blueprintSourceKey(a));
});
