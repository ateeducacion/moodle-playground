const DIR_MODE = 0o40755;
const FILE_MODE = 0o100444;
const WRITABLE_FILE_MODE = 0o100644;
const DEFAULT_ERRNO = {
  EEXIST: 20,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ENOENT: 44,
  ENOTDIR: 54,
  EPERM: 63,
  EROFS: 69,
};

function splitPath(path) {
  return path.split("/").filter(Boolean);
}

function normalizePath(path) {
  return `/${splitPath(path).join("/")}`;
}

function joinPath(parentPath, childName) {
  return normalizePath(`${parentPath}/${childName}`);
}

function errno(FS, code) {
  const resolved = FS.ERRNO_CODES?.[code] ?? DEFAULT_ERRNO[code] ?? DEFAULT_ERRNO.EIO;
  return new FS.ErrnoError(resolved);
}

function createDirectoryRecord(path) {
  return {
    kind: "dir",
    path,
    children: new Map(),
    mode: DIR_MODE,
    mtimeMs: Date.now(),
  };
}

function buildTree(entries) {
  const root = createDirectoryRecord("/");

  for (const entry of entries) {
    const parts = splitPath(entry.path);
    let current = root;
    let currentPath = "/";

    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const nextPath = joinPath(currentPath, part);

      if (!current.children.has(part)) {
        current.children.set(part, createDirectoryRecord(nextPath));
      }

      current = current.children.get(part);
      currentPath = nextPath;
    }

    const fileName = parts[parts.length - 1];
    const filePath = joinPath(currentPath, fileName);

    current.children.set(fileName, {
      kind: "file",
      path: filePath,
      mode: FILE_MODE,
      mtimeMs: entry.mtimeMs || Date.now(),
      offset: entry.offset,
      size: entry.size,
    });
  }

  return root;
}

function attachPath(FS, node) {
  if (!node || node.vfsPath) {
    return node;
  }

  node.vfsPath = FS.getPath ? FS.getPath(node) : "/";
  return node;
}

function copyToBuffer(source, target, targetOffset) {
  target.set(source, targetOffset);
  return source.byteLength;
}

function getNodeContents(node) {
  if (node.vfsRecord?.contents) {
    return node.vfsRecord.contents;
  }

  return node.contents || new Uint8Array(0);
}

function debugFs(detail) {
  if (typeof globalThis.__moodleFsDebugHook === "function") {
    try {
      globalThis.__moodleFsDebugHook(detail);
    } catch {}
  }
}

