import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BUILD_VERSION } from "../../src/generated/build-version.js";
import {
  blueprintSourceKey,
  buildScopedSitePath,
  getBasePath,
} from "../../src/shared/paths.js";
import { createWorkerRequestId } from "../../src/shared/protocol.js";
import { registerVersionedServiceWorker } from "../../src/shared/service-worker-version.js";
import {
  clearScopeSession,
  getOrCreateScopeId,
  loadSessionState,
  saveSessionState,
} from "../../src/shared/storage.js";
import { settleStaticFetch } from "../../src/shared/sw-static-response.js";

const originalWindow = globalThis.window;
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
  globalThis.window = originalWindow;
  if (originalNavigator)
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  Object.defineProperty(globalThis, "crypto", originalCrypto);
});

// sessionStorage stand-in whose own enumerable keys are the stored items, as
// Object.keys(window.sessionStorage) expects.
function fakeSessionStorage() {
  const store = {};
  Object.defineProperties(store, {
    getItem: { value: (k) => (k in store ? store[k] : null) },
    setItem: {
      value: (k, v) => {
        store[k] = String(v);
      },
    },
    removeItem: {
      value: (k) => {
        delete store[k];
      },
    },
  });
  return store;
}

function setWindow(href) {
  globalThis.window = {
    location: { href, pathname: new URL(href).pathname },
    sessionStorage: fakeSessionStorage(),
  };
  return globalThis.window;
}

function setCrypto(value) {
  Object.defineProperty(globalThis, "crypto", { value, configurable: true });
}

describe("scope id creation", () => {
  it("uses randomUUID and remembers the new scope for the tab", () => {
    const win = setWindow("https://app.test/");
    setCrypto({ randomUUID: () => "uuid-1" });
    assert.equal(getOrCreateScopeId(), "tab-uuid-1");
    assert.equal(win.sessionStorage["moodle-playground:active"], "tab-uuid-1");
    // The remembered scope wins over a fresh id on the next call.
    setCrypto({ randomUUID: () => "uuid-2" });
    assert.equal(getOrCreateScopeId(), "tab-uuid-1");
  });

  it("falls back to getRandomValues, then to a timestamp counter", () => {
    setWindow("https://app.test/");
    setCrypto({ getRandomValues: (arr) => arr.fill(255) });
    assert.equal(getOrCreateScopeId(), "tab-000000ff000000ff");

    setWindow("https://app.test/");
    setCrypto(undefined);
    assert.match(getOrCreateScopeId(), /^tab-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+$/);
  });
});

describe("session state", () => {
  it("round-trips state and clears only the scope's keys", () => {
    const win = setWindow("https://app.test/");
    assert.equal(loadSessionState("a"), null);
    saveSessionState("a", { path: "/my/" });
    saveSessionState("b", { path: "/" });
    assert.deepEqual(loadSessionState("a"), { path: "/my/" });

    clearScopeSession("a");
    assert.equal(loadSessionState("a"), null);
    assert.deepEqual(loadSessionState("b"), { path: "/" });
    assert.deepEqual(Object.keys(win.sessionStorage), [
      "moodle-playground:b:state",
    ]);
  });
});

describe("base paths", () => {
  it("derives the app base path from the current document", () => {
    setWindow("https://app.test/index.html");
    assert.equal(getBasePath(), "/");
    setWindow("https://app.test/moodle-playground/index.html");
    assert.equal(getBasePath(), "/moodle-playground/");
  });

  it("builds scoped site paths under the subpath and normalizes the path", () => {
    setWindow("https://app.test/moodle-playground/index.html");
    assert.equal(
      buildScopedSitePath("s1", "php83", "my/"),
      "/moodle-playground/playground/s1/php83/my/",
    );
    assert.equal(
      buildScopedSitePath("s1", "php83"),
      "/moodle-playground/playground/s1/php83/",
    );
  });

  it("defaults blueprintSourceKey to the current location", () => {
    setWindow("https://app.test/?blueprint-url=https://x.test/b.json");
    assert.equal(blueprintSourceKey(), "url:https://x.test/b.json");
  });
});

describe("createWorkerRequestId", () => {
  it("returns a fresh UUID per request", () => {
    const a = createWorkerRequestId();
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, createWorkerRequestId());
  });
});

describe("registerVersionedServiceWorker", () => {
  function setServiceWorker(register) {
    Object.defineProperty(globalThis, "navigator", {
      value: { serviceWorker: { register } },
      configurable: true,
    });
  }

  it("registers the versioned URL with defaults and asks for an update", async () => {
    setWindow("https://app.test/sub/index.html");
    let updated = false;
    let args;
    setServiceWorker(async (...a) => {
      args = a;
      return {
        update: async () => {
          updated = true;
        },
      };
    });
    await registerVersionedServiceWorker("sw.bundle.js");
    assert.equal(
      args[0].toString(),
      `https://app.test/sub/sw.bundle.js?build=${BUILD_VERSION}`,
    );
    assert.deepEqual(args[1], {
      scope: "./",
      type: "classic",
      updateViaCache: "none",
    });
    assert.ok(updated);
  });

  it("keeps the installed worker when the update check fails offline", async () => {
    setWindow("https://app.test/");
    const registration = {
      update: async () => {
        throw new Error("offline");
      },
    };
    setServiceWorker(async () => registration);
    assert.equal(
      await registerVersionedServiceWorker("sw.js", { scope: "/x/" }),
      registration,
    );
  });
});

describe("settleStaticFetch waitUntil", () => {
  it("returns the response even when waitUntil throws after the event ended", async () => {
    const puts = [];
    const cache = { put: async (key) => puts.push(key) };
    const response = new Response("body");
    const result = settleStaticFetch(response, cache, "k", () => {
      throw new Error("InvalidStateError");
    });
    assert.equal(result, response);
    assert.equal(await result.text(), "body");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(puts, ["k"]);
  });
});
