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

  it("proxies direct GitHub release-asset URLs without calling the GitHub API", async () => {
    // Regression: a complete /releases/download/{tag}/{asset} URL must be
    // proxied directly (302 -> CDN), NOT rerouted through api.github.com — the
    // API call fails (502 JSON) whenever it is rate-limited or the worker's
    // GITHUB_TOKEN is blocked for the repo, which broke editor installs.
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (
        u ===
        "https://github.com/exelearning/exelearning/releases/download/v4.0.0/exelearning-static-v4.0.0.zip"
      ) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 206,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://github.com/exelearning/exelearning/releases/download/v4.0.0/exelearning-static-v4.0.0.zip",
        { headers: { Range: "bytes=0-3" } },
      ),
      {},
    );

    assert.equal(response.status, 206);
    // Exactly one upstream fetch — and it is NOT an api.github.com call.
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://github.com/exelearning/exelearning/releases/download/v4.0.0/exelearning-static-v4.0.0.zip",
    );
    assert.ok(!calls.some((c) => c.url.startsWith("https://api.github.com/")));
    assert.equal(calls[0].init.headers.get("Range"), "bytes=0-3");
    assert.equal(calls[0].init.headers.get("Cache-Control"), "no-cache");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="exelearning-static-v4.0.0.zip"',
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("returns upstream status details when a direct release-asset fetch fails", async () => {
    global.fetch = async (url) => {
      if (
        String(url) ===
        "https://github.com/exelearning/exelearning/releases/download/v4.0.0/exelearning-static-v4.0.0.zip"
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

  it("translates Google Drive share URLs to direct download URLs", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="plugin.zip"',
        },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://drive.google.com/file/d/drive-file-id/view?usp=sharing",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://drive.google.com/uc?id=drive-file-id&export=download",
    );
    assert.equal(
      upstreamRequest.init.headers.get("Accept"),
      "application/octet-stream, text/plain;q=0.9, */*;q=0.8",
    );
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="plugin.zip"',
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("proxies omeka.org plugin/module pages", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response("<html>module page</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://omeka.org/s/modules/ContactUs/",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(upstreamRequest.url, "https://omeka.org/s/modules/ContactUs/");
    assert.equal(
      upstreamRequest.init.headers.get("User-Agent"),
      "github-proxy-worker",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.equal(await response.text(), "<html>module page</html>");
  });

  it("proxies dev.omeka.org resources", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://dev.omeka.org/files/plugins/ContactUs-2.0.0.zip",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://dev.omeka.org/files/plugins/ContactUs-2.0.0.zip",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("proxies gitlab.com archive downloads", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://gitlab.com/owner/repo/-/archive/main/repo-main.zip",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://gitlab.com/owner/repo/-/archive/main/repo-main.zip",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
  });

  it("proxies jsDelivr CDN resources on non-zip paths", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response("console.log('hi');", {
        status: 200,
        headers: { "Content-Type": "application/javascript" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://cdn.jsdelivr.net/gh/owner/repo@1.0.0/dist/file.js",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://cdn.jsdelivr.net/gh/owner/repo@1.0.0/dist/file.js",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
  });

  it("proxies data.jsdelivr.com package metadata API", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response(JSON.stringify({ versions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://data.jsdelivr.com/v1/packages/gh/owner/repo",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://data.jsdelivr.com/v1/packages/gh/owner/repo",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
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

  it("rejects zip-like paths on non-allowlisted hosts (open proxy / SSRF)", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const targets = [
      "https://internal.corp/secret.zip",
      "https://evil.example/archive/refs/heads/main.zip",
      "https://attacker.test/zip/payload",
      "https://example.com/downloadbuild/123/stable",
    ];

    for (const target of targets) {
      const response = await worker.fetch(
        new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
        {},
      );

      assert.equal(response.status, 400, `expected 400 for ${target}`);
      const body = await response.json();
      assert.match(body.error, /not a supported direct GitHub\/resource URL/i);
    }
  });

  it("rejects private, loopback, and link-local hosts even with zip-like paths", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const targets = [
      "http://169.254.169.254/latest/meta-data/foo.zip",
      "http://127.0.0.1/x.zip",
      "http://localhost:6379/x.zip",
      "http://10.0.0.5/internal.zip",
      "http://172.16.4.4/internal.zip",
      "http://192.168.1.1/internal.zip",
      "http://0.0.0.0/x.zip",
      "http://[::1]/x.zip",
      "http://service.local/x.zip",
    ];

    for (const target of targets) {
      const response = await worker.fetch(
        new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
        {},
      );

      assert.equal(response.status, 400, `expected 400 for ${target}`);
      const body = await response.json();
      assert.match(body.error, /not a supported direct GitHub\/resource URL/i);
    }
  });

  it("still allows FacturaScripts build downloads on the allowlisted host", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url, init };
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://facturascripts.com/DownloadBuild/123/stable",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://facturascripts.com/DownloadBuild/123/stable",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("proxies Moodle language packs from packaging.moodle.org", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url: String(url), init };
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://packaging.moodle.org/langpack/5.0/es.zip",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://packaging.moodle.org/langpack/5.0/es.zip",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("proxies the Moodle langpack index (languages.md5, non-zip path)", async () => {
    let upstreamRequest;
    global.fetch = async (url, init = {}) => {
      upstreamRequest = { url: String(url), init };
      return new Response("abc123  es.zip\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://download.moodle.org/langpack/5.0/languages.md5",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      upstreamRequest.url,
      "https://download.moodle.org/langpack/5.0/languages.md5",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
  });

  it("follows the download.moodle.org langpack redirect to packaging.moodle.org", async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      // download.moodle.org/download.php/direct/langpack/... 302-redirects to
      // packaging.moodle.org — both hosts are allowlisted, so the hop is followed.
      // Match on the exact hostname (not a substring) so this stays a precise
      // host check and not an "anywhere in the URL" comparison.
      if (new URL(String(url)).hostname === "download.moodle.org") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://packaging.moodle.org/langpack/5.0/es.zip",
          },
        });
      }
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://download.moodle.org/download.php/direct/langpack/5.0/es.zip",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0],
      "https://download.moodle.org/download.php/direct/langpack/5.0/es.zip",
    );
    assert.equal(calls[1], "https://packaging.moodle.org/langpack/5.0/es.zip");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });
});

