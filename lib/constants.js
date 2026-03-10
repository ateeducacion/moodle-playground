import { RUNTIME_ENV } from "./runtime-env.js";

const env = RUNTIME_ENV || {};

export const PHP_WASM_VERSION = env.PHP_WASM_VERSION || "0.0.9-alpha-32";

export const SERVICE_WORKER_URL = "./sw.js";
export const MOODLE_BASE_PATH = "/moodle";
export const DEFAULT_MOODLE_VERSION = env.MOODLE_DEFAULT_VERSION || "4.4";
export const AVAILABLE_MOODLE_VERSIONS = (env.MOODLE_AVAILABLE_VERSIONS || "4.3,4.4")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
export const MOODLE_ASSET_BASE_URL = env.MOODLE_ASSET_BASE_URL || "./vendor/moodle";
export const DEFAULT_MOODLE_MANIFEST_URL =
  env.MOODLE_MANIFEST_URL || `${MOODLE_ASSET_BASE_URL}/${DEFAULT_MOODLE_VERSION}/manifest.json`;

export const DOCROOT = "/persist/www/moodle";
export const MOODLE_ROOT = DOCROOT;
export const MOODLEDATA_ROOT = "/persist/moodledata";
export const TEMP_ROOT = "/persist/tmp/moodle";

export const DEFAULT_BOOT_OPTIONS = {
  adminUser: env.MOODLE_ADMIN_USER || "admin",
  dbName: env.MOODLE_DB_NAME || "moodle",
  dbUser: env.MOODLE_DB_USER || "postgres",
  dbPassword: env.MOODLE_DB_PASSWORD || "postgres",
  dbHost: env.MOODLE_DB_HOST || "idb-storage",
  moodleVersion: DEFAULT_MOODLE_VERSION,
  moodleManifestUrl: DEFAULT_MOODLE_MANIFEST_URL,
  prefix: env.MOODLE_DB_PREFIX || "mdl_",
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
