/**
 * ResourceRegistry: resolves named or inline resource descriptors to bytes or text.
 */
export class ResourceRegistry {
  /** @type {Record<string, object>} */
  #defs;
  /** @type {string} */
  #appBaseUrl;
  /** @type {object|null} */
  #php;
  /** @type {Map<string, Uint8Array>} */
  #cache;

  /**
   * @param {Record<string, object>} resourceDefs - Named resource descriptors from blueprint.resources
   * @param {{ appBaseUrl?: string, php?: object }} options
   */
  constructor(resourceDefs = {}, { appBaseUrl = "", php = null } = {}) {
    this.#defs = resourceDefs;
    this.#appBaseUrl = appBaseUrl;
    this.#php = php;
    this.#cache = new Map();
  }

  /**
   * Resolve a resource reference to bytes.
   * @param {string|object} ref - "@name" string or inline descriptor object.
   * @returns {Promise<Uint8Array>}
   */
  async resolve(ref) {
    const descriptor = this.#resolveDescriptor(ref);
    const cacheKey = this.#cacheKey(descriptor);
    if (cacheKey && this.#cache.has(cacheKey)) {
      return this.#cache.get(cacheKey);
    }

    const bytes = await this.#fetchDescriptor(descriptor);
    if (cacheKey) {
      this.#cache.set(cacheKey, bytes);
    }
    return bytes;
  }

  /**
   * Resolve a resource reference to a UTF-8 string.
   * @param {string|object} ref
   * @returns {Promise<string>}
   */
  async resolveText(ref) {
    const bytes = await this.resolve(ref);
    return new TextDecoder().decode(bytes);
  }

  #resolveDescriptor(ref) {
    if (typeof ref === "string" && ref.startsWith("@")) {
      const name = ref.slice(1);
      const desc = this.#defs[name];
      if (!desc) {
        throw new Error(`Unknown resource reference: ${ref}`);
      }
      return desc;
    }
    if (typeof ref === "object" && ref !== null) {
      return ref;
    }
    throw new Error(`Invalid resource reference: ${JSON.stringify(ref)}`);
  }

  #cacheKey(descriptor) {
    if (descriptor.url) return `url:${descriptor.url}`;
    if (descriptor.bundled) return `bundled:${descriptor.bundled}`;
    if (descriptor.vfs) return `vfs:${descriptor.vfs}`;
    return null; // inline values are not cached
  }

  async #fetchDescriptor(descriptor) {
    const encoder = new TextEncoder();

    if (descriptor.literal !== undefined) {
      return typeof descriptor.literal === "string"
        ? encoder.encode(descriptor.literal)
        : descriptor.literal instanceof Uint8Array
          ? descriptor.literal
          : encoder.encode(JSON.stringify(descriptor.literal));
    }

    if (descriptor.url) {
      const resolved = this.#appBaseUrl
        ? new URL(descriptor.url, this.#appBaseUrl).toString()
        : descriptor.url;
      const response = await fetch(resolved);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch resource from ${resolved}: ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }

    if (descriptor.base64) {
      return base64ToBytes(descriptor.base64);
    }

    if (descriptor["data-url"]) {
      return dataUrlToBytes(descriptor["data-url"]);
    }

    if (descriptor.bundled) {
      const url = this.#appBaseUrl
        ? new URL(descriptor.bundled, this.#appBaseUrl).toString()
        : descriptor.bundled;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch bundled resource from ${url}: ${response.status}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }

    if (descriptor.vfs) {
      if (!this.#php) {
        throw new Error("Cannot resolve VFS resource without a PHP runtime.");
      }
      return this.#php.readFile(descriptor.vfs);
    }

    throw new Error(
      `Unsupported resource descriptor: ${JSON.stringify(descriptor)}`,
    );
  }
}

function base64ToBytes(str) {
  if (typeof atob === "function") {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(str, "base64"));
}

function dataUrlToBytes(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]*?)?(;base64)?,(.*)$/su);
  if (!match) {
    throw new Error("Malformed data: URL in resource descriptor.");
  }
  if (match[2]) {
    return base64ToBytes(match[3]);
  }
  return new TextEncoder().encode(decodeURIComponent(match[3]));
}
