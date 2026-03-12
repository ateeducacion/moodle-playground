export const PHP_WASM_VERSION = "0.0.9-alpha-32";
export const PHP_WASM_MODULE_URL = "/vendor/php-wasm/PhpWeb.js";
export const PHP_CGI_WASM_ESM_URL = "/vendor/php-cgi-wasm/php-cgi-worker.js";
export const PHP_CGI_WORKER_MODULE_URL = "/vendor/php-cgi-wasm/PhpCgiWorker.js";
export const PHP_CGI_MSG_BUS_URL = "/vendor/php-cgi-wasm/msg-bus.js";
export const FFLATE_MODULE_URL = "/vendor/fflate-browser.js";

export const SERVICE_WORKER_URL = "./sw.js";
export const PHP_WORKER_URL = "./php-worker.js";
export const PHP_BRIDGE_CHANNEL = "moodle-playground-php-bridge-v1";
export const DEFAULT_MANIFEST_URL = "./assets/manifests/latest.json";
export const BUNDLE_CACHE_NAME = "moodle-playground-bundles-v1";
export const MOODLE_BASE_PATH = "/moodle";
export const DOCROOT = "/persist/www";
export const MOODLE_ROOT = `${DOCROOT}${MOODLE_BASE_PATH}`;
export const MOODLEDATA_ROOT = "/persist/moodledata";
export const MANIFEST_STATE_PATH = "/config/moodle-playground-manifest.json";
export const TEMP_ROOT = "/tmp/moodle";

export const DEFAULT_BOOT_OPTIONS = {
  adminUser: "admin",
  dbName: "moodle",
  dbUser: "",
  dbPassword: "",
  dbHost: "localhost",
  manifestUrl: DEFAULT_MANIFEST_URL,
  prefix: "mdl_",
};

export const CGI_MIME_TYPES = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
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

export const OPTIONAL_EXTENSION_NOTES = [
  "Moodle 4.4 exige o recomienda varias extensiones de PHP que el runtime estándar puede no tener activadas.",
  "Si el instalador se detiene por requisitos, el siguiente paso es servir las librerías compartidas de php-wasm y añadirlas a `sharedLibs`.",
];