export function mountReadonlyVfs(php, { imageBytes, entries, mountPath, writablePaths = [] }) {
  const binary = php;
  const FS = binary.FS;
  const tree = buildTree(entries);
  const writableSet = new Set(writablePaths.map(normalizePath));
  const overlayFiles = new Map();

  const createNodeFromRecord = (parent, name, record) => {
    const mountedPath = parent
      ? joinPath(parent.vfsPath, name)
      : normalizePath(record.path);
    const mode = record.kind === "dir"
      ? DIR_MODE
      : (writableSet.has(mountedPath) ? WRITABLE_FILE_MODE : FILE_MODE);

    const node = FS.createNode(parent, name, mode, 0);
    node.vfsRecord = record;
    node.vfsType = record.kind;
    node.vfsPath = mountedPath;
    node.mount = parent ? parent.mount : node.mount;

    if (record.kind === "dir") {
      node.node_ops = dirNodeOps;
      node.stream_ops = {};
    } else {
      if (!record.contents) {
        // Materialize each file into its own Uint8Array so any consumer that
        // reaches for .buffer does not accidentally read the whole VFS blob
        // starting at byte 0 and corrupt PHP source parsing.
        record.contents = imageBytes.slice(record.offset, record.offset + record.size);
      }
      node.contents = record.contents;
      node.usedBytes = node.contents.byteLength;
      node.node_ops = fileNodeOps;
      node.stream_ops = fileStreamOps;
    }

    return node;
  };

  const ensureOverlayRecord = (path) => {
    if (!overlayFiles.has(path)) {
      overlayFiles.set(path, {
        kind: "file",
        path,
        mode: WRITABLE_FILE_MODE,
        mtimeMs: Date.now(),
        size: 0,
        contents: new Uint8Array(0),
      });
    }

    return overlayFiles.get(path);
  };

  const dirNodeOps = {
    getattr(node) {
      attachPath(FS, node);
      const record = node.vfsRecord;
      const size = 4096;
      const timestamp = new Date(record.mtimeMs);

      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 2,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        atime: timestamp,
        mtime: timestamp,
        ctime: timestamp,
        blksize: 4096,
        blocks: 1,
      };
    },
    lookup(parent, name) {
      attachPath(FS, parent);
      const parentRecord = parent.vfsRecord;
      const childPath = joinPath(parent.vfsPath, name);
      debugFs(`lookup ${childPath}`);

      if (overlayFiles.has(childPath)) {
        return createNodeFromRecord(parent, name, overlayFiles.get(childPath));
      }

      const childRecord = parentRecord.children.get(name);

      if (!childRecord) {
        throw errno(FS, "ENOENT");
      }

      return createNodeFromRecord(parent, name, childRecord);
    },
    readdir(node) {
      attachPath(FS, node);
      const names = new Set([".", ".."]);

      for (const name of node.vfsRecord.children.keys()) {
        names.add(name);
      }

      for (const path of overlayFiles.keys()) {
        const parentPath = normalizePath(path.split("/").slice(0, -1).join("/"));

        if (parentPath === node.vfsPath) {
          names.add(path.split("/").pop());
        }
      }

      return [...names].sort();
    },
    mknod(parent, name, mode) {
      attachPath(FS, parent);
      const path = joinPath(parent.vfsPath, name);

      if (!writableSet.has(path)) {
        throw errno(FS, "EROFS");
      }

      if (parent.vfsRecord.children.has(name) || overlayFiles.has(path)) {
        throw errno(FS, "EEXIST");
      }

      const record = ensureOverlayRecord(path);
      record.mode = mode || WRITABLE_FILE_MODE;
      return createNodeFromRecord(parent, name, record);
    },
    rename() {
      throw errno(FS, "EROFS");
    },
    unlink(parent, name) {
      attachPath(FS, parent);
      const path = joinPath(parent.vfsPath, name);

      if (overlayFiles.has(path)) {
        overlayFiles.delete(path);
        return;
      }

      throw errno(FS, "EROFS");
    },
    rmdir() {
      throw errno(FS, "EROFS");
    },
    setattr(node, attr) {
      attachPath(FS, node);
      const record = node.vfsRecord;

      if (record.kind !== "dir") {
        throw errno(FS, "ENOTDIR");
      }

      if (attr.mode !== undefined) {
        node.mode = attr.mode;
      }

      if (attr.mtime !== undefined) {
        record.mtimeMs = attr.mtime.getTime?.() ?? Date.now();
      }
    },
  };

  const fileNodeOps = {
    getattr(node) {
      attachPath(FS, node);
      const record = node.vfsRecord;
      const size = node.contents ? node.contents.byteLength : record.size;
      const timestamp = new Date(record.mtimeMs);

      return {
        dev: 1,
        ino: node.id,
        mode: node.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size,
        atime: timestamp,
        mtime: timestamp,
        ctime: timestamp,
        blksize: 4096,
        blocks: Math.ceil(size / 4096),
      };
    },
    setattr(node, attr) {
      attachPath(FS, node);
      const record = node.vfsRecord;

      if (!writableSet.has(node.vfsPath)) {
        throw errno(FS, "EROFS");
      }

      if (!record.contents) {
        record.contents = new Uint8Array(record.size || 0);
      }

      if (attr.size !== undefined) {
        const resized = new Uint8Array(attr.size);
        resized.set(record.contents.subarray(0, Math.min(attr.size, record.contents.byteLength)));
        record.contents = resized;
        record.size = attr.size;
        node.contents = record.contents;
        node.usedBytes = record.contents.byteLength;
      }

      if (attr.mode !== undefined) {
        node.mode = attr.mode;
        record.mode = attr.mode;
      }

      if (attr.mtime !== undefined) {
        record.mtimeMs = attr.mtime.getTime?.() ?? Date.now();
      }
    },
  };

  const fileStreamOps = {
    open(stream) {
      attachPath(FS, stream.node);
      stream.seekable = true;
      debugFs(`open ${stream.node.vfsPath}`);
    },
    close() {},
    llseek(stream, offset, whence) {
      const record = stream.node.vfsRecord;
      const size = record.contents ? record.contents.byteLength : record.size;
      let position = offset;

      if (whence === 1) {
        position += stream.position;
      } else if (whence === 2) {
        position += size;
      }

      if (position < 0) {
        throw errno(FS, "EINVAL");
      }

      stream.position = position;
      return position;
    },
    read(stream, buffer, offset, length, position) {
      const record = stream.node.vfsRecord;

      if (record.kind !== "file") {
        throw errno(FS, "EISDIR");
      }

      const readPosition = position ?? stream.position ?? 0;
      debugFs(`read ${stream.node.vfsPath} offset=${readPosition} length=${length}`);

      const source = record.contents
        ? record.contents
        : stream.node.contents;
      const available = Math.max(0, source.byteLength - readPosition);
      const chunkSize = Math.min(length, available);

      if (chunkSize <= 0) {
        return 0;
      }

      const copied = copyToBuffer(
        source.subarray(readPosition, readPosition + chunkSize),
        buffer,
        offset,
      );

      if (position === undefined || position === null) {
        stream.position = readPosition + copied;
      }

      return copied;
    },
    write(stream, buffer, offset, length, position) {
      attachPath(FS, stream.node);
      const record = stream.node.vfsRecord;
      debugFs(`write ${stream.node.vfsPath} offset=${position ?? stream.position ?? 0} length=${length}`);

      if (!writableSet.has(stream.node.vfsPath)) {
        throw errno(FS, "EROFS");
      }

      const writePosition = position ?? stream.position ?? 0;

      if (!record.contents) {
        record.contents = new Uint8Array(record.size || 0);
        stream.node.contents = record.contents;
      }

      const nextSize = Math.max(record.contents.byteLength, writePosition + length);

      if (nextSize !== record.contents.byteLength) {
        const resized = new Uint8Array(nextSize);
        resized.set(record.contents);
        record.contents = resized;
      }

      record.contents.set(buffer.subarray(offset, offset + length), writePosition);
      record.size = record.contents.byteLength;
      stream.node.contents = record.contents;
      stream.node.usedBytes = record.contents.byteLength;
      record.mtimeMs = Date.now();

      if (position === undefined || position === null) {
        stream.position = writePosition + length;
      }

      return length;
    },
    mmap(stream, length, position, prot, flags) {
      debugFs(`mmap ${stream.node.vfsPath} offset=${position || 0} length=${length}`);
      const source = getNodeContents(stream.node);
      const start = Math.max(0, position || 0);
      const end = Math.min(source.byteLength, start + length);
      const chunk = source.subarray(start, end);
      const ptr = binary._malloc(length);

      if (!ptr) {
        throw errno(FS, "EIO");
      }

      binary.HEAP8.fill(0, ptr, ptr + length);
      binary.HEAP8.set(chunk, ptr);

      return {
        ptr,
        allocated: true,
      };
    },
    msync(stream, buffer, offset, length) {
      if (!writableSet.has(stream.node.vfsPath)) {
        return 0;
      }

      return this.write(stream, buffer, 0, length, offset);
    },
  };

  const VFS = {
    mount(mount) {
      const rootNode = createNodeFromRecord(null, mount.mountpoint.split("/").pop() || "/", tree);
      rootNode.mount = mount;
      rootNode.vfsPath = normalizePath(mount.mountpoint);
      return rootNode;
    },
  };

  try {
    FS.mkdirTree(mountPath);
  } catch {}

  return FS.mount(VFS, {}, mountPath);
}
