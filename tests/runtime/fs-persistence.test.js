import assert from "node:assert/strict";
import { test } from "node:test";

import { collapseAndHydrate } from "../../src/runtime/fs-persistence.js";

// Regression guard for the journal-flush OOM: a heavy install rewrites the same
// (multi-MB) SQLite DB hundreds of times within one debounce window. Hydrating
// the raw, un-collapsed op list read every write's content into memory at once →
// `RangeError: Array buffer allocation failed`. collapseAndHydrate must normalize
// FIRST (collapsing same-path writes) so each changed file is read exactly once.
test("collapseAndHydrate reads each changed file once, not once per write", async () => {
  const path = "/persist/data.sq3";
  const ops = Array.from({ length: 500 }, () => ({
    operation: "WRITE",
    path,
    nodeType: "file",
  }));

  const reads = new Map();
  const fakePhp = {
    readFileAsBuffer(p) {
      reads.set(p, (reads.get(p) || 0) + 1);
      return new Uint8Array(8);
    },
  };

  const hydrated = await collapseAndHydrate(fakePhp, ops);

  // 500 writes to one path collapse to a single WRITE op...
  const writes = hydrated.filter(
    (op) => op.operation === "WRITE" && op.path === path,
  );
  assert.equal(writes.length, 1);
  // ...and the file is read exactly once (the OOM guard), not 500 times.
  assert.equal(reads.get(path), 1);
});
