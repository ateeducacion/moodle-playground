import { PhpCgiWorker } from "../../vendor/php-cgi-wasm/PhpCgiWorker.js";
import { PhpWorker } from "../../vendor/php-wasm/PhpWorker.js";
import { PGlite } from "../../vendor/pglite/index.js";
import { MOODLE_ROOT } from "./config-template.js";
import { resolveSharedLibs } from "./runtime-registry.js";

const PGLITE_INSTANCES = new Set();
const PGLITE_SYNC_BYPASS = true;

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

class PGliteCompat extends PGlite {
  constructor(options) {
    const normalizedOptions = typeof options === "string" || options === undefined
      ? { dataDir: options, relaxedDurability: true }
      : { ...options, relaxedDurability: options.relaxedDurability ?? true };

    super(normalizedOptions);
    this.__playgroundDirty = false;

    const proxy = new Proxy(this, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || property === "then") {
          return value;
        }

        return (...args) => {
          console.info("[pglite-compat] method", String(property), args);
          return value.apply(target, args);
        };
      },
    });

    PGLITE_INSTANCES.add(proxy);
    return proxy;
  }

  exec(query, options) {
    console.info("[pglite-compat] exec", query);
    this.__playgroundDirty = true;
    return super.exec(query, options);
  }

  query(query, params = [], options) {
    console.info("[pglite-compat] query", query, params);
    const isMutatingQuery = /^\s*(alter|create|delete|drop|grant|insert|reindex|replace|truncate|update|vacuum)\b/iu.test(query);
    if (isMutatingQuery) {
      this.__playgroundDirty = true;
    }
    return super.query(query, params, options);
  }

  async syncToFs() {
    if (PGLITE_SYNC_BYPASS && this.__playgroundDirty) {
      return;
    }

    return super.syncToFs();
  }

  async flushToFs() {
    this.__playgroundDirty = false;
    return PGlite.prototype.syncToFs.call(this);
  }
}

export async function flushAllPGliteInstances() {
  const errors = [];

  for (const instance of PGLITE_INSTANCES) {
    if (!instance?.__playgroundDirty) {
      continue;
    }

    try {
      await instance.flushToFs();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length) {
    throw errors[0];
  }
}

function buildSharedRuntimeOptions(runtime) {
  return {
    PGlite: PGliteCompat,
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
