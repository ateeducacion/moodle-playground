import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPhpBridgeChannel,
  createShellChannel,
  formatErrorDetail,
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

  it("isolates shell messages between owners and remote reloads", () => {
    assert.notEqual(
      createShellChannel("shared", "old"),
      createShellChannel("shared", "new"),
    );
    assert.notEqual(
      createShellChannel("first", "owner"),
      createShellChannel("second", "owner"),
    );
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

describe("formatErrorDetail", () => {
  it("returns 'Unknown error' for falsy values", () => {
    assert.strictEqual(formatErrorDetail(null), "Unknown error");
    assert.strictEqual(formatErrorDetail(undefined), "Unknown error");
    assert.strictEqual(formatErrorDetail(""), "Unknown error");
    assert.strictEqual(formatErrorDetail(0), "Unknown error");
  });

  it("returns strings as-is", () => {
    assert.strictEqual(formatErrorDetail("some error"), "some error");
  });

  it("formats Error objects with stack trace", () => {
    const error = new Error("test error");
    const result = formatErrorDetail(error);
    assert.ok(result.includes("test error"));
    assert.ok(result.includes("Error"));
  });

  it("keeps the error message when the stack omits it (Firefox/Safari)", () => {
    const firefox = new Error("needs what this installation lacks");
    firefox.name = "PHPExecutionFailureError";
    firefox.stack = "run@http://localhost/dist/php-worker.bundle.js:1:1\n";
    assert.strictEqual(
      formatErrorDetail(firefox),
      "PHPExecutionFailureError: needs what this installation lacks\nrun@http://localhost/dist/php-worker.bundle.js:1:1",
    );
  });

  it("does not duplicate the message when the stack starts with it (Chromium)", () => {
    const chromium = new Error("boom");
    assert.strictEqual(formatErrorDetail(chromium), chromium.stack);
  });

  it("formats plain objects as JSON", () => {
    const result = formatErrorDetail({ code: 42, message: "oops" });
    assert.ok(result.includes("42"));
    assert.ok(result.includes("oops"));
  });

  it("handles objects that fail JSON.stringify", () => {
    const circular = {};
    circular.self = circular;
    const result = formatErrorDetail(circular);
    assert.ok(typeof result === "string");
  });
});
