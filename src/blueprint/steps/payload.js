/**
 * Shared payload resolution for provisioning steps that accept their data
 * either inline in the blueprint OR by reference to an external resource
 * (a `@name` reference, an inline resource descriptor like `{ "url": "…" }`,
 * or a raw JSON/XML string). This reuses the blueprint ResourceRegistry, so
 * "reference an external JSON/XML (URL or similar)" needs no new mechanism —
 * the same `url`/`base64`/`data-url`/`bundled`/`vfs`/`literal` types that
 * `writeFile`/`unzip` already use work here too.
 */

const RESOURCE_TYPE_KEYS = [
  "url",
  "base64",
  "data-url",
  "bundled",
  "vfs",
  "literal",
];

/**
 * True when an object is an inline resource descriptor (has a resource type
 * key) rather than inline domain data (e.g. a scales export envelope).
 * @param {*} obj
 * @returns {boolean}
 */
export function isResourceDescriptor(obj) {
  return (
    !!obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    RESOURCE_TYPE_KEYS.some((k) => k in obj)
  );
}

/**
 * Resolve a JSON payload to a parsed value (array or object).
 *
 * Accepts:
 *  - an inline array/object (returned as-is),
 *  - a `@name` reference or inline resource descriptor (fetched + JSON-parsed),
 *  - a raw JSON string (parsed).
 *
 * @param {*} payload
 * @param {object|undefined} resources - ResourceRegistry from the step context.
 * @param {string} stepName - For error messages.
 * @returns {Promise<*>}
 */
export async function resolveJsonPayload(payload, resources, stepName) {
  if (typeof payload === "string") {
    if (payload.startsWith("@")) {
      return JSON.parse(
        await requireResources(resources, stepName).resolveText(payload),
      );
    }
    return JSON.parse(payload);
  }
  if (Array.isArray(payload)) return payload;
  if (isResourceDescriptor(payload)) {
    return JSON.parse(
      await requireResources(resources, stepName).resolveText(payload),
    );
  }
  if (payload && typeof payload === "object") return payload;
  throw new Error(`${stepName}: missing or invalid payload.`);
}

/**
 * Normalize a resolved JSON payload to an array of entries. Accepts a plain
 * array or an envelope object that wraps the array under `key`
 * (e.g. `{ "format": "moodle-scale-export", "scales": [...] }`).
 *
 * @param {*} data
 * @param {string} key - Envelope property holding the array (e.g. "scales").
 * @returns {object[]}
 */
export function toEntryArray(data, key) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data[key])) {
    return data[key];
  }
  return [];
}

/**
 * Resolve a single XML preset reference to an XML string. Accepts:
 *  - a `@name` reference (fetched as text),
 *  - a raw XML string,
 *  - `{ "xml": "…" }` (inline literal),
 *  - `{ "resource": <ref> }` (a nested @name / descriptor),
 *  - an inline resource descriptor `{ "url": "…" }` etc.
 *
 * @param {*} item
 * @param {object|undefined} resources
 * @param {string} stepName
 * @returns {Promise<string>}
 */
export async function resolveXmlItem(item, resources, stepName) {
  if (typeof item === "string") {
    if (item.startsWith("@")) {
      return requireResources(resources, stepName).resolveText(item);
    }
    return item; // raw XML literal
  }
  if (item && typeof item === "object") {
    if (typeof item.xml === "string") return item.xml;
    if (item.resource !== undefined) {
      return requireResources(resources, stepName).resolveText(item.resource);
    }
    if (isResourceDescriptor(item)) {
      return requireResources(resources, stepName).resolveText(item);
    }
  }
  throw new Error(`${stepName}: invalid role preset reference.`);
}

function requireResources(resources, stepName) {
  if (!resources || typeof resources.resolveText !== "function") {
    throw new Error(
      `${stepName}: a resource reference was used but no ResourceRegistry is available.`,
    );
  }
  return resources;
}
