import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";

import {
  clearJournal,
  flushPendingOps,
  initFsPersistence,
  operationTouchesPathPrefix,
} from "../../src/runtime/fs-persistence.js";

// Minimal async IndexedDB: one op array per database name. `failOpen` makes
// the next open() fail like a blocked/quota-denied database.
function installIndexedDb() {
  const dbs = new Map();
  let failOpen = false;
  const later = (fn) => setImmediate(fn);
  globalThis.indexedDB = {
    open(name) {
      const req = {};
      later(() => {
        if (failOpen) {
          req.error = new Error("open denied");
          req.onerror();
          return;
        }
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, { ops: null });
        const entry = dbs.get(name);
        const db = {
          objectStoreNames: { contains: () => entry.ops !== null },
          createObjectStore: () => {
            entry.ops = [];
          },
          transaction() {
            const tx = {
              objectStore: () => ({
                getAll() {
                  const r = {};
                  later(() => {
                    r.result = [...entry.ops];
                    r.onsuccess();
                  });
                  return r;
                },
                clear() {
                  entry.ops = [];
                },
                add(op) {
                  entry.ops.push(op);
                },
              }),
            };
            later(() => tx.oncomplete?.());
            return tx;
          },
          close() {},
        };
        req.result = db;
        if (fresh) req.onupgradeneeded({ target: { result: db } });
        req.onsuccess();
      });
      return req;
    },
  };
  return {
    dbs,
    failNextOpen: () => {
      failOpen = true;
    },
  };
}

// Raw PHP stand-in exposing the Emscripten FS hooks that fs-journal wraps and
// the high-level calls replayFSJournal uses.
function fakeRawPhp({ files = {}, sizes = {}, failWrite = () => false } = {}) {
  const store = new Map(Object.entries(files));
  const FS = {
    write() {},
    truncate() {},
    unlink() {},
    mknod() {},
    mkdir() {},
    rmdir() {},
    rename() {},
    stat: (path) => ({ size: sizes[path] }),
  };
  return {
    store,
    fs: FS,
    [__private__dont__use]: { FS },
    addEventListener() {},
    removeEventListener() {},
    readFileAsBuffer: (path) => store.get(path) ?? new Uint8Array(0),
    writeFile(path, data) {
      if (failWrite(path)) throw new Error(`cannot write ${path}`);
      store.set(path, data);
    },
    mkdir() {},
    unlink(path) {
      if (!store.has(path)) throw new Error("ENOENT");
      store.delete(path);
    },
    rmdir() {},
    mv() {},
  };
}

const DB_FILE = "/persist/moodledata/moodle_s_php.sq3.php";
const write = (path, data) => ({
  operation: "WRITE",
  path,
  nodeType: "file",
  data,
});

let idb;
beforeEach(() => {
  idb = installIndexedDb();
});
afterEach(() => {
  delete globalThis.indexedDB;
  mock.timers.reset();
});

