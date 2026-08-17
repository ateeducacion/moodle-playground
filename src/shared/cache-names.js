// Application-owned Cache Storage namespaces, versioned by the Playground
// Build ID. A new deployment therefore writes into fresh namespaces and the
// Service Worker purges the ones left behind by the previous build, so a
// browser can never mix code from two different builds.
// See docs/architecture/adr/ADR-0029-build-identification-and-cache-versioning.md

export const STATIC_CACHE_PREFIX = "moodle-playground-static";
export const SCOPED_STATIC_CACHE_PREFIX = "moodle-playground-scoped-static";

export function buildStaticCacheName(buildVersion) {
  return `${STATIC_CACHE_PREFIX}-${buildVersion}`;
}

export function buildScopedStaticCacheName(buildVersion) {
  return `${SCOPED_STATIC_CACHE_PREFIX}-${buildVersion}`;
}

/**
 * True when `cacheName` is one of this app's versioned caches left over from a
 * previous build. Caches belonging to other apps or origins — and this app's
 * unversioned caches, which have their own lifecycle — never match, so
 * activation only ever purges what this Service Worker owns.
 */
export function isStaleAppCacheName(cacheName, buildVersion) {
  const current = [
    buildStaticCacheName(buildVersion),
    buildScopedStaticCacheName(buildVersion),
  ];
  if (current.includes(cacheName)) {
    return false;
  }
  return [STATIC_CACHE_PREFIX, SCOPED_STATIC_CACHE_PREFIX].some((prefix) =>
    cacheName.startsWith(`${prefix}-`),
  );
}
