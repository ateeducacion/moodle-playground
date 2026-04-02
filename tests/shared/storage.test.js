import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildScopeKey, getOrCreateScopeId } from "../../src/shared/storage.js";

describe("buildScopeKey", () => {
  it("builds key with prefix, scopeId, and suffix", () => {
    const key = buildScopeKey("main", "state");
    assert.strictEqual(key, "moodle-playground:main:state");
  });

  it("handles custom scopeId", () => {
    const key = buildScopeKey("custom", "blueprint");
    assert.strictEqual(key, "moodle-playground:custom:blueprint");
  });
});

describe("getOrCreateScopeId", () => {
  it("reuses scope from the URL when present", () => {
    const originalWindow = globalThis.window;

    try {
      globalThis.window = {
        location: { href: "https://example.com/?scope=shared-scope" },
        sessionStorage: {
          store: new Map(),
          getItem(key) {
            return this.store.get(key) ?? null;
          },
          setItem(key, value) {
            this.store.set(key, value);
          },
        },
      };

      const scopeId = getOrCreateScopeId();
      assert.strictEqual(scopeId, "shared-scope");
      assert.strictEqual(
        globalThis.window.sessionStorage.getItem("moodle-playground:active"),
        "shared-scope",
      );
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it("creates a per-tab scope when none is provided", () => {
    const originalWindow = globalThis.window;
    const originalCrypto = globalThis.crypto;

    try {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: {
          randomUUID: () => "uuid",
        },
      });

      globalThis.window = {
        location: { href: "https://example.com/" },
        sessionStorage: {
          store: new Map(),
          getItem(key) {
            return this.store.get(key) ?? null;
          },
          setItem(key, value) {
            this.store.set(key, value);
          },
        },
      };

      const scopeId = getOrCreateScopeId();
      assert.strictEqual(scopeId, "tab-uuid");
      assert.strictEqual(
        globalThis.window.sessionStorage.getItem("moodle-playground:active"),
        "tab-uuid",
      );
      assert.strictEqual(getOrCreateScopeId(), "tab-uuid");
    } finally {
      globalThis.window = originalWindow;
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});
