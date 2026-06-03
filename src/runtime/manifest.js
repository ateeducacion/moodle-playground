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
 * Resolve the manifest URL for a given branch.
 *
 * The branch-specific manifest is preferred. Falling back to latest.json is
 * only safe when the branch manifest is DEFINITIVELY absent (HTTP 404):
 * latest.json may point at a different branch with a different webRoot
 * (e.g. `/www/moodle` vs `/www/moodle/public`), and the caller derives
 * webRoot from the *requested* branch — so extracting a different-branch
 * bundle would produce a missing `public/` docroot and a code-vs-DB schema
 * mismatch. Therefore:
 *   - transient/network HEAD failures are retried, then propagated (never
 *     silently downgraded to the fallback);
 *   - a non-404 non-OK status is propagated (it is not proof of absence);
 *   - on a real 404, the fallback manifest is fetched and its `channel`/
 *     `release` must match the requested branch before it is accepted.
 *
 * @param {string} moodleBranch The requested Moodle branch (e.g. "main").
 * @param {string} appBaseUrl   Base URL used to build manifest URLs.
 * @returns {Promise<string>} The resolved manifest URL.
 */
export async function resolveManifestUrl(moodleBranch, appBaseUrl) {
  const branchUrl = buildBranchManifestUrl(moodleBranch, appBaseUrl);
  const fallbackUrl = buildFallbackManifestUrl(appBaseUrl);

  // If both URLs point to the same file, skip the extra HEAD request
  if (branchUrl === fallbackUrl) {
    return branchUrl;
  }

  // Probe the branch-specific manifest. Retry transient failures so a single
  // flaky HEAD does not cause a wrong-branch fallback.
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;
    try {
      response = await fetch(branchUrl, { method: "HEAD", cache: "no-store" });
    } catch (error) {
      // Network error — transient. Retry, then propagate if it never recovers.
      lastError = error;
      continue;
    }

    if (response.ok) {
      return branchUrl;
    }

    // A definitive 404 means the branch manifest genuinely does not exist:
    // this is the only case where falling back is safe.
    if (response.status === 404) {
      return await resolveVerifiedFallbackUrl(moodleBranch, fallbackUrl);
    }

    // Any other non-OK status (e.g. 403/500/503) is NOT proof of absence.
    // Treat it as transient: retry, then propagate.
    lastError = new Error(
      `Manifest probe for ${moodleBranch} failed: ${response.status} ${response.statusText}`,
    );
  }

  throw (
    lastError ||
    new Error(`Unable to probe manifest for branch ${moodleBranch}`)
  );
}

/**
 * Fetch the fallback manifest and confirm it actually corresponds to the
 * requested branch before allowing it to be used. If it does not match, the
 * fallback is unusable (its webRoot would be incompatible) and we propagate
 * an error rather than extract a wrong-branch bundle.
 */
async function resolveVerifiedFallbackUrl(moodleBranch, fallbackUrl) {
  const fallbackManifest = await fetchManifest(fallbackUrl);
  if (manifestMatchesBranch(fallbackManifest, moodleBranch)) {
    return fallbackUrl;
  }

  throw new Error(
    `Branch manifest for ${moodleBranch} not found and fallback manifest ` +
      `(channel: ${fallbackManifest.channel ?? "unknown"}, release: ` +
      `${fallbackManifest.release ?? "unknown"}) does not match the requested ` +
      `branch — refusing to extract a wrong-branch bundle under an ` +
      `incompatible webRoot.`,
  );
}

/**
 * Returns true when the manifest's channel (preferred) corresponds to the
 * requested branch. Manifests identify their branch via the `channel` field
 * (e.g. "MOODLE_500_STABLE", "main").
 */
function manifestMatchesBranch(manifest, moodleBranch) {
  if (!manifest || !moodleBranch) {
    return false;
  }
  return manifest.channel === moodleBranch;
}

export { resolveBootstrapArchive };
