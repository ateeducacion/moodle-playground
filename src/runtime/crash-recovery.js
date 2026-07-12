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
 *   - Pending filedir journal changes are checkpointed before the DB snapshot.
 *
 * @module crash-recovery
 */

const FILEDIR_PATH = "/persist/moodledata/filedir";
const DEFAULT_MAX_CRASH_FILEDIR_BYTES = 16 * 1024 * 1024;

/**
 * Detect Emscripten network errors (errno 23 = EHOSTUNREACH).
 * Firefox and Safari cannot make outbound HTTP calls from WASM,
 * causing crashes when PHP uses curl or file_get_contents on URLs.
 */
export function isEmscriptenNetworkError(error) {
  if (!error) return false;
  return error.errno === 23 || String(error.message || "").includes("errno 23");
}

/**
 * Determine whether an error represents a fatal, unrecoverable WASM crash.
 * A crashed runtime MUST be discarded — it cannot be safely reused.
 *
 * @param {unknown} error - The caught error.
 * @returns {boolean} true if the error is a fatal WASM crash.
 */
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
 * The persisted filesystem journal remains the source of truth for filedir.
 * Before capturing the DB, the manager forces only pending filedir operations
 * into IndexedDB. This keeps the restored DB and user files on the same crash
 * checkpoint without copying the complete filedir into JavaScript memory.
 *
 * If filesystem persistence is unavailable, a bounded in-memory filedir
 * snapshot is used. If that fallback exceeds the configured limit, recovery
 * skips the live snapshot and falls back to the last coherent persisted state.
 * Runtime-installed plugin directories are still snapshotted because they live
 * outside /persist and are not covered by the filesystem journal.
 *
 * @param {object} options - Snapshot manager options.
 * @param {(msg: object) => void} options.postShell - Shell message callback.
 * @param {number} [options.maxCrashFiledirBytes] - Crash checkpoint byte limit.
 * @returns {object} Snapshot manager with hydrate/restore methods.
 */
