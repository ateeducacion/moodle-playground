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
  const bundle = manifest?.bundle;
  const normalized = { ...manifest };

  if (bundle?.parts?.length) {
    // Chunked bundle ("zip-parts"): resolve every part path to an absolute URL,
    // mirroring how a single bundle.path is resolved below.
    normalized.bundle = {
      ...bundle,
      parts: bundle.parts.map((part) => ({
        ...part,
        url: new URL(part.path, resolvedManifestUrl).toString(),
      })),
    };
  } else if (bundle?.path) {
    normalized.bundle = {
      ...bundle,
      url: new URL(bundle.path, resolvedManifestUrl).toString(),
    };
  }

  if (!normalized.bundle || (!normalized.bundle.url && !normalized.bundle.parts?.length)) {
    throw new Error(`Manifest ${resolvedManifestUrl} does not include bundle.path or bundle.parts`);
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

async function fetchPartInto(url, target, baseOffset, onLoaded = () => {}) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Unable to download bundle part: ${response.status} ${response.statusText} (${url})`);
  }

  const reader = response.body?.getReader();

  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    target.set(buffer, baseOffset);
    onLoaded(buffer.byteLength);
    return buffer.byteLength;
  }

  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    target.set(value, baseOffset + loaded);
    loaded += value.byteLength;
    onLoaded(loaded);
  }

  return loaded;
}

/**
 * Fetch a chunked ("zip-parts") bundle. Each part is fetched cache-first and
 * written directly into a single preallocated buffer at its computed offset, so
 * peak memory stays at ~one assembled bundle regardless of how many parts run in
 * parallel. The reassembled bytes are byte-identical to the original zip and are
 * verified against the overall sha256 (each part is also checked individually
 * when its sha256 is present).
 */
async function fetchPartsWithCache(manifest, onProgress = () => {}) {
  const cache = await openBundleCache();
  const { parts } = manifest.bundle;
  const sizes = parts.map((part) => Number(part.size) || 0);
  const offsets = [];
  let total = 0;
  for (const size of sizes) {
    offsets.push(total);
    total += size;
  }

  const full = new Uint8Array(total);
  const loadedByPart = new Array(parts.length).fill(0);
  const emit = (extra = {}) => {
    const loaded = loadedByPart.reduce((sum, value) => sum + value, 0);
    onProgress({ loaded, total, ratio: total ? loaded / total : 0, ...extra });
  };

  await Promise.all(
    parts.map(async (part, index) => {
      const offset = offsets[index];
      const expected = sizes[index];
      const cached = await cache.match(part.url);

      if (cached) {
        try {
          const bytes = await responseToBytes(cached);
          if (part.sha256) {
            await verifyBundle(bytes, part.sha256);
          }
          full.set(bytes, offset);
          loadedByPart[index] = bytes.byteLength;
          emit({ cached: true });
          return;
        } catch {
          await cache.delete(part.url);
        }
      }

      const written = await fetchPartInto(part.url, full, offset, (loaded) => {
        loadedByPart[index] = loaded;
        emit();
      });

      if (expected && written !== expected) {
        throw new Error(
          `Bundle part size mismatch for ${part.url}: expected ${expected}, received ${written}`,
        );
      }

      const slice = full.subarray(offset, offset + written);
      if (part.sha256) {
        await verifyBundle(slice, part.sha256);
      }
      loadedByPart[index] = written;
      emit();

      try {
        await cache.put(
          part.url,
          new Response(slice, {
            headers: {
              "content-length": String(written),
              "content-type": "application/octet-stream",
            },
          }),
        );
      } catch {
        // Caching is an optimization. Bootstrap must continue without it.
      }
    }),
  );

  await verifyBundle(full, manifest.bundle.sha256);
  emit({ ratio: 1 });

  return full;
}

export async function fetchBundleWithCache(manifest, onProgress = () => {}) {
  if (manifest.bundle?.parts?.length) {
    return fetchPartsWithCache(manifest, onProgress);
  }

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
    sourceUrl: manifest.bundle.url || manifest.bundle.parts?.[0]?.url || "",
  };
}

export function normalizeArchiveName(name) {
  return name.replaceAll("\\", "/").replace(/^\/+/, "");
}

/**
 * Sanitize a normalized archive entry path to prevent ZIP-slip (path
 * traversal). Splits the path on "/", drops empty and "." segments, and
 * rejects any entry that contains a ".." segment or that resolves to an
 * absolute path. Returns the cleaned relative path, or null when the entry
 * is empty after sanitization. Throws on a traversal/absolute path so callers
 * never write outside the intended directory.
 */
export function sanitizeArchivePath(name) {
  // normalizeArchiveName already converts "\\" -> "/" and strips leading "/".
  const segments = String(name)
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Unsafe archive entry path (path traversal): ${name}`);
  }

  return segments.length > 0 ? segments.join("/") : null;
}

