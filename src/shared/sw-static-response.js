// Cache Storage writes for static responses. Shared with sw.js so tests cover
// the shipped helper instead of a copy of it.

/**
 * Return `response` immediately and store a clone in Cache Storage without
 * waiting for that write.
 *
 * Awaiting `cache.put(response.clone())` before returning the response
 * deadlocks large bodies. `clone()` tees the stream: `cache.put` stops
 * reading once its backpressure buffer fills, and the client cannot read
 * the original until the service worker returns it. Moodle core parts are
 * about 24 MiB, so a cold boot stays on "Loading manifest" for the whole
 * download — or forever, if the buffer never drains.
 *
 * See docs/architecture/adr/ADR-0042-stream-static-cache-bodies.md.
 *
 * @param {Response} response
 * @param {Cache|null|undefined} cache
 * @param {string} cacheKey
 * @param {(promise: Promise<void>) => void} [waitUntil]
 * @returns {Response}
 */
export function settleStaticFetch(response, cache, cacheKey, waitUntil) {
  if (response?.ok && response.body && cache) {
    // Clone synchronously. Deferring clone() until a microtask lets the
    // client lock the body first, and cache.put then fails.
    const cached = response.clone();
    const cacheDone = Promise.resolve()
      .then(() => cache.put(cacheKey, cached))
      .catch(() => {
        // CacheStorage is an optimization. Routing must continue without it.
      });
    if (typeof waitUntil === "function") {
      try {
        waitUntil(cacheDone);
      } catch {
        // FetchEvent.waitUntil() throws once the event has finished. The
        // cache write is already running and its failure is non-fatal.
      }
    }
  }

  return response;
}