export function createSnapshotManager({
  postShell,
  maxCrashFiledirBytes = DEFAULT_MAX_CRASH_FILEDIR_BYTES,
}) {
  let savedDbSnapshot = null;
  let savedPluginFiles = null;
  let savedFiledirFiles = null;
  /** Paths of plugin directories installed during this session. */
  const installedPluginDirs = new Set();

  function clearSavedState() {
    savedDbSnapshot = null;
    savedPluginFiles = null;
    savedFiledirFiles = null;
  }

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

  /** Recursively collect all files under a directory. */
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

  /** Recursively collect files while enforcing an upper byte bound. */
  function collectFilesBounded(rawPhp, dirPath, maxBytes) {
    const files = [];
    let totalBytes = 0;
    let exceeded = false;

    const visit = (path) => {
      if (exceeded) return;
      let entries;
      try {
        entries = rawPhp.listFiles(path, { prependPath: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (exceeded) return;
        if (rawPhp.isDir(entry)) {
          visit(entry);
          continue;
        }

        try {
          const data = new Uint8Array(rawPhp.readFileAsBuffer(entry));
          if (totalBytes + data.byteLength > maxBytes) {
            exceeded = true;
            files.length = 0;
            return;
          }
          totalBytes += data.byteLength;
          files.push({ path: entry, data });
        } catch {
          // Unreadable file — skip
        }
      }
    };

    visit(dirPath);
    return { exceeded, files, totalBytes };
  }

  async function prepareFiledirCheckpoint(php, rawPhp) {
    if (typeof php.flushPersistence === "function") {
      try {
        const result = await php.flushPersistence({
          pathPrefix: FILEDIR_PATH,
          maxBytes: maxCrashFiledirBytes,
        });

        if (result?.enabled) {
          if (!result.ok) {
            const sizeDetail =
              result.reason === "size-limit"
                ? ` (${Math.round((result.estimatedBytes || 0) / 1024)}KB exceeds ${Math.round(maxCrashFiledirBytes / 1024)}KB limit)`
                : "";
            postShell({
              kind: "error",
              detail: `[snapshot] filedir checkpoint failed${sizeDetail}; using the last persisted checkpoint`,
            });
            return { ok: false, mode: "journal", reason: result.reason };
          }

          postShell({
            kind: "trace",
            detail: `[snapshot] checkpointed ${result.flushedOps || 0} pending filedir ops (${Math.round((result.hydratedBytes || 0) / 1024)}KB)`,
          });
          return { ok: true, mode: "journal" };
        }
      } catch (error) {
        postShell({
          kind: "error",
          detail: `[snapshot] filedir checkpoint failed: ${error.message}; using the last persisted checkpoint`,
        });
        return { ok: false, mode: "journal", reason: "flush-failed" };
      }
    }

    // Lightweight mocks and runtimes without filesystem helpers have no
    // recoverable filedir. Treat them as an empty bounded fallback.
    if (
      typeof rawPhp?.fileExists !== "function" ||
      typeof rawPhp?.isDir !== "function"
    ) {
      return { ok: true, mode: "fallback", files: [] };
    }

    let hasFiledir = false;
    try {
      hasFiledir =
        rawPhp.fileExists(FILEDIR_PATH) && rawPhp.isDir(FILEDIR_PATH);
    } catch {
      return { ok: true, mode: "fallback", files: [] };
    }

    if (!hasFiledir) {
      return { ok: true, mode: "fallback", files: [] };
    }

    const fallback = collectFilesBounded(
      rawPhp,
      FILEDIR_PATH,
      maxCrashFiledirBytes,
    );
    if (fallback.exceeded) {
      postShell({
        kind: "error",
        detail: `[snapshot] bounded filedir fallback exceeds ${Math.round(maxCrashFiledirBytes / 1024)}KB; skipping live snapshot`,
      });
      return { ok: false, mode: "fallback", reason: "size-limit" };
    }

    postShell({
      kind: "trace",
      detail: `[snapshot] saved bounded filedir fallback (${fallback.files.length} entries, ${Math.round(fallback.totalBytes / 1024)}KB)`,
    });
    return { ok: true, mode: "fallback", files: fallback.files };
  }

  return {
    /**
     * Capture a coherent recovery checkpoint from the crashed runtime.
     *
     * Must be called BEFORE resetRuntime() / destroying the old PHP.
     *
     * @param {object} php - The php-compat wrapper (has ._php).
     * @param {string} dbPath - Full path to the SQLite DB file.
     * @returns {Promise<object>} Snapshot capture result.
     */
    async hydrate(php, dbPath) {
      clearSavedState();
      const rawPhp = php._php;
      const filedirCheckpoint = await prepareFiledirCheckpoint(php, rawPhp);

      if (!filedirCheckpoint.ok) {
        return {
          captured: false,
          reason: filedirCheckpoint.reason || "filedir-checkpoint-failed",
        };
      }

      if (
        filedirCheckpoint.mode === "fallback" &&
        filedirCheckpoint.files.length > 0
      ) {
        savedFiledirFiles = filedirCheckpoint.files;
      }

      // 1. Save the DB only after filedir has reached the same checkpoint.
      try {
        const data = rawPhp.readFileAsBuffer(dbPath);
        if (!data || data.byteLength === 0) {
          throw new Error("DB snapshot is empty");
        }
        savedDbSnapshot = { path: dbPath, data: new Uint8Array(data) };
        postShell({
          kind: "trace",
          detail: `[snapshot] saved DB (${data.byteLength} bytes)`,
        });
      } catch (err) {
        clearSavedState();
        postShell({
          kind: "error",
          detail: `[snapshot] failed to read DB: ${err.message}; using the last persisted checkpoint`,
        });
        return { captured: false, reason: "db-read-failed" };
      }

      // 2. Save files from plugin directories installed during this session.
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
            detail: "[snapshot] no plugin files collected from tracked dirs",
          });
        }
      } else {
        postShell({
          kind: "trace",
          detail:
            "[snapshot] no plugin dirs tracked, skipping plugin hydration",
        });
      }

      return {
        captured: true,
        filedirMode: filedirCheckpoint.mode,
      };
    },

    /**
     * Restore the saved DB, plugin files, and bounded fallback files.
     *
     * @param {object} php - The php-compat wrapper (has ._php).
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

      // 1. Restore DB.
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

      // 3. Restore filedir only for the bounded no-persistence fallback.
      if (savedFiledirFiles) {
        const { ok, failed } = restoreFiles(rawPhp, savedFiledirFiles);
        postShell({
          kind: "trace",
          detail: `[snapshot] restored ${ok} fallback filedir entries${failed > 0 ? ` (${failed} failed)` : ""}`,
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
      clearSavedState();
    },
  };
}
