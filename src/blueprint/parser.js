/**
 * Parse a blueprint from various input formats.
 *
 * Accepts: plain object (passthrough), JSON string, base64-encoded JSON,
 * or a data: URL containing JSON (optionally base64-encoded).
 *
 * @param {*} input
 * @returns {object} Parsed blueprint object.
 */
export function parseBlueprint(input) {
  if (input === null || input === undefined) {
    throw new Error("Blueprint input is null or undefined.");
  }

  // Plain object — passthrough
  if (typeof input === "object" && !Array.isArray(input)) {
    return input;
  }

  if (typeof input !== "string") {
    throw new Error(`Unsupported blueprint input type: ${typeof input}`);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Blueprint input is an empty string.");
  }

  // data: URL
  if (trimmed.startsWith("data:")) {
    return parseDataUrl(trimmed);
  }

  // JSON string — starts with {
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSON blueprint: ${error.message}`);
    }
  }

  // base64-encoded JSON — typically starts with "ey" (base64 of "{")
  // Accept both standard base64 (+/=) and base64url (-_) variants.
  // Require minimum length to avoid false positives on short strings like "hello"
  if (trimmed.length >= 20 && /^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) {
    try {
      const decoded = decodeBase64(trimmed);
      return JSON.parse(decoded);
    } catch (error) {
      throw new Error(`Invalid base64 blueprint: ${error.message}`);
    }
  }

  throw new Error(
    "Unrecognized blueprint format. Expected JSON, base64, data-URL, or object.",
  );
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([^,]*?)(;base64)?,(.*)$/su);
  if (!match) {
    throw new Error("Malformed data: URL.");
  }

  const isBase64 = Boolean(match[2]);
  const payload = match[3];

  let jsonString;
  if (isBase64) {
    jsonString = decodeBase64(payload);
  } else {
    jsonString = decodeURIComponent(payload);
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`Invalid JSON in data: URL: ${error.message}`);
  }
}

function normalizeBase64(str) {
  // Convert base64url to standard base64: - → +, _ → /
  let b64 = str.replaceAll("-", "+").replaceAll("_", "/");
  // Add padding if missing
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  return b64;
}

function decodeBase64(str) {
  return new TextDecoder().decode(decodeBase64ToBytes(str));
}

// Decode a base64 / base64url string to raw bytes (no UTF-8 decoding), so we can
// inspect gzip magic bytes and feed DecompressionStream.
function decodeBase64ToBytes(str) {
  const normalized = normalizeBase64(str);
  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node.js fallback
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

// Encode raw bytes to base64url (URL-safe, unpadded) for use in `?blueprint=`.
function bytesToBase64Url(bytes) {
  let b64;
  if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    b64 = btoa(binary);
  } else {
    b64 = Buffer.from(bytes).toString("base64");
  }
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// gzip / gunzip via the web Streams API (browsers + Node 18+). Portable: write
// the bytes to the stream's writable end and read the result off the readable.
async function gzip(bytes) {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * Compress a blueprint to a short, URL-safe `?blueprint=` value: gzip(JSON) then
 * base64url. A repetitive blueprint shrinks ~70-85% vs plain base64, keeping the
 * shareable link self-contained but small. Throws if `CompressionStream` is
 * unavailable so the caller can fall back to plain base64.
 *
 * @param {object} blueprint
 * @returns {Promise<string>} base64url of gzipped JSON
 */
export async function compressBlueprint(blueprint) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream is not available in this environment.");
  }
  const input = new TextEncoder().encode(JSON.stringify(blueprint));
  return bytesToBase64Url(await gzip(input));
}

/**
 * Encode a blueprint for the `?blueprint=` URL param, self-handling the
 * fallback so callers never need to catch: gzip+base64url via
 * {@link compressBlueprint} when `CompressionStream` is available, otherwise
 * plain base64 of the JSON. Never throws.
 *
 * @param {object} blueprint
 * @returns {Promise<string>}
 */
export async function encodeBlueprintParam(blueprint) {
  try {
    return await compressBlueprint(blueprint);
  } catch {
    return btoa(unescape(encodeURIComponent(JSON.stringify(blueprint))));
  }
}

/**
 * Async wrapper over {@link parseBlueprint} that also accepts a gzip+base64url
 * value. Detection is by content, not by a new URL param: a base64 value whose
 * decoded bytes start with the gzip magic `0x1f 0x8b` is decompressed; anything
 * else (object, JSON string, data: URL, plain base64-JSON) falls through to the
 * synchronous parser unchanged. A JSON document never starts with those bytes,
 * so old `?blueprint=<base64-JSON>` links keep working.
 *
 * @param {*} value
 * @returns {Promise<object>} Parsed blueprint object.
 */
export async function parseBlueprintParam(value) {
  if (typeof value !== "string") {
    return parseBlueprint(value);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("data:")) {
    return parseBlueprint(value);
  }
  if (trimmed.length >= 20 && /^[A-Za-z0-9+/=_-]+$/u.test(trimmed)) {
    let bytes;
    try {
      bytes = decodeBase64ToBytes(trimmed);
    } catch {
      return parseBlueprint(value);
    }
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error(
          "DecompressionStream is required to read a gzipped blueprint.",
        );
      }
      const json = new TextDecoder().decode(await gunzip(bytes));
      return JSON.parse(json);
    }
  }
  return parseBlueprint(value);
}