export function extractZipEntries(zipBytes) {
  const archive = unzipSync(zipBytes);
  const rawNames = Object.keys(archive);

  if (rawNames.length === 0) {
    throw new Error("The Moodle archive is empty.");
  }

  // Normalize once per entry to avoid redundant string processing on ~30k entries.
  // Sanitization drops "." / empty segments and skips traversal/absolute paths
  // so a crafted archive can never write outside the target root (ZIP-slip).
  const entries = rawNames
    .map((raw) => {
      const normalized = normalizeArchiveName(raw);
      // Skip directory entries: archive keys ending in "/" carry no file
      // content. This MUST run before sanitizeArchivePath(), which strips the
      // trailing slash and would otherwise turn a directory entry into a bare
      // file path (e.g. ".git/" -> ".git"), colliding with the real files
      // inside that directory and breaking extraction ("Not a directory").
      if (normalized.endsWith("/")) {
        return null;
      }
      let name;
      try {
        name = sanitizeArchivePath(normalized);
      } catch {
        return null;
      }
      return name ? { raw, name } : null;
    })
    .filter(Boolean);

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
    // Sanitize to prevent ZIP-slip: skip entries with ".." segments or
    // absolute paths so extraction can never escape the target directory.
    let path;
    try {
      path = sanitizeArchivePath(normalizeArchiveName(value.name));
    } catch {
      continue;
    }
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

const escapePhp = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

/**
 * Extract the core Moodle bundle into the webroot using PHP's native ZipArchive
 * (libzip `extractTo`) instead of decompressing the whole archive in JavaScript.
 *
 * Why: the JS path (fflate `unzipSync` + `writeEntriesToPhp`) decompresses every
 * entry into the JS heap at once and then copies it into MEMFS. For the core
 * bundle (~179 MB / ~29 000 files) that peak risks MEMFS OOM on constrained
 * clients; the streaming `decodeZip` alternative spins up a DecompressionStream
 * per entry and is far too slow at this file count (boot exceeds the readiness
 * gate, regressing the Firefox e2e suite). libzip's `extractTo()` inflates +
 * writes one entry at a time in native code — fast regardless of file count and
 * ~one-entry peak. ext/zip is confirmed present (Moodle already drives
 * ZipArchive via the patched tool_installaddon), so there is no JS fallback.
 *
 * Moodle's core bundle stores files at the archive root (many top-level entries,
 * no single wrapping folder), so the lone-wrapper descent is a no-op here — the
 * generic script handles both shapes.
 *
 * Contract: prints exactly one sentinel on stdout:
 *   - `NO_ZIP_EXT`            → the build lacks ext/zip (caller fails loud).
 *   - `INSTALL_OK <count>`    → extracted <count> entries into the target.
 *   - `INSTALL_ERR <message>` → anything else (caller fails loud).
 * On success the temp zip is removed.
 */
export function buildCoreExtractScript(zipPath, stagePath, targetRoot) {
  const zip = escapePhp(zipPath);
  const stage = escapePhp(stagePath);
  const target = escapePhp(targetRoot);
  return `<?php
echo (function () {
  $zipPath = '${zip}';
  $stage = '${stage}';
  $target = '${target}';
  if (!class_exists('ZipArchive')) { return 'NO_ZIP_EXT'; }
  $rrmdir = function ($dir) use (&$rrmdir) {
    if (!is_dir($dir)) { return; }
    foreach (scandir($dir) as $e) {
      if ($e === '.' || $e === '..') { continue; }
      $p = $dir . '/' . $e;
      is_dir($p) ? $rrmdir($p) : @unlink($p);
    }
    @rmdir($dir);
  };
  try {
    $rrmdir($stage);
    @mkdir($stage, 0777, true);
    $zip = new ZipArchive();
    $rc = $zip->open($zipPath);
    if ($rc !== true) { $rrmdir($stage); return 'INSTALL_ERR open=' . $rc; }
    $ok = $zip->extractTo($stage);
    $count = $zip->numFiles;
    $zip->close();
    if (!$ok) { $rrmdir($stage); return 'INSTALL_ERR extract'; }
    // Descend into a lone wrapping folder (e.g. "moodle/"); root-level bundles
    // keep several top entries and are used as-is.
    $top = array_values(array_diff(scandir($stage), ['.', '..']));
    $src = $stage;
    if (count($top) === 1 && is_dir($stage . '/' . $top[0])) {
      $src = $stage . '/' . $top[0];
    }
    $rrmdir($target);
    @mkdir(dirname($target), 0777, true);
    if (!@rename($src, $target)) { $rrmdir($stage); return 'INSTALL_ERR rename'; }
    $rrmdir($stage);
    @unlink($zipPath);
    return 'INSTALL_OK ' . $count;
  } catch (\\Throwable $e) {
    $rrmdir($stage);
    return 'INSTALL_ERR ' . $e->getMessage();
  }
})();
`;
}
