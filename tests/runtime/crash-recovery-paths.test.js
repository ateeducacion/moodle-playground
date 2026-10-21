import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSnapshotManager,
  isEmscriptenNetworkError,
  isFatalWasmError,
  requestPathname,
} from "../../src/runtime/crash-recovery.js";

const DB = "/persist/moodledata/moodle_t_php.sq3.php";
const FILEDIR = "/persist/moodledata/filedir";
const bytes = (n) => new Uint8Array(n).fill(7);

// In-memory raw Emscripten FS: `files` maps path -> bytes; directories are
// implied by file paths plus `dirs`. `fail` lets a test break single calls.
function memFs(files = {}, { dirs = [], fail = {} } = {}) {
  const store = new Map(Object.entries(files));
  const dirSet = new Set(dirs);
  for (const path of store.keys()) {
    for (let d = path.slice(0, path.lastIndexOf("/")); d; ) {
      dirSet.add(d);
      d = d.slice(0, d.lastIndexOf("/"));
    }
  }
  const check = (op, path) => {
    if (fail[op]?.(path)) throw new Error(`${op} failed: ${path}`);
  };
  return {
    store,
    fileExists(p) {
      check("fileExists", p);
      return store.has(p) || dirSet.has(p);
    },
    isDir: (p) => dirSet.has(p),
    listFiles(dir) {
      check("listFiles", dir);
      if (!dirSet.has(dir)) throw new Error("ENOENT");
      const kids = new Set();
      for (const p of [...store.keys(), ...dirSet]) {
        if (p.startsWith(`${dir}/`)) {
          kids.add(`${dir}/${p.slice(dir.length + 1).split("/")[0]}`);
        }
      }
      return [...kids];
    },
    readFileAsBuffer(p) {
      check("read", p);
      if (!store.has(p)) throw new Error("ENOENT");
      return store.get(p);
    },
    writeFile(p, data) {
      check("write", p);
      store.set(p, data);
    },
    mkdirTree: (d) => dirSet.add(d),
  };
}

function manager(options = {}) {
  const messages = [];
  const snapshots = createSnapshotManager({
    postShell: (msg) => messages.push(msg),
    ...options,
  });
  return { snapshots, messages, text: () => messages.map((m) => m.detail) };
}

describe("crash error classification", () => {
  it("treats Emscripten EHOSTUNREACH as fatal and ignores empty errors", () => {
    assert.equal(isEmscriptenNetworkError(null), false);
    assert.equal(isEmscriptenNetworkError({ errno: 23 }), true);
    assert.equal(isFatalWasmError(new Error("socket errno 23")), true);
  });

  it("falls back to / when the request URL cannot be parsed", () => {
    assert.equal(requestPathname({ url: "http://[bad" }), "/");
    assert.equal(requestPathname({ url: "/admin/?sesskey=1" }), "/admin/");
  });
});

describe("snapshot manager plugin directories", () => {
  it("captures tracked plugin trees and reports missing or unreadable dirs", async () => {
    const raw = memFs(
      {
        [DB]: bytes(4),
        "/www/moodle/mod/a/version.php": bytes(2),
        "/www/moodle/mod/a/lang/en/a.php": bytes(3),
        "/www/moodle/mod/a/secret.php": bytes(1),
      },
      {
        dirs: ["/www/moodle/mod/broken"],
        fail: {
          read: (p) => p.endsWith("secret.php"),
          fileExists: (p) => p === "/www/moodle/mod/boom",
        },
      },
    );
    const { snapshots, text } = manager();
    for (const dir of ["a", "gone", "boom"]) {
      snapshots.trackPluginDir(`/www/moodle/mod/${dir}`);
    }

    const result = await snapshots.hydrate({ _php: raw }, DB);

    assert.deepEqual(result, { captured: true, filedirMode: "fallback" });
    const log = text().join("\n");
    assert.match(log, /tracking installed plugin: \/www\/moodle\/mod\/a/);
    assert.match(log, /plugin dir not found: \/www\/moodle\/mod\/gone/);
    assert.match(log, /failed to read plugin dir \/www\/moodle\/mod\/boom/);
    assert.match(log, /collected 2 files from \/www\/moodle\/mod\/a/);

    // Restoring into a fresh FS writes the DB and the readable plugin files;
    // a failing write is counted instead of aborting the rest.
    const target = memFs(
      {},
      { fail: { write: (p) => p.endsWith("version.php") } },
    );
    const restored = await snapshots.restore({ _php: target });
    assert.equal(restored.restored, true);
    assert.equal(restored.pluginsRestored, true);
    assert.ok(restored.restoredPluginDirs.includes("/www/moodle/mod/a"));
    assert.deepEqual(target.store.get(DB), bytes(4));
    assert.ok(target.store.has("/www/moodle/mod/a/lang/en/a.php"));
    assert.equal(target.store.has("/www/moodle/mod/a/version.php"), false);
    assert.match(text().join("\n"), /restored 1 plugin files \(1 failed\)/);
    assert.equal(snapshots.hasPendingRestore, false);
  });

  it("says so when tracked plugin dirs are empty", async () => {
    const raw = memFs({ [DB]: bytes(1) }, { dirs: ["/www/moodle/mod/empty"] });
    const { snapshots, text } = manager();
    snapshots.trackPluginDir("/www/moodle/mod/empty");
    await snapshots.hydrate({ _php: raw }, DB);
    assert.ok(
      text().includes("[snapshot] no plugin files collected from tracked dirs"),
    );
  });

  it("reports a DB restore failure without claiming success", async () => {
    const { snapshots, text } = manager();
    await snapshots.hydrate({ _php: memFs({ [DB]: bytes(2) }) }, DB);
    const result = await snapshots.restore({
      _php: memFs({}, { fail: { write: () => true } }),
    });
    assert.equal(result.restored, false);
    assert.match(text().at(-1), /failed to restore DB: write failed/);
  });
});

