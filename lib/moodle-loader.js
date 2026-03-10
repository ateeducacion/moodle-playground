function splitPath(path) {
  return path.split("/").filter(Boolean);
}

function resolveUrl(url, base = globalThis.location?.href || self.location?.href) {
  return new URL(url, base).toString();
}

export async function fetchBinary(url, onProgress = () => {}) {
  const resolvedUrl = resolveUrl(url);
  const response = await fetch(resolvedUrl);

  if (!response.ok) {
    throw new Error(`Unable to fetch ${resolvedUrl}: ${response.status} ${response.statusText}`);
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

export async function fetchManifest(manifestUrl) {
  const resolvedManifestUrl = resolveUrl(manifestUrl);
  const response = await fetch(resolvedManifestUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch manifest ${resolvedManifestUrl}: ${response.status} ${response.statusText}`,
    );
  }

  const manifest = await response.json();

  if (!manifest?.bundle) {
    throw new Error(`Manifest ${resolvedManifestUrl} does not contain a bundle.`);
  }

  return {
    manifest,
    resolvedManifestUrl,
  };
}

function readTarString(bytes, start, length) {
  let result = "";

  for (let index = start; index < start + length; index += 1) {
    const byte = bytes[index];

    if (byte === 0) {
      break;
    }

    result += String.fromCharCode(byte);
  }

  return result;
}

function readTarNumber(bytes, start, length) {
  const raw = readTarString(bytes, start, length).trim().replace(/\0/g, "");

  if (!raw) {
    return 0;
  }

  return Number.parseInt(raw.replace(/\s+$/, ""), 8);
}

function isZeroBlock(bytes, offset) {
  for (let index = offset; index < offset + 512; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }

  return true;
}

export function extractTarEntries(tarBytes) {
  const entries = [];
  let offset = 0;

  while (offset + 512 <= tarBytes.length) {
    if (isZeroBlock(tarBytes, offset)) {
      break;
    }

    const name = readTarString(tarBytes, offset, 100);
    const prefix = readTarString(tarBytes, offset + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readTarNumber(tarBytes, offset + 124, 12);
    const typeFlag = readTarString(tarBytes, offset + 156, 1) || "0";

    offset += 512;

    const data = tarBytes.slice(offset, offset + size);

    if ((typeFlag === "0" || typeFlag === "\0") && path) {
      entries.push({
        path,
        data,
      });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}

export async function fetchManifestEntries(manifestUrl, onProgress = () => {}) {
  const { manifest, resolvedManifestUrl } = await fetchManifest(manifestUrl);
  const bundleUrl = resolveUrl(manifest.bundle, resolvedManifestUrl);
  const tarBytes = await fetchBinary(bundleUrl, onProgress);
  const entries = extractTarEntries(tarBytes);

  return {
    manifest,
    resolvedManifestUrl,
    bundleUrl,
    entries,
  };
}

export async function ensureDir(php, path) {
  const parts = splitPath(path);
  let current = "";

  for (const part of parts) {
    current += `/${part}`;
    const about = await php.analyzePath(current);

    if (about?.exists) {
      if (!about.object?.isFolder) {
        throw new Error(`Cannot create directory ${current}: path exists and is not a directory.`);
      }

      continue;
    }

    try {
      await php.mkdir(current);
    } catch (error) {
      const parent = current.split("/").slice(0, -1).join("/") || "/";
      const parentAbout = await php.analyzePath(parent);

      throw new Error(
        `mkdir failed for ${current} (parent=${parent}, parentExists=${Boolean(parentAbout?.exists)}, parentIsFolder=${Boolean(parentAbout?.object?.isFolder)}, errno=${error?.errno ?? "unknown"})`,
      );
    }
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
