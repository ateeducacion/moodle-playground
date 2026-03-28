/**
 * Crash recovery utilities for the PHP WASM runtime.
 *
 * The PHP WASM runtime can crash with several classes of errors:
 *
 * 1. **WASM OOM / corruption** — `RuntimeError: memory access out of bounds`,
 *    `RuntimeError: unreachable`.  These indicate the WASM heap is corrupted
 *    and the runtime cannot be reused.
 *
 * 2. **Resource exhaustion** — `Failed to open stream: No file descriptors
 *    available`, `Failed opening required '/internal/shared/…'`.  These
 *    indicate resource limits inside the Emscripten sandbox.
 *
 * 3. **Bootstrap failures** — Errors during Moodle install/upgrade that
 *    prevent the runtime from reaching a usable state.
 *
 * Recovery strategy:
 *   - Reactive rotation detects fatal errors and discards the runtime.
 *   - Idempotent requests (GET/HEAD) are replayed once on a fresh runtime.
 *   - Non-idempotent requests are NOT replayed to avoid side-effects.
 *   - A request is never retried more than once (loop protection).
 *   - An anti-loop guard prevents restarts if too few requests were processed.
 *   - DB snapshot preserves session state (courses, users, config) across restarts.
 *
 * @module crash-recovery
 */

/**
 * Determine whether an error represents a fatal, unrecoverable WASM crash.
 * A crashed runtime MUST be discarded — it cannot be safely reused.
 *
 * @param {unknown} error - The caught error.
 * @returns {boolean} true if the error is a fatal WASM crash.
 */
/**
 * Detect Emscripten network errors (errno 23 = EHOSTUNREACH).
 * Firefox and Safari cannot make outbound HTTP calls from WASM,
 * causing crashes when PHP uses curl or file_get_contents on URLs.
 */
export function isEmscriptenNetworkError(error) {
  if (!error) return false;
  return error.errno === 23 || String(error.message || "").includes("errno 23");
}

export function isFatalWasmError(error) {
  if (!error) {
    return false;
  }

  // Emscripten network errors (EHOSTUNREACH) are fatal — the runtime
  // cannot recover from a failed outbound curl call in Firefox/Safari.
  if (isEmscriptenNetworkError(error)) {
    return true;
  }

  // Check for actual WebAssembly.RuntimeError instances first
  if (
    typeof WebAssembly !== "undefined" &&
    error instanceof WebAssembly.RuntimeError
  ) {
    return true;
  }

  const message = String(error.message || error);
  return (
    message.includes("memory access out of bounds") ||
    message.includes("table index is out of bounds") ||
    message.includes("null function or function signature mismatch") ||
    // Match "unreachable" as a WASM trap keyword
    /\bunreachable\b/u.test(message) ||
    // Match wrapped RuntimeError messages from WASM
    /\bRuntimeError\b/u.test(message) ||
    message.includes("No file descriptors available") ||
    message.includes("Failed opening required '/internal/shared/")
  );
}

/**
 * Determine whether a serialized request is safe to replay automatically
 * after a runtime crash.  Only idempotent HTTP methods are replayed to
 * avoid unintentional side-effects (e.g. double form submissions).
 *
 * @param {{ method?: string }} serializedRequest - The request descriptor.
 * @returns {boolean} true if the request can be safely retried.
 */