describe("snapshot manager filedir checkpoint", () => {
  it("refuses an empty DB file", async () => {
    const { snapshots, text } = manager();
    const result = await snapshots.hydrate(
      { _php: memFs({ [DB]: bytes(0) }) },
      DB,
    );
    assert.deepEqual(result, { captured: false, reason: "db-read-failed" });
    assert.match(text().at(-1), /DB snapshot is empty/);
  });

  it("does not snapshot when the journal flush throws", async () => {
    const { snapshots, text } = manager();
    const result = await snapshots.hydrate(
      {
        _php: memFs({ [DB]: bytes(1) }),
        flushPersistence: async () => {
          throw new Error("idb closed");
        },
      },
      DB,
    );
    assert.deepEqual(result, { captured: false, reason: "flush-failed" });
    assert.match(text()[0], /checkpoint failed: idb closed/);
    assert.equal(snapshots.hasPendingRestore, false);
  });

  it("reports non-size journal failures and zero-op checkpoints plainly", async () => {
    const { snapshots, text } = manager();
    const failed = await snapshots.hydrate(
      {
        _php: memFs({ [DB]: bytes(1) }),
        flushPersistence: async () => ({
          enabled: true,
          ok: false,
          reason: "quota",
        }),
      },
      DB,
    );
    assert.equal(failed.reason, "quota");
    assert.equal(
      text()[0],
      "[snapshot] filedir checkpoint failed; using the last persisted checkpoint",
    );

    const ok = await snapshots.hydrate(
      {
        _php: memFs({ [DB]: bytes(1) }),
        flushPersistence: async () => ({ enabled: true, ok: true }),
      },
      DB,
    );
    assert.equal(ok.filedirMode, "journal");
    assert.ok(
      text().includes("[snapshot] checkpointed 0 pending filedir ops (0KB)"),
    );
  });

  it("estimates 0KB when a size-limit failure has no estimate", async () => {
    const { snapshots, text } = manager({ maxCrashFiledirBytes: 2048 });
    await snapshots.hydrate(
      {
        _php: memFs({ [DB]: bytes(1) }),
        flushPersistence: async () => ({
          enabled: true,
          ok: false,
          reason: "size-limit",
        }),
      },
      DB,
    );
    assert.match(text()[0], /\(0KB exceeds 2KB limit\)/);
  });

  it("uses an empty fallback when filedir is absent or cannot be probed", async () => {
    for (const raw of [
      memFs({ [DB]: bytes(1) }),
      memFs({ [DB]: bytes(1) }, { fail: { fileExists: (p) => p === FILEDIR } }),
    ]) {
      const { snapshots } = manager();
      const result = await snapshots.hydrate({ _php: raw }, DB);
      assert.deepEqual(result, { captured: true, filedirMode: "fallback" });
    }
  });

  it("copies nested filedir entries, skipping unreadable files and dirs", async () => {
    const raw = memFs(
      {
        [DB]: bytes(1),
        [`${FILEDIR}/aa/bb/hash1`]: bytes(3),
        [`${FILEDIR}/aa/bb/hash2`]: bytes(3),
        [`${FILEDIR}/cc/hash3`]: bytes(3),
      },
      {
        fail: {
          read: (p) => p.endsWith("hash2"),
          listFiles: (p) => p === `${FILEDIR}/cc`,
        },
      },
    );
    const { snapshots, text } = manager();
    await snapshots.hydrate({ _php: raw }, DB);
    assert.ok(
      text().some((t) => /bounded filedir fallback \(1 entries, 0KB\)/.test(t)),
    );

    const target = memFs({}, { fail: { write: (p) => p === DB } });
    const result = await snapshots.restore({ _php: target });
    assert.equal(result.restored, true);
    assert.deepEqual([...target.store.keys()], [`${FILEDIR}/aa/bb/hash1`]);
  });

  it("stops collecting as soon as the byte bound is crossed", async () => {
    const raw = memFs({
      [DB]: bytes(1),
      [`${FILEDIR}/a/one`]: bytes(600),
      [`${FILEDIR}/a/two`]: bytes(600),
      [`${FILEDIR}/b/three`]: bytes(1),
    });
    const { snapshots } = manager({ maxCrashFiledirBytes: 1000 });
    const result = await snapshots.hydrate({ _php: raw }, DB);
    assert.deepEqual(result, { captured: false, reason: "size-limit" });
  });

  it("counts failed filedir fallback writes", async () => {
    const raw = memFs({ [DB]: bytes(1), [`${FILEDIR}/x/h`]: bytes(1) });
    const { snapshots, text } = manager();
    await snapshots.hydrate({ _php: raw }, DB);
    await snapshots.restore({
      _php: memFs({}, { fail: { write: (p) => p !== DB } }),
    });
    assert.match(
      text().at(-1),
      /restored 0 fallback filedir entries \(1 failed\)/,
    );
  });
});
