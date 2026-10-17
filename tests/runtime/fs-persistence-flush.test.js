import assert from "node:assert/strict";
import { test } from "node:test";

import { createJournalFlusher } from "../../src/runtime/fs-persistence.js";

// Minimal IndexedDB stand-in: reads succeed on the next tick, while each
// readwrite transaction stays open until the test commits it.
function createFakeDb() {
  const commits = [];
  let notifyWrite;
  const writeOpened = new Promise((resolve) => {
    notifyWrite = resolve;
  });
  const db = {
    transaction(_store, mode) {
      const tx = {
        objectStore: () => ({
          getAll() {
            const req = {};
            setImmediate(() => req.onsuccess?.());
            return req;
          },
          clear() {},
          add() {},
        }),
      };
      if (mode === "readwrite") {
        commits.push(() => tx.oncomplete?.());
        notifyWrite();
      }
      return tx;
    },
  };
  return { db, commits, writeOpened };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Regression guard: an in-flight flush has already drained pendingOps, so a
// flushNow() that only looks at pendingOps returned at once. The OPcache
// reload then tore the worker down and aborted that IndexedDB transaction.
test("flushNow waits for a journal flush that is already in flight", async () => {
  const pendingOps = [
    { operation: "WRITE", path: "/persist/install-marker", nodeType: "file" },
  ];
  const rawPhp = { readFileAsBuffer: () => new Uint8Array([1]) };
  const { db, commits, writeOpened } = createFakeDb();
  const flusher = createJournalFlusher(rawPhp, db, pendingOps);

  const inFlight = flusher.flushNow();
  await writeOpened;
  assert.equal(pendingOps.length, 0, "the in-flight flush drained the ops");

  let settled = false;
  const second = flusher.flushNow().then(() => {
    settled = true;
  });
  await tick();
  await tick();
  assert.equal(settled, false, "flushNow returned before the write committed");

  commits[0]();
  await inFlight;
  await second;
  assert.equal(settled, true);
});
