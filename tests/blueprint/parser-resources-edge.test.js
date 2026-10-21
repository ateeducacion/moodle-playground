import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compressBlueprint,
  encodeBlueprintParam,
  parseBlueprint,
  parseBlueprintParam,
} from "../../src/blueprint/parser.js";
import { ResourceRegistry } from "../../src/blueprint/resources.js";

// Temporarily remove a global (e.g. atob) to exercise the Node fallbacks.
async function without(name, fn) {
  const saved = globalThis[name];
  delete globalThis[name];
  try {
    return await fn();
  } finally {
    globalThis[name] = saved;
  }
}

const bp = { steps: [{ step: "login", username: "admin" }] };

describe("parseBlueprint invalid inputs", () => {
  it("names the failing format", () => {
    const notJson = Buffer.from("this is not json at all").toString("base64");
    assert.throws(() => parseBlueprint(notJson), /Invalid base64 blueprint/);
    assert.throws(
      () => parseBlueprint("hello"),
      /Unrecognized blueprint format/,
    );
    assert.throws(
      () => parseBlueprint("data:no-comma"),
      /Malformed data: URL\./,
    );
    assert.throws(
      () => parseBlueprint("data:application/json,%7Bbad"),
      /Invalid JSON in data: URL/,
    );
  });

  it("decodes plain (non-base64) data: URLs and base64 without atob", async () => {
    assert.deepEqual(
      parseBlueprint(
        `data:application/json,${encodeURIComponent(JSON.stringify(bp))}`,
      ),
      bp,
    );
    const b64 = Buffer.from(JSON.stringify(bp)).toString("base64");
    assert.deepEqual(await without("atob", () => parseBlueprint(b64)), bp);
  });
});

describe("blueprint param encoding", () => {
  it("round-trips through gzip+base64url, also without btoa", async () => {
    const encoded = await without("btoa", () => compressBlueprint(bp));
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(await parseBlueprintParam(encoded), bp);
  });

  it("falls back to plain base64url when CompressionStream is unavailable", async () => {
    await without("CompressionStream", async () => {
      await assert.rejects(
        compressBlueprint(bp),
        /CompressionStream is not available/,
      );
      const encoded = await encodeBlueprintParam(bp);
      assert.deepEqual(parseBlueprint(encoded), bp);
    });
  });

  it("refuses a gzipped value without DecompressionStream", async () => {
    const encoded = await compressBlueprint(bp);
    await without("DecompressionStream", () =>
      assert.rejects(
        parseBlueprintParam(encoded),
        /DecompressionStream is required/,
      ),
    );
  });

  it("delegates undecodable base64 to the sync parser error", async () => {
    await assert.rejects(
      parseBlueprintParam("abcd=efghijklmnopqrstuvwxyz"),
      /Invalid base64 blueprint/,
    );
  });
});

describe("ResourceRegistry edge cases", () => {
  it("caches URL resources and resolves bundled ones against the app base", async () => {
    let fetches = 0;
    const registry = new ResourceRegistry(
      { a: { url: "a.bin" } },
      {
        appBaseUrl: "https://app.test/base/",
        fetchImpl: async (url) => {
          fetches += 1;
          assert.equal(url, "https://app.test/base/a.bin");
          return new Response(new Uint8Array([1]));
        },
      },
    );
    await registry.resolve("@a");
    await registry.resolve("@a");
    assert.equal(fetches, 1);

    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(url);
      return url.endsWith("missing")
        ? new Response("", { status: 404 })
        : new Response("bundled");
    };
    try {
      assert.equal(
        await registry.resolveText({ bundled: "assets/x" }),
        "bundled",
      );
      await assert.rejects(
        registry.resolve({ bundled: "missing" }),
        /Failed to fetch bundled resource from https:\/\/app\.test\/base\/missing: 404/,
      );
      const bare = new ResourceRegistry();
      assert.equal(await bare.resolveText({ bundled: "rel/y" }), "bundled");
      assert.deepEqual(seen, [
        "https://app.test/base/assets/x",
        "https://app.test/base/missing",
        "rel/y",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("retries transient failures with backoff and stops at permanent ones", async () => {
    let calls = 0;
    const registry = new ResourceRegistry(
      {},
      {
        retryDelayMs: 1,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return new Response("", { status: 429 });
          return {
            ok: true,
            arrayBuffer: async () => ({ byteLength: 51 * 1024 * 1024 }),
          };
        },
      },
    );
    await assert.rejects(
      registry.resolve({ url: "https://x/big" }),
      /exceeds 50MB/,
    );
    assert.equal(calls, 2, "the size cap is not retried");
  });

  it("reports missing fetch, missing PHP, unsupported and malformed descriptors", async () => {
    await without("fetch", async () => {
      const registry = new ResourceRegistry();
      await assert.rejects(
        registry.resolve({ url: "https://x" }),
        /No fetch implementation/,
      );
    });
    const registry = new ResourceRegistry();
    await assert.rejects(
      registry.resolve({ vfs: "/a" }),
      /without a PHP runtime/,
    );
    await assert.rejects(
      registry.resolve({ other: 1 }),
      /Unsupported resource descriptor/,
    );
    await assert.rejects(
      registry.resolve({ "data-url": "nope" }),
      /Malformed data: URL/,
    );
    await assert.rejects(
      registry.resolve(42),
      /Invalid resource reference: 42/,
    );
  });

  it("decodes literals, data URLs and base64 without atob", async () => {
    const registry = new ResourceRegistry();
    assert.equal(await registry.resolveText({ literal: { a: 1 } }), '{"a":1}');
    const bytes = new Uint8Array([5]);
    assert.equal(await registry.resolve({ literal: bytes }), bytes);
    assert.equal(
      await registry.resolveText({ "data-url": "data:text/plain,a%20b" }),
      "a b",
    );
    assert.equal(
      await without("atob", () => registry.resolveText({ base64: "aGk=" })),
      "hi",
    );
  });
});
