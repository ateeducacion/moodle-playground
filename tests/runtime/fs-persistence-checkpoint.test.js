import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  flushPendingOps,
  operationTouchesPathPrefix,
} from "../../src/runtime/fs-persistence.js";

const FILEDIR_PATH = "/persist/moodledata/filedir";

describe("selective persistence checkpoints", () => {
  it("flushes only filedir operations and leaves unrelated DB work pending", async () => {
    const filePath = `${FILEDIR_PATH}/ab/contenthash`;
    const dbOp = {
      operation: "WRITE",
      path: "/persist/moodledata/site.sq3.php",
      nodeType: "file",
    };
    const pendingOps = [
      dbOp,
      { operation: "WRITE", path: filePath, nodeType: "file" },
      { operation: "WRITE", path: filePath, nodeType: "file" },
    ];
    let reads = 0;
    let persisted = [];

    const result = await flushPendingOps({
      rawPhp: {
        readFileAsBuffer(path) {
          assert.equal(path, filePath);
          reads++;
          return new Uint8Array([1, 2, 3]);
        },
      },
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async (ops) => {
        persisted = ops;
      },
      shouldFlush: (op) => operationTouchesPathPrefix(op, FILEDIR_PATH),
      maxBytes: 1024,
      getFileSize: () => 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.flushedOps, 1);
    assert.equal(result.hydratedBytes, 3);
    assert.equal(reads, 1);
    assert.deepEqual(pendingOps, [dbOp]);
    assert.equal(persisted.length, 1);
    assert.deepEqual([...persisted[0].data], [1, 2, 3]);
  });

  it("rejects an oversized crash checkpoint before reading file contents", async () => {
    const fileOp = {
      operation: "WRITE",
      path: `${FILEDIR_PATH}/large-file`,
      nodeType: "file",
    };
    const pendingOps = [fileOp];
    let reads = 0;
    let writes = 0;

    const result = await flushPendingOps({
      rawPhp: {
        readFileAsBuffer() {
          reads++;
          return new Uint8Array(32);
        },
      },
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async () => {
        writes++;
      },
      maxBytes: 8,
      getFileSize: () => 32,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "size-limit");
    assert.equal(result.estimatedBytes, 32);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.deepEqual(pendingOps, [fileOp]);
  });

  it("restores selected operations to the pending queue when persistence fails", async () => {
    const fileOp = {
      operation: "WRITE",
      path: `${FILEDIR_PATH}/file`,
      nodeType: "file",
    };
    const pendingOps = [fileOp];

    const result = await flushPendingOps({
      rawPhp: {
        readFileAsBuffer: () => new Uint8Array([1]),
      },
      pendingOps,
      loadPersistedOps: async () => [],
      replacePersistedOps: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "flush-failed");
    assert.deepEqual(pendingOps, [fileOp]);
  });

  it("matches renames entering or leaving filedir", () => {
    assert.equal(
      operationTouchesPathPrefix(
        {
          operation: "RENAME",
          path: "/tmp/upload",
          toPath: `${FILEDIR_PATH}/new-file`,
          nodeType: "file",
        },
        FILEDIR_PATH,
      ),
      true,
    );
    assert.equal(
      operationTouchesPathPrefix(
        {
          operation: "RENAME",
          path: `${FILEDIR_PATH}/old-file`,
          toPath: "/tmp/removed",
          nodeType: "file",
        },
        FILEDIR_PATH,
      ),
      true,
    );
  });
});
