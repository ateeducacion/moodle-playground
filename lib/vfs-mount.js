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

function dirname(path) {
  const parts = splitPath(path);
  parts.pop();
  return `/${parts.join("/")}`;
}

function basename(path) {
  const parts = splitPath(path);
  return parts.at(-1) || "";
}

function isDescendantPath(path, parentPath) {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parentPath);
  return normalizedPath.startsWith(`${normalizedParent}/`);
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

function createFileRecord(path, contents = new Uint8Array(0)) {
  return {
    kind: "file",
    path,
    mode: WRITABLE_FILE_MODE,
    mtimeMs: Date.now(),
    size: contents.byteLength,
    contents,
    overlay: true,
  };
}

function createLazyFileRecord(path, sourceRecord) {
  const size = sourceRecord.size || (sourceRecord.contents?.byteLength ?? 0);
  return {
    kind: "file",
    path,
    mode: WRITABLE_FILE_MODE,
    mtimeMs: Date.now(),
    size,
    contents: sourceRecord.contents || null,
    offset: sourceRecord.offset,
    _shared: true,
    overlay: true,
  };
}

function createDeletedRecord(path, deletedKind = null) {
  return {
    kind: "deleted",
    path,
    deletedKind,
    mtimeMs: Date.now(),
    overlay: true,
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
  if (!node) {
    return node;
  }

  node.vfsPath = FS.getPath ? FS.getPath(node) : (node.vfsPath || "/");
  return node;
}

function copyToBuffer(source, target, targetOffset) {
  target.set(source, targetOffset);
  return source.byteLength;
}

function sliceUsedBytes(bytes, usedBytes = null) {
  if (!(bytes instanceof Uint8Array)) {
    return new Uint8Array(0);
  }

  if (!Number.isFinite(usedBytes) || usedBytes < 0 || usedBytes >= bytes.byteLength) {
    return new Uint8Array(bytes);
  }

  return new Uint8Array(bytes.subarray(0, usedBytes));
}

function getNodeContents(node) {
  if (node.vfsRecord?.contents) {
    return node.vfsRecord.contents;
  }

  return node.contents || new Uint8Array(0);
}

function describeKind(value) {
  if (!value) {
    return "none";
  }

  return String(value);
}

function modeIsDir(FS, mode) {
  if (typeof FS?.isDir === "function") {
    return FS.isDir(mode);
  }

  return (mode & 0o170000) === 0o040000;
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
  const normalizedMountPath = normalizePath(mountPath);
  const writableSet = new Set(writablePaths.map(normalizePath));
  const overlayRecords = new Map();
  const nodeCache = new Map();

  const dropCachedSubtree = (path, { preserveNode = null, destroyRoot = true } = {}) => {
    const normalized = normalizePath(path);

    for (const [cachedPath, cachedNode] of [...nodeCache.entries()]) {
      const matchesPath = cachedPath === normalized;
      const inSubtree = matchesPath || isDescendantPath(cachedPath, normalized);
      if (!inSubtree || cachedNode === preserveNode) {
        continue;
      }

      nodeCache.delete(cachedPath);

      // Release node content references to help GC reclaim buffers
      if (cachedNode) {
        cachedNode.contents = null;
      }

      if ((!matchesPath || destroyRoot) && FS.destroyNode) {
        try {
          FS.destroyNode(cachedNode);
        } catch {}
      }
    }
  };

  // Resolve the readable source for a file record without allocating a new
  // buffer.  Returns a Uint8Array view (possibly a subarray of imageBytes)
  // that must NOT be mutated.  Callers that need an owned copy must slice().
  const resolveRecordSource = (record) => {
    if (record.contents) {
      return record.contents;
    }

    if (record.kind === "file" && record.offset !== undefined && record.size > 0) {
      return imageBytes.subarray(record.offset, record.offset + record.size);
    }

    return new Uint8Array(0);
  };

  // Materialize a record's contents into an owned Uint8Array (copy from
  // imageBytes when the record only has offset/size, or from the existing
  // shared buffer).  After this call record.contents is a mutable buffer.
  const materializeContents = (record) => {
    if (record.contents && !record._shared) {
      return record.contents;
    }

    if (record._shared && record.contents) {
      record.contents = new Uint8Array(record.contents);
      record._shared = false;
      return record.contents;
    }

    if (record.offset !== undefined && record.size > 0) {
      record.contents = imageBytes.slice(record.offset, record.offset + record.size);
    } else {
      record.contents = new Uint8Array(record.size || 0);
    }

    record._shared = false;
    return record.contents;
  };

  const createNodeFromRecord = (parent, name, record) => {
    const mountedPath = parent
      ? joinPath(parent.vfsPath, name)
      : normalizePath(record.path);
    const cachedNode = nodeCache.get(mountedPath);
    const mode = record.kind === "dir"
      ? (record.mode || DIR_MODE)
      : ((record.overlay || writableSet.has(mountedPath)) ? WRITABLE_FILE_MODE : FILE_MODE);

    const node = cachedNode || FS.createNode(parent, name, mode, 0);
    node.vfsRecord = record;
    node.vfsType = record.kind;
    node.vfsPath = mountedPath;
    node.mount = parent ? parent.mount : node.mount;
    node.parent = parent || node.parent || node;
    node.name = name || node.name;
    node.mode = mode;

    if (record.kind === "dir") {
      node.node_ops = dirNodeOps;
      node.stream_ops = {};
      delete node.contents;
      delete node.usedBytes;
    } else {
      // Deferred materialization: do NOT eagerly slice from imageBytes.
      // The read/mmap handlers resolve contents on demand via
      // resolveRecordSource(), avoiding large allocations for files that
      // are never actually read (e.g. during directory listings or
      // existence checks).
      //
      // NOTE: node.contents may be null for unmaterialized files.  This
      // diverges from the standard MEMFS contract, but all I/O goes
      // through our custom stream_ops which handle it correctly.
      // External code must not access node.contents directly — use
      // resolveRecordSource(record) or materializeContents(record).
      if (record.contents) {
        node.contents = record.contents;
        node.usedBytes = record.contents.byteLength;
      } else {
        node.contents = null;
        node.usedBytes = record.size || 0;
      }
      node.node_ops = fileNodeOps;
      node.stream_ops = fileStreamOps;
    }

    nodeCache.set(mountedPath, node);
    return node;
  };

  const getBasePathParts = (path) => {
    const normalized = normalizePath(path);

    if (normalized === normalizedMountPath) {
      return [];
    }

    if (!normalized.startsWith(`${normalizedMountPath}/`)) {
      return null;
    }

    return splitPath(normalized.slice(normalizedMountPath.length));
  };

  const getBaseRecord = (path) => {
    const parts = getBasePathParts(path);
    if (!parts) {
      return null;
    }

    let current = tree;
    for (const part of parts) {
      if (current.kind !== "dir") {
        return null;
      }
      current = current.children.get(part);
      if (!current) {
        return null;
      }
    }

    return current;
  };

  const getOverlayRecord = (path) => overlayRecords.get(normalizePath(path)) || null;

  const removeOverlaySubtree = (path) => {
    const normalized = normalizePath(path);
    for (const candidate of [...overlayRecords.keys()]) {
      if (candidate === normalized || isDescendantPath(candidate, normalized)) {
        const record = overlayRecords.get(candidate);
        // Release large buffers eagerly so GC can reclaim them
        if (record) {
          record.contents = null;
        }
        overlayRecords.delete(candidate);
      }
    }
  };

  const lookupChildNode = (parent, name) => {
    try {
      return FS.lookupNode(parent, name);
    } catch {
      return null;
    }
  };

  const copyNodeContents = (node) => {
    if (node?.vfsRecord) {
      // Use resolveRecordSource to handle unmaterialized records that only
      // have offset/size but no contents buffer yet.
      const source = resolveRecordSource(node.vfsRecord);
      return new Uint8Array(source);
    }

    if (node?.contents instanceof Uint8Array) {
      return sliceUsedBytes(node.contents, node.usedBytes);
    }

    if (node?.contents?.subarray) {
      return sliceUsedBytes(new Uint8Array(node.contents), node.usedBytes);
    }

    return new Uint8Array(0);
  };

  const installCrossMountRenameFallback = () => {
    if (typeof FS.rename !== "function" || typeof FS.lookupPath !== "function") {
      return;
    }

    if (FS.__moodleCrossMountRenameMounts instanceof Set) {
      FS.__moodleCrossMountRenameMounts.add(normalizedMountPath);
      return;
    }

    const originalRename = FS.rename.bind(FS);
    const managedMounts = new Set([normalizedMountPath]);

    const touchesManagedMount = (path) => {
      const normalized = normalizePath(path);
      return [...managedMounts].some(
        (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
      );
    };

    const isDirectoryNode = (node) => {
      if (!node) {
        return false;
      }

      if (typeof FS.isDir === "function") {
        return FS.isDir(node.mode);
      }

      return node.vfsType === "dir";
    };

    const describeNodeKind = (node) => {
      if (!node) {
        return "none";
      }

      return isDirectoryNode(node) ? "dir" : "file";
    };

    const lookupPathSafe = (path) => {
      try {
        return FS.lookupPath(path);
      } catch {
        return null;
      }
    };

    const nodeMatchesKind = (node, kind) => {
      if (!node || !kind) {
        return false;
      }

      return kind === "dir" ? isDirectoryNode(node) : !isDirectoryNode(node);
    };

    const destroyLookupNode = (path) => {
      const lookedUpNode = lookupPathSafe(path)?.node;
      if (!lookedUpNode) {
        return;
      }

      debugFs(`drop stale lookup ${path}`);
      try {
        FS.destroyNode?.(lookedUpNode);
      } catch {}
    };

    const lookupManagedNode = (path) => {
      const normalized = normalizePath(path);
      if (normalized === "/") {
        return lookupPathSafe("/").node;
      }

      const visibleRecord = getVisibleRecord(normalized);
      if (!visibleRecord) {
        debugFs(`lookup managed ${normalized} visible=none`);
        return null;
      }

      const cachedNode = nodeCache.get(normalized);
      if (nodeMatchesKind(cachedNode, visibleRecord.kind)) {
        return cachedNode;
      }

      const lookedUpNode = lookupPathSafe(normalized)?.node;
      if (nodeMatchesKind(lookedUpNode, visibleRecord.kind)) {
        attachPath(FS, lookedUpNode);
        nodeCache.set(normalized, lookedUpNode);
        return lookedUpNode;
      }

      if (cachedNode || lookedUpNode) {
        debugFs(
          `repair lookup ${normalized} visible=${describeKind(visibleRecord.kind)} cached=${describeNodeKind(cachedNode)} lookup=${describeNodeKind(lookedUpNode)}`,
        );
        nodeCache.delete(normalized);
        destroyLookupNode(normalized);
      }

      if (normalized === normalizedMountPath) {
        return lookupPathSafe(normalized)?.node || null;
      }

      const parentNode = lookupManagedNode(dirname(normalized));
      if (!parentNode) {
        return null;
      }

      return createNodeFromRecord(parentNode, basename(normalized), visibleRecord);
    };

    const ensureManagedDirectory = (path) => {
      const normalized = normalizePath(path);
      const existingRecord = getVisibleRecord(normalized);
      const existing = lookupManagedNode(normalized);
      debugFs(
        `ensure dir ${normalized} visible=${describeKind(existingRecord?.kind)} node=${describeNodeKind(existing)}`,
      );

      if (existing) {
        if (isDirectoryNode(existing)) {
          return existing;
        }

        const parentPath = dirname(normalized);
        const parentNode = ensureManagedDirectory(parentPath);
        debugFs(`repair parent ${normalized}`);
        parentNode.node_ops.unlink(parentNode, basename(normalized));
      }

      if (normalized === "/") {
        return lookupManagedNode("/") || FS.lookupPath("/").node;
      }

      if (existingRecord && existingRecord.kind && existingRecord.kind !== "dir") {
        debugFs(`replace non-dir ${normalized} visible=${describeKind(existingRecord.kind)}`);
      }

      const parentNode = ensureManagedDirectory(dirname(normalized));
      const name = basename(normalized);
      const recreated = lookupManagedNode(normalized) || lookupChildNode(parentNode, name);
      if (recreated && isDirectoryNode(recreated)) {
        return recreated;
      }

      debugFs(`create parent ${normalized}`);
      return parentNode.node_ops.mkdir(parentNode, name, DIR_MODE);
    };

    const replaceDestinationIfNeeded = (path, sourceIsDir) => {
      const destinationNode = lookupManagedNode(path) || lookupPathSafe(path)?.node;
      if (!destinationNode) {
        return null;
      }

      const destinationIsDir = isDirectoryNode(destinationNode);
      debugFs(
        `replace destination ${normalizePath(path)} source=${sourceIsDir ? "dir" : "file"} dest=${destinationIsDir ? "dir" : "file"}`,
      );
      if (destinationIsDir) {
        if (!sourceIsDir) {
          removeVisiblePath(path, "dir");
          return null;
        }

        return destinationNode;
      }

      removeVisiblePath(path, "file");
      return null;
    };

    const crossMountRename = (oldPath, newPath) => {
      const oldDir = FS.lookupPath(dirname(oldPath)).node;
      const oldName = basename(oldPath);
      const oldNode = FS.lookupNode(oldDir, oldName);
      const newName = basename(newPath);
      const isDir = isDirectoryNode(oldNode);
      const newDir = ensureManagedDirectory(dirname(newPath));

      debugFs(`cross-mount rename ${oldPath} -> ${newPath}`);
      replaceDestinationIfNeeded(newPath, isDir);

      if (isDir) {
        if (!newDir?.node_ops?.mkdir) {
          throw errno(FS, "EPERM");
        }

        newDir.node_ops.mkdir(newDir, newName, oldNode.mode || DIR_MODE);

        for (const childName of oldNode.node_ops.readdir(oldNode)) {
          if (childName === "." || childName === "..") {
            continue;
          }

          FS.rename(
            joinPath(oldPath, childName),
            joinPath(newPath, childName),
          );
        }

        oldDir.node_ops.rmdir(oldDir, oldName);
        return;
      }

      if (!newDir?.node_ops?.mknod) {
        throw errno(FS, "EPERM");
      }

      const createdNode = newDir.node_ops.mknod(newDir, newName, oldNode.mode || WRITABLE_FILE_MODE, 0);
      const contents = copyNodeContents(oldNode);
      const stream = { node: createdNode, position: 0 };

      if (contents.byteLength > 0) {
        createdNode.stream_ops.open(stream);
        createdNode.stream_ops.write(stream, contents, 0, contents.byteLength, 0);
      }

      oldDir.node_ops.unlink(oldDir, oldName);
    };

    FS.rename = (oldPath, newPath) => {
      const normalizedOldPath = normalizePath(oldPath);
      const normalizedNewPath = normalizePath(newPath);

      if (
        !touchesManagedMount(normalizedOldPath) &&
        !touchesManagedMount(normalizedNewPath)
      ) {
        return originalRename(oldPath, newPath);
      }

      const oldLookup = FS.lookupPath(normalizedOldPath, { parent: true });
      const newLookup = FS.lookupPath(normalizedNewPath, { parent: true });
      const oldDir = oldLookup.node;
      const newDir = newLookup.node;

      if (oldDir?.mount === newDir?.mount) {
        return originalRename(oldPath, newPath);
      }

      return crossMountRename(normalizedOldPath, normalizedNewPath);
    };

    FS.__moodleCrossMountRenameMounts = managedMounts;
  };

  const getRecordContents = (record) => {
    if (record.contents) {
      return new Uint8Array(record.contents);
    }

    if (record.kind !== "file") {
      return new Uint8Array(0);
    }

    return imageBytes.slice(record.offset, record.offset + record.size);
  };

  const getAncestorOverlayRecord = (path) => {
    let current = dirname(path);

    while (current.length >= normalizedMountPath.length) {
      const overlayRecord = getOverlayRecord(current);
      if (overlayRecord) {
        return overlayRecord;
      }
      if (current === normalizedMountPath) {
        break;
      }
      current = dirname(current);
    }

    return null;
  };

  const promoteFileToOverlay = (path, record) => {
    const overlayRecord = createFileRecord(normalizePath(path), getRecordContents(record));
    overlayRecords.set(overlayRecord.path, overlayRecord);
    return overlayRecord;
  };

  const getVisibleRecord = (path) => {
    const normalized = normalizePath(path);
    const overlayRecord = getOverlayRecord(normalized);

    if (overlayRecord) {
      return overlayRecord.kind === "deleted" ? null : overlayRecord;
    }

    const ancestorOverlayRecord = getAncestorOverlayRecord(normalized);
    if (ancestorOverlayRecord) {
      return null;
    }

    return getBaseRecord(normalized);
  };

  const getVisibleChildNames = (path) => {
    const normalized = normalizePath(path);
    const names = new Set();
    const overlayRecord = getOverlayRecord(normalized);
    const baseRecord = getBaseRecord(normalized);

    if (!overlayRecord && baseRecord?.kind === "dir") {
      for (const name of baseRecord.children.keys()) {
        const childPath = joinPath(normalized, name);
        const overlayRecord = getOverlayRecord(childPath);
        if (overlayRecord?.kind === "deleted") {
          continue;
        }
        names.add(name);
      }
    }

    for (const [overlayPath, overlayRecord] of overlayRecords) {
      if (dirname(overlayPath) !== normalized) {
        continue;
      }

      const name = basename(overlayPath);
      if (!name) {
        continue;
      }

      if (overlayRecord.kind === "deleted") {
        names.delete(name);
      } else {
        names.add(name);
      }
    }

    return [...names].sort();
  };

  const assertDirectoryEmpty = (path) => {
    if (getVisibleChildNames(path).length > 0) {
      throw errno(FS, "EEXIST");
    }
  };

  const removeVisiblePath = (path, expectedKind) => {
    const normalized = normalizePath(path);
    const baseRecord = getBaseRecord(normalized);
    const overlayRecord = getOverlayRecord(normalized);

    if (!baseRecord && !overlayRecord) {
      throw errno(FS, "ENOENT");
    }

    const visibleRecord = overlayRecord?.kind === "deleted" ? null : (overlayRecord || baseRecord);
    if (!visibleRecord) {
      throw errno(FS, "ENOENT");
    }

    if (expectedKind && visibleRecord.kind !== expectedKind) {
      throw errno(FS, expectedKind === "dir" ? "ENOTDIR" : "EISDIR");
    }

    if (visibleRecord.kind === "dir") {
      assertDirectoryEmpty(normalized);
    }

    dropCachedSubtree(normalized);
    removeOverlaySubtree(normalized);

    if (baseRecord) {
      overlayRecords.set(normalized, createDeletedRecord(normalized, visibleRecord.kind));
    }
  };

  const hideVisiblePath = (path, kind) => {
    const normalized = normalizePath(path);
    const baseRecord = getBaseRecord(normalized);
    const overlayRecord = getOverlayRecord(normalized);
    const visibleRecord = overlayRecord?.kind === "deleted" ? null : (overlayRecord || baseRecord);

    if (!visibleRecord) {
      throw errno(FS, "ENOENT");
    }

    if (kind && visibleRecord.kind !== kind) {
      throw errno(FS, kind === "dir" ? "ENOTDIR" : "EISDIR");
    }

    dropCachedSubtree(normalized, { destroyRoot: false });
    removeOverlaySubtree(normalized);

    if (baseRecord) {
      overlayRecords.set(normalized, createDeletedRecord(normalized, visibleRecord.kind));
    }
  };

  const cloneVisibleSubtree = (sourcePath, targetPath) => {
    const sourceRecord = getVisibleRecord(sourcePath);
    if (!sourceRecord) {
      throw errno(FS, "ENOENT");
    }

    const normalizedTarget = normalizePath(targetPath);
    if (sourceRecord.kind === "file") {
      debugFs(`clone file ${normalizePath(sourcePath)} -> ${normalizedTarget} (lazy)`);
      overlayRecords.set(
        normalizedTarget,
        createLazyFileRecord(normalizedTarget, sourceRecord),
      );
      return;
    }

    debugFs(`clone dir ${normalizePath(sourcePath)} -> ${normalizedTarget}`);
    const dirRecord = createDirectoryRecord(normalizedTarget);
    dirRecord.overlay = true;
    overlayRecords.set(normalizedTarget, dirRecord);

    for (const childName of getVisibleChildNames(sourcePath)) {
      cloneVisibleSubtree(
        joinPath(sourcePath, childName),
        joinPath(normalizedTarget, childName),
      );
    }
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
      const childPath = joinPath(parent.vfsPath, name);
      debugFs(`lookup ${childPath}`);
      const childRecord = getVisibleRecord(childPath);

      if (!childRecord) {
        throw errno(FS, "ENOENT");
      }

      return createNodeFromRecord(parent, name, childRecord);
    },
    readdir(node) {
      attachPath(FS, node);
      return [".", "..", ...getVisibleChildNames(node.vfsPath)];
    },
    mknod(parent, name, mode) {
      attachPath(FS, parent);
      const path = joinPath(parent.vfsPath, name);

      if (getVisibleRecord(path)) {
        throw errno(FS, "EEXIST");
      }

      const createDir = modeIsDir(FS, mode || 0);
      const record = createDir ? createDirectoryRecord(path) : createFileRecord(path);
      record.overlay = true;
      record.mode = mode || (createDir ? DIR_MODE : WRITABLE_FILE_MODE);
      overlayRecords.set(path, record);
      debugFs(`mknod ${path} kind=${createDir ? "dir" : "file"}`);
      return createNodeFromRecord(parent, name, record);
    },
    mkdir(parent, name, mode) {
      attachPath(FS, parent);
      const path = joinPath(parent.vfsPath, name);
      debugFs(`mkdir ${path}`);

      if (getVisibleRecord(path)) {
        throw errno(FS, "EEXIST");
      }

      const record = createDirectoryRecord(path);
      record.overlay = true;
      record.mode = mode || DIR_MODE;
      overlayRecords.set(path, record);
      return createNodeFromRecord(parent, name, record);
    },
    rename(node, newParent, newName) {
      attachPath(FS, node);
      attachPath(FS, newParent);
      const oldPath = normalizePath(node.vfsPath);
      const newPath = joinPath(newParent.vfsPath, newName);
      debugFs(`rename ${oldPath} -> ${newPath}`);

      if (oldPath === normalizedMountPath) {
        throw errno(FS, "EPERM");
      }

      if (newPath === oldPath) {
        return;
      }

      if (node.vfsRecord.kind === "dir" && isDescendantPath(newPath, oldPath)) {
        throw errno(FS, "EINVAL");
      }

      if (getVisibleRecord(newPath)) {
        throw errno(FS, "EEXIST");
      }

      dropCachedSubtree(newPath);
      cloneVisibleSubtree(oldPath, newPath);
      hideVisiblePath(oldPath, node.vfsRecord.kind);
      nodeCache.delete(oldPath);
      node.parent = newParent;
      node.name = newName;
      node.vfsPath = newPath;
      nodeCache.set(newPath, node);
    },
    unlink(parent, name) {
      attachPath(FS, parent);
      const path = joinPath(parent.vfsPath, name);
      debugFs(`unlink ${path}`);
      removeVisiblePath(path, "file");
    },
    rmdir(parent, name) {
      attachPath(FS, parent);
      const path = joinPath(parent.vfsPath, name);
      debugFs(`rmdir ${path}`);
      removeVisiblePath(path, "dir");
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
      let record = node.vfsRecord;
      const overlayRecord = getOverlayRecord(node.vfsPath);

      if (!writableSet.has(node.vfsPath) && (!overlayRecord || overlayRecord.kind === "deleted")) {
        // Copy-on-write: promote readonly file to overlay
        const promoted = promoteFileToOverlay(node.vfsPath, record);
        node.vfsRecord = promoted;
        node.mode = WRITABLE_FILE_MODE;
        record = promoted;
      }

      // Materialize contents from imageBytes or detach shared buffer before
      // mutating (lazy copy-on-write).
      materializeContents(record);

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

      const source = resolveRecordSource(record);
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
      let record = stream.node.vfsRecord;
      debugFs(`write ${stream.node.vfsPath} offset=${position ?? stream.position ?? 0} length=${length}`);
      const overlayRecord = getOverlayRecord(stream.node.vfsPath);

      if (!writableSet.has(stream.node.vfsPath) && (!overlayRecord || overlayRecord.kind === "deleted")) {
        // Copy-on-write: promote readonly file to overlay
        const promoted = promoteFileToOverlay(stream.node.vfsPath, record);
        stream.node.vfsRecord = promoted;
        stream.node.mode = WRITABLE_FILE_MODE;
        record = promoted;
      }

      // Detach shared buffer or materialize from imageBytes before mutating
      if (record._shared || !record.contents) {
        materializeContents(record);
        stream.node.contents = record.contents;
      }

      const writePosition = position ?? stream.position ?? 0;

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
      const source = resolveRecordSource(stream.node.vfsRecord);
      const start = Math.max(0, position || 0);
      const end = Math.min(source.byteLength, start + length);
      const chunk = source.subarray(start, end);
      const ptr = binary._malloc(length);

      if (!ptr) {
        throw errno(FS, "EIO");
      }

      // WP Playground's Emscripten module uses HEAPU8 (unsigned).
      // Fall back to HEAP8 for compatibility with other Emscripten builds.
      const heap = binary.HEAPU8 || binary.HEAP8;
      heap.fill(0, ptr, ptr + length);
      heap.set(chunk, ptr);

      return {
        ptr,
        allocated: true,
      };
    },
    msync(stream, buffer, offset, length) {
      if (!writableSet.has(stream.node.vfsPath) && !getOverlayRecord(stream.node.vfsPath)) {
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

  const mounted = FS.mount(VFS, {}, mountPath);
  installCrossMountRenameFallback();
  return mounted;
}
