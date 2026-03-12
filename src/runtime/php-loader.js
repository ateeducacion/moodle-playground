import { PhpCgiWorker } from "../../vendor/php-cgi-wasm/PhpCgiWorker.js";
import { PhpWorker } from "../../vendor/php-wasm/PhpWorker.js";
import { MOODLE_ROOT } from "./config-template.js";
import { resolveSharedLibs } from "./runtime-registry.js";

const MIME_TYPES = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
};

function buildSharedRuntimeOptions(runtime) {
  return {
    sharedLibs: resolveSharedLibs(runtime),
  };
}

export function createPhpRuntime(runtime) {
  return new PhpCgiWorker({
    ...buildSharedRuntimeOptions(runtime),
    prefix: "/",
    docroot: MOODLE_ROOT,
    types: MIME_TYPES,
    rewrite: (pathname) => pathname,
  });
}

export function createProvisioningRuntime(runtime) {
  return new PhpWorker({
    ...buildSharedRuntimeOptions(runtime),
  });
}