describe("github-proxy-worker redirect validation (SSRF)", () => {
  it("blocks a redirect from an allowlisted host into an internal IP", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      // omeka.org is allowlisted, but its (compromised/open-redirect) response
      // tries to bounce the proxy into the AWS metadata endpoint.
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://omeka.org/s/modules/ContactUs/",
      ),
      {},
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /not an allowed proxy destination/i);
    // Only the initial hop was issued; the internal target was never fetched.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://omeka.org/s/modules/ContactUs/");
    assert.equal(calls[0].init.redirect, "manual");
  });

  it("blocks a redirect into a loopback host", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 301,
        headers: { Location: "http://127.0.0.1:6379/" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://omeka.org/s/modules/ContactUs/",
      ),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("blocks a redirect into a host outside the generic allowlist", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/payload" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://omeka.org/s/modules/ContactUs/",
      ),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("follows a GitHub archive redirect into codeload.github.com", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (u === "https://github.com/owner/repo/archive/refs/heads/main.zip") {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://codeload.github.com/owner/repo/zip/refs/heads/main",
          },
        });
      }

      if (u === "https://codeload.github.com/owner/repo/zip/refs/heads/main") {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request("https://proxy.example/?repo=owner/repo&branch=main"),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      "https://github.com/owner/repo/archive/refs/heads/main.zip",
    );
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(
      calls[1].url,
      "https://codeload.github.com/owner/repo/zip/refs/heads/main",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("follows a GitHub release-asset redirect into objects.githubusercontent.com", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (
        u === "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0"
      ) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: "plugin.zip",
                browser_download_url:
                  "https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (
        u ===
        "https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip"
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://objects.githubusercontent.com/github-production-release-asset/plugin.zip",
          },
        });
      }

      if (
        u ===
        "https://objects.githubusercontent.com/github-production-release-asset/plugin.zip"
      ) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?repo=owner/repo&release=v1.0.0&asset=plugin.zip",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(
      calls[calls.length - 1].url,
      "https://objects.githubusercontent.com/github-production-release-asset/plugin.zip",
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("falls back to the direct download URL when the release API is blocked (?repo=&release=&asset=)", async () => {
    // The release API 404s (e.g. an org fine-grained-PAT policy blocks the
    // token for a public repo). The asset must still download via the
    // deterministic /releases/download/{tag}/{asset} URL.
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (
        u === "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0"
      ) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        u ===
        "https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip"
      ) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?repo=owner/repo&release=v1.0.0&asset=plugin.zip",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.ok(
      calls.some(
        (c) =>
          c.url ===
          "https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip",
      ),
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("falls back to main when the default-branch API call is blocked (?repo=)", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);

      if (u === "https://api.github.com/repos/owner/repo") {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (u === "https://github.com/owner/repo/archive/refs/heads/main.zip") {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request("https://proxy.example/?repo=owner/repo"),
      {},
    );

    assert.equal(response.status, 200);
    assert.ok(
      calls.includes(
        "https://github.com/owner/repo/archive/refs/heads/main.zip",
      ),
    );
  });

  it("falls back to master when main is absent and the default-branch API is blocked", async () => {
    const calls = [];
    global.fetch = async (url) => {
      const u = String(url);
      calls.push(u);

      if (u === "https://api.github.com/repos/owner/repo") {
        return new Response("rate limited", { status: 403 });
      }

      if (u === "https://github.com/owner/repo/archive/refs/heads/main.zip") {
        return new Response("no main branch", {
          status: 404,
          statusText: "Not Found",
        });
      }

      if (u === "https://github.com/owner/repo/archive/refs/heads/master.zip") {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request("https://proxy.example/?repo=owner/repo"),
      {},
    );

    assert.equal(response.status, 200);
    assert.ok(
      calls.includes(
        "https://github.com/owner/repo/archive/refs/heads/main.zip",
      ),
    );
    assert.ok(
      calls.includes(
        "https://github.com/owner/repo/archive/refs/heads/master.zip",
      ),
    );
  });

  it("blocks a GitHub archive redirect into a non-GitHub host", async () => {
    let calls = 0;
    global.fetch = async (url) => {
      calls++;
      if (
        String(url) ===
        "https://github.com/owner/repo/archive/refs/heads/main.zip"
      ) {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    };

    const response = await worker.fetch(
      new Request("https://proxy.example/?repo=owner/repo&branch=main"),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("caps the number of redirect hops", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      // Always redirect to another allowlisted-but-distinct path on omeka.org.
      return new Response(null, {
        status: 302,
        headers: { Location: `https://omeka.org/s/modules/hop-${calls}/` },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?url=https://omeka.org/s/modules/ContactUs/",
      ),
      {},
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.details, /too many redirects/i);
    // Initial fetch + MAX_REDIRECT_HOPS (5) = 6 issued requests, then capped.
    assert.equal(calls, 6);
  });
});

describe("github-proxy-worker isPrivateOrLocalHost extras", () => {
  it("rejects IPv4-mapped IPv6 loopback and link-local literals", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const targets = [
      "http://[::ffff:127.0.0.1]/x.zip",
      "http://[::ffff:169.254.169.254]/latest/meta-data/foo.zip",
      "http://[::ffff:7f00:1]/x.zip", // hex form of 127.0.0.1
      "http://[::ffff:a9fe:a9fe]/x.zip", // hex form of 169.254.169.254
      "http://[::ffff:10.0.0.5]/internal.zip",
    ];

    for (const target of targets) {
      const response = await worker.fetch(
        new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
        {},
      );

      assert.equal(response.status, 400, `expected 400 for ${target}`);
    }
  });

  it("rejects the cloud metadata DNS name", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const targets = [
      "http://metadata.google.internal/computeMetadata/v1/x.zip",
      "http://metadata/computeMetadata/v1/x.zip",
    ];

    for (const target of targets) {
      const response = await worker.fetch(
        new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
        {},
      );

      assert.equal(response.status, 400, `expected 400 for ${target}`);
    }
  });
});

