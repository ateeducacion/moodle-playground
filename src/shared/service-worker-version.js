import { BUILD_VERSION } from "../generated/build-version.js";

export function buildVersionedServiceWorkerUrl(
  serviceWorkerUrl,
  baseUrl = window.location.href,
) {
  const url =
    serviceWorkerUrl instanceof URL
      ? new URL(serviceWorkerUrl.toString())
      : new URL(String(serviceWorkerUrl), baseUrl);
  url.searchParams.set("build", BUILD_VERSION);
  return url;
}

/**
 * True when this browsing context exposes a usable Service Worker API.
 *
 * iOS Safari private browsing, insecure (non-HTTPS) origins and browsers with
 * Service Workers disabled leave `navigator.serviceWorker` undefined, so any
 * unguarded access throws a TypeError and blanks the page.
 */
export function isServiceWorkerSupported() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof navigator.serviceWorker?.register === "function"
  );
}

export const SERVICE_WORKER_UNSUPPORTED_ERROR_NAME =
  "ServiceWorkerUnsupportedError";

export const SERVICE_WORKER_UNSUPPORTED_MESSAGE =
  "Service Workers are unavailable in this browser context. Private browsing " +
  "on iOS Safari disables them, and the playground cannot run without one.";

/**
 * Build the error thrown when the Service Worker API is missing. Callers
 * distinguish it from a genuine registration rejection by `error.name`, so an
 * environment limitation is reported as a warning instead of a crash.
 */
export function createServiceWorkerUnsupportedError() {
  const error = new Error(SERVICE_WORKER_UNSUPPORTED_MESSAGE);
  error.name = SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
  return error;
}

export function isServiceWorkerUnsupportedError(error) {
  return error?.name === SERVICE_WORKER_UNSUPPORTED_ERROR_NAME;
}

export async function registerVersionedServiceWorker(
  serviceWorkerUrl,
  { scope = "./", type = "classic", updateViaCache = "none" } = {},
) {
  if (!isServiceWorkerSupported()) {
    throw createServiceWorkerUnsupportedError();
  }

  const registration = await navigator.serviceWorker.register(
    buildVersionedServiceWorkerUrl(serviceWorkerUrl),
    {
      scope,
      type,
      updateViaCache,
    },
  );

  try {
    await registration.update();
  } catch {
    // Keep working with the currently installed worker when offline.
  }

  return registration;
}
