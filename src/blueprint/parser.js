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
  const match = dataUrl.match(/^data:([^;,]*?)?(;base64)?,(.*)$/su);
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
  const normalized = normalizeBase64(str);
  if (typeof atob === "function") {
    // atob returns Latin-1; decode via Uint8Array for correct UTF-8 handling
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
  // Node.js fallback
  return Buffer.from(normalized, "base64").toString("utf-8");
}
