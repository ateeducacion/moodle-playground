#!/usr/bin/env node

import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ALL_PHP_VERSIONS as MOODLE_PHP_VERSIONS } from "./src/shared/version-resolver.js";

const require = createRequire(import.meta.url);

// Only bundle the PHP runtime versions Moodle actually supports. @php-wasm/web's
// loadWebRuntime() switch dynamically imports every @php-wasm/web-X-Y package,
// so esbuild can't tree-shake and would emit all 8 versions' .wasm (~798 MB)
// into dist/ — though the browser only downloads the one version a session
// selects. Keep the versions any deployed Moodle branch can run (the resolver's
// ALL_PHP_VERSIONS) and stub the rest so their assets are never emitted (a
// deploy/CI/disk reduction; loadWebRuntime behavior for kept versions is
// unchanged). NOTE: keep-set comes from version-resolver, not playground.config
// (which only lists the default runtime), so branch/?php= overrides keep working.
const ALL_PHP_VERSIONS = ["5-2", "7-4", "8-0", "8-1", "8-2", "8-3", "8-4", "8-5"];
const keepVersions = MOODLE_PHP_VERSIONS.map((v) => v.replace(".", "-"));
const dropVersions = ALL_PHP_VERSIONS.filter((v) => !keepVersions.includes(v));
const stripUnusedPhpVersions = {
  name: "strip-unused-php-versions",
  setup(b) {
    if (dropVersions.length === 0) return;
    const filter = new RegExp(
      `@php-wasm/(?:web|node)-(?:${dropVersions.join("|")})(?:/|$)`,
    );
    b.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "phpver-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "phpver-stub" }, (args) => ({
      loader: "js",
      contents:
        `export function getPHPLoaderModule(){throw new Error("PHP runtime not bundled in this build: ${args.path}");}\n` +
        `export function getIntlExtensionPath(){throw new Error("PHP intl not bundled in this build: ${args.path}");}\n`,
    }));
  },
};

const phpWasmWebPackage = JSON.parse(
  readFileSync(require.resolve("@php-wasm/web/package.json"), "utf8"),
);
const ICU_DATA_URL = `https://unpkg.com/@php-wasm/web@${phpWasmWebPackage.version}/shared/icu.dat`;
const phpWasmIcuDataPlugin = {
  name: "php-wasm-icu-data",
  setup(b) {
    b.onResolve(
      { filter: /(^|\/)(?:intl\/shared|shared)\/icu\.dat$/ },
      () => ({
        path: "external-icu-data-url",
        namespace: "external-icu-data-url",
      }),
    );
    b.onLoad({ filter: /.*/, namespace: "external-icu-data-url" }, () => ({
      loader: "js",
      contents: `export default ${JSON.stringify(ICU_DATA_URL)};`,
    }));
  },
};

rmSync("dist", { force: true, recursive: true });

await Promise.all([
  // Bundle the PHP worker (Web Worker — uses @php-wasm dependencies)
  build({
    entryPoints: ["php-worker.js"],
    bundle: true,
    outdir: "dist",
    entryNames: "php-worker.bundle",
    assetNames: "[name]-[hash]",
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    // The worker bundle lives in dist/ but import.meta.url references in the
    // source assume they are relative to the original source file locations.
    // We inject a global __APP_ROOT__ that points to the project root so that
    // asset URLs can be resolved correctly at runtime.
    banner: {
      js: `const __APP_ROOT__ = new URL("../", import.meta.url).href;`,
    },
    plugins: [phpWasmIcuDataPlugin, stripUnusedPhpVersions],
    loader: {
      ".wasm": "file",
      ".so": "file",
      ".dat": "file",
    },
    // Node.js built-ins referenced by Emscripten-generated code (conditional,
    // never executed in browser). Mark them as external to avoid resolution errors.
    external: [
      "worker_threads",
      "events",
      "fs",
      "path",
      "crypto",
      "os",
      "url",
      "child_process",
      "net",
      "tls",
      "http",
      "https",
      "stream",
      "zlib",
      "util",
      "assert",
      "buffer",
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  }).then(() =>
    console.log(
      `Built dist/php-worker.bundle.js (bundled PHP runtimes: ${keepVersions.join(", ")})`,
    ),
  ),

  // Bundle the Service Worker as an IIFE (classic script).
  // Firefox does not support ES module Service Workers (type: "module" + import
  // statements). Bundling inlines all imports so the SW works as a classic script
  // in all browsers.
  //
  // IMPORTANT: The SW bundle MUST live at the project root (not in dist/).
  // A Service Worker's maximum allowed scope is its own directory path. If the
  // bundle were at /dist/sw.bundle.js, it could only control paths under /dist/,
  // but it needs to control "/" (the whole site). Firefox strictly enforces this
  // scope rule and throws "The operation is insecure" SecurityError when a SW
  // tries to register with a scope above its own directory.
  build({
    entryPoints: ["sw.js"],
    bundle: true,
    outfile: "sw.bundle.js",
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
  }).then(() => console.log("Built sw.bundle.js")),
]);
