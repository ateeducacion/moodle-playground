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
 *   - VFS lazy materialization (lib/vfs-mount.js) reduces memory pressure.
 *   - Preventive rotation restarts the runtime periodically.
 *   - Reactive rotation detects fatal errors and discards the runtime.
 *   - Idempotent requests (GET/HEAD) are replayed once on a fresh runtime.
 *   - Non-idempotent requests are NOT replayed to avoid side-effects.
 *   - A request is never retried more than once (loop protection).
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
export function isFatalWasmError(error) {
  if (!error) {
    return false;
  }

  const message = String(error.message || error);
  return (
    (typeof WebAssembly !== "undefined" &&
      error instanceof WebAssembly.RuntimeError) ||
    message.includes("memory access out of bounds") ||
    message.includes("unreachable") ||
    message.includes("RuntimeError") ||
    message.includes("No file descriptors available") ||
    message.includes("Failed opening required")
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
