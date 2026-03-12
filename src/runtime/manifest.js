import { resolveBootstrapArchive } from "../../lib/moodle-loader.js";

export async function fetchManifest(manifestUrl = "../../assets/manifests/latest.json") {
  const response = await fetch(new URL(manifestUrl, import.meta.url), { cache: "no-cache" });

  if (!response.ok) {
    throw new Error(`Unable to load Moodle manifest: ${response.status}`);
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

export { resolveBootstrapArchive };
