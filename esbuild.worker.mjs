#!/usr/bin/env node

import { build } from "esbuild";

// Bundle the PHP worker (Web Worker — uses @php-wasm dependencies)
await build({
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
});

console.log("Built dist/php-worker.bundle.js");

// Bundle the Service Worker as an IIFE (classic script).
// Firefox does not support ES module Service Workers (type: "module" + import
// statements). Bundling inlines all imports so the SW works as a classic script
// in all browsers.
await build({
  entryPoints: ["sw.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "sw.bundle",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
});

console.log("Built dist/sw.bundle.js");
