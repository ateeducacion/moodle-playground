import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BUILD_VERSION } from "../../src/generated/build-version.js";
import {
  buildVersionedServiceWorkerUrl,
  isServiceWorkerSupported,
  isServiceWorkerUnsupportedError,
  registerVersionedServiceWorker,
  SERVICE_WORKER_UNSUPPORTED_ERROR_NAME,
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
});

// Regression: iOS Safari private browsing leaves navigator.serviceWorker
// undefined, so the unguarded register() call died with
// "TypeError: undefined is not an object" and blanked the whole shell.
describe("isServiceWorkerSupported", () => {
  const originalNavigator = globalThis.navigator;

  const setNavigator = (value) => {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    setNavigator(originalNavigator);
  });

  it("is true when the API exposes register()", () => {
    setNavigator({ serviceWorker: { register() {} } });
    assert.strictEqual(isServiceWorkerSupported(), true);
  });

  it("is false when navigator has no serviceWorker (iOS private browsing)", () => {
    setNavigator({});
    assert.strictEqual(isServiceWorkerSupported(), false);
  });

  it("is false when serviceWorker exists but register() does not", () => {
    setNavigator({ serviceWorker: {} });
    assert.strictEqual(isServiceWorkerSupported(), false);
  });

  it("is false when navigator is undefined", () => {
    setNavigator(undefined);
    assert.strictEqual(isServiceWorkerSupported(), false);
  });
});

describe("registerVersionedServiceWorker", () => {
  const originalNavigator = globalThis.navigator;

  const setNavigator = (value) => {
    Object.defineProperty(globalThis, "navigator", {
      value,
      configurable: true,
      writable: true,
    });
  };

  afterEach(() => {
    setNavigator(originalNavigator);
  });

  it("throws a distinguishable error without touching navigator.serviceWorker", async () => {
    setNavigator({});

    const error = await registerVersionedServiceWorker("./sw.js").then(
      () => null,
      (thrown) => thrown,
    );

    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, SERVICE_WORKER_UNSUPPORTED_ERROR_NAME);
    assert.strictEqual(isServiceWorkerUnsupportedError(error), true);
    assert.match(error.message, /Service Workers are unavailable/);
    assert.match(error.message, /private browsing on ios safari/i);
  });

  it("does not classify an ordinary registration rejection as unsupported", () => {
    assert.strictEqual(
      isServiceWorkerUnsupportedError(new Error("Rejected")),
      false,
    );
    assert.strictEqual(isServiceWorkerUnsupportedError(undefined), false);
  });
});
