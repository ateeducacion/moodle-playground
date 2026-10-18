export const SHELL_CHANNEL_PREFIX = "moodle-playground-shell";
export const PHP_BRIDGE_CHANNEL_PREFIX = "moodle-playground-php";
export const SNAPSHOT_VERSION = 1;

export function createShellChannel(scopeId, instanceId) {
  return `${SHELL_CHANNEL_PREFIX}:${scopeId}${instanceId ? `:${instanceId}` : ""}`;
}

export function createPhpBridgeChannel(scopeId) {
  return `${PHP_BRIDGE_CHANNEL_PREFIX}:${scopeId}`;
}

export function createWorkerRequestId() {
  return globalThis.crypto.randomUUID();
}