describe("github-proxy-worker Nextcloud / ownCloud public shares", () => {
  it("proxies a /s/{token}/download URL on an arbitrary host", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="content.elpx"',
        },
      });
    };

    const target = "https://cloud.example.org/s/aB3xToken9/download";
    const response = await worker.fetch(
      new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, target);
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="content.elpx"',
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("normalizes a bare /s/{token} share page to /s/{token}/download", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://cloud.example.org/s/aB3xToken9",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://cloud.example.org/s/aB3xToken9/download",
    );
  });

  it("follows the same-host 303 redirect to the public DAV endpoint", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (u === "https://cloud.example.org/s/aB3xToken9/download") {
        return new Response(null, {
          status: 303,
          headers: {
            Location:
              "https://cloud.example.org/public.php/dav/files/aB3xToken9/?accept=zip",
          },
        });
      }

      if (
        u ===
        "https://cloud.example.org/public.php/dav/files/aB3xToken9/?accept=zip"
      ) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://cloud.example.org/s/aB3xToken9/download",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(
      calls[1].url,
      "https://cloud.example.org/public.php/dav/files/aB3xToken9/?accept=zip",
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("blocks a Nextcloud share redirect that leaves the original host", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 303,
        headers: { Location: "https://evil.example/payload" },
      });
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://cloud.example.org/s/aB3xToken9/download",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("blocks a Nextcloud share that redirects into an internal IP", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 303,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      });
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://cloud.example.org/s/aB3xToken9/download",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("does not authorize non-share paths on an arbitrary host", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://cloud.example.org/remote.php/dav/files/admin/secret.zip",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
  });

  it("rejects a Nextcloud-shaped path on a private host (SSRF guard)", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "http://192.168.1.10/s/aB3xToken9/download",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
  });
});

