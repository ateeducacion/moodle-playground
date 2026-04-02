import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __testing } from "../../src/runtime/php-loader.js";

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
