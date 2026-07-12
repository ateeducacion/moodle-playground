import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSnapshotManager } from "../../src/runtime/crash-recovery.js";

const DB_PATH = "/persist/moodledata/moodle_test_php.sq3.php";
const FILEDIR_PATH = "/persist/moodledata/filedir";

function createMessages() {
  const messages = [];
  return {
    messages,
    postShell: (message) => messages.push(message),
  };
}

describe("crash recovery filedir checkpoints", () => {
  it("flushes pending filedir changes before taking the DB snapshot", async () => {
    const { messages, postShell } = createMessages();
    const flushCalls = [];
    let dbReads = 0;
    const rawPhp = {
      readFileAsBuffer(path) {
        assert.equal(path, DB_PATH);
        dbReads++;
        return new Uint8Array([1, 2, 3]);
      },
      fileExists() {
        throw new Error("full filedir traversal must not run");
      },
    };
    const php = {
      _php: rawPhp,
      async flushPersistence(options) {
        flushCalls.push(options);
        return {
          enabled: true,
          ok: true,
          flushedOps: 2,
          hydratedBytes: 1024,
          estimatedBytes: 1024,
        };
      },
    };
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 4096,
    });

    const result = await snapshot.hydrate(php, DB_PATH);

    assert.deepEqual(result, { captured: true, filedirMode: "journal" });
    assert.equal(dbReads, 1);
    assert.deepEqual(flushCalls, [
      { pathPrefix: FILEDIR_PATH, maxBytes: 4096 },
    ]);
    assert.equal(snapshot.hasPendingRestore, true);
    assert.ok(
      messages.some((message) =>
        message.detail?.includes("checkpointed 2 pending filedir ops"),
      ),
    );
  });

  it("does not capture a newer DB when the filedir checkpoint fails", async () => {
    const { postShell } = createMessages();
    let dbReads = 0;
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 4096,
    });
    const php = {
      _php: {
        readFileAsBuffer() {
          dbReads++;
          return new Uint8Array([1]);
        },
      },
      async flushPersistence() {
        return {
          enabled: true,
          ok: false,
          reason: "size-limit",
          estimatedBytes: 8192,
        };
      },
    };

    const result = await snapshot.hydrate(php, DB_PATH);

    assert.equal(result.captured, false);
    assert.equal(result.reason, "size-limit");
    assert.equal(dbReads, 0);
    assert.equal(snapshot.hasPendingRestore, false);
  });

  it("uses a bounded full filedir fallback when persistence is disabled", async () => {
    const { postShell } = createMessages();
    const storedFile = `${FILEDIR_PATH}/ab/contenthash`;
    const rawPhp = {
      fileExists(path) {
        return path === FILEDIR_PATH;
      },
      isDir(path) {
        return path === FILEDIR_PATH || path === `${FILEDIR_PATH}/ab`;
      },
      listFiles(path) {
        if (path === FILEDIR_PATH) return [`${FILEDIR_PATH}/ab`];
        if (path === `${FILEDIR_PATH}/ab`) return [storedFile];
        return [];
      },
      readFileAsBuffer(path) {
        if (path === DB_PATH) return new Uint8Array([9, 8]);
        if (path === storedFile) return new Uint8Array([7, 6, 5]);
        throw new Error(`unexpected read: ${path}`);
      },
    };
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 1024,
    });

    const result = await snapshot.hydrate(
      {
        _php: rawPhp,
        async flushPersistence() {
          return { enabled: false, ok: true };
        },
      },
      DB_PATH,
    );

    assert.deepEqual(result, { captured: true, filedirMode: "fallback" });

    const writes = new Map();
    const restoreResult = await snapshot.restore({
      _php: {
        mkdirTree() {},
        writeFile(path, data) {
          writes.set(path, [...data]);
        },
      },
    });

    assert.equal(restoreResult.restored, true);
    assert.deepEqual(writes.get(DB_PATH), [9, 8]);
    assert.deepEqual(writes.get(storedFile), [7, 6, 5]);
    assert.equal(snapshot.hasPendingRestore, false);
  });

  it("abandons the live snapshot when the bounded fallback is too large", async () => {
    const { postShell } = createMessages();
    const storedFile = `${FILEDIR_PATH}/large-file`;
    let dbReads = 0;
    const snapshot = createSnapshotManager({
      postShell,
      maxCrashFiledirBytes: 3,
    });

    const result = await snapshot.hydrate(
      {
        _php: {
          fileExists: () => true,
          isDir: (path) => path === FILEDIR_PATH,
          listFiles: () => [storedFile],
          readFileAsBuffer(path) {
            if (path === DB_PATH) {
              dbReads++;
              return new Uint8Array([1]);
            }
            return new Uint8Array([1, 2, 3, 4]);
          },
        },
        async flushPersistence() {
          return { enabled: false, ok: true };
        },
      },
      DB_PATH,
    );

    assert.equal(result.captured, false);
    assert.equal(result.reason, "size-limit");
    assert.equal(dbReads, 0);
    assert.equal(snapshot.hasPendingRestore, false);
  });
});