describe("github-proxy-worker Dropbox shared links", () => {
  // The matcher is path-based (isDropboxShareUrl tests url.pathname only), so the
  // worker proxies the URL regardless of its query. The client appends `?dl=1`,
  // which is the only param Dropbox honors to 302 a share link to the
  // *.dropboxusercontent.com CDN (verified live; `?download=1` and `?dl=0` both
  // return the HTML preview page instead of the file).
  it("proxies a legacy /s/{hash}/{file} share and follows the CDN redirect", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (u === "https://www.dropbox.com/s/aB3xHash9/content.elpx?dl=1") {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://dl.dropboxusercontent.com/cd/0/get/abc/content.elpx",
          },
        });
      }

      if (u === "https://dl.dropboxusercontent.com/cd/0/get/abc/content.elpx") {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="content.elpx"',
          },
        });
      }

      throw new Error(`unexpected url ${u}`);
    };

    const target = "https://www.dropbox.com/s/aB3xHash9/content.elpx?dl=1";
    const response = await worker.fetch(
      new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, target);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(
      calls[1].url,
      "https://dl.dropboxusercontent.com/cd/0/get/abc/content.elpx",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("proxies a newer /scl/fi/{hash}/{file} share with rlkey+st params", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, init });

      if (u.startsWith("https://www.dropbox.com/scl/fi/")) {
        return new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://uc1234.dl.dropboxusercontent.com/cd/0/get/xyz/course.zip",
          },
        });
      }

      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    };

    const target =
      "https://www.dropbox.com/scl/fi/aB3xHash9/course.zip?rlkey=k3y123&st=t0k3n&dl=1";
    const response = await worker.fetch(
      new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, target);
    assert.equal(
      calls[1].url,
      "https://uc1234.dl.dropboxusercontent.com/cd/0/get/xyz/course.zip",
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await response.arrayBuffer())),
      [0x50, 0x4b, 0x03, 0x04],
    );
  });

  it("blocks a Dropbox share redirect that leaves the Dropbox hosts", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/payload" },
      });
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://www.dropbox.com/s/aB3xHash9/content.elpx?dl=1",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("blocks a Dropbox share that redirects into an internal IP", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      });
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://www.dropbox.com/scl/fi/aB3xHash9/course.zip?rlkey=k&dl=1",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("does not authorize non-share Dropbox paths (e.g. /home)", async () => {
    global.fetch = async () => {
      throw new Error("should not fetch upstream");
    };

    const response = await worker.fetch(
      new Request(
        `https://proxy.example/?url=${encodeURIComponent(
          "https://www.dropbox.com/home/secret.zip",
        )}`,
      ),
      {},
    );

    assert.equal(response.status, 400);
  });
});

describe("github-proxy-worker ?path= raw file mode", () => {
  it("serves a raw repo file at a branch ref with CORS (slash-safe ref)", async () => {
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response('{"steps":[]}', {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    };

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?repo=owner/repo&branch=feat/x&path=blueprint.json",
      ),
      {},
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://raw.githubusercontent.com/owner/repo/feat/x/blueprint.json",
    );
    assert.equal(response.headers.get("X-Playground-Cors-Proxy"), "true");
    assert.match(response.headers.get("Content-Type"), /application\/json/i);
    assert.equal(await response.text(), '{"steps":[]}');
  });

  it("strips leading slashes from the path", async () => {
    let captured;
    global.fetch = async (url) => {
      captured = String(url);
      return new Response("x", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    };

    await worker.fetch(
      new Request(
        "https://proxy.example/?repo=owner/repo&branch=main&path=/a/b.json",
      ),
      {},
    );

    assert.equal(
      captured,
      "https://raw.githubusercontent.com/owner/repo/main/a/b.json",
    );
  });

  it("returns 404 when the raw file is missing", async () => {
    global.fetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    const response = await worker.fetch(
      new Request(
        "https://proxy.example/?repo=owner/repo&branch=main&path=missing.json",
      ),
      {},
    );

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Upstream server returned an error.");
  });
});
