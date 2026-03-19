import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mountReadonlyVfs } from "../../lib/vfs-mount.js";

function createMockFs() {
  let nextId = 1;
  const nameTable = new Map();

  class ErrnoError extends Error {
    constructor(errno) {
      super(`Errno ${errno}`);
      this.errno = errno;
    }
  }

  const hashName = (parentId, name) => `${parentId}:${name}`;

  const fs = {
    ERRNO_CODES: {
      EEXIST: 20,
      EINVAL: 28,
      EIO: 29,
      EISDIR: 31,
      ENOENT: 44,
      ENOTDIR: 54,
      EPERM: 63,
      EROFS: 69,
    },
    ErrnoError,
    createNode(parent, name, mode) {
      const node = {
        id: nextId++,
        parent,
        name,
        mode,
        mount: parent?.mount || null,
      };

      if (parent) {
        nameTable.set(hashName(parent.id, name), node);
      }

      return node;
    },
    destroyNode(node) {
      if (node?.parent) {
        nameTable.delete(hashName(node.parent.id, node.name));
      }
    },
    lookupNode(parent, name) {
      const cached = nameTable.get(hashName(parent.id, name));
      if (cached) {
        return cached;
      }

      return parent.node_ops.lookup(parent, name);
    },
    getPath(node) {
      if (!node) {
        return "/";
      }

      const parts = [];
      let current = node;
      while (current?.parent && current.parent !== current) {
        if (current.name) {
          parts.push(current.name);
        }
        current = current.parent;
      }

      const base = current?.vfsPath || "/";
      const suffix = parts.reverse().join("/");
      return suffix ? `${base.replace(/\/$/, "")}/${suffix}` : base;
    },
    mkdirTree() {},
    mount(type, _opts, mountPath) {
      return type.mount({ mountpoint: mountPath });
    },
    isDir(mode) {
      return (mode & 0o170000) === 0o040000;
    },
  };

  return fs;
}

