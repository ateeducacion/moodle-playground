import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import worker from "../../scripts/github-proxy-worker.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

// Routes upstream fetches by URL; records every call. A function value is
// called with the init so a test can inspect forwarded headers.
function route(table) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const entry = table[u];
    if (entry === undefined) throw new Error(`unexpected url ${u}`);
    return typeof entry === "function" ? entry(init) : entry.clone();
  };
  return calls;
}

const bytes = (status = 200, headers = {}) =>
  new Response(new Uint8Array([1, 2, 3]), { status, headers });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
const redirect = (location, status = 302) =>
  new Response(null, {
    status,
    headers: location ? { Location: location } : {},
  });

const get = (query, init) =>
  worker.fetch(new Request(`https://proxy.example/${query}`, init), {});

describe("github-proxy-worker entry routing", () => {
  it("answers CORS preflight and rejects non-GET methods", async () => {
    const preflight = await get("", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");

    const post = await get("?repo=a/b", { method: "POST" });
    assert.equal(post.status, 405);
    assert.match((await post.json()).error, /Method not allowed/);
  });

  it("serves the landing page to browsers and usage JSON to API clients", async () => {
    const html = await get("", { headers: { Accept: "text/html" } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("Content-Type"), /text\/html/);
    assert.match(await html.text(), /https:\/\/proxy\.example\/\?repo=/);

    const usage = await get("");
    assert.equal(usage.status, 400);
    const body = await usage.json();
    assert.equal(
      body.usage.raw_file,
      "?repo={owner/repo}&path={path}[&branch={branch}]",
    );
  });
});

describe("github-proxy-worker ?repo= archive resolution", () => {
  it("resolves the default branch through the API and sends the token", async () => {
    const calls = route({
      "https://api.github.com/repos/o/r": json({ default_branch: "trunk" }),
      "https://github.com/o/r/archive/refs/heads/trunk.zip": bytes(),
    });
    const response = await worker.fetch(
      new Request("https://proxy.example/?repo=o/r"),
      { GITHUB_TOKEN: "secret" },
    );
    assert.equal(response.status, 200);
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="trunk.zip"',
    );
  });

  it("proxies explicit branch, commit and tag archives without an API call", async () => {
    const calls = route({
      "https://github.com/o/r/archive/refs/heads/dev.zip": bytes(),
      "https://github.com/o/r/archive/abc123.zip": bytes(),
      "https://github.com/o/r/archive/refs/tags/v1.zip": bytes(),
    });
    for (const query of ["branch=dev", "commit=abc123", "release=v1"]) {
      assert.equal((await get(`?repo=o/r&${query}`)).status, 200);
    }
    assert.ok(calls.every((c) => new URL(c.url).hostname !== "api.github.com"));
  });

  it("resolves a pull request head SHA and fails clearly when the API cannot", async () => {
    route({
      "https://api.github.com/repos/o/r/pulls/7": json({
        head: { sha: "f00" },
      }),
      "https://github.com/o/r/archive/f00.zip": bytes(),
      "https://api.github.com/repos/o/r/pulls/8": json({}, 404),
    });
    assert.equal((await get("?repo=o/r&pr=7")).status, 200);
    const missing = await get("?repo=o/r&pr=8");
    assert.equal(missing.status, 502);
    assert.match((await missing.json()).error, /PR #8/);
  });

  it("returns the last failure when neither main nor master exists", async () => {
    route({
      "https://api.github.com/repos/o/r": () => {
        throw new Error("offline");
      },
      "https://github.com/o/r/archive/refs/heads/main.zip": bytes(404),
      "https://github.com/o/r/archive/refs/heads/master.zip": bytes(410),
    });
    const response = await get("?repo=o/r");
    assert.equal(response.status, 410);
    assert.match((await response.json()).upstream_url, /master\.zip$/);
  });

  it("reports a network failure while downloading an archive as 502", async () => {
    route({
      "https://github.com/o/r/archive/refs/heads/x.zip": () => {
        throw new Error("reset");
      },
    });
    const response = await get("?repo=o/r&branch=x");
    assert.equal(response.status, 502);
    assert.equal((await response.json()).details, "reset");
  });

  it("names the requested asset and labels a missing asset in a fixed tag", async () => {
    route({
      "https://api.github.com/repos/o/r/releases/tags/v2": json({
        assets: [
          {
            name: "Tool.ZIP",
            browser_download_url:
              "https://github.com/o/r/releases/download/v2/Tool.ZIP",
          },
        ],
      }),
      "https://github.com/o/r/releases/download/v2/Tool.ZIP": bytes(),
    });
    const found = await get("?repo=o/r&release=v2&asset=tool.zip");
    assert.equal(found.status, 200);
    assert.equal(
      found.headers.get("Content-Disposition"),
      'attachment; filename="Tool.ZIP"',
    );

    const missing = await get("?repo=o/r&release=v2&asset=other.zip");
    assert.equal(missing.status, 404);
    const body = await missing.json();
    assert.match(body.error, /Asset "other.zip" not found in release "v2"/);
    assert.deepEqual(body.available_assets, ["Tool.ZIP"]);
  });

  it("forwards Range on release-asset downloads and passes the 206 through (#378)", async () => {
    let range;
    route({
      "https://api.github.com/repos/o/r/releases/tags/v2": json({
        assets: [
          {
            name: "a.zip",
            browser_download_url:
              "https://github.com/o/r/releases/download/v2/a.zip",
          },
        ],
      }),
      "https://github.com/o/r/releases/download/v2/a.zip": (init) => {
        range = init.headers.get("Range");
        return bytes(206, { "Content-Range": "bytes 0-2/10" });
      },
    });
    const response = await get("?repo=o/r&release=v2&asset=a.zip", {
      headers: { Range: "bytes=0-2" },
    });
    assert.equal(range, "bytes=0-2");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 0-2/10");
  });

  it("labels a latest release without a tag name", async () => {
    route({
      "https://api.github.com/repos/o/r/releases/latest": json({ assets: [] }),
    });
    const response = await get("?repo=o/r&release=latest&asset=x.zip");
    assert.match((await response.json()).error, /latest \(unknown tag\)/);
  });
});

describe("github-proxy-worker raw file and Atom routes", () => {
  it("falls back to the default branch, then main, for a raw path without a ref", async () => {
    const calls = route({
      "https://api.github.com/repos/o/r": json({ default_branch: "dev" }),
      "https://raw.githubusercontent.com/o/r/dev/notes.txt": bytes(),
    });
    const response = await get("?repo=o/r&path=notes.txt");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(calls.length, 2);

    route({
      "https://api.github.com/repos/o/r": json({}, 500),
      "https://raw.githubusercontent.com/o/r/main/a.css": bytes(200, {
        "Content-Type": "text/css",
      }),
    });
    const css = await get("?repo=o/r&path=a.css");
    assert.equal(css.headers.get("Content-Type"), "text/css");
  });

  it("maps raw file network failures and blocked redirects", async () => {
    route({
      "https://raw.githubusercontent.com/o/r/main/a.json": () => {
        throw new Error("dns");
      },
      "https://raw.githubusercontent.com/o/r/main/b.json": redirect(
        "https://evil.example/b.json",
      ),
    });
    const failed = await get("?repo=o/r&branch=main&path=a.json");
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /raw file/);
    const blocked = await get("?repo=o/r&branch=main&path=b.json");
    assert.equal(blocked.status, 400);
  });

  it("validates the feed type and maps feed failures", async () => {
    const invalid = await get("?repo=o/r&atom=issues");
    assert.equal(invalid.status, 400);

    route({
      "https://github.com/o/r/tags.atom": () => {
        throw new Error("down");
      },
      "https://github.com/o/r/releases.atom": redirect("https://evil.example/"),
    });
    const failed = await get("?repo=o/r&atom=tags");
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /Atom feed/);
    assert.equal((await get("?repo=o/r&atom=releases")).status, 400);
  });
});

