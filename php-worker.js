import { PhpCgiWorker } from "./vendor/php-cgi-wasm/PhpCgiWorker.js";
import { PGlite } from "./vendor/pglite/index.js";
import * as PhpWasmDom from "./vendor/php-wasm-dom/index.js";
import * as PhpWasmIconv from "./vendor/php-wasm-iconv/index.js";
import * as PhpWasmIntl from "./vendor/php-wasm-intl/index.js";
import * as PhpWasmLibxml from "./vendor/php-wasm-libxml/index.js";
import * as PhpWasmLibzip from "./vendor/php-wasm-libzip/index.js";
import * as PhpWasmMbstring from "./vendor/php-wasm-mbstring/index.js";
import * as PhpWasmOpenssl from "./vendor/php-wasm-openssl/index.js";
import * as PhpWasmPhar from "./vendor/php-wasm-phar/index.js";
import * as PhpWasmSimplexml from "./vendor/php-wasm-simplexml/index.js";
import * as PhpWasmZlib from "./vendor/php-wasm-zlib/index.js";
import {
  CGI_MIME_TYPES,
  DEFAULT_BOOT_OPTIONS,
  DOCROOT,
  MANIFEST_STATE_PATH,
  MOODLE_BASE_PATH,
  MOODLEDATA_ROOT,
  MOODLE_ROOT,
  OPTIONAL_EXTENSION_NOTES,
  PHP_BRIDGE_CHANNEL,
  TEMP_ROOT,
} from "./lib/constants.js";
import {
  createBootstrapNotice,
  createPhpIni,
} from "./lib/config-template.js";
import { mountReadonlyVfs } from "./lib/vfs-mount.js";
import {
  ensureDir,
  extractZipEntries,
  resolveBootstrapArchive,
  writeEntriesToPhp,
} from "./lib/moodle-loader.js";

