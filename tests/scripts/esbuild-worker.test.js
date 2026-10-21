import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ALL_PHP_VERSIONS } from "../../src/shared/version-resolver.js";

// esbuild.worker.mjs runs its build at import time against the current working
// directory. Swap the "esbuild" specifier for a recorder so the real config,
// plugins and post-build .wasm check run without bundling anything, and chdir
// into a temp dir so its `rmSync("dist")` and output checks stay sandboxed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "esbuild") {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export const build = (opts) => globalThis.__fakeEsbuild(opts);",
        )}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const SCRIPT_URL = new URL("../../esbuild.worker.mjs", import.meta.url);
const KEEP = ALL_PHP_VERSIONS.map((v) => v.replace(".", "-"));
const DROP = ["5-2", "7-4", "8-0", "8-1", "8-2", "8-3", "8-4", "8-5"].filter(
  (v) => !KEEP.includes(v),
);
const phpWasmWebVersion = createRequire(import.meta.url)(
  "@php-wasm/web/package.json",
).version;

const originalCwd = process.cwd();
let workDir;
let runCount = 0;

// Import a fresh copy of the script. `emitWasm` lists the PHP versions whose
// .wasm the fake build writes into dist/.
async function runBuildScript({ emitWasm = KEEP } = {}) {
  const calls = [];
  globalThis.__fakeEsbuild = async (opts) => {
    calls.push(opts);
    if (opts.outdir) {
      mkdirSync(opts.outdir, { recursive: true });
      for (const v of emitWasm) {
        writeFileSync(
          join(opts.outdir, `php_${v.replace("-", "_")}-HASH.wasm`),
          "",
        );
      }
    }
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);
  try {
    await import(`${SCRIPT_URL.href}?run=${++runCount}`);
    return { calls, logs, error: null };
  } catch (error) {
    return { calls, logs, error };
  } finally {
    console.log = originalLog;
  }
}

// Collect a plugin's onResolve/onLoad registrations.
function setupPlugin(plugin) {
  const resolvers = [];
  const loaders = [];
  plugin.setup({
    onResolve: (opts, fn) => resolvers.push({ ...opts, fn }),
    onLoad: (opts, fn) => loaders.push({ ...opts, fn }),
  });
  return { resolvers, loaders };
}

describe("esbuild.worker.mjs", () => {
  let result;
  let worker;
  let sw;
  const plugin = (name) => worker.plugins.find((p) => p.name === name);

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), "esbuild-worker-"));
    process.chdir(workDir);
    // A stale dist/ must be wiped before building.
    mkdirSync("dist");
    writeFileSync("dist/stale.js", "old");
    result = await runBuildScript();
    worker = result.calls.find((c) => c.entryPoints[0] === "php-worker.js");
    sw = result.calls.find((c) => c.entryPoints[0] === "sw.js");
  });

  after(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
    delete globalThis.__fakeEsbuild;
  });

  it("builds exactly the PHP worker and the service worker", () => {
    assert.equal(result.error, null);
    assert.equal(result.calls.length, 2);
    assert.ok(worker);
    assert.ok(sw);
    assert.deepEqual(result.logs.sort(), [
      `Built dist/php-worker.bundle.js (bundled PHP runtimes: ${KEEP.join(", ")})`,
      "Built sw.bundle.js",
    ]);
  });

  it("emits the PHP worker as an ESM bundle in dist/ with an app-root banner", () => {
    assert.equal(worker.outdir, "dist");
    assert.equal(worker.entryNames, "php-worker.bundle");
    assert.equal(worker.format, "esm");
    assert.equal(worker.platform, "browser");
    assert.equal(worker.bundle, true);
    assert.match(worker.banner.js, /__APP_ROOT__ = new URL\("\.\.\/"/);
    assert.deepEqual(worker.loader, {
      ".wasm": "file",
      ".so": "file",
      ".dat": "file",
    });
    for (const builtin of ["fs", "path", "worker_threads", "crypto"]) {
      assert.ok(worker.external.includes(builtin), builtin);
    }
    assert.equal(worker.define["process.env.NODE_ENV"], '"production"');
  });

  it("emits the service worker as a classic IIFE at the app root", () => {
    // Firefox rejects module SWs and a SW under dist/ could not control "/".
    assert.equal(sw.outfile, "sw.bundle.js");
    assert.equal(sw.format, "iife");
    assert.equal(sw.outdir, undefined);
    assert.equal(sw.bundle, true);
  });

  it("removes the previous dist/ before building", () => {
    assert.ok(!readdirSync("dist").includes("stale.js"));
  });

  it("stubs PHP runtimes Moodle cannot run and keeps the supported ones", async () => {
    const { resolvers, loaders } = setupPlugin(
      plugin("strip-unused-php-versions"),
    );
    const [{ filter, fn }] = resolvers;
    for (const v of DROP) {
      assert.ok(filter.test(`@php-wasm/web-${v}`), v);
      assert.ok(filter.test(`@php-wasm/node-${v}/index.js`), v);
    }
    for (const v of KEEP) {
      assert.ok(!filter.test(`@php-wasm/web-${v}`), v);
    }
    const resolved = fn({ path: `@php-wasm/web-${DROP[0]}` });
    assert.equal(resolved.namespace, "phpver-stub");
    const loaded = loaders[0].fn({ path: resolved.path });
    const stub = await import(
      `data:text/javascript,${encodeURIComponent(loaded.contents)}`
    );
    assert.throws(
      () => stub.getPHPLoaderModule(),
      /PHP runtime not bundled in this build: @php-wasm\/web-/,
    );
    assert.throws(() => stub.getIntlExtensionPath(), /PHP intl not bundled/);
  });

  it("points ICU data at the matching @php-wasm/web version on unpkg", async () => {
    const { resolvers, loaders } = setupPlugin(plugin("php-wasm-icu-data"));
    const [{ filter, fn }] = resolvers;
    assert.ok(filter.test("./shared/icu.dat"));
    assert.ok(filter.test("../intl/shared/icu.dat"));
    assert.ok(!filter.test("./shared/other.dat"));
    const resolved = fn({ path: "./shared/icu.dat" });
    const mod = await import(
      `data:text/javascript,${encodeURIComponent(loaders[0].fn(resolved).contents)}`
    );
    assert.equal(
      mod.default,
      `https://unpkg.com/@php-wasm/web@${phpWasmWebVersion}/shared/icu.dat`,
    );
  });

  it("rewrites the loaders' new URL(.wasm) into an import the file loader emits", () => {
    const { loaders } = setupPlugin(plugin("php-wasm-url-to-import"));
    const [{ filter, fn }] = loaders;
    const dir = join(workDir, "node_modules/@php-wasm/web-8-3/jspi");
    const file = join(dir, "php_8_3.js");
    assert.ok(filter.test(file));
    assert.ok(
      !filter.test(join(workDir, "node_modules/@php-wasm/web/index.js")),
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      "const dependencyFilename = new URL('./php_8_3.wasm', import.meta.url).href;\nexport default dependencyFilename;\n",
    );
    const out = fn({ path: file });
    assert.equal(out.resolveDir, dir);
    assert.equal(
      out.contents,
      "import dependencyFilename from './php_8_3.wasm';\nexport default dependencyFilename;\n",
    );
  });

  it("fails the build when a supported PHP version emitted no .wasm", async () => {
    const missing = KEEP.slice(-2);
    const { error } = await runBuildScript({ emitWasm: KEEP.slice(0, -2) });
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      `No .wasm emitted for PHP ${missing.join(", ")}; check phpWasmUrlToImport against the installed @php-wasm/web-* loaders`,
    );
  });
});
