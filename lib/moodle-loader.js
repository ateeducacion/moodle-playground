import { unzipSync } from "../vendor/fflate.js";
import { BUNDLE_CACHE_NAME, DEFAULT_BOOT_OPTIONS } from "./constants.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

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

export async function verifyBundle(bytes, expectedSha256) {
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

  // Resolve the auxiliary boot assets (install snapshot + localcache seed)
  // the same way, so consumers can fetch them cache-first by absolute URL.
  if (normalized.snapshot?.path) {
    normalized.snapshot = {
      ...normalized.snapshot,
      url: new URL(normalized.snapshot.path, resolvedManifestUrl).toString(),
    };
    if (normalized.snapshot.localcache?.path) {
      normalized.snapshot.localcache = {
        ...normalized.snapshot.localcache,
        url: new URL(normalized.snapshot.localcache.path, resolvedManifestUrl).toString(),
      };
    }
  }

  // Resolve experimental solid-compressed alternatives (ADR 0018), the same way
  // as the canonical bundle. Purely additive: manifests without the field behave
  // exactly as before (default ZIP boot).
  if (Array.isArray(normalized.bundleAlternatives)) {
    normalized.bundleAlternatives = normalized.bundleAlternatives.map((alt) => {
      const resolved = { ...alt };
      if (alt.parts?.length) {
        resolved.parts = alt.parts.map((part) => ({
          ...part,
          url: new URL(part.path, resolvedManifestUrl).toString(),
        }));
      } else if (alt.path) {
        resolved.url = new URL(alt.path, resolvedManifestUrl).toString();
      }
      return resolved;
    });
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

/**
 * Fetch an auxiliary bootstrap asset (install snapshot, localcache seed)
 * cache-first through the same Cache API bucket as the core bundle.
 *
 * Caches ONLY when a sha256 is provided: the checksum is the staleness
 * signal (mismatch deletes the entry and refetches — the same lifecycle as
 * the bundle cache). Without one (legacy manifests) this degrades to a
 * plain network fetch with no Cache API involvement. Throws on a non-OK
 * response or a checksum mismatch of freshly downloaded bytes, so callers
 * decide whether a missing asset is fatal (localcache seed) or a graceful
 * fallback (install snapshot -> CLI install).
 */
export async function fetchAssetWithCache(url, { sha256: expectedSha256 } = {}, onProgress = () => {}) {
  const cacheable = Boolean(expectedSha256);

  if (cacheable) {
    const cache = await openBundleCache();
    const cached = await cache.match(url);
    if (cached) {
      try {
        const bytes = await responseToBytes(cached);
        await verifyBundle(bytes, expectedSha256);
        onProgress({
          loaded: bytes.byteLength,
          total: bytes.byteLength,
          ratio: 1,
          cached: true,
          url,
        });
        return bytes;
      } catch {
        // Stale or corrupted entry: bust it and fall through to the network.
        await cache.delete(url);
      }
    }
  }

  const response = await fetch(url);
  if (!response?.ok) {
    throw new Error(`Unable to download asset: ${response?.status} ${response?.statusText || ""} (${url})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyBundle(bytes, expectedSha256);
  onProgress({
    loaded: bytes.byteLength,
    total: bytes.byteLength,
    ratio: 1,
    cached: false,
    url,
  });

  if (cacheable) {
    try {
      const cache = await openBundleCache();
      await cache.put(
        url,
        new Response(bytes, {
          headers: {
            "content-length": String(bytes.byteLength),
            "content-type": "application/octet-stream",
          },
        }),
      );
    } catch {
      // Caching is an optimization. Bootstrap must continue without it.
    }
  }

  return bytes;
}

// ── Experimental solid-compressed bundle formats (ADR 0018) ──────────────────
// Everything below is inert on the default ZIP boot: selectBundleDescriptor
// returns the ZIP descriptor unless a `?bundle-format=` other than "zip" is
// threaded in, and the ZIP fetch/extract path is byte-for-byte unchanged.

const CODEC_ALIASES = { br: "brotli" };
const normalizeCodec = (codec) => CODEC_ALIASES[codec] || codec;

/**
 * Whether this environment's native DecompressionStream can decode `codec`.
 * gzip/deflate are universal; zstd/brotli are non-standard extensions present
 * only in some engines (feature-detected by construction, never assumed).
 */
export function nativeDecoderSupported(codec) {
  if (typeof DecompressionStream === "undefined") return false;
  try {
    // Constructing with an unsupported algorithm throws.
    void new DecompressionStream(codec);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the runtime can decode `codec` at all: natively, or via a bundled
 * WASM fallback. zstd always has the zstddec (libzstd→WASM) fallback; brotli has
 * no bundled fallback in this prototype, so it is decodable only where native.
 */
export function decoderSupported(codec) {
  const c = normalizeCodec(codec);
  if (nativeDecoderSupported(c)) return true;
  if (c === "zstd") return true; // zstddec (libzstd→WASM) fallback is bundled
  return false;
}

async function inflateWithNativeStream(bytes, codec) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream(codec));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Lazily create + init a single zstddec decoder. zstddec is real libzstd
// compiled to WASM with the wasm embedded as base64 (no separate asset fetch,
// no application/wasm MIME/CSP concern in the SW-mediated environment). We use
// it instead of the pure-JS fzstd, which SILENTLY CORRUPTS this bundle's large
// windowLog-27 frame (measured: right size, wrong bytes from ~101 MB on).
let zstdDecoderPromise = null;
function getZstdDecoder() {
  if (!zstdDecoderPromise) {
    zstdDecoderPromise = import("zstddec").then(async ({ ZSTDDecoder }) => {
      const decoder = new ZSTDDecoder();
      await decoder.init();
      return decoder;
    });
  }
  return zstdDecoderPromise;
}

/**
 * Decode a compressed bundle (tar.gz / tar.br / tar.zst) into the raw .tar
 * bytes. Prefers native DecompressionStream; falls back to zstddec (WASM) for
 * zstd, which no shipping browser exposes via DecompressionStream (Chrome 150 +
 * Firefox both lack it). Runs in the worker, so the tar (~250 MB for Moodle
 * core) lands in the worker heap before being written to MEMFS — the memory
 * cost the ADR benchmark measures for "approach (a)".
 */
export async function decodeToTar(compressed, codec, uncompressedSize) {
  const c = normalizeCodec(codec);
  if (nativeDecoderSupported(c)) return inflateWithNativeStream(compressed, c);
  if (c === "zstd") {
    if (!uncompressedSize) {
      throw new Error("zstd decode requires the manifest's uncompressedSize.");
    }
    const decoder = await getZstdDecoder();
    return decoder.decode(compressed, uncompressedSize);
  }
  throw new Error(`No available decoder for codec "${codec}" in this browser.`);
}

/**
 * Whether a codec can be decoded as a STREAM (bounded memory): natively via
 * DecompressionStream (gzip/deflate, and brotli/zstd where the engine has them),
 * or via zstddec's streaming generator for zstd. This is the ADR 0019 default
 * path; the ADR 0018 full-buffer path is kept only behind `?bundle-format=…-full`.
 */
export function streamingSupported(codec) {
  const c = normalizeCodec(codec);
  if (nativeDecoderSupported(c)) return true;
  if (c === "zstd") return true; // zstddec streaming generator
  return false;
}

/**
 * Choose which bundle representation to boot from. Default and fallback is the
 * canonical ZIP (manifest.bundle). A requested tar.* format selects a matching
 * manifest.bundleAlternatives entry; a "-full" suffix (e.g. `tar.zst-full`)
 * forces the ADR 0018 full-buffer path for comparison. "auto" picks the smallest
 * STREAMING-capable alternative (falling back to ZIP). A `forced` selection (an
 * explicit non-zip `?bundle-format=`) throws when the format is absent or
 * undecodable instead of silently masking the miss with ZIP.
 *
 * The returned descriptor carries `extraction: "streaming" | "full"`; the ZIP
 * descriptor has no `extraction` (it uses ZipArchive).
 */
export function selectBundleDescriptor(manifest, requestedFormat) {
  const b = manifest.bundle;
  const zipDescriptor = {
    format: b.format || "zip",
    container: "zip",
    codec: "deflate",
    url: b.url,
    parts: b.parts,
    sha256: b.sha256,
    size: b.size,
    fileCount: b.fileCount,
    forced: false,
  };
  const rawReq = String(requestedFormat || "zip").toLowerCase();
  if (rawReq === "zip" || rawReq === "") return zipDescriptor;

  // "-full" suffix selects the ADR 0018 full-buffer extraction (unsafe for
  // production memory; kept for benchmarking).
  const full = rawReq.endsWith("-full");
  const req = full ? rawReq.slice(0, -"-full".length) : rawReq;
  const extraction = full ? "full" : "streaming";

  const alts = Array.isArray(manifest.bundleAlternatives) ? manifest.bundleAlternatives : [];
  const toDescriptor = (a, forced, mode) => ({
    format: a.format,
    requestedFormat: rawReq,
    container: a.container || "tar",
    codec: a.codec,
    extraction: mode,
    url: a.url,
    parts: a.parts,
    sha256: a.sha256,
    size: a.size,
    uncompressedSize: a.uncompressedSize,
    fileCount: a.fileCount,
    forced,
  });

  if (req === "auto") {
    // Prefer the smallest STREAMING-capable alternative; never pick "-full" for auto.
    const pick = alts.find((a) => streamingSupported(a.codec));
    return pick ? toDescriptor(pick, false, "streaming") : zipDescriptor;
  }

  const match = alts.find((a) => a.format === req);
  if (!match) {
    throw new Error(`Requested bundle format "${req}" is not in manifest.bundleAlternatives.`);
  }
  const usable = extraction === "streaming" ? streamingSupported(match.codec) : decoderSupported(match.codec);
  if (!usable) {
    throw new Error(
      `Bundle format "${rawReq}" needs codec "${match.codec}" (${extraction}), which this browser cannot decode.`,
    );
  }
  return toDescriptor(match, true, extraction);
}

// A descriptor's fetch spec reuses the existing fetchBundleWithCache pipeline
// (single-url or chunked parts, whole-artifact + per-part SHA-256, Cache API).
const descriptorToBundle = (d) => ({
  url: d.url,
  parts: d.parts,
  sha256: d.sha256,
  size: d.size,
  format: d.format,
});

export async function resolveBootstrapArchive(
  {
    manifestUrl = DEFAULT_BOOT_OPTIONS.manifestUrl,
    bundleFormat = null,
  } = {},
  onProgress = () => {},
) {
  onProgress({
    phase: "manifest",
    detail: `Loading manifest ${manifestUrl}`,
  });

  const manifest = await fetchManifest(manifestUrl);
  // Throws for a forced-but-missing/undecodable format (fail loud).
  const descriptor = selectBundleDescriptor(manifest, bundleFormat);

  // ZIP baseline: the default + fallback path, completely unchanged.
  if (descriptor.container === "zip") {
    const bytes = await fetchBundleWithCache(manifest, onProgress);
    return {
      kind: "bundle",
      manifest,
      bytes,
      descriptor,
      sourceUrl: manifest.bundle.url || manifest.bundle.parts?.[0]?.url || "",
    };
  }

  // tar.* candidate. For STREAMING extraction (ADR 0019, the default) we only
  // fetch here (cache-first, SHA-256-verified) and return the COMPRESSED bytes —
  // the streaming decode + incremental MEMFS write happen at the extraction site
  // once PHP is ready, so the ~250 MB tar is never materialized. For the FULL
  // (ADR 0018) path, kept behind `?bundle-format=…-full`, we decode to a plain
  // .tar here. A fetch failure on a non-forced selection falls back to ZIP; a
  // forced one fails loud. (Streaming decode/extract failures surface at the
  // site, which has its own ZIP fallback.)
  try {
    const compressed = await fetchBundleWithCache(
      { bundle: descriptorToBundle(descriptor), release: manifest.release },
      onProgress,
    );
    const compressedBytes = compressed.byteLength;

    if (descriptor.extraction === "streaming") {
      return {
        kind: "bundle",
        manifest,
        bytes: compressed,
        descriptor,
        compressedBytes,
        sourceUrl: descriptor.url || descriptor.parts?.[0]?.url || "",
      };
    }

    onProgress({
      phase: "decompress",
      detail: `Decoding ${descriptor.format} (codec ${descriptor.codec}) [full buffer].`,
    });
    const tDecode = now();
    const bytes = await decodeToTar(compressed, descriptor.codec, descriptor.uncompressedSize);
    const decodeMs = Math.round(now() - tDecode);
    return {
      kind: "bundle",
      manifest,
      bytes,
      descriptor,
      decodeMs,
      compressedBytes,
      sourceUrl: descriptor.url || descriptor.parts?.[0]?.url || "",
    };
  } catch (error) {
    if (descriptor.forced) {
      throw new Error(
        `Forced bundle format ${descriptor.format} failed: ${error?.message || error}`,
      );
    }
    onProgress({
      phase: "bundle-format-fallback",
      detail: `Alternative ${descriptor.format} failed (${error?.message || error}); falling back to ZIP.`,
    });
    const bytes = await fetchBundleWithCache(manifest, onProgress);
    return {
      kind: "bundle",
      manifest,
      bytes,
      descriptor: selectBundleDescriptor(manifest, "zip"),
      sourceUrl: manifest.bundle.url || manifest.bundle.parts?.[0]?.url || "",
    };
  }
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

/**
 * Extract a plain `.tar` core bundle (ADR 0018) with PHP's native PharData —
 * the tar twin of buildCoreExtractScript. PharData reads the USTAR prefix/name
 * split and GNU longlink entries our tar writer emits (verified: full 23,324-file
 * parity with the ZIP baseline), so long Moodle paths survive. It does NOT read
 * PAX 'path' headers, which is exactly why scripts/lib/tar-ustar.mjs avoids them.
 *
 * Same sentinel contract as the ZIP extractor:
 *   - `NO_TAR_EXT`            → the build lacks ext/phar (caller fails loud).
 *   - `INSTALL_OK <count>`    → extracted <count> entries into the target.
 *   - `INSTALL_ERR <message>` → anything else (caller fails loud).
 */
export function buildTarExtractScript(tarPath, stagePath, targetRoot) {
  const tar = escapePhp(tarPath);
  const stage = escapePhp(stagePath);
  const target = escapePhp(targetRoot);
  return `<?php
echo (function () {
  $tarPath = '${tar}';
  $stage = '${stage}';
  $target = '${target}';
  if (!class_exists('PharData')) { return 'NO_TAR_EXT'; }
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
    $phar = new PharData($tarPath);
    $count = count($phar);
    // overwrite=true so a retry after a partial extract is clean.
    $phar->extractTo($stage, null, true);
    unset($phar);
    // Descend into a lone wrapping folder; our root-level tars are used as-is.
    $top = array_values(array_diff(scandir($stage), ['.', '..']));
    $src = $stage;
    if (count($top) === 1 && is_dir($stage . '/' . $top[0])) {
      $src = $stage . '/' . $top[0];
    }
    $rrmdir($target);
    @mkdir(dirname($target), 0777, true);
    if (!@rename($src, $target)) { $rrmdir($stage); return 'INSTALL_ERR rename'; }
    $rrmdir($stage);
    @unlink($tarPath);
    return 'INSTALL_OK ' . $count;
  } catch (\\Throwable $e) {
    $rrmdir($stage);
    return 'INSTALL_ERR ' . $e->getMessage();
  }
})();
`;
}
