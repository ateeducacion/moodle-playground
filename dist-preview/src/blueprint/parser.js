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
  if (/^[A-Za-z0-9+/=]+$/u.test(trimmed)) {
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

function decodeBase64(str) {
  if (typeof atob === "function") {
    return atob(str);
  }
  // Node.js fallback
  return Buffer.from(str, "base64").toString("utf-8");
}
