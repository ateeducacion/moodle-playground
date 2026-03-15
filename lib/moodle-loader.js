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

  onProgress({ loaded, total, ratio: total ? 1 : 1 });

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

  if (!normalized.bundle && !manifest?.vfs) {
    throw new Error(`Manifest ${resolvedManifestUrl} does not include bundle.path or vfs metadata`);
  }

  return normalized;
}

export async function fetchManifest(manifestUrl = DEFAULT_BOOT_OPTIONS.manifestUrl) {
  const response = await fetch(manifestUrl, {
    cache: "no-cache",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to load manifest: ${response.status} ${response.statusText}`);
  }

  return normalizeManifest(manifestUrl, await response.json());
}

function normalizeVfs(manifestUrl, manifest) {
  const resolvedManifestUrl = new URL(manifestUrl, self.location.href).toString();

  if (!manifest?.vfs?.data?.path || !manifest?.vfs?.index?.path) {
    return null;
  }

  return {
    ...manifest.vfs,
    data: {
      ...manifest.vfs.data,
      url: new URL(manifest.vfs.data.path, resolvedManifestUrl).toString(),
    },
    index: {
      ...manifest.vfs.index,
      url: new URL(manifest.vfs.index.path, resolvedManifestUrl).toString(),
    },
  };
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
  const vfs = normalizeVfs(manifestUrl, manifest);

  if (vfs) {
    onProgress({
      phase: "manifest",
      detail: `Loading VFS index ${vfs.index.path}`,
    });

    const [index, bytes] = await Promise.all([
      fetchJsonWithCache(vfs.index.url, BUNDLE_CACHE_NAME),
      fetchBundleWithCache(
        {
          bundle: vfs.data,
          release: manifest.release,
        },
        onProgress,
      ),
    ]);

    return {
      kind: "vfs-image",
      manifest,
      image: {
        ...vfs,
        entries: index.entries || [],
        totalBytes: index.totalBytes || 0,
      },
      bytes,
      sourceUrl: vfs.data.url,
    };
  }

  const bytes = await fetchBundleWithCache(manifest, onProgress);

  return {
    kind: "bundle",
    manifest,
    bytes,
    sourceUrl: manifest.bundle.url,
  };
}

function normalizeArchiveName(name) {
  return name.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function extractZipEntries(zipBytes) {
  const archive = unzipSync(zipBytes);
  const names = Object.keys(archive).map(normalizeArchiveName).filter(Boolean);

  if (names.length === 0) {
    throw new Error("The Moodle archive is empty.");
  }

  const firstSegments = new Set(names.map((name) => splitPath(name)[0]).filter(Boolean));
  const stripLeadingFolder = firstSegments.size === 1 ? [...firstSegments][0] : null;

  return names
    .map((name) => {
      const originalData = archive[name];

      if (!originalData) {
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
        data: originalData,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function ensureDir(php, path) {
  const parts = splitPath(path);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;

    const about = await php.analyzePath(current);

    if (about?.exists) {
      if (about.object?.isFolder) {
        continue;
      }

      throw new Error(
        `Cannot create directory ${current}: path exists and is not a directory (${JSON.stringify(about)})`,
      );
    }

    try {
      await php.mkdir(current);
    } catch (error) {
      const parent = current.split("/").slice(0, -1).join("/") || "/";
      const parentAbout = await php.analyzePath(parent);
      throw new Error(
        `mkdir failed for ${current}: ${JSON.stringify(error)} | parent=${JSON.stringify(parentAbout)}`,
      );
    }
  }
}

export async function writeVfsImageToPhp(php, image, targetRoot, onProgress = () => {}) {
  const entries = image?.entries || [];
  const total = entries.length;
  const bytes = image?.bytes;

  if (!(bytes instanceof Uint8Array)) {
    throw new Error("The VFS image payload is not available.");
  }

  for (let index = 0; index < total; index += 1) {
    const entry = entries[index];
    const destination = `${targetRoot}/${entry.path}`.replaceAll("//", "/");
    await ensureParentDir(php, destination);
    await php.writeFile(destination, bytes.subarray(entry.offset, entry.offset + entry.size));

    onProgress({
      written: index + 1,
      total,
      ratio: total ? (index + 1) / total : 1,
      path: entry.path,
    });
  }
}

async function ensureParentDir(php, filePath) {
  const parent = filePath.split("/").slice(0, -1).join("/") || "/";
  await ensureDir(php, parent);
}

export async function writeEntriesToPhp(php, entries, targetRoot, onProgress = () => {}) {
  let written = 0;
  const total = entries.length;

  for (const entry of entries) {
    const destination = `${targetRoot}/${entry.path}`.replaceAll("//", "/");
    await ensureParentDir(php, destination);
    await php.writeFile(destination, entry.data);
    written += 1;

    onProgress({
      written,
      total,
      ratio: total ? written / total : 1,
      path: entry.path,
    });
  }
}
