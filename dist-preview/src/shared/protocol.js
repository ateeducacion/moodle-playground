export const SHELL_CHANNEL_PREFIX = "moodle-playground-shell";
export const PHP_BRIDGE_CHANNEL_PREFIX = "moodle-playground-php";
export const SNAPSHOT_VERSION = 1;

export function createShellChannel(scopeId) {
  return `${SHELL_CHANNEL_PREFIX}:${scopeId}`;
}

export function createPhpBridgeChannel(scopeId) {
  return `${PHP_BRIDGE_CHANNEL_PREFIX}:${scopeId}`;
}

export function createWorkerRequestId() {
  return globalThis.crypto.randomUUID();
}
