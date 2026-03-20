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

export async function registerVersionedServiceWorker(
  serviceWorkerUrl,
  { scope = "./", type = "classic", updateViaCache = "none" } = {},
) {
  const registrationOptions = {
    scope,
    updateViaCache,
  };
  if (type) {
    registrationOptions.type = type;
  }

  const registration = await navigator.serviceWorker.register(
    buildVersionedServiceWorkerUrl(serviceWorkerUrl),
    registrationOptions,
  );

  try {
    await registration.update();
  } catch {
    // Keep working with the currently installed worker when offline.
  }

  return registration;
}
