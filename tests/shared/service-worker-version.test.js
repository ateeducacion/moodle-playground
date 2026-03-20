import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILD_VERSION } from "../../src/generated/build-version.js";
import {
  buildVersionedServiceWorkerUrl,
  registerVersionedServiceWorker,
} from "../../src/shared/service-worker-version.js";

describe("buildVersionedServiceWorkerUrl", () => {
  it("adds the build version to a relative service worker URL", () => {
    const url = buildVersionedServiceWorkerUrl(
      "./sw.js",
      "https://example.com/moodle-playground/index.html",
    );

    assert.strictEqual(
      url.toString(),
      `https://example.com/moodle-playground/sw.js?build=${BUILD_VERSION}`,
    );
  });

  it("overwrites an existing build query parameter and preserves others", () => {
    const url = buildVersionedServiceWorkerUrl(
      "https://example.com/sw.js?foo=1&build=stale",
      "https://example.com/index.html",
    );

    assert.strictEqual(url.searchParams.get("foo"), "1");
    assert.strictEqual(url.searchParams.get("build"), BUILD_VERSION);
  });

  it("registers a classic service worker by default", async () => {
    const registerCalls = [];
    const originalNavigator = globalThis.navigator;
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          register: async (...args) => {
            registerCalls.push(args);
            return {
              update: async () => {},
            };
          },
        },
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://example.com/moodle-playground/index.html",
        },
      },
    });

    try {
      await registerVersionedServiceWorker(
        "https://example.com/moodle-playground/sw.js",
        {
          scope: "/moodle-playground/",
        },
      );
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }

    assert.equal(registerCalls.length, 1);
    assert.strictEqual(
      registerCalls[0][0].toString(),
      `https://example.com/moodle-playground/sw.js?build=${BUILD_VERSION}`,
    );
    assert.deepEqual(registerCalls[0][1], {
      scope: "/moodle-playground/",
      type: "classic",
      updateViaCache: "none",
    });
  });
});
