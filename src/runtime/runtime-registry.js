import * as PhpWasmDom from "../../vendor/php-wasm-dom/index.js";
import * as PhpWasmIconv from "../../vendor/php-wasm-iconv/index.js";
import * as PhpWasmIntl from "../../vendor/php-wasm-intl/index.js";
import * as PhpWasmLibxml from "../../vendor/php-wasm-libxml/index.js";
import * as PhpWasmLibzip from "../../vendor/php-wasm-libzip/index.js";
import * as PhpWasmMbstring from "../../vendor/php-wasm-mbstring/index.js";
import * as PhpWasmOpenssl from "../../vendor/php-wasm-openssl/index.js";
import * as PhpWasmPhar from "../../vendor/php-wasm-phar/index.js";
import * as PhpWasmSimplexml from "../../vendor/php-wasm-simplexml/index.js";
import * as PhpWasmSqlite from "../../vendor/php-wasm-sqlite/index.js";
import * as PhpWasmXml from "../../vendor/php-wasm-xml/index.js";
import * as PhpWasmZlib from "../../vendor/php-wasm-zlib/index.js";

const LIBS = {
  dom: PhpWasmDom,
  iconv: PhpWasmIconv,
  intl: PhpWasmIntl,
  libxml: PhpWasmLibxml,
  zip: PhpWasmLibzip,
  mbstring: PhpWasmMbstring,
  openssl: PhpWasmOpenssl,
  phar: PhpWasmPhar,
  simplexml: PhpWasmSimplexml,
  sqlite: PhpWasmSqlite,
  xml: PhpWasmXml,
  zlib: PhpWasmZlib,
};

export function resolveSharedLibs(runtime) {
  return (runtime.sharedLibs || []).map((name) => {
    const lib = LIBS[name];
    if (!lib) {
      throw new Error(`Unknown PHP shared library '${name}' in runtime config.`);
    }
    return lib;
  });
}
