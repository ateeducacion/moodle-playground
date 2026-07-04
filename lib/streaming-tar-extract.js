// streaming-tar-extract.js — bounded-memory streaming extraction of a solid
// tar.* core bundle (ADR 0019). Replaces the "decode the whole .tar into MEMFS
// then PharData::extractTo()" prototype from ADR 0018, whose peak memory was the
// blocker to adoption.
//
// Pipeline: compressed bytes → (zstddec streaming | native DecompressionStream)
// → a ReadableStream of decoded tar bytes → an incremental USTAR/GNU-longlink
// parser that writes each entry into MEMFS as it is decoded. The full
// uncompressed tar (~250 MB for Moodle core) is NEVER materialized: at any
// moment we hold only a partial 512-byte header, the current entry's bytes
// (bounded by the largest single file), and one decoded chunk.
//
// Path safety mirrors the ZIP boot path (lib/moodle-loader.js): "\\"→"/",
// absolute paths and ".." segments are rejected (fail loud), empty entries
// skipped — no TAR-slip.

const BLOCK = 512;

/**
 * Sanitize a raw tar entry name. Rejects absolute paths and ".." traversal
 * (throws), normalizes separators, drops "." / empty segments. Returns the safe
 * relative path, or "" for an empty entry the caller should skip.
 */
