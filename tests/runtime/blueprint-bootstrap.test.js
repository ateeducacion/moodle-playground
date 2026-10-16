import assert from "node:assert/strict";
import { it } from "node:test";
import {
  flushBlueprintPersistence,
  loadInstallSnapshot,
  resetRecoveredMoodleCaches,
} from "../../src/runtime/bootstrap.js";

it("writes the empty blueprint checkpoint before returning a restored snapshot", async () => {
  const calls = [];
  const snapshot = await loadInstallSnapshot(
    {
      writeFile: async () => calls.push("db"),
      run: async (code) => {
        calls.push(code.includes("SELECT value") ? "read" : "checkpoint");
        return {
          text: code.includes("SELECT value") ? "null" : "checkpoint-saved",
        };
      },
    },
    {
      dbFile: "/persist/fixture",
      appBaseUrl: "https://example.test/",
      publish() {},
      blueprint: { steps: [{ step: "installMoodle" }] },
      prefetched: Promise.resolve(new Uint8Array(100)),
    },
  );
  assert.deepEqual(calls, ["db", "read", "checkpoint"]);
  assert.equal(snapshot.checkpoint.resuming, false);
});

it("clears recovered DB caches before another PHP request without changing asset revisions", async () => {
  let script;
  await resetRecoveredMoodleCaches({
    run: async (code) => {
      script = code;
      return { text: "recovery-caches-cleared" };
    },
  });
  assert.match(script, /require\('\/www\/moodle\/config.php'\)/);
  assert.match(script, /cache_helper::purge_all\(\)/);
  assert.doesNotMatch(
    script,
    /purge_all_caches|js_reset_all_caches|theme_reset_all_caches/,
  );
  await assert.rejects(
    resetRecoveredMoodleCaches({ run: async () => ({ text: "failed" }) }),
    /could not be cleared/,
  );
});

it("keeps the session usable and warns on flush failure, rejection or unavailable persistence", async () => {
  for (const flushPersistence of [
    async () => ({ ok: false, reason: "quota" }),
    async () => {
      throw new Error("quota");
    },
    async () => ({ ok: true, enabled: false }),
  ]) {
    const messages = [];
    await flushBlueprintPersistence({ flushPersistence }, (message) =>
      messages.push(message),
    );
    assert.ok(
      messages.some((message) => /reload may not keep it/.test(message)),
    );
  }
});

it("reports successful persistence cost without changing the flush result", async () => {
  const messages = [];
  const result = {
    enabled: true,
    ok: true,
    hydratedBytes: 8192,
    flushedOps: 2,
  };
  assert.equal(
    await flushBlueprintPersistence(
      { flushPersistence: async () => result },
      (message) => messages.push(message),
    ),
    result,
  );
  assert.ok(messages.some((message) => /8192 bytes.*2 ops/.test(message)));
});