function createBinary(files) {
  let offset = 0;
  const entries = [];
  const chunks = [];

  for (const [path, content] of files) {
    const bytes = new TextEncoder().encode(content);
    entries.push({ path, offset, size: bytes.byteLength });
    chunks.push(bytes);
    offset += bytes.byteLength;
  }

  const imageBytes = new Uint8Array(offset || 1);
  let cursor = 0;
  for (const chunk of chunks) {
    imageBytes.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  return {
    imageBytes,
    entries,
    binary: {
      FS: createMockFs(),
      _malloc() {
        return 1;
      },
      HEAPU8: new Uint8Array(1024),
    },
  };
}

function mountTestVfs(files) {
  const { imageBytes, entries, binary } = createBinary(files);
  const root = mountReadonlyVfs(binary, {
    imageBytes,
    entries,
    mountPath: "/www/moodle",
  });
  root.binary = binary;
  return root;
}

function listNames(node) {
  return node.node_ops
    .readdir(node)
    .filter((name) => name !== "." && name !== "..");
}

function pathParts(path) {
  return path.split("/").filter(Boolean);
}

function lookupPath(root, absolutePath) {
  const rootPath = root.vfsPath;
  const relative = absolutePath.startsWith(rootPath)
    ? absolutePath.slice(rootPath.length)
    : absolutePath;
  const parts = relative.split("/").filter(Boolean);
  let node = root;

  for (const part of parts) {
    node = node.node_ops.lookup(node, part);
  }

  return node;
}

function writeFile(parent, name, content) {
  const file = parent.node_ops.mknod(parent, name, 0o100644);
  const stream = { node: file, position: 0 };
  const bytes = new TextEncoder().encode(content);

  file.stream_ops.open(stream);
  file.stream_ops.write(stream, bytes, 0, bytes.byteLength, 0);
  return file;
}

function readFile(node) {
  const stream = { node, position: 0 };
  const size = node.vfsRecord.contents?.byteLength || node.vfsRecord.size || 0;
  const buffer = new Uint8Array(size);

  node.stream_ops.open(stream);
  const read = node.stream_ops.read(stream, buffer, 0, buffer.byteLength, 0);
  return new TextDecoder().decode(buffer.subarray(0, read));
}

function lookupPathLikeEmscripten(root, absolutePath) {
  const fs = root.binary?.FS;
  const parts = absolutePath.split("/").filter(Boolean);
  let node = root;

  for (const part of parts.slice(pathParts(root.vfsPath).length)) {
    node = fs.lookupNode(node, part);
  }

  return node;
}

function removeTree(node) {
  for (const name of listNames(node)) {
    const child = node.node_ops.lookup(node, name);

    if (child.vfsType === "dir") {
      removeTree(child);
      node.node_ops.rmdir(node, name);
    } else {
      node.node_ops.unlink(node, name);
    }
  }
}

let tempCounter = 0;

function removeDirLikeMoodle(node) {
  const parent = node.parent;
  const tempName = `_temp_${++tempCounter}`;
  node.node_ops.rename(node, parent, tempName);
  const renamed = parent.node_ops.lookup(parent, tempName);

  for (const name of listNames(renamed)) {
    const child = renamed.node_ops.lookup(renamed, name);
    if (child.vfsType === "dir") {
      removeDirLikeMoodle(child);
    } else {
      renamed.node_ops.unlink(renamed, name);
    }
  }

  parent.node_ops.rmdir(parent, tempName);
}

function mkdirs(root, absolutePath) {
  const parts = absolutePath.split("/").filter(Boolean);
  let node = root;

  for (const part of parts.slice(pathParts(root.vfsPath).length)) {
    try {
      node = node.node_ops.lookup(node, part);
    } catch {
      node = node.node_ops.mkdir(node, part, 0o40755);
    }
  }

  return node;
}

function emscriptenMkdir(root, absolutePath) {
  const parts = absolutePath.split("/").filter(Boolean);
  const parentPath = `/${parts.slice(0, -1).join("/")}`;
  const name = parts.at(-1);
  const parent = lookupPathLikeEmscripten(root, parentPath);
  return parent.node_ops.mknod(parent, name, 0o40755, 0);
}

describe("mountReadonlyVfs", () => {
  it("supports deleting a readonly subtree and recreating it through the overlay", () => {
    const root = mountTestVfs([
      ["/mod/exeweb/version.php", "<?php echo 'old';"],
      ["/mod/exeweb/lang/en/exeweb.php", "<?php echo 'lang';"],
      ["/mod/other/version.php", "<?php echo 'other';"],
    ]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");

    removeTree(exewebDir);
    modDir.node_ops.rmdir(modDir, "exeweb");

    assert.deepStrictEqual(listNames(modDir), ["other"]);

    const recreated = modDir.node_ops.mkdir(modDir, "exeweb", 0o40755);
    writeFile(recreated, "version.php", "<?php echo 'new';");

    assert.deepStrictEqual(listNames(modDir), ["exeweb", "other"]);
    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb/version.php")),
      "<?php echo 'new';",
    );
  });

  it("allows replacing a readonly file after it has been tombstoned", () => {
    const root = mountTestVfs([["/mod/exeweb/version.php", "old-version"]]);
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");

    exewebDir.node_ops.unlink(exewebDir, "version.php");
    assert.throws(
      () => lookupPath(root, "/www/moodle/mod/exeweb/version.php"),
      /Errno/,
    );

    writeFile(exewebDir, "version.php", "new-version");

    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb/version.php")),
      "new-version",
    );
  });

  it("renames a readonly directory subtree into overlay storage", () => {
    const root = mountTestVfs([
      ["/mod/exeweb/version.php", "old-version"],
      ["/mod/exeweb/lang/en/exeweb.php", "lang-data"],
      ["/mod/other/version.php", "other-version"],
    ]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");

    exewebDir.node_ops.rename(exewebDir, modDir, "exeweb_renamed");

    assert.deepStrictEqual(listNames(modDir), ["exeweb_renamed", "other"]);
    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb_renamed/version.php")),
      "old-version",
    );
    assert.strictEqual(
      readFile(
        lookupPath(root, "/www/moodle/mod/exeweb_renamed/lang/en/exeweb.php"),
      ),
      "lang-data",
    );
    assert.throws(() => lookupPath(root, "/www/moodle/mod/exeweb"), /Errno/);
  });

  it("reuses the same node object for repeated lookups of the same path", () => {
    const root = mountTestVfs([["/mod/exeweb/version.php", "old-version"]]);

    const first = lookupPath(root, "/www/moodle/mod/exeweb");
    const second = lookupPath(root, "/www/moodle/mod/exeweb");

    assert.strictEqual(first, second);
  });

  it("keeps cached descendant directories usable after renaming their parent", () => {
    const root = mountTestVfs([
      ["/mod/exeweb/lang/en/exeweb.php", "lang-data"],
    ]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");
    const cachedLangDir = lookupPath(root, "/www/moodle/mod/exeweb/lang");

    exewebDir.node_ops.rename(exewebDir, modDir, "_temp_replace");

    assert.deepStrictEqual(listNames(cachedLangDir), ["en"]);
    assert.strictEqual(
      readFile(
        lookupPath(root, "/www/moodle/mod/_temp_replace/lang/en/exeweb.php"),
      ),
      "lang-data",
    );
  });

  it("supports Moodle's replace-plugin flow after renaming the existing tree away", () => {
    const root = mountTestVfs([
      ["/mod/exeweb/version.php", "old-version"],
      ["/mod/exeweb/lib.php", "old-lib"],
      ["/mod/exeweb/lang/en/exeweb.php", "old-lang"],
      ["/mod/exeweb/classes/output/renderer.php", "old-renderer"],
    ]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");

    exewebDir.node_ops.rename(exewebDir, modDir, "_temp_replace");
    const tempDir = lookupPath(root, "/www/moodle/mod/_temp_replace");
    removeTree(tempDir);
    modDir.node_ops.rmdir(modDir, "_temp_replace");

    const recreated = modDir.node_ops.mkdir(modDir, "exeweb", 0o40755);
    assert.deepStrictEqual(listNames(recreated), []);

    mkdirs(root, "/www/moodle/mod/exeweb/lang/en");
    mkdirs(root, "/www/moodle/mod/exeweb/classes/output");
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb"),
      "version.php",
      "new-version",
    );
    writeFile(lookupPath(root, "/www/moodle/mod/exeweb"), "lib.php", "new-lib");
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb/lang/en"),
      "exeweb.php",
      "new-lang",
    );
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb/classes/output"),
      "renderer.php",
      "new-renderer",
    );

    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb/version.php")),
      "new-version",
    );
    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb/lib.php")),
      "new-lib",
    );
    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb/lang/en/exeweb.php")),
      "new-lang",
    );
    assert.strictEqual(
      readFile(
        lookupPath(root, "/www/moodle/mod/exeweb/classes/output/renderer.php"),
      ),
      "new-renderer",
    );
  });

  it("supports Moodle's remove_dir pattern with nested temp renames before redeploy", () => {
    tempCounter = 0;
    const root = mountTestVfs([
      ["/mod/exeweb/version.php", "old-version"],
      ["/mod/exeweb/lib.php", "old-lib"],
      ["/mod/exeweb/lang/en/exeweb.php", "old-lang"],
      ["/mod/exeweb/classes/output/renderer.php", "old-renderer"],
      ["/mod/exeweb/amd/build/modform.min.js", "old-js"],
    ]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");

    removeDirLikeMoodle(exewebDir);

    const recreated = modDir.node_ops.mkdir(modDir, "exeweb", 0o40755);
    assert.deepStrictEqual(listNames(recreated), []);

    mkdirs(root, "/www/moodle/mod/exeweb/lang/en");
    mkdirs(root, "/www/moodle/mod/exeweb/classes/output");
    mkdirs(root, "/www/moodle/mod/exeweb/amd/build");
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb"),
      "version.php",
      "new-version",
    );
    writeFile(lookupPath(root, "/www/moodle/mod/exeweb"), "lib.php", "new-lib");
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb/lang/en"),
      "exeweb.php",
      "new-lang",
    );
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb/classes/output"),
      "renderer.php",
      "new-renderer",
    );
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb/amd/build"),
      "modform.min.js",
      "new-js",
    );

    assert.strictEqual(
      readFile(
        lookupPath(root, "/www/moodle/mod/exeweb/amd/build/modform.min.js"),
      ),
      "new-js",
    );
  });

  it("supports redeploying a plugin while the renamed temp tree still exists", () => {
    const root = mountTestVfs([
      ["/mod/exeweb/version.php", "old-version"],
      ["/mod/exeweb/lib.php", "old-lib"],
      ["/mod/exeweb/.distignore", "old-distignore"],
      ["/mod/exeweb/amd/build/modform.min.js", "old-js"],
    ]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const exewebDir = lookupPath(root, "/www/moodle/mod/exeweb");

    exewebDir.node_ops.rename(exewebDir, modDir, "_temp_replace");

    const recreated = modDir.node_ops.mkdir(modDir, "exeweb", 0o40755);
    writeFile(recreated, ".distignore", "new-distignore");
    mkdirs(root, "/www/moodle/mod/exeweb/amd/build");
    writeFile(
      lookupPath(root, "/www/moodle/mod/exeweb/amd/build"),
      "modform.min.js",
      "new-js",
    );

    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/exeweb/.distignore")),
      "new-distignore",
    );
    assert.strictEqual(
      readFile(
        lookupPath(root, "/www/moodle/mod/exeweb/amd/build/modform.min.js"),
      ),
      "new-js",
    );
    assert.strictEqual(
      readFile(lookupPath(root, "/www/moodle/mod/_temp_replace/.distignore")),
      "old-distignore",
    );
  });

  it("removes deleted overlay nodes from the Emscripten name hash so they can be recreated", () => {
    const root = mountTestVfs([["/mod/exeweb/version.php", "old-version"]]);
    const modDir = lookupPath(root, "/www/moodle/mod");
    const created = modDir.node_ops.mkdir(modDir, "scratch", 0o40755);

    assert.strictEqual(
      lookupPathLikeEmscripten(root, "/www/moodle/mod/scratch"),
      created,
    );

    modDir.node_ops.rmdir(modDir, "scratch");

    assert.throws(
      () => lookupPathLikeEmscripten(root, "/www/moodle/mod/scratch"),
      /Errno/,
    );

    const recreated = modDir.node_ops.mkdir(modDir, "scratch", 0o40755);

    assert.strictEqual(
      lookupPathLikeEmscripten(root, "/www/moodle/mod/scratch"),
      recreated,
    );
  });

  it("treats Emscripten mkdir-through-mknod calls as directories", () => {
    const root = mountTestVfs([]);

    mkdirs(root, "/www/moodle/mod/exeweb");
    const classesDir = emscriptenMkdir(root, "/www/moodle/mod/exeweb/classes");

    assert.strictEqual(classesDir.vfsType, "dir");
    assert.strictEqual(
      lookupPath(root, "/www/moodle/mod/exeweb/classes").vfsType,
      "dir",
    );
  });
});