export function sanitizeTarPath(rawName) {
  const normalized = String(rawName).replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    throw new Error(`Unsafe tar entry (absolute path): ${rawName}`);
  }
  const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Unsafe tar entry (path traversal): ${rawName}`);
  }
  return segments.join("/");
}

function readOctal(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  let s = "";
  for (const byte of raw) {
    if (byte === 0 || byte === 0x20) {
      if (s) break;
      continue;
    }
    s += String.fromCharCode(byte);
  }
  return s ? Number.parseInt(s, 8) : 0;
}

function readCString(block, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end += 1;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function isZeroBlock(block) {
  for (let i = 0; i < BLOCK; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Incremental USTAR/GNU tar parser. Feed arbitrary byte chunks via push(); it
 * invokes onEntry({ type, path, data }) for each complete file/directory entry.
 * Directory entries carry no data. Bounded memory: it never buffers more than a
 * partial header + the current entry + leftover bytes (tracked in maxBuffered).
 */
export class StreamingTarParser {
  constructor({ onEntry } = {}) {
    this.onEntry = onEntry || (() => {});
    this.leftover = new Uint8Array(0); // bytes not yet consumed as blocks
    this.state = "header"; // "header" | "data" | "pad"
    this.entry = null; // { name, size, typeflag, isLongLink }
    this.dataChunks = [];
    this.dataFilled = 0;
    this.padRemaining = 0;
    this.pendingLongName = null;
    this.zeroBlocks = 0;
    this.ended = false;
    this.maxBuffered = 0;
    this.fileCount = 0;
    this.dirCount = 0;
    this.phpCount = 0;
    this.bytesWritten = 0;
  }

  _track(extra = 0) {
    const total = this.leftover.length + this.dataFilled + extra;
    if (total > this.maxBuffered) this.maxBuffered = total;
  }

  push(chunk) {
    if (chunk?.length) {
      // Append to leftover. This concatenation is bounded: leftover is always
      // < 512 bytes when in header/pad state, and in data state we drain into
      // dataChunks immediately below.
      const merged = new Uint8Array(this.leftover.length + chunk.length);
      merged.set(this.leftover, 0);
      merged.set(chunk, this.leftover.length);
      this.leftover = merged;
    }
    this._track();
    this._drain();
  }

  _drain() {
    let progress = true;
    while (progress) {
      progress = false;

      if (this.state === "header") {
        if (this.leftover.length < BLOCK) break;
        const header = this.leftover.subarray(0, BLOCK);
        this.leftover = this.leftover.subarray(BLOCK);

        if (isZeroBlock(header)) {
          this.zeroBlocks += 1;
          progress = true;
          continue;
        }
        this.zeroBlocks = 0;

        const size = readOctal(header, 124, 12);
        const typeflag = String.fromCharCode(header[156]) || "0";
        const name = readCString(header, 0, 100);
        const prefix = readCString(header, 345, 155);
        this.entry = {
          name,
          prefix,
          size,
          typeflag,
          isLongLink: typeflag === "L",
        };
        this.dataChunks = [];
        this.dataFilled = 0;

        if (size > 0) {
          this.state = "data";
        } else {
          this._finishEntry();
          this.state = "header";
        }
        progress = true;
        continue;
      }

      if (this.state === "data") {
        const need = this.entry.size - this.dataFilled;
        if (need <= 0) {
          this._finishEntry();
          continue;
        }
        if (this.leftover.length === 0) break;
        const take = Math.min(need, this.leftover.length);
        this.dataChunks.push(this.leftover.subarray(0, take));
        this.dataFilled += take;
        this.leftover = this.leftover.subarray(take);
        this._track();
        if (this.dataFilled === this.entry.size) {
          this._finishEntry();
        }
        progress = true;
        continue;
      }

      if (this.state === "pad") {
        if (this.padRemaining === 0) {
          this.state = "header";
          progress = true;
          continue;
        }
        if (this.leftover.length === 0) break;
        const skip = Math.min(this.padRemaining, this.leftover.length);
        this.leftover = this.leftover.subarray(skip);
        this.padRemaining -= skip;
        progress = true;
      }
    }
  }

  _concatData() {
    const out = new Uint8Array(this.dataFilled);
    let offset = 0;
    for (const c of this.dataChunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  _finishEntry() {
    const { entry } = this;
    const data = this._concatData();
    this.dataChunks = [];
    // Set up padding to the next 512-byte boundary before emitting, so the
    // state machine is consistent even if onEntry throws.
    const remainder = entry.size % BLOCK;
    this.padRemaining = remainder === 0 ? 0 : BLOCK - remainder;
    this.state = this.padRemaining > 0 ? "pad" : "header";
    this.dataFilled = 0;
    this.entry = null;

    if (entry.isLongLink) {
      // GNU longlink body is the full path (NUL-terminated) for the NEXT entry.
      this.pendingLongName = new TextDecoder().decode(data).replace(/\0.*$/, "");
      return;
    }

    const rawName =
      this.pendingLongName ?? (entry.prefix ? `${entry.prefix}/${entry.name}` : entry.name);
    this.pendingLongName = null;

    // Directory entries: typeflag '5', or a trailing-slash name.
    const isDir = entry.typeflag === "5" || rawName.endsWith("/");
    const path = sanitizeTarPath(rawName);
    if (!path) return; // empty after sanitization — skip

    if (isDir) {
      this.dirCount += 1;
      this.onEntry({ type: "dir", path });
      return;
    }
    // Only regular files ('0' or '\0'); ignore symlinks/other exotic types.
    if (entry.typeflag !== "0" && entry.typeflag !== "\0") return;
    this.fileCount += 1;
    this.bytesWritten += data.length;
    if (path.endsWith(".php")) this.phpCount += 1;
    this.onEntry({ type: "file", path, data });
  }

  end() {
    this.ended = true;
    // A well-formed archive ends with >=1 zero block (we require the two-zero
    // trailer to have been seen, but tolerate a truncated trailer). What we do
    // NOT tolerate is a half-read entry: that means the stream was truncated.
    if (this.state === "data" && this.dataFilled < (this.entry?.size ?? 0)) {
      throw new Error(
        `Truncated tar stream: entry ${this.entry?.name} expected ${this.entry?.size} bytes, got ${this.dataFilled}`,
      );
    }
    return this.stats();
  }

  stats() {
    return {
      fileCount: this.fileCount,
      dirCount: this.dirCount,
      phpCount: this.phpCount,
      bytesWritten: this.bytesWritten,
      maxBuffered: this.maxBuffered,
    };
  }
}

/**
 * Build a ReadableStream of decoded tar bytes from the compressed bundle.
 * gzip/deflate/brotli use the browser-native DecompressionStream; zstd uses
 * zstddec's streaming generator (native DecompressionStream("zstd") is absent in
 * every shipping browser). The generator is lazy — it yields ~128 KB chunks and
 * holds only the zstd window in WASM, so the JS side never sees the whole tar.
 */
export async function createDecodedTarStream(compressed, codec) {
  const normalized = codec === "br" ? "brotli" : codec;
  if (typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream(normalized);
      return new Response(compressed).body.pipeThrough(ds);
    } catch {
      // Not natively supported — fall through to a bundled decoder.
    }
  }
  if (normalized === "zstd") {
    const { ZSTDDecoder } = await import("zstddec/stream");
    const decoder = new ZSTDDecoder();
    await decoder.init();
    const generator = decoder.decodeStreaming([compressed]);
    return new ReadableStream({
      pull(controller) {
        const { value, done } = generator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
    });
  }
  throw new Error(`No streaming decoder available for codec "${codec}".`);
}

/**
 * Stream a compressed tar bundle into MEMFS, one entry at a time. Writes files
 * via the raw Emscripten module (mkdirTree + writeFile), mirroring
 * writeEntriesToPhp() but without ever holding the whole archive. Returns
 * extraction stats (file/dir/php counts, bytes, peak JS buffer).
 */
export async function extractTarStreamToPhp(tarStream, php, targetRoot, options = {}) {
  const { onProgress = () => {} } = options;
  const rawPhp = php._php;
  const root = String(targetRoot).replace(/\/+$/, "");
  const createdDirs = new Set();

  const ensureDir = (dir) => {
    if (!dir || createdDirs.has(dir)) return;
    rawPhp.mkdirTree(dir);
    let d = dir;
    while (d && !createdDirs.has(d)) {
      createdDirs.add(d);
      d = d.substring(0, d.lastIndexOf("/")) || null;
    }
  };

  const parser = new StreamingTarParser({
    onEntry: (entry) => {
      const dest = `${root}/${entry.path}`;
      if (entry.type === "dir") {
        ensureDir(dest);
        return;
      }
      const lastSlash = dest.lastIndexOf("/");
      if (lastSlash > 0) ensureDir(dest.substring(0, lastSlash));
      rawPhp.writeFile(dest, entry.data);
      if (parser.fileCount % 1000 === 0) {
        onProgress({ fileCount: parser.fileCount, bytes: parser.bytesWritten });
      }
    },
  });

  ensureDir(root);
  const reader = tarStream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value);
  }
  return parser.end();
}
