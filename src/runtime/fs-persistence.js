import {
  hydrateUpdateFileOps,
  journalFSEvents,
  normalizeFilesystemOperations,
  replayFSJournal,
} from "@php-wasm/fs-journal";

// Persist Moodle's mutable state (SQLite DB at /persist/moodledata/*.sq3.php,
// moodledata/filedir, config under /persist) to IndexedDB via @php-wasm/fs-journal,
// keyed by scopeId, so it survives reloads within the tab session (scopeId is
// sessionStorage-based — same durability as the nextcloud/facturascripts
// playgrounds). The bootstrap install gate (persisted install marker / "database
// already installed") then reuses it and skips CLI provisioning. OPcache is
// intentionally NOT journaled (measured no boot benefit; large cache).
const PERSIST_DB_PREFIX = "moodle-fs-journal";
const DB_VERSION = 1;
const STORE_NAME = "ops";
const FLUSH_DELAY_MS = 1500;

async function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadOps(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function replaceOps(db, ops) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    for (const op of ops) {
      store.add(op);
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function clearDb(name) {
  const db = await openDb(name);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function flushOps(rawPhp, db, pendingOps) {
  if (pendingOps.length === 0) return;
  const ops = pendingOps.splice(0);
  try {
    const hydrated = await hydrateUpdateFileOps(rawPhp, ops);
    const current = await loadOps(db);
    const merged = normalizeFilesystemOperations([...current, ...hydrated]);
    await replaceOps(db, merged);
  } catch {
    // Non-fatal — changes are in MEMFS even if the journal write fails.
  }
}

export async function clearJournal(scopeId) {
  await clearDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
}

/**
 * Replay the journal, tolerating ops that can't be applied to a fresh FS so a
 * single bad op never bricks the reload (e.g. an unlink of a file whose create
 * wasn't journaled). Fast path replays the whole batch; on failure, replay
 * op-by-op and skip the ones that throw — a failed unlink just means the file is
 * already gone, which is the intended end state.
 */
function replayResilient(rawPhp, ops) {
  if (!ops || ops.length === 0) return;
  try {
    replayFSJournal(rawPhp, ops);
  } catch {
    for (const op of ops) {
      try {
        replayFSJournal(rawPhp, [op]);
      } catch {
        // Skip un-appliable op.
      }
    }
  }
}

/**
 * Replay the persisted /persist journal onto the fresh PHP instance, then start
 * journaling new changes back to IndexedDB (debounced). Must run before Moodle
 * bootstraps so the install gate finds the restored database.
 */
export async function initFsPersistence(rawPhp, scopeId) {
  const persistDb = await openDb(`${PERSIST_DB_PREFIX}:${scopeId}`);
  const pendingPersistOps = [];
  let flushTimer = null;

  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushOps(rawPhp, persistDb, pendingPersistOps);
    }, FLUSH_DELAY_MS);
  };

  // Journal /persist — mutable app data (DB, moodledata, config). Skip ephemeral
  // SQLite temp files: they are created and deleted within a single transaction
  // and cause hydration failures if journaled.
  journalFSEvents(rawPhp, "/persist", (op) => {
    if (/\.(sqlite-journal|sqlite-wal|sqlite-shm)$/.test(op.path || "")) return;
    pendingPersistOps.push(op);
    scheduleFlush();
  });

  const savedPersistOps = await loadOps(persistDb);
  replayResilient(rawPhp, savedPersistOps);
}
