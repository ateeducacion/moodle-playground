import {
  __private__dont__use,
  PHP,
  setPhpIniEntries,
} from "@php-wasm/universal";
import {
  certificateToPEM,
  generateCertificate,
  loadWebRuntime,
} from "@php-wasm/web";
import { DEFAULT_PHP_VERSION } from "../shared/version-resolver.js";
import {
  CHDIR_FIX_PRELOAD_PATH,
  createChdirFixPhp,
  createPhpIniEntries,
  MOODLE_ROOT,
} from "./config-template.js";
import { wrapPhpInstance } from "./php-compat.js";

const PERSIST_ROOT = "/persist";
const TEMP_ROOT = "/tmp/moodle";
const TCP_OVER_FETCH_CA_PATH = "/internal/shared/playground-ca.pem";

let cachedTcpOverFetchCaPromise = null;

function resolveCorsProxyUrl(options = {}) {
  return options.corsProxyUrl ?? options.phpCorsProxyUrl ?? null;
}

function mergeDefinedOptions(base = {}, overrides = {}) {
  const merged = { ...(base || {}) };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

async function getTcpOverFetchOptions(corsProxyUrl) {
  if (!cachedTcpOverFetchCaPromise) {
    cachedTcpOverFetchCaPromise = generateCertificate({
      subject: {
        commonName: "Moodle Playground CA",
        organizationName: "Moodle Playground",
        countryName: "US",
      },
      basicConstraints: {
        ca: true,
      },
    });
  }

  return {
    CAroot: await cachedTcpOverFetchCaPromise,
    ...(corsProxyUrl ? { corsProxyUrl } : {}),
  };
}

function buildPhpIniEntries({ tcpOverFetchEnabled = false } = {}) {
  const entries = createPhpIniEntries();
  if (!tcpOverFetchEnabled) {
    return entries;
  }

  return {
    ...entries,
    "openssl.cafile": TCP_OVER_FETCH_CA_PATH,
    "curl.cainfo": TCP_OVER_FETCH_CA_PATH,
  };
}

export const __testing = {
  buildPhpIniEntries,
  getTcpOverFetchOptions,
  resolveCorsProxyUrl,
  TCP_OVER_FETCH_CA_PATH,
};

/**
 * Create the primary PHP CGI runtime for serving Moodle requests.
 *
 * Returns a deferred object:
 * - Call refresh() to initialize the runtime (loads WASM)
 * - Then use request(), writeFile(), readFile(), etc.
 */
export function createPhpRuntime(
  _runtime,
  {
    appBaseUrl,
    phpVersion,
    webRoot,
    corsProxyUrl,
    phpCorsProxyUrl,
    scopeId,
    forceCleanBoot,
  } = {},
) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  const resolvedCorsProxyUrl = resolveCorsProxyUrl(
    mergeDefinedOptions(_runtime, {
      corsProxyUrl,
      phpCorsProxyUrl,
    }),
  );
  let wrapped = null;
  let persistenceController = null;

  const deferred = {
    /**
     * Initialize the PHP runtime. Must be called before any other method.
     */
    async refresh() {
      const tcpOverFetch = await getTcpOverFetchOptions(resolvedCorsProxyUrl);
      const runtimeId = await loadWebRuntime(resolvedPhpVersion, {
        ...(tcpOverFetch ? { tcpOverFetch } : {}),
        withIntl: true,
        // Lower initial WASM memory allocation + explicit growth.
        // Reduces peak memory at boot and allows the heap to grow only as
        // needed (inspired by WP Playground lower-initial-memory work).
        // 128 MiB starting point is a compromise for Moodle's size.
        emscriptenOptions: {
          INITIAL_MEMORY: 128 * 1024 * 1024,
          ALLOW_MEMORY_GROWTH: 1,
        },
      });
      const php = new PHP(runtimeId);
      const FS = php[__private__dont__use].FS;
      persistenceController = null;

      // Ensure directories exist
      try {
        FS.mkdirTree(TEMP_ROOT);
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree(`${TEMP_ROOT}/sessions`);
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree(MOODLE_ROOT);
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree(PERSIST_ROOT);
      } catch {
        /* exists */
      }

      // Restore persisted mutable data (/persist) before Moodle bootstraps, so
      // the install gate finds the existing DB/marker and skips CLI provisioning.
      // Keyed by scopeId (sessionStorage) → data survives reloads within the tab
      // session. forceCleanBoot (reset / blueprint change) wipes it instead.
      if (scopeId) {
        const { clearJournal, initFsPersistence } = await import(
          "./fs-persistence.js"
        );
        // On a clean boot (reset / blueprint change), wipe the old journal first;
        // then ALWAYS start journaling — replaying whatever remains (nothing,
        // after a wipe) and recording new writes — so the fresh env is persisted
        // and a later reload of the same blueprint reuses it instead of
        // reinstalling.
        if (forceCleanBoot) {
          await clearJournal(scopeId);
        }
        persistenceController = await initFsPersistence(php, scopeId);
      }

      // Write glob polyfill + chdir fix into WP Playground's preload dir
      try {
        FS.mkdirTree("/internal/shared/preload");
      } catch {
        /* exists */
      }
      try {
        FS.mkdirTree("/internal/shared/opcache");
      } catch {
        /* exists */
      }
      if (tcpOverFetch) {
        php.writeFile(
          TCP_OVER_FETCH_CA_PATH,
          `${certificateToPEM(tcpOverFetch.CAroot.certificate)}\n`,
        );
      }

      // Apply Moodle php.ini settings to /internal/shared/php.ini
      await setPhpIniEntries(
        php,
        buildPhpIniEntries({ tcpOverFetchEnabled: true }),
      );

      php.writeFile(CHDIR_FIX_PRELOAD_PATH, createChdirFixPhp());

      const absoluteUrl = (appBaseUrl || "http://localhost:8080").replace(
        /\/$/u,
        "",
      );
      wrapped = wrapPhpInstance(php, { syncFs: null, absoluteUrl, webRoot });

      // Copy all methods from the wrapped instance onto this deferred object
      for (const key of Object.keys(wrapped)) {
        if (key !== "refresh") {
          deferred[key] = wrapped[key];
        }
      }

      Object.defineProperty(deferred, "binary", {
        get() {
          return wrapped.binary;
        },
        configurable: true,
      });
      Object.defineProperty(deferred, "_php", {
        get() {
          return wrapped._php;
        },
        configurable: true,
      });
    },

    /**
     * Flush pending persistence operations before a runtime is discarded.
     *
     * @param {object} options - Optional path and byte limits for the flush.
     * @returns {Promise<object>} Flush status and metrics.
     */
    async flushPersistence(options = {}) {
      if (!persistenceController) {
        return {
          enabled: false,
          ok: true,
          flushedOps: 0,
          hydratedBytes: 0,
          estimatedBytes: 0,
        };
      }

      return {
        enabled: true,
        ...(await persistenceController.flushNow(options)),
      };
    },

    // Placeholder methods that throw if called before refresh()
    async request() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async analyzePath() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async mkdir() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async writeFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async readFile() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    async run() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return deferred;
}

/**
 * Create a lightweight PHP runtime for provisioning tasks (phpinfo capture).
 */
export function createProvisioningRuntime(_runtime, { phpVersion } = {}) {
  const resolvedPhpVersion = phpVersion || DEFAULT_PHP_VERSION;
  const resolvedCorsProxyUrl = resolveCorsProxyUrl(_runtime || {});
  let wrapped = null;

  const deferred = {
    async refresh() {
      const tcpOverFetch = await getTcpOverFetchOptions(resolvedCorsProxyUrl);
      const runtimeId = await loadWebRuntime(resolvedPhpVersion, {
        ...(tcpOverFetch ? { tcpOverFetch } : {}),
        withIntl: true,
        // Lower initial WASM memory allocation + explicit growth.
        // Reduces peak memory at boot and allows the heap to grow only as
        // needed (inspired by WP Playground lower-initial-memory work).
        // 128 MiB starting point is a compromise for Moodle's size.
        emscriptenOptions: {
          INITIAL_MEMORY: 128 * 1024 * 1024,
          ALLOW_MEMORY_GROWTH: 1,
        },
      });
      const php = new PHP(runtimeId);
      const FS2 = php[__private__dont__use].FS;

      // Write glob polyfill + chdir fix into WP Playground's preload dir
      try {
        FS2.mkdirTree("/internal/shared/preload");
      } catch {
        /* exists */
      }
      if (tcpOverFetch) {
        php.writeFile(
          TCP_OVER_FETCH_CA_PATH,
          `${certificateToPEM(tcpOverFetch.CAroot.certificate)}\n`,
        );
      }

      // Apply Moodle php.ini settings so phpinfo reflects correct values
      await setPhpIniEntries(
        php,
        buildPhpIniEntries({ tcpOverFetchEnabled: true }),
      );

      php.writeFile(CHDIR_FIX_PRELOAD_PATH, createChdirFixPhp());

      wrapped = wrapPhpInstance(php);

      for (const key of Object.keys(wrapped)) {
        if (key !== "refresh") {
          deferred[key] = wrapped[key];
        }
      }
    },

    async run() {
      throw new Error("PHP runtime not initialized. Call refresh() first.");
    },
    addEventListener() {},
    removeEventListener() {},
  };

  return deferred;
}
