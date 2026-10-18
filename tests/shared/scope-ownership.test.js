import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acquireScopeOwnership } from "../../src/shared/scope-ownership.js";

describe("scope ownership", () => {
  it("holds the exclusive lock until the owner releases it", async () => {
    let held;
    const release = await acquireScopeOwnership("tab", {
      request(name, options, callback) {
        assert.equal(name, "moodle-playground-owner:tab");
        assert.deepEqual(options, { ifAvailable: true });
        held = callback({ name });
        return held;
      },
    });
    let finished = false;
    held.then(() => {
      finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    await held;
    assert.equal(finished, true);
  });

  it("rejects a second owner instead of queueing or stealing ownership", async () => {
    await assert.rejects(
      acquireScopeOwnership("tab", {
        request: (_name, _options, callback) => callback(null),
      }),
      /already open/,
    );
  });

  it("fails closed when locks are unavailable or denied", async () => {
    await assert.rejects(acquireScopeOwnership("tab", null), /Web Locks/);
    await assert.rejects(
      acquireScopeOwnership("tab", {
        request: async () => {
          throw new Error("Storage access denied");
        },
      }),
      /Storage access denied/,
    );
  });
});
