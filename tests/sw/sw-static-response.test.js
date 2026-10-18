import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { settleStaticFetch } from "../../src/shared/sw-static-response.js";

function gatedStream() {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(new Uint8Array([7]));
      await gate;
      controller.enqueue(new Uint8Array([8]));
      controller.close();
    },
  });
  return { stream, release };
}

describe("settleStaticFetch", () => {
  it("returns the original response before the cache write finishes", async () => {
    const { stream, release } = gatedStream();
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    let cacheFinished = false;
    const cache = {
      async put(_key, cached) {
        await cached.arrayBuffer();
        cacheFinished = true;
      },
    };
    const extended = [];

    const delivered = settleStaticFetch(
      response,
      cache,
      "https://example.test/part",
      (promise) => {
        extended.push(promise);
      },
    );

    assert.equal(delivered, response);
    const reader = delivered.body.getReader();
    const first = await reader.read();
    assert.deepEqual([...first.value], [7]);
    assert.equal(cacheFinished, false);
    assert.equal(extended.length, 1);

    release();
    const second = await reader.read();
    assert.deepEqual([...second.value], [8]);
    await extended[0];
    assert.equal(cacheFinished, true);
  });

  it("does not cache a failed response", async () => {
    let puts = 0;
    const response = new Response("nope", { status: 404 });
    const delivered = settleStaticFetch(
      response,
      {
        async put() {
          puts += 1;
        },
      },
      "https://example.test/missing",
    );

    assert.equal(delivered, response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(puts, 0);
  });

  it("still returns the response when Cache Storage rejects the write", async () => {
    const response = new Response(new Uint8Array([1]), { status: 200 });
    const delivered = settleStaticFetch(
      response,
      {
        async put() {
          throw new Error("quota");
        },
      },
      "https://example.test/part",
    );

    assert.equal(delivered, response);
    assert.deepEqual([...new Uint8Array(await delivered.arrayBuffer())], [1]);
  });
});
