import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import worker from "../../scripts/github-proxy-worker.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("github-proxy-worker generic ?url= mode", () => {
  it("proxies direct GitHub Atom feed URLs", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response("<feed />", {
        status: 200,
        headers: { "Content-Type": "application/atom+xml; charset=utf-8" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://github.com/exelearning/exelearning/releases.atom",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://github.com/exelearning/exelearning/releases.atom",
    );
    assert.equal(
      upstreamRequest.init.headers["User-Agent"],
      "github-proxy-worker",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.match(
      response.headers.get("Content-Type"),
      /application\/atom\+xml/i,
    );
    assert.equal(await response.text(), "<feed />");
  });

  it("routes direct GitHub release asset URLs through the GitHub API asset resolver", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url, init });
      if (
        String(url) ===
        "https://api.github.com/repos/exelearning/exelearning/releases/tags/v4.0.0"
      ) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: "exelearning-static-v4.0.0.zip",
                browser_download_url:
                  "https://release-assets.githubusercontent.com/exelearning-static-v4.0.0.zip",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (
        String(url) ===
        "https://release-assets.githubusercontent.com/exelearning-static-v4.0.0.zip"
      ) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 206,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      throw new Error(`unexpected url ${url}`);
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://github.com/exelearning/exelearning/releases/download/v4.0.0/exelearning-static-v4.0.0.zip",
        { headers: { Range: "bytes=0-3" } },
      ),
      {},
    );

    assert.equal(response.status, 206);
    assert.equal(
      calls[0].url,
      "https://api.github.com/repos/exelearning/exelearning/releases/tags/v4.0.0",
    );
    assert.equal(
      calls[1].url,
      "https://release-assets.githubusercontent.com/exelearning-static-v4.0.0.zip",
    );
    assert.equal(calls[1].init.headers.get("Range"), "bytes=0-3");
    assert.equal(calls[1].init.headers.get("Cache-Control"), "no-cache");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="exelearning-static-v4.0.0.zip"',
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("includes upstream status details when the final asset fetch fails", async () => {
    global.fetch = async (url) => {
      if (
        String(url) ===
        "https://api.github.com/repos/exelearning/exelearning/releases/tags/v4.0.0"
      ) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: "exelearning-static-v4.0.0.zip",
                browser_download_url:
                  "https://release-assets.githubusercontent.com/exelearning-static-v4.0.0.zip",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (
        String(url) ===
        "https://release-assets.githubusercontent.com/exelearning-static-v4.0.0.zip"
      ) {
        return new Response("upstream bad gateway", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/plain" },
        });
      }

      throw new Error(`unexpected url ${url}`);
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://github.com/exelearning/exelearning/releases/download/v4.0.0/exelearning-static-v4.0.0.zip",
      ),
      {},
    );

    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, "Upstream server returned an error.");
    assert.equal(body.status, 502);
    assert.equal(body.statusText, "Bad Gateway");
    assert.equal(
      body.upstream_url,
      "https://release-assets.githubusercontent.com/exelearning-static-v4.0.0.zip",
    );
  });

  it("forwards Range headers for generic raw GitHub resource downloads", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 206,
        headers: { "Content-Type": "application/octet-stream" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://raw.githubusercontent.com/exelearning/exelearning/main/file.bin",
        { headers: { Range: "bytes=0-3" } },
      ),
      {},
    );

    assert.equal(response.status, 206);
    assert.equal(
      upstreamRequest.url,
      "https://raw.githubusercontent.com/exelearning/exelearning/main/file.bin",
    );
    assert.equal(upstreamRequest.init.headers.get("Range"), "bytes=0-3");
    assert.equal(upstreamRequest.init.headers.get("Cache-Control"), "no-cache");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("still rejects unrelated direct URLs", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const response = await worker.fetch(
      new Request("https://proxy.example/?url=https://example.com/file.txt"),
      {},
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /not a supported direct GitHub\/resource URL/i);
  });
});
