export const SHELL_CHANNEL_PREFIX = "moodle-playground-shell";
export const PHP_BRIDGE_CHANNEL_PREFIX = "moodle-playground-php";
export const SNAPSHOT_VERSION = 1;

export function createShellChannel(scopeId, instanceId) {
  return `${SHELL_CHANNEL_PREFIX}:${scopeId}${instanceId ? `:${instanceId}` : ""}`;
}

export function createPhpBridgeChannel(scopeId) {
  return `${PHP_BRIDGE_CHANNEL_PREFIX}:${scopeId}`;
}

let randomIdCounter = 0;

export function createRandomId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const words =
    globalThis.crypto?.getRandomValues?.(new Uint32Array(4)) || null;
  if (words) {
    return Array.from(words, (w) => w.toString(16).padStart(8, "0")).join("-");
  }

  randomIdCounter += 1;
  const timestamp = Date.now().toString(36);
  const monotonic = Math.floor(globalThis.performance?.now?.() || 0).toString(
    36,
  );
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${timestamp}-${monotonic}-${randomIdCounter.toString(36)}-${rand}`;
}

export function createWorkerRequestId() {
  return createRandomId();
}

export function createInstanceId() {
  return createRandomId();
}

/**
 * Format an error into a human-readable string for display/logging.
 */
export function formatErrorDetail(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    // Chromium's stack starts with "Name: message"; Firefox and Safari list
    // only the frames, so the message would be lost.
    const head = `${error.name}: ${error.message}`;
    if (!error.stack || error.stack.startsWith(head)) {
      return String(error.stack || head);
    }
    return `${head}\n${error.stack}`.trim();
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

/**
 * Wrap an error in a minimal HTML page, escaping it so the text never
 * becomes markup.
 */
export function formatErrorHtml(error) {
  const text = formatErrorDetail(error)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;");
  return `<!doctype html><meta charset="utf-8"><pre>${text}</pre>`;
}
