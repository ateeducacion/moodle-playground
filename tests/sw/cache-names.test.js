import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildScopedStaticCacheName,
  buildStaticCacheName,
  isStaleAppCacheName,
  SCOPED_STATIC_CACHE_PREFIX,
  STATIC_CACHE_PREFIX,
} from "../../src/shared/cache-names.js";

const BUILD = "20260816T065012Z-9e39f37d";
const PREVIOUS_BUILD = "20260809T050000Z-1234abcd";

describe("cache names", () => {
  it("versions application caches by Build ID", () => {
    assert.strictEqual(
      buildStaticCacheName(BUILD),
      `${STATIC_CACHE_PREFIX}-${BUILD}`,
    );
    assert.strictEqual(
      buildScopedStaticCacheName(BUILD),
      `${SCOPED_STATIC_CACHE_PREFIX}-${BUILD}`,
    );
  });

  it("gives each build its own namespaces", () => {
    assert.notStrictEqual(
      buildStaticCacheName(BUILD),
      buildStaticCacheName(PREVIOUS_BUILD),
    );
  });

  it("keeps the static and scoped namespaces distinct", () => {
    assert.notStrictEqual(
      buildStaticCacheName(BUILD),
      buildScopedStaticCacheName(BUILD),
    );
  });
});

describe("isStaleAppCacheName", () => {
  it("keeps the caches belonging to the current build", () => {
    assert.strictEqual(
      isStaleAppCacheName(buildStaticCacheName(BUILD), BUILD),
      false,
    );
    assert.strictEqual(
      isStaleAppCacheName(buildScopedStaticCacheName(BUILD), BUILD),
      false,
    );
  });

  it("marks this app's caches from previous builds as stale", () => {
    assert.strictEqual(
      isStaleAppCacheName(buildStaticCacheName(PREVIOUS_BUILD), BUILD),
      true,
    );
    assert.strictEqual(
      isStaleAppCacheName(buildScopedStaticCacheName(PREVIOUS_BUILD), BUILD),
      true,
    );
  });

  it("never touches caches this Service Worker does not own", () => {
    // Activation must not purge other apps on the origin, or this app's
    // caches that have their own lifecycle.
    for (const cacheName of [
      "moodle-playground-bundles-v1",
      "omeka-s-playground-static-20260816T065012Z-9e39f37d",
      "workbox-precache-v2",
      "some-other-app",
      "",
    ]) {
      assert.strictEqual(
        isStaleAppCacheName(cacheName, BUILD),
        false,
        `would have deleted ${cacheName}`,
      );
    }
  });
});
