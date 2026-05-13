#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

// @php-wasm/web 3.1.22+ references the ICU data file via the source-layout
// path `../intl/shared/icu.dat`, but the published tarball ships the file at
// `./shared/icu.dat` (no sibling `intl` package exists on npm). Without a
// resolver hook, esbuild fails with "Could not resolve ../intl/shared/icu.dat"
// when bundling the worker. See WordPress/wordpress-playground#2776.
const phpWasmWebDir = dirname(require.resolve("@php-wasm/web/package.json"));
const phpWasmIcuDataPlugin = {
  name: "php-wasm-icu-data",
  setup(b) {
    b.onResolve({ filter: /(^|\/)intl\/shared\/icu\.dat$/ }, () => ({
      path: `${phpWasmWebDir}/shared/icu.dat`,
    }));
  },
};

// @php-wasm/web's `tcp-over-fetch-websocket.ts` (lines around 643 upstream)
// builds an outbound `ReadableStream` body for every request whose method is
// not exactly "GET", then constructs `new Request(url, { method, body })`.
// HEAD passes through that branch and the browser throws
// `Failed to construct 'Request': Request with GET/HEAD method cannot have body`,
// which surfaces as an uncaught promise rejection from PHP curl. The published
// @php-wasm/web bundle minifies the variable to `S.method`, so we patch the
// single occurrence to also exclude HEAD before esbuild ingests the file.
// Filed upstream at WordPress/wordpress-playground; remove this plugin once
// it lands in a published @php-wasm/web release.
const phpWasmHeadBodyFixPlugin = {
  name: "php-wasm-tcp-over-fetch-head-body-fix",
  setup(b) {
    const phpWasmWebIndex = `${phpWasmWebDir}/index.js`;
    b.onLoad({ filter: /@php-wasm\/web\/index\.js$/ }, async (args) => {
      if (args.path !== phpWasmWebIndex) {
        return null;
      }
      const source = await readFile(args.path, "utf8");
      const pattern = /\bif\s*\(\s*S\.method\s*!==\s*"GET"\s*\)\s*\{/;
      if (!pattern.test(source)) {
        throw new Error(
          "php-wasm-tcp-over-fetch-head-body-fix: pattern not found in "
            + `${args.path}. The upstream bundle layout may have changed; `
            + "verify parseHttpRequest() in @php-wasm/web/index.js and update "
            + "the regex.",
        );
      }
      const patched = source.replace(
        pattern,
        'if (S.method !== "GET" && S.method !== "HEAD") {',
      );
      return { contents: patched, loader: "js" };
    });
  },
};

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
    plugins: [phpWasmIcuDataPlugin, phpWasmHeadBodyFixPlugin],
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
  }).then(() => console.log("Built dist/php-worker.bundle.js")),

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