describe("initFsPersistence", () => {
  it("replays the saved journal, skipping cache ops and ops that cannot apply", async () => {
    idb.dbs.set("moodle-fs-journal:s", {
      ops: [
        write(DB_FILE, new Uint8Array([1, 2])),
        write("/persist/moodledata/localcache/di.php", new Uint8Array([9])),
        {
          operation: "DELETE",
          path: "/persist/never-created",
          nodeType: "file",
        },
        write("/persist/config/marker.json", new Uint8Array([3])),
      ],
    });
    const rawPhp = fakeRawPhp();

    await initFsPersistence(rawPhp, "s");

    assert.deepEqual([...rawPhp.store.get(DB_FILE)], [1, 2]);
    assert.deepEqual([...rawPhp.store.get("/persist/config/marker.json")], [3]);
    assert.equal(
      rawPhp.store.has("/persist/moodledata/localcache/di.php"),
      false,
    );
  });

  it("journals /persist writes but not SQLite temp files or caches", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const rawPhp = fakeRawPhp({
      files: { [DB_FILE]: new Uint8Array([5, 6, 7]) },
    });
    const { flushNow } = await initFsPersistence(rawPhp, "s");

    rawPhp.fs.write({ path: "/persist/x.sqlite-journal" });
    rawPhp.fs.write({ path: "/persist/moodledata/muc/config.php" });
    rawPhp.fs.write({ path: DB_FILE });
    rawPhp.fs.write({ path: DB_FILE });
    rawPhp.fs.write({ path: "/www/moodle/config.php" });

    // flushNow cancels the debounce timer and persists the collapsed write.
    const result = await flushNow();
    assert.equal(result.ok, true);
    assert.equal(result.flushedOps, 1);
    const persisted = idb.dbs.get("moodle-fs-journal:s").ops;
    assert.deepEqual(
      persisted.map((op) => op.path),
      [DB_FILE],
    );
    assert.equal(persisted[0].data.byteLength, 3);
  });

  it("flushes on the debounce timer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const rawPhp = fakeRawPhp({ files: { [DB_FILE]: new Uint8Array([1]) } });
    const { flushNow } = await initFsPersistence(rawPhp, "s");
    rawPhp.fs.write({ path: DB_FILE });
    mock.timers.tick(1500);
    // flushNow awaits the queued (timer-started) flush and finds nothing left.
    assert.deepEqual(await flushNow(), {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
    assert.equal(idb.dbs.get("moodle-fs-journal:s").ops.length, 1);
  });

  it("checkpoints a path prefix within a byte limit using FS.stat sizes", async () => {
    const filedir = "/persist/moodledata/filedir/ab/hash";
    const rawPhp = fakeRawPhp({
      files: { [filedir]: new Uint8Array(10) },
      sizes: { [filedir]: 10 },
    });
    const { flushNow } = await initFsPersistence(rawPhp, "s");
    rawPhp.fs.write({ path: filedir });
    rawPhp.fs.write({ path: DB_FILE });

    const tooBig = await flushNow({
      pathPrefix: "/persist/moodledata/filedir",
      maxBytes: 5,
    });
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.reason, "size-limit");
    assert.equal(tooBig.estimatedBytes, 10);

    const ok = await flushNow({
      pathPrefix: "/persist/moodledata/filedir",
      maxBytes: 64,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.flushedOps, 1);
    // The DB write outside the prefix stays pending for the next full flush.
    assert.equal((await flushNow()).flushedOps, 1);
  });

  it("propagates an IndexedDB open failure", async () => {
    idb.failNextOpen();
    await assert.rejects(initFsPersistence(fakeRawPhp(), "s"), /open denied/);
  });
});

describe("clearJournal", () => {
  it("empties only the given scope's journal", async () => {
    idb.dbs.set("moodle-fs-journal:a", { ops: [write(DB_FILE)] });
    idb.dbs.set("moodle-fs-journal:b", { ops: [write(DB_FILE)] });
    await clearJournal("a");
    assert.equal(idb.dbs.get("moodle-fs-journal:a").ops.length, 0);
    assert.equal(idb.dbs.get("moodle-fs-journal:b").ops.length, 1);
  });
});

describe("flushPendingOps edge cases", () => {
  it("does nothing when no pending op is selected", async () => {
    const pendingOps = [write(DB_FILE)];
    const result = await flushPendingOps({
      rawPhp: {},
      pendingOps,
      loadPersistedOps: () => assert.fail("must not read the journal"),
      replacePersistedOps: () => assert.fail("must not write the journal"),
      shouldFlush: () => false,
    });
    assert.deepEqual(result, {
      ok: true,
      flushedOps: 0,
      hydratedBytes: 0,
      estimatedBytes: 0,
    });
    assert.equal(pendingOps.length, 1);
  });

  it("counts only WRITE payload bytes and treats unknown sizes as zero", async () => {
    let persisted;
    const result = await flushPendingOps({
      rawPhp: { readFileAsBuffer: () => new Uint8Array(4) },
      pendingOps: [
        { operation: "CREATE", path: "/persist/dir", nodeType: "directory" },
        { operation: "WRITE", path: "/persist/dir/f", nodeType: "file" },
      ],
      loadPersistedOps: async () => [],
      replacePersistedOps: async (ops) => {
        persisted = ops;
      },
      maxBytes: 100,
      getFileSize: () => undefined,
    });
    assert.equal(result.estimatedBytes, 0);
    assert.equal(result.hydratedBytes, 4);
    assert.equal(persisted.length, 2);
  });
});

describe("operationTouchesPathPrefix", () => {
  it("matches every op without a prefix and tolerates missing paths", () => {
    assert.equal(operationTouchesPathPrefix({ path: "/x" }, null), true);
    assert.equal(operationTouchesPathPrefix(null, "/persist"), false);
    assert.equal(
      operationTouchesPathPrefix(
        { operation: "RENAME", path: "/tmp/a" },
        "/persist",
      ),
      false,
    );
    assert.equal(
      operationTouchesPathPrefix({ path: "/persist/" }, "/persist/"),
      true,
    );
  });
});
