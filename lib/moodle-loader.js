import { unzipSync } from "../vendor/fflate.js";
import { BUNDLE_CACHE_NAME, DEFAULT_BOOT_OPTIONS } from "./constants.js";

function splitPath(path) {
  return path.split("/").filter(Boolean);
}

export async function fetchWithProgress(url, onProgress = () => {}) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unable to download Moodle archive: ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body?.getReader();

  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onProgress({ loaded: buffer.byteLength, total, ratio: total ? 1 : 0 });
    return buffer;
  }

  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    chunks.push(value);
    loaded += value.byteLength;
    onProgress({
      loaded,
      total,
      ratio: total ? loaded / total : 0,
    });
  }

  const buffer = new Uint8Array(loaded);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  onProgress({ loaded, total, ratio: 1 });

  return buffer;
}

function decodeHex(byteArray) {
  return [...byteArray].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return decodeHex(new Uint8Array(digest));
}

async function responseToBytes(response) {
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchJsonWithCache(url, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(url);

  if (cached) {
    return cached.json();
  }

  const response = await fetch(url, {
    cache: "no-cache",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load JSON asset: ${response.status} ${response.statusText}`);
  }

  try {
    await cache.put(url, response.clone());
  } catch {
    // Some browser/storage combinations reject large or synthetic entries.
  }
  return response.json();
}

async function verifyBundle(bytes, expectedSha256) {
  if (!expectedSha256) {
    return;
  }

  const actual = await sha256(bytes);

  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`Bundle checksum mismatch: expected ${expectedSha256}, received ${actual}`);
  }
}

function normalizeManifest(manifestUrl, manifest) {
  const resolvedManifestUrl = new URL(manifestUrl, self.location.href).toString();
  const bundlePath = manifest?.bundle?.path;
  const normalized = { ...manifest };

  if (bundlePath) {
    normalized.bundle = {
      ...manifest.bundle,
      url: new URL(bundlePath, resolvedManifestUrl).toString(),
    };
  }

  if (!normalized.bundle) {
    throw new Error(`Manifest ${resolvedManifestUrl} does not include bundle.path`);
  }

  return normalized;
}

export async function fetchManifest(manifestUrl = DEFAULT_BOOT_OPTIONS.manifestUrl) {
  const response = await fetch(manifestUrl, {
    cache: "no-store",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load manifest: ${response.status} ${response.statusText}`);
  }

  return normalizeManifest(manifestUrl, await response.json());
}

async function openBundleCache() {
  return caches.open(BUNDLE_CACHE_NAME);
}

export async function fetchBundleWithCache(manifest, onProgress = () => {}) {
  const bundleUrl = manifest.bundle.url;
  const cache = await openBundleCache();
  const cached = await cache.match(bundleUrl);

  if (cached) {
    try {
      onProgress({
        loaded: Number(cached.headers.get("content-length")) || manifest.bundle.size || 0,
        total: manifest.bundle.size || 0,
        ratio: 1,
        cached: true,
        url: bundleUrl,
      });

      const bytes = await responseToBytes(cached);
      await verifyBundle(bytes, manifest.bundle.sha256);
      return bytes;
    } catch (error) {
      await cache.delete(bundleUrl);
      onProgress({
        phase: "cache-bust",
        detail: `Cached bundle failed verification, redownloading ${bundleUrl}`,
        error: String(error?.message || error),
      });
    }
  }

  const bytes = await fetchWithProgress(bundleUrl, onProgress);
  await verifyBundle(bytes, manifest.bundle.sha256);

  try {
    await cache.put(
      bundleUrl,
      new Response(bytes, {
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "application/zip",
          "x-moodle-release": manifest.release || "",
        },
      }),
    );
  } catch {
    // Caching is an optimization. Bootstrap must continue without it.
  }

  return bytes;
}

export async function resolveBootstrapArchive(
  {
    manifestUrl = DEFAULT_BOOT_OPTIONS.manifestUrl,
  } = {},
  onProgress = () => {},
) {
  onProgress({
    phase: "manifest",
    detail: `Loading manifest ${manifestUrl}`,
  });

  const manifest = await fetchManifest(manifestUrl);

  const bytes = await fetchBundleWithCache(manifest, onProgress);

  return {
    kind: "bundle",
    manifest,
    bytes,
    sourceUrl: manifest.bundle.url,
  };
}

export function normalizeArchiveName(name) {
  return name.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function extractZipEntries(zipBytes) {
  const archive = unzipSync(zipBytes);
  const rawNames = Object.keys(archive);

  if (rawNames.length === 0) {
    throw new Error("The Moodle archive is empty.");
  }

  // Normalize once per entry to avoid redundant string processing on ~30k entries.
  const entries = rawNames.map((raw) => ({ raw, name: normalizeArchiveName(raw) }));

  const firstSegments = new Set(
    entries.map(({ name }) => splitPath(name)[0]).filter(Boolean),
  );
  const stripLeadingFolder = firstSegments.size === 1 ? [...firstSegments][0] : null;

  return entries
    .map(({ raw, name }) => {
      if (!name || name.endsWith("/")) {
        return null;
      }

      const normalized = stripLeadingFolder && name.startsWith(`${stripLeadingFolder}/`)
        ? name.slice(stripLeadingFolder.length + 1)
        : name;

      if (!normalized || normalized.endsWith("/")) {
        return null;
      }

      return {
        path: normalized,
        data: archive[raw],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Stream-decode a ZIP buffer into an array of { path, data } entries using
 * @php-wasm/stream-compression. Shared by blueprint steps and the plugin
 * installer to avoid duplicating the decodeZip streaming pattern.
 */
export async function readZipEntries(zipBytes) {
  const { decodeZip } = await import("@php-wasm/stream-compression");
  const stream = decodeZip(new Response(zipBytes).body);
  const reader = stream.getReader();
  const entries = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "directory") continue;
    const path = normalizeArchiveName(value.name);
    if (!path || path.endsWith("/")) continue;
    entries.push({ path, data: new Uint8Array(await value.arrayBuffer()) });
  }
  return entries;
}

export function writeEntriesToPhp(php, entries, targetRoot, onProgress = () => {}) {
  const total = entries.length;
  const rawPhp = php._php;
  const createdDirs = new Set();
  const root = targetRoot.replace(/\/+$/, "");

  for (let i = 0; i < total; i++) {
    const destination = `${root}/${entries[i].path}`;
    const lastSlash = destination.lastIndexOf("/");
    const parentDir = lastSlash > 0 ? destination.substring(0, lastSlash) : null;
    if (parentDir && !createdDirs.has(parentDir)) {
      rawPhp.mkdirTree(parentDir);
      // Cache this dir and all ancestors to avoid redundant mkdirTree calls
      let dir = parentDir;
      while (dir && !createdDirs.has(dir)) {
        createdDirs.add(dir);
        dir = dir.substring(0, dir.lastIndexOf("/")) || null;
      }
    }
    rawPhp.writeFile(destination, entries[i].data);

    if (i % 500 === 0 || i === total - 1) {
      onProgress({
        written: i + 1,
        total,
        ratio: total ? (i + 1) / total : 1,
        path: entries[i].path,
      });
    }
  }
}
