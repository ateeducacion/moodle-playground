import { PhpCgiWorker } from "../../vendor/php-cgi-wasm/PhpCgiWorker.js";
import { PhpWorker } from "../../vendor/php-wasm/PhpWorker.js";
import { PGlite, parse, protocol } from "../../vendor/pglite/index.js";
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

    if (!this.ready) {
      return this.waitReady.then(() => this.exec(query, options));
    }

    const messages = this.#parseProtocolMessages(protocol.serialize.query(query));
    console.info("[pglite-compat] exec:messages", messages.map((entry) => entry.name));
    return parse.parseResults(messages, this.parsers, options, undefined);
  }

  query(query, params = [], options) {
    console.info("[pglite-compat] query", query, params);
    const isMutatingQuery = /^\s*(alter|create|delete|drop|grant|insert|reindex|replace|truncate|update|vacuum)\b/iu.test(query);
    if (isMutatingQuery) {
      this.__playgroundDirty = true;
    }

    if (!this.ready) {
      return this.waitReady.then(() => this.query(query, params, options));
    }

    if (!params.length) {
      const result = this.exec(query, options)[0] ?? { rows: [], fields: [], affectedRows: 0 };
      return isMutatingQuery ? (result.affectedRows ?? 0) : result;
    }

    const messages = [];
    messages.push(...this.#parseProtocolMessages(protocol.serialize.parse({
      text: query,
      types: options?.paramTypes,
    })));

    const statementDescription = this.#parseProtocolMessages(protocol.serialize.describe({ type: "S" }));
    messages.push(...statementDescription);

    const dataTypeIds = parse.parseDescribeStatementResults(statementDescription);
    const values = params.map((param, index) => {
      const oid = dataTypeIds[index];
      if (param === null || param === undefined) {
        return null;
      }

      const serialize = options?.serializers?.[oid] ?? this.serializers[oid];
      return serialize ? serialize(param) : String(param);
    });

    messages.push(...this.#parseProtocolMessages(protocol.serialize.bind({ values })));
    messages.push(...this.#parseProtocolMessages(protocol.serialize.describe({ type: "P" })));
    messages.push(...this.#parseProtocolMessages(protocol.serialize.execute({})));
    messages.push(...this.#parseProtocolMessages(protocol.serialize.sync()));
    console.info("[pglite-compat] query:messages", messages.map((entry) => entry.name));

    return parse.parseResults(messages, this.parsers, options, undefined)[0];
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

  #parseProtocolMessages(message) {
    const raw = this.execProtocolRawSync(message);
    const parser = new protocol.Parser();
    const messages = [];
    parser.parse(raw, (entry) => messages.push(entry));
    return messages;
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
