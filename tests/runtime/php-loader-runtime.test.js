/**
 * Runs php-loader's runtime factories against a fake @php-wasm boundary
 * (tests/runtime/fixtures/fake-php-wasm.mjs) so refresh() can be exercised
 * under Node: which runtime is loaded, what is written into MEMFS before the
 * first request, php.ini values, OPcache SAPI, and journal wiring.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

const FAKE_URL = new URL("./fixtures/fake-php-wasm.mjs", import.meta.url).href;
const MOCKED = new Set([
  "@php-wasm/web",
  "@php-wasm/universal",
  "./fs-persistence.js",
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      MOCKED.has(specifier) &&
      context.parentURL?.endsWith("/src/runtime/php-loader.js")
    ) {
      return { url: FAKE_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { state } = await import(FAKE_URL);
const { createPhpRuntime, createProvisioningRuntime } = await import(
  "../../src/runtime/php-loader.js"
);

const PHP_INI = "/internal/shared/php.ini";
const CA_PATH = "/internal/shared/playground-ca.pem";

beforeEach(() => {
  state.instances.length = 0;
  state.loadCalls.length = 0;
  state.clearedJournals.length = 0;
  state.persistence.length = 0;
  state.mkdirTreeThrows = false;
});

describe("createPhpRuntime", () => {
  it("rejects every PHP call until refresh() and reports persistence as disabled", async () => {
    const runtime = createPhpRuntime({});
    for (const method of [
      "request",
      "analyzePath",
      "mkdir",
      "writeFile",
      "readFile",
      "run",
    ]) {
      await assert.rejects(runtime[method](), /Call refresh\(\) first/);
    }
    runtime.addEventListener();
    runtime.removeEventListener();
    assert.deepEqual(await runtime.flushPersistence(), {
      enabled: false,
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
    assert.equal(state.loadCalls.length, 0);
  });

  it("boots the requested PHP version with the CORS proxy and seeds MEMFS before any request", async () => {
    const runtime = createPhpRuntime(
      { phpCorsProxyUrl: "https://proxy.test/cors?" },
      {
        appBaseUrl: "https://example.test/moodle-playground/",
        phpVersion: "8.4",
        webRoot: "/www/moodle/public",
        corsProxyUrl: undefined,
      },
    );
    await runtime.refresh();

    const [load] = state.loadCalls;
    assert.equal(load.version, "8.4");
    assert.equal(load.options.withIntl, true);
    assert.equal(
      load.options.tcpOverFetch.corsProxyUrl,
      "https://proxy.test/cors?",
    );
    assert.equal(
      load.options.emscriptenOptions.INITIAL_MEMORY,
      128 * 1024 * 1024,
    );

    const [php] = state.instances;
    assert.equal(php.sapiName, null);
    assert.ok(php.dirs.includes("/tmp/moodle/sessions"));
    assert.ok(php.dirs.includes("/persist"));
    assert.ok(php.dirs.includes("/internal/shared/preload"));
    assert.equal(php.files.get(CA_PATH), "PEM(Moodle Playground CA)\n");
    assert.equal(
      php.files.get("/internal/shared/opcache-blacklist.txt"),
      "/internal/eval.php\n",
    );
    const ini = String(php.files.get(PHP_INI));
    assert.match(ini, /memory_limit\s*=\s*"?256M/);
    assert.match(
      ini,
      /openssl\.cafile\s*=\s*"?\/internal\/shared\/playground-ca\.pem/,
    );
    assert.equal(state.persistence.length, 0);

    // After refresh the deferred object forwards to the wrapped instance.
    assert.equal(runtime._php, php);
    assert.equal(runtime.binary, php[Object.getOwnPropertySymbols(php)[0]]);
    assert.deepEqual(await runtime.analyzePath(CA_PATH), {
      exists: true,
      object: { isFolder: false, mode: 0o100644 },
    });
    const missing = await runtime.request(
      new Request("https://example.test/moodle-playground/none.php"),
    );
    assert.equal(missing.status, 404);
  });

  it("wipes and re-attaches the journal on a clean scoped boot, with OPcache on", async () => {
    state.mkdirTreeThrows = true;
    const runtime = createPhpRuntime(
      {},
      { scopeId: "scope-1", forceCleanBoot: true, opcache: true },
    );
    await runtime.refresh();

    const [php] = state.instances;
    assert.equal(state.loadCalls[0].version, "8.3");
    assert.equal(
      state.loadCalls[0].options.tcpOverFetch.corsProxyUrl,
      undefined,
    );
    assert.equal(php.sapiName, "uwsgi");
    assert.deepEqual(state.clearedJournals, ["scope-1"]);
    assert.equal(state.persistence[0].php, php);
    assert.equal(state.persistence[0].scopeId, "scope-1");
    assert.match(String(php.files.get(PHP_INI)), /memory_limit\s*=\s*"?512M/);
    // mkdirTree failures (already exists) do not stop the blacklist write.
    assert.ok(php.files.has("/internal/shared/opcache-blacklist.txt"));

    assert.deepEqual(await runtime.flushPersistence({ maxBytes: 1 }), {
      enabled: true,
      ok: true,
      flushedOps: 3,
      options: { maxBytes: 1 },
    });
  });

  it("keeps an existing journal on a normal scoped reload", async () => {
    await createPhpRuntime({}, { scopeId: "keep" }).refresh();
    assert.deepEqual(state.clearedJournals, []);
    assert.equal(state.persistence[0].scopeId, "keep");
  });

  it("lets an explicit corsProxyUrl win and reuses one generated CA", async () => {
    const before = state.certificates;
    await createPhpRuntime(
      { corsProxyUrl: "https://config.test/" },
      { corsProxyUrl: "https://explicit.test/" },
    ).refresh();
    await createProvisioningRuntime({}).refresh();
    assert.equal(
      state.loadCalls[0].options.tcpOverFetch.corsProxyUrl,
      "https://explicit.test/",
    );
    assert.equal(state.certificates, before);
  });
});

describe("createProvisioningRuntime", () => {
  it("rejects run() before refresh()", async () => {
    const runtime = createProvisioningRuntime();
    await assert.rejects(runtime.run("<?php"), /Call refresh\(\) first/);
    runtime.addEventListener();
    runtime.removeEventListener();
  });

  it("mirrors the serving runtime's ini, OPcache SAPI and CA, then runs code", async () => {
    state.mkdirTreeThrows = true;
    const runtime = createProvisioningRuntime(
      { corsProxyUrl: "https://proxy.test/" },
      { phpVersion: "8.5", opcache: true },
    );
    await runtime.refresh();
    const [php] = state.instances;
    assert.equal(state.loadCalls[0].version, "8.5");
    assert.equal(
      state.loadCalls[0].options.tcpOverFetch.corsProxyUrl,
      "https://proxy.test/",
    );
    assert.equal(php.sapiName, "uwsgi");
    assert.equal(php.files.get(CA_PATH), "PEM(Moodle Playground CA)\n");
    assert.match(String(php.files.get(PHP_INI)), /memory_limit\s*=\s*"?512M/);

    const result = await runtime.run("<?php phpinfo();");
    assert.equal(result.text, "ran");
    assert.deepEqual(php.runs, [{ code: "<?php phpinfo();" }]);
  });

  it("defaults to PHP 8.3 without OPcache", async () => {
    await createProvisioningRuntime().refresh();
    assert.equal(state.loadCalls[0].version, "8.3");
    assert.equal(state.instances[0].sapiName, null);
    assert.ok(state.instances[0].dirs.includes("/internal/shared/preload"));
  });
});
