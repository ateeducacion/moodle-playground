import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadPlaygroundConfig } from "../../src/shared/config.js";

const originalFetch = globalThis.fetch;

describe("loadPlaygroundConfig", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries after a failed load instead of caching the rejection", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("", { status: 503 });
      }
      return Response.json({ runtimes: [] });
    };

    await assert.rejects(loadPlaygroundConfig(), /503/u);
    assert.deepStrictEqual(await loadPlaygroundConfig(), { runtimes: [] });
    assert.deepStrictEqual(await loadPlaygroundConfig(), { runtimes: [] });
    assert.strictEqual(calls, 2);
  });
});