const bootState = {
  active: false,
  ready: false,
  lastError: null,
  entryUrl: `${MOODLE_BASE_PATH}/install.php`,
  manifest: null,
  sourceKind: null,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const bridgeChannel = new BroadcastChannel(PHP_BRIDGE_CHANNEL);
let requestQueue = Promise.resolve();

globalThis.__moodleDebugHook = (detail) => {
  publish({
    kind: "bootstrap-progress",
    phase: "php-runtime",
    detail,
    timestamp: nowIso(),
  });
};
let lastFsDebugAt = 0;
globalThis.__moodleFsDebugHook = (detail) => {
  const now = Date.now();

  if (now - lastFsDebugAt < 200) {
    return;
  }

  lastFsDebugAt = now;
  publish({
    kind: "bootstrap-progress",
    phase: "php-fs",
    detail,
    timestamp: nowIso(),
  });
};
globalThis.__moodleDisablePhpStaticCache = true;
globalThis.__moodleDisablePhpSyncfs = true;
const sharedLibs = [
  PhpWasmLibxml,
  PhpWasmIconv,
  PhpWasmIntl,
  PhpWasmDom,
  PhpWasmSimplexml,
  PhpWasmZlib,
  PhpWasmLibzip,
  PhpWasmMbstring,
  PhpWasmOpenssl,
  PhpWasmPhar,
];

function nowIso() {
  return new Date().toISOString();
}

function publish(message) {
  self.postMessage(message);
}

function publishProgress(phase, detail, progress = null) {
  publish({
    kind: "bootstrap-progress",
    phase,
    detail,
    progress,
    timestamp: nowIso(),
  });
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return String(error.stack || error.message || error);
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function buildLoadingResponse(message, status = 503) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Moodle Playground</title><body><pre>${message}</pre></body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function headersToObject(headers) {
  return Object.fromEntries(headers.entries());
}

function buildManifestState(manifest) {
  return {
    release: manifest?.release || null,
    sha256: manifest?.vfs?.data?.sha256 || manifest?.bundle?.sha256 || null,
    bundlePath: manifest?.vfs?.data?.path || manifest?.bundle?.path || null,
  };
}

function manifestStateMatches(savedState, manifest) {
  const nextState = buildManifestState(manifest);
  return (
    savedState?.release === nextState.release
    && savedState?.sha256 === nextState.sha256
    && savedState?.bundlePath === nextState.bundlePath
  );
}

async function readJsonFile(php, path) {
  const about = await php.analyzePath(path);

  if (!about?.exists) {
    return null;
  }

  const data = await php.readFile(path);
  return JSON.parse(textDecoder.decode(data));
}

async function writeJsonFile(php, path, value) {
  await php.writeFile(path, textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`));
}

async function serializeResponse(response) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
    body: await response.arrayBuffer(),
  };
}

function deserializeRequest(requestLike) {
  const init = {
    method: requestLike.method,
    headers: requestLike.headers,
  };

  if (requestLike.method !== "GET" && requestLike.method !== "HEAD" && requestLike.body) {
    init.body = requestLike.body;
  }

  return new Request(requestLike.url, init);
}

const php = new PhpCgiWorker({
  PGlite,
  prefix: MOODLE_BASE_PATH,
  docroot: MOODLE_ROOT,
  sharedLibs,
  types: CGI_MIME_TYPES,
  rewrite: (pathname) => {
    if (pathname === MOODLE_BASE_PATH || pathname === `${MOODLE_BASE_PATH}/`) {
      return `${MOODLE_BASE_PATH}/install.php`;
    }

    return pathname;
  },
});

async function bootstrapMoodle(rawOptions = {}) {
  if (bootState.active) {
    return {
      ok: false,
      ready: bootState.ready,
      message: "Bootstrap already running.",
      entryUrl: bootState.entryUrl,
    };
  }

  const options = { ...DEFAULT_BOOT_OPTIONS, ...rawOptions };
  const origin = options.origin || self.location.origin;
  const timezone = options.timezone || "UTC";

  bootState.active = true;
  bootState.ready = false;
  bootState.lastError = null;

  try {
    await publishProgress("runtime", "Refreshing php-cgi-wasm runtime.", 0.02);
    await php.refresh();

    await publishProgress("manifest", `Resolving Moodle bundle from ${options.manifestUrl}`, 0.1);
    const archive = await resolveBootstrapArchive(options, ({ ratio, cached, phase, detail }) => {
      if (phase === "manifest") {
        return publishProgress("manifest", detail, 0.12);
      }

      if (phase === "cache-bust") {
        return publishProgress("download", detail, 0.18);
      }

      const progress = cached ? 0.45 : 0.14 + (typeof ratio === "number" ? ratio * 0.31 : 0);
      const label = cached ? "Restoring cached Moodle bundle." : "Downloading Moodle bundle.";
      return publishProgress("download", label, progress);
    });

    await publishProgress("filesystem", "Creating Moodle directories.", 0.06);
    await ensureDir(php, DOCROOT);
    await ensureDir(php, MOODLE_ROOT);
    await ensureDir(php, MOODLEDATA_ROOT);
    await ensureDir(php, `${MOODLEDATA_ROOT}/cache`);
    await ensureDir(php, `${MOODLEDATA_ROOT}/localcache`);
    await ensureDir(php, `${MOODLEDATA_ROOT}/sessions`);
    await ensureDir(php, TEMP_ROOT);
    await ensureDir(php, `${TEMP_ROOT}/sessions`);

    let fileCount = 0;

    if (archive.kind === "vfs-image") {
      await publishProgress("archive", "Mounting the prebuilt VFS image.", 0.48);
      const binary = await php.binary;
      mountReadonlyVfs(binary, {
        imageBytes: archive.bytes,
        entries: archive.image.entries || [],
        mountPath: MOODLE_ROOT,
        writablePaths: [`${MOODLE_ROOT}/config.php`],
      });
      fileCount = archive.image.entries?.length || 0;
      await publishProgress("filesystem", `Mounted ${fileCount} files from the VFS image.`, 0.88);

      const installEntry = archive.image.entries?.find((entry) => entry.path === "install.php");
      const mountedInstall = binary.FS.readFile(`${MOODLE_ROOT}/install.php`, { encoding: "binary" });
      const mountedTail = textDecoder.decode(
        mountedInstall.subarray(Math.max(0, mountedInstall.length - 120)),
      );
      await publishProgress(
        "filesystem",
        `Mounted install.php sanity: read=${mountedInstall.length} expected=${installEntry?.size || 0} tail=${JSON.stringify(mountedTail)}`,
        0.89,
      );
    } else {
      const savedState = await readJsonFile(php, MANIFEST_STATE_PATH);
      const configAbout = await php.analyzePath(`${MOODLE_ROOT}/config.php`);
      const canReuseHydratedTree = manifestStateMatches(savedState, archive.manifest) && configAbout?.exists;

      if (canReuseHydratedTree) {
        await publishProgress("filesystem", "Reusing persisted Moodle core from previous hydration.", 0.88);
        fileCount = archive.manifest?.bundle?.fileCount || 0;
      } else {
        await publishProgress(
          "archive",
          "Expanding prebuilt Moodle bundle into memory.",
          0.48,
        );
        const entries = extractZipEntries(archive.bytes);

        await publishProgress("filesystem", `Writing ${entries.length} files to the PHP VFS.`, 0.52);
        await writeEntriesToPhp(php, entries, MOODLE_ROOT, ({ ratio, path }) =>
          publishProgress("filesystem", `Writing ${path}`, 0.52 + ratio * 0.36),
        );
        fileCount = entries.length;
      }

      await publishProgress(
        "config",
        "Persisting manifest marker for the hydrated tree.",
        0.9,
      );
      await writeJsonFile(php, MANIFEST_STATE_PATH, buildManifestState(archive.manifest));
    }

    const phpIni = createPhpIni({ timezone });

    await publishProgress("config", "Generating php.ini and bootstrap helpers.", 0.92);
    await php.writeFile(`${DOCROOT}/php.ini`, textEncoder.encode(phpIni));
    await php.writeFile(
      `${DOCROOT}/playground-bootstrap.php`,
      textEncoder.encode(createBootstrapNotice()),
    );

    bootState.active = false;
    bootState.ready = true;
    bootState.entryUrl = `${MOODLE_BASE_PATH}/install.php?lang=en`;
    bootState.manifest = archive.manifest;
    bootState.sourceKind = archive.kind;

    publish({
      kind: "bootstrap-ready",
      entryUrl: bootState.entryUrl,
      notes: OPTIONAL_EXTENSION_NOTES,
      manifest: archive.manifest,
      sourceKind: archive.kind,
      timestamp: nowIso(),
    });

    return {
      ok: true,
      entryUrl: bootState.entryUrl,
      notes: OPTIONAL_EXTENSION_NOTES,
      manifest: archive.manifest,
      sourceKind: archive.kind,
      fileCount,
    };
  } catch (error) {
    bootState.active = false;
    bootState.ready = false;
    bootState.lastError = formatError(error);

    publish({
      kind: "bootstrap-error",
      error: bootState.lastError,
      timestamp: nowIso(),
    });

    throw error;
  }
}

self.addEventListener("message", async (event) => {
  const { id, action, params } = event.data || {};

  if (!id || !action) {
    return;
  }

  try {
    let result;

    if (action === "bootstrapMoodle") {
      result = await bootstrapMoodle(params || {});
    } else if (action === "getBootState") {
      result = { ...bootState };
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    self.postMessage({ kind: "rpc-result", id, result });
  } catch (error) {
    self.postMessage({
      kind: "rpc-error",
      id,
      error: formatError(error),
    });
  }
});

bridgeChannel.addEventListener("message", async (event) => {
  const data = event.data;

  if (!data || data.kind !== "http-request" || !data.id) {
    return;
  }

  requestQueue = requestQueue.then(async () => {
    try {
      let response;

      if (!bootState.ready) {
        response = buildLoadingResponse("Moodle Playground is bootstrapping. Please wait.");
      } else {
        publish({
          kind: "bootstrap-progress",
          phase: "request",
          detail: `Handling PHP request ${data.request?.method || "GET"} ${data.request?.url || ""}`,
          timestamp: nowIso(),
        });
        response = await php.request(deserializeRequest(data.request));
        publish({
          kind: "bootstrap-progress",
          phase: "request",
          detail: `Completed PHP request ${data.request?.method || "GET"} ${data.request?.url || ""} with ${response.status}`,
          timestamp: nowIso(),
        });
      }

      bridgeChannel.postMessage({
        kind: "http-response",
        id: data.id,
        response: await serializeResponse(response),
      });
    } catch (error) {
      bridgeChannel.postMessage({
        kind: "http-error",
        id: data.id,
        error: formatError(error),
      });
    }
  }).catch(() => {});
});
