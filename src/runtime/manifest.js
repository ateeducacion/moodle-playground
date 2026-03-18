import { resolveBootstrapArchive } from "../../lib/moodle-loader.js";
import { buildManifestUrl as buildManifestUrlFromVersions } from "../shared/version-resolver.js";

export async function fetchManifest(manifestUrl) {
  if (!manifestUrl) {
    const base =
      typeof __APP_ROOT__ !== "undefined"
        ? __APP_ROOT__
        : new URL("../../", import.meta.url).href;
    manifestUrl = new URL("assets/manifests/latest.json", base).toString();
  }
  const response = await fetch(manifestUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(
      `Unable to load manifest: ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

export function buildManifestState(manifest, runtimeId, bundleVersion) {
  return {
    runtimeId,
    bundleVersion,
    release: manifest.release,
    sha256: manifest.vfs?.data?.sha256 || manifest.bundle?.sha256 || null,
    generatedAt: manifest.generatedAt,
  };
}

/**
 * Build the manifest URL for a given Moodle branch.
 * Returns the branch-specific URL (e.g., assets/manifests/MOODLE_500_STABLE.json).
 */
export function buildBranchManifestUrl(moodleBranch, appBaseUrl) {
  return buildManifestUrlFromVersions(moodleBranch, appBaseUrl);
}

/**
 * Build the fallback manifest URL (assets/manifests/latest.json).
 */
export function buildFallbackManifestUrl(appBaseUrl) {
  const base =
    appBaseUrl || (typeof __APP_ROOT__ !== "undefined" ? __APP_ROOT__ : "./");
  return new URL("assets/manifests/latest.json", base).toString();
}

/**
 * Resolve the manifest URL for a given branch, falling back to latest.json
 * if the branch-specific manifest does not exist.
 */
export async function resolveManifestUrl(moodleBranch, appBaseUrl) {
  const branchUrl = buildBranchManifestUrl(moodleBranch, appBaseUrl);
  const fallbackUrl = buildFallbackManifestUrl(appBaseUrl);

  // If both URLs point to the same file, skip the extra HEAD request
  if (branchUrl === fallbackUrl) {
    return branchUrl;
  }

  try {
    const response = await fetch(branchUrl, {
      method: "HEAD",
      cache: "no-store",
    });
    if (response.ok) {
      return branchUrl;
    }
  } catch {
    // network error — fall through to fallback
  }

  return fallbackUrl;
}

export { resolveBootstrapArchive };