describe("github-proxy-worker redirect validation edge cases", () => {
  const start = "https://github.com/o/r/archive/refs/heads/b.zip";

  it("passes a 3xx without Location through unchanged (#378)", async () => {
    route({ [start]: redirect(null) });
    const response = await get("?repo=o/r&branch=b");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("blocks invalid and non-http redirect targets", async () => {
    route({ [start]: redirect("http://[bad") });
    const invalid = await get("?repo=o/r&branch=b");
    assert.match((await invalid.json()).details, /not a valid URL/);

    route({ [start]: redirect("ftp://github.com/x.zip") });
    const ftp = await get("?repo=o/r&branch=b");
    assert.match((await ftp.json()).details, /unsupported protocol/);
  });
});

describe("github-proxy-worker generic ?url= validation and headers", () => {
  it("rejects malformed URLs and non-http protocols", async () => {
    const malformed = await get("?url=not a url");
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "Invalid URL.");
    const ftp = await get("?url=ftp://github.com/a.zip");
    assert.match((await ftp.json()).error, /Invalid protocol/);
  });

  it("routes a direct tags.atom URL to the Atom handler", async () => {
    route({ "https://github.com/o/r/tags.atom": bytes() });
    const response = await get("?url=https://github.com/o/r/tags.atom");
    assert.equal(
      response.headers.get("Content-Type"),
      "application/atom+xml; charset=utf-8",
    );
  });

  it("forwards conditional headers and picks a default Accept/Content-Type", async () => {
    const seen = {};
    const capture = (key) => (init) => {
      seen[key] = init.headers;
      return bytes();
    };
    route({
      "https://facturascripts.com/plugins/foo": capture("fs"),
      "https://gitlab.com/g/p/-/archive/main/p-main.zip": capture("zip"),
      "https://gitlab.com/g/p/raw/file.bin": capture("bin"),
    });

    const fs = await get("?url=https://facturascripts.com/plugins/foo", {
      headers: { "If-None-Match": '"e"', "If-Modified-Since": "yesterday" },
    });
    assert.equal(seen.fs.get("If-None-Match"), '"e"');
    assert.equal(seen.fs.get("If-Modified-Since"), "yesterday");
    assert.match(seen.fs.get("Accept"), /^text\/html/);
    assert.equal(fs.headers.get("Content-Type"), "text/html; charset=utf-8");

    const zip = await get(
      "?url=https://gitlab.com/g/p/-/archive/main/p-main.zip",
    );
    assert.match(seen.zip.get("Accept"), /^application\/zip/);
    assert.equal(zip.headers.get("Content-Type"), "application/zip");
    assert.equal(
      zip.headers.get("Content-Disposition"),
      'attachment; filename="p-main.zip"',
    );

    const bin = await get("?url=https://gitlab.com/g/p/raw/file.bin");
    assert.match(seen.bin.get("Accept"), /^application\/octet-stream/);
    assert.equal(bin.headers.get("Content-Type"), "application/octet-stream");
  });

  it("serves Atom content types for a generic .atom path", async () => {
    let accept;
    route({
      "https://gitlab.com/g/p/feed.atom": (init) => {
        accept = init.headers.get("Accept");
        return bytes();
      },
    });
    const response = await get("?url=https://gitlab.com/g/p/feed.atom");
    assert.match(accept, /^application\/atom\+xml/);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/atom+xml; charset=utf-8",
    );
  });

  it("normalizes Google Drive /open links and keeps passthrough params", async () => {
    const calls = route({
      "https://drive.google.com/uc?confirm=t&id=FILE&export=download": bytes(),
      "https://drive.usercontent.google.com/download?id=FILE": bytes(),
    });
    await get(
      `?url=${encodeURIComponent("https://drive.google.com/open?id=FILE&confirm=t")}`,
    );
    await get(
      `?url=${encodeURIComponent("https://drive.usercontent.google.com/download?id=FILE")}`,
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        "https://drive.google.com/uc?confirm=t&id=FILE&export=download",
        "https://drive.usercontent.google.com/download?id=FILE",
      ],
    );
  });

  it("rejects Drive and usercontent paths that are not file downloads", async () => {
    for (const url of [
      "https://drive.google.com/drive/folders/x",
      "https://drive.usercontent.google.com/other?id=x",
    ]) {
      const response = await get(`?url=${encodeURIComponent(url)}`);
      assert.equal(response.status, 400, url);
    }
  });

  it("passes an upstream 304 through for conditional requests (#378)", async () => {
    route({
      "https://gitlab.com/g/p/x.zip": () =>
        new Response(null, { status: 304, headers: { ETag: '"e"' } }),
    });
    const response = await get("?url=https://gitlab.com/g/p/x.zip", {
      headers: { "If-None-Match": '"e"' },
    });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("ETag"), '"e"');
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  });

  it("reports a generic upstream network failure as 502", async () => {
    route({
      "https://gitlab.com/g/p/x.zip": () => {
        throw new Error("boom");
      },
    });
    const response = await get("?url=https://gitlab.com/g/p/x.zip");
    assert.equal(response.status, 502);
    assert.equal((await response.json()).details, "boom");
  });

  it("blocks private IPv4 ranges, IPv6 unique-local and hex IPv4-mapped hosts", async () => {
    for (const host of [
      "172.20.0.1",
      "192.168.1.1",
      "0.0.0.0",
      "[fd00::1]",
      "[::ffff:a9fe:a9fe]",
      "[fe80::1]",
      "x.localhost",
    ]) {
      const response = await get(`?url=http://${host}/a.zip`);
      assert.equal(response.status, 400, host);
    }
  });

  it("allows public IPv6 and IPv4-mapped public literals past the SSRF guard", async () => {
    // Not allowlisted either way, but must not be rejected as private: the
    // message is the allowlist rejection, which the SSRF guard also returns,
    // so assert through a redirect target that IS allowlisted afterwards.
    route({
      "https://github.com/o/r/archive/refs/heads/p.zip": redirect(
        "https://[::ffff:8.8.8.8]/a.zip",
      ),
    });
    const response = await get("?repo=o/r&branch=p");
    // Public mapped address passes the SSRF guard but fails the GitHub allowlist.
    assert.match((await response.json()).details, /not authorized/);
  });
});
