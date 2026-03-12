import * as PhpWasmDom from "../../vendor/php-wasm-dom/index.js";
import * as PhpWasmIconv from "../../vendor/php-wasm-iconv/index.js";
import * as PhpWasmIntl from "../../vendor/php-wasm-intl/index.js";
import * as PhpWasmLibxml from "../../vendor/php-wasm-libxml/index.js";
import * as PhpWasmLibzip from "../../vendor/php-wasm-libzip/index.js";
import * as PhpWasmMbstring from "../../vendor/php-wasm-mbstring/index.js";
import * as PhpWasmOpenssl from "../../vendor/php-wasm-openssl/index.js";
import * as PhpWasmPhar from "../../vendor/php-wasm-phar/index.js";
import * as PhpWasmSimplexml from "../../vendor/php-wasm-simplexml/index.js";
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
  xml: PhpWasmXml,
  zlib: PhpWasmZlib,
};

function buildPhpModuleFilename(runtime, extension) {
  const version = String(runtime?.phpVersionLabel || "8.3").trim();
  return `php${version}-${extension}.so`;
}

function createManualXmlLibDefs(runtime) {
  return [
    {
      name: "libxml2.so",
      url: new URL("../../vendor/php-wasm-libxml/libxml2.so", import.meta.url),
      ini: false,
    },
    {
      name: buildPhpModuleFilename(runtime, "xml"),
      url: new URL(`../../vendor/php-wasm-xml/${buildPhpModuleFilename(runtime, "xml")}`, import.meta.url),
      ini: true,
    },
    {
      name: buildPhpModuleFilename(runtime, "dom"),
      url: new URL(`../../vendor/php-wasm-dom/${buildPhpModuleFilename(runtime, "dom")}`, import.meta.url),
      ini: true,
    },
    {
      name: buildPhpModuleFilename(runtime, "simplexml"),
      url: new URL(`../../vendor/php-wasm-simplexml/${buildPhpModuleFilename(runtime, "simplexml")}`, import.meta.url),
      ini: true,
    },
  ];
}

export function resolveSharedLibs(runtime) {
  const requested = new Set(runtime.sharedLibs || []);
  const resolved = [];

  // Load the libxml/xml family in a fixed order instead of relying on module shorthand.
  if (requested.has("libxml") || requested.has("xml") || requested.has("dom") || requested.has("simplexml")) {
    resolved.push(...createManualXmlLibDefs(runtime));
    requested.delete("libxml");
    requested.delete("xml");
    requested.delete("dom");
    requested.delete("simplexml");
  }

  for (const name of runtime.sharedLibs || []) {
    if (!requested.has(name)) {
      continue;
    }

    const lib = LIBS[name];
    if (!lib) {
      throw new Error(`Unknown PHP shared library '${name}' in runtime config.`);
    }
    resolved.push(lib);
  }

  return resolved;
}
