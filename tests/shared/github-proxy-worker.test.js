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
