import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "../../src/runtime/php-loader.js";

describe("php-loader OPcache blacklist", () => {
  it("writes /internal/eval.php into the blacklist file before PHP starts", () => {
    const dirs = [];
    const files = new Map();
    __testing.writeOpcacheBlacklist(
      { writeFile: (path, data) => files.set(path, data) },
      { mkdirTree: (path) => dirs.push(path) },
    );
    assert.deepStrictEqual(dirs, ["/internal/shared"]);
    assert.deepStrictEqual(
      [...files],
      [["/internal/shared/opcache-blacklist.txt", "/internal/eval.php\n"]],
    );
  });

  it("tolerates an existing /internal/shared directory", () => {
    const files = new Map();
    __testing.writeOpcacheBlacklist(
      { writeFile: (path, data) => files.set(path, data) },
      {
        mkdirTree: () => {
          throw new Error("EEXIST");
        },
      },
    );
    assert.strictEqual(files.size, 1);
  });
});

describe("php-loader tcpOverFetch helpers", () => {
  it("prefers explicit corsProxyUrl over phpCorsProxyUrl", () => {
    const value = __testing.resolveCorsProxyUrl({
      corsProxyUrl: "https://cors.example.test/",
      phpCorsProxyUrl: "https://php-cors.example.test/",
    });

    assert.strictEqual(value, "https://cors.example.test/");
  });

  it("falls back to phpCorsProxyUrl only", () => {
    assert.strictEqual(
      __testing.resolveCorsProxyUrl({
        phpCorsProxyUrl: "https://php-cors.example.test/",
      }),
      "https://php-cors.example.test/",
    );
    assert.strictEqual(__testing.resolveCorsProxyUrl({}), null);
  });

  it("returns base php.ini entries when tcpOverFetch is disabled", () => {
    const entries = __testing.buildPhpIniEntries();

    assert.ok(!("openssl.cafile" in entries));
    assert.ok(!("curl.cainfo" in entries));
  });

  it("raises memory_limit only while the file cache is live", () => {
    assert.strictEqual(__testing.buildPhpIniEntries().memory_limit, "256M");
    assert.strictEqual(
      __testing.buildPhpIniEntries({ opcache: true }).memory_limit,
      "512M",
    );
    assert.strictEqual(
      __testing.buildPhpIniEntries({ phpVersion: "8.4" }).memory_limit,
      "256M",
    );
    assert.strictEqual(
      __testing.buildPhpIniEntries({ phpVersion: "8.5" }).memory_limit,
      "512M",
    );
  });

  it("adds CA ini entries when tcpOverFetch is enabled", () => {
    const entries = __testing.buildPhpIniEntries({
      tcpOverFetchEnabled: true,
    });

    assert.strictEqual(
      entries["openssl.cafile"],
      __testing.TCP_OVER_FETCH_CA_PATH,
    );
    assert.strictEqual(
      entries["curl.cainfo"],
      __testing.TCP_OVER_FETCH_CA_PATH,
    );
  });

  it("creates tcpOverFetch options even when no CORS proxy is configured", async () => {
    const options = await __testing.getTcpOverFetchOptions(null);

    assert.ok(options.CAroot);
    assert.ok(!("corsProxyUrl" in options));
  });

  it("creates tcpOverFetch options with a generated CA root", async () => {
    const options = await __testing.getTcpOverFetchOptions(
      "https://github-proxy.exelearning.dev/",
    );

    assert.strictEqual(
      options.corsProxyUrl,
      "https://github-proxy.exelearning.dev/",
    );
    assert.ok(options.CAroot);
    assert.ok(options.CAroot.certificate);
    assert.ok(options.CAroot.keyPair);
  });
});
