// Validate the classic ZIP directory before trusting the decoder's EOF.
// The decoder still owns decompression. Reject ZIP64, split/encrypted archives
// and data descriptors rather than trusting a partially decoded result.
// Record layouts: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
export function readZipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  for (; end >= earliest; end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < earliest) throw new Error("missing or truncated end record");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    start + size !== end
  ) {
    throw new Error("inconsistent or unsupported central directory");
  }
  const entries = [];
  let cursor = start;
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("invalid central directory entry");
    const nameEnd = cursor + 46 + view.getUint16(cursor + 28, true);
    const next =
      nameEnd +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const original = view.getUint32(cursor + 24, true);
    if (
      next > end ||
      offset + 30 > start ||
      view.getUint32(offset, true) !== 0x04034b50
    )
      throw new Error("missing or truncated file header");
    if (
      view.getUint16(cursor + 34, true) ||
      view.getUint16(cursor + 8, true) & 9 ||
      ![0, 8].includes(method)
    )
      throw new Error("unsupported ZIP entry format");
    if (
      view.getUint16(offset + 6, true) !== view.getUint16(cursor + 8, true) ||
      view.getUint16(offset + 8, true) !== method ||
      view.getUint32(offset + 14, true) !== crc ||
      view.getUint32(offset + 18, true) !== compressed ||
      view.getUint32(offset + 22, true) !== original ||
      original === 0xffffffff
    )
      throw new Error("file header disagrees with central directory");
    const dataStart =
      offset +
      30 +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, nameEnd));
    const localName = decoder.decode(
      bytes.subarray(
        offset + 30,
        offset + 30 + view.getUint16(offset + 26, true),
      ),
    );
    if (dataStart + compressed > start || name !== localName)
      throw new Error("inconsistent file name or length");
    entries.push({
      name,
      original,
      crc,
      method,
      offset,
      end: dataStart + compressed,
    });
    cursor = next;
  }
  if (cursor !== end) throw new Error("incomplete central directory");
  entries.sort((a, b) => a.offset - b.offset);
  let fileEnd = 0;
  for (const entry of entries) {
    if (entry.offset !== fileEnd) throw new Error("incomplete file sequence");
    fileEnd = entry.end;
  }
  if (fileEnd !== start) throw new Error("inconsistent file sequence ending");
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function validateZipEntry(file, data, expected) {
  if (
    !expected ||
    file.name !== expected.name ||
    data.length !== expected.original
  )
    throw new Error("decoded entry disagrees with central directory");
  // Deflate CRC is checked by the decoder's gzip stream. Stored entries need
  // the same check here because no decompression stream validates them.
  if (expected.method === 0) {
    let crc = -1;
    for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    if ((crc ^ -1) >>> 0 !== expected.crc)
      throw new Error(`checksum mismatch for ${file.name}`);
  }
}