export function isSafeToReplay(serializedRequest) {
  const method = String(serializedRequest?.method || "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * Format an error into a human-readable string for display/logging.
 *
 * @param {unknown} error - The error to format.
 * @returns {string} Formatted error detail.
 */
export function formatErrorDetail(error) {
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

/**
 * Create a state snapshot manager for crash recovery.
 *
 * Instead of using @php-wasm/fs-journal (which replays FS operations and
 * conflicts with the fresh runtime's state), this takes a simpler approach:
 *
 * 1. Before destroying the crashed runtime, read the DB file and any
 *    runtime-installed plugin files directly from MEMFS (JS heap — works
 *    even with corrupted WASM linear memory).
 * 2. After bootstrapping a fresh runtime, overwrite the DB file and
 *    restore plugin directories. This preserves courses, users, config,
 *    and installed plugins.
 * 3. Re-create the admin session (auto-login) on the restored DB.
 *
 * @param {{ postShell: (msg: object) => void }} options
 * @returns {object} Snapshot manager with hydrate/restore methods.
 */
const FILEDIR_PATH = "/persist/moodledata/filedir";

export function createSnapshotManager({ postShell }) {
  let savedDbSnapshot = null;
  let savedPluginFiles = null;
  let savedFiledirFiles = null;
  /** Paths of plugin directories installed during this session. */
  const installedPluginDirs = new Set();

  /**
   * Recursively collect all files under a directory from the raw PHP FS.
   * Returns an array of { path, data } entries.
   */
  /**
   * Write an array of { path, data } entries into MEMFS with dir deduplication.
   * Returns { ok, failed } counts.
   */
  function restoreFiles(rawPhp, files) {
    let ok = 0;
    let failed = 0;
    const createdDirs = new Set();

    for (const file of files) {
      try {
        const lastSlash = file.path.lastIndexOf("/");
        const parentDir =
          lastSlash > 0 ? file.path.substring(0, lastSlash) : null;
        if (parentDir && !createdDirs.has(parentDir)) {
          rawPhp.mkdirTree(parentDir);
          let dir = parentDir;
          while (dir && !createdDirs.has(dir)) {
            createdDirs.add(dir);
            dir = dir.substring(0, dir.lastIndexOf("/")) || null;
          }
        }
        rawPhp.writeFile(file.path, file.data);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  function collectFiles(rawPhp, dirPath) {
    const files = [];
    try {
      const entries = rawPhp.listFiles(dirPath, { prependPath: true });
      for (const entry of entries) {
        if (rawPhp.isDir(entry)) {
          files.push(...collectFiles(rawPhp, entry));
        } else {
          try {
            const data = rawPhp.readFileAsBuffer(entry);
            files.push({ path: entry, data: new Uint8Array(data) });
          } catch {
            // Unreadable file — skip
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read — skip
    }
    return files;
  }

  return {
    /**
     * Read the DB file and plugin directories from the (possibly crashed)
     * runtime before it is destroyed. MEMFS lives in JS heap, so
     * readFileAsBuffer works even when the WASM linear memory is corrupted.
     *
     * Must be called BEFORE resetRuntime() / destroying the old PHP.
     *
     * @param {object} php - The php-compat wrapper (has ._php)
     * @param {string} dbPath - Full path to the SQLite DB file
     */
    async hydrate(php, dbPath) {
      const rawPhp = php._php;

      // 1. Save the DB file
      try {
        const data = rawPhp.readFileAsBuffer(dbPath);
        if (data && data.byteLength > 0) {
          savedDbSnapshot = { path: dbPath, data: new Uint8Array(data) };
          postShell({
            kind: "trace",
            detail: `[snapshot] saved DB (${data.byteLength} bytes)`,
          });
        }
      } catch (err) {
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read DB: ${err.message}`,
        });
      }

      // 2. Save files from plugin directories installed during this session
      if (installedPluginDirs.size > 0) {
        postShell({
          kind: "trace",
          detail: `[snapshot] hydrating ${installedPluginDirs.size} tracked plugin dirs: ${[...installedPluginDirs].join(", ")}`,
        });
        const allFiles = [];
        for (const dir of installedPluginDirs) {
          try {
            if (!rawPhp.fileExists(dir)) {
              postShell({
                kind: "trace",
                detail: `[snapshot] plugin dir not found: ${dir}`,
              });
              continue;
            }
            const files = collectFiles(rawPhp, dir);
            if (files.length > 0) {
              allFiles.push(...files);
              postShell({
                kind: "trace",
                detail: `[snapshot] collected ${files.length} files from ${dir}`,
              });
            }
          } catch (err) {
            postShell({
              kind: "error",
              detail: `[snapshot] failed to read plugin dir ${dir}: ${err.message}`,
            });
          }
        }
        if (allFiles.length > 0) {
          savedPluginFiles = allFiles;
          postShell({
            kind: "trace",
            detail: `[snapshot] saved ${allFiles.length} plugin files total`,
          });
        } else {
          postShell({
            kind: "trace",
            detail: `[snapshot] no plugin files collected from tracked dirs`,
          });
        }
      } else {
        postShell({
          kind: "trace",
          detail: `[snapshot] no plugin dirs tracked, skipping plugin hydration`,
        });
      }

      // 3. Save user-uploaded files (stored files in filedir)
      try {
        if (rawPhp.fileExists(FILEDIR_PATH) && rawPhp.isDir(FILEDIR_PATH)) {
          const files = collectFiles(rawPhp, FILEDIR_PATH);
          if (files.length > 0) {
            savedFiledirFiles = files;
            const totalBytes = files.reduce(
              (sum, f) => sum + f.data.byteLength,
              0,
            );
            postShell({
              kind: "trace",
              detail: `[snapshot] saved ${files.length} filedir entries (${Math.round(totalBytes / 1024)}KB)`,
            });
          }
        }
      } catch (err) {
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read filedir: ${err.message}`,
        });
      }
    },

    /**
     * Restore the saved DB and plugin files onto a fresh runtime.
     *
     * @param {object} php - The php-compat wrapper (has ._php)
     */
    async restore(php) {
      if (!savedDbSnapshot && !savedPluginFiles && !savedFiledirFiles) {
        return {
          restored: false,
          pluginsRestored: false,
          restoredPluginDirs: [],
        };
      }
      const rawPhp = php._php;
      let restored = false;
      let pluginsRestored = false;
      const restoredPluginDirs = [];

      // 1. Restore DB
      if (savedDbSnapshot) {
        try {
          rawPhp.writeFile(savedDbSnapshot.path, savedDbSnapshot.data);
          postShell({
            kind: "trace",
            detail: `[snapshot] restored DB (${savedDbSnapshot.data.byteLength} bytes)`,
          });
          restored = true;
        } catch (err) {
          postShell({
            kind: "error",
            detail: `[snapshot] failed to restore DB: ${err.message}`,
          });
        }
        savedDbSnapshot = null;
      }

      // 2. Restore plugin files directly into MEMFS.
      if (savedPluginFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedPluginFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} plugin files${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
          pluginsRestored = true;
          restoredPluginDirs.push(...installedPluginDirs);
        }
        savedPluginFiles = null;
      }

      // 3. Restore filedir (user-uploaded content)
      if (savedFiledirFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedFiledirFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} filedir entries${failed > 0 ? ` (${failed} failed)` : ""}`,
        });
        if (ok > 0) {
          restored = true;
        }
        savedFiledirFiles = null;
      }

      return { restored, pluginsRestored, restoredPluginDirs };
    },

    /** Whether there is a saved snapshot waiting to be restored. */
    get hasPendingRestore() {
      return (
        savedDbSnapshot !== null ||
        savedPluginFiles !== null ||
        savedFiledirFiles !== null
      );
    },

    /**
     * Register a plugin directory that was installed during this session.
     * Called by the worker when installMoodlePlugin/installTheme runs.
     * Only tracked dirs are included in the snapshot on crash.
     *
     * @param {string} dirPath - e.g. "/www/moodle/mod/attendance"
     */
    trackPluginDir(dirPath) {
      installedPluginDirs.add(dirPath);
      postShell({
        kind: "trace",
        detail: `[snapshot] tracking installed plugin: ${dirPath}`,
      });
    },

    /** Discard any saved snapshot. */
    clear() {
      savedDbSnapshot = null;
      savedPluginFiles = null;
      savedFiledirFiles = null;
    },
  };
}
