import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPhpBridgeChannel,
  createShellChannel,
  PHP_BRIDGE_CHANNEL_PREFIX,
  SHELL_CHANNEL_PREFIX,
  SNAPSHOT_VERSION,
} from "../../src/shared/protocol.js";

describe("createShellChannel", () => {
  it("creates channel with prefix and scopeId", () => {
    const channel = createShellChannel("main");
    assert.strictEqual(channel, `${SHELL_CHANNEL_PREFIX}:main`);
  });

  it("handles custom scopeId", () => {
    const channel = createShellChannel("custom-scope");
    assert.ok(channel.endsWith(":custom-scope"));
  });
});

describe("createPhpBridgeChannel", () => {
  it("creates channel with prefix and scopeId", () => {
    const channel = createPhpBridgeChannel("main");
    assert.strictEqual(channel, `${PHP_BRIDGE_CHANNEL_PREFIX}:main`);
  });
});

describe("SNAPSHOT_VERSION", () => {
  it("is a number", () => {
    assert.strictEqual(typeof SNAPSHOT_VERSION, "number");
  });
});
