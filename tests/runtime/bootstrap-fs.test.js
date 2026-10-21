import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ensureDir,
  readJsonFile,
  writeJsonFile,
} from "../../src/runtime/bootstrap-fs.js";

function memoryPhp(entries = {}) {
  const fs = new Map(Object.entries(entries));
  return {
    fs,
    mkdirs: [],
    async analyzePath(path) {
      if (!fs.has(path)) return { exists: false };
      return { exists: true, object: { isFolder: fs.get(path) === "dir" } };
    },
    async mkdir(path) {
      this.mkdirs.push(path);
      fs.set(path, "dir");
    },
    async readFile(path) {
      return fs.get(path);
    },
    async writeFile(path, data) {
      fs.set(path, data);
    },
  };
}

it("ensureDir creates only the missing path segments", async () => {
  const php = memoryPhp({ "/persist": "dir" });
  await ensureDir(php, "/persist/moodledata//cache/");
  assert.deepEqual(php.mkdirs, [
    "/persist/moodledata",
    "/persist/moodledata/cache",
  ]);
});

it("ensureDir refuses to replace a file with a directory", async () => {
  const php = memoryPhp({ "/persist": new Uint8Array() });
  await assert.rejects(
    ensureDir(php, "/persist/config"),
    /Cannot create directory \/persist: path exists and is not a directory/,
  );
  assert.deepEqual(php.mkdirs, []);
});

it("round-trips JSON and reads a missing file as null", async () => {
  const php = memoryPhp();
  assert.equal(await readJsonFile(php, "/state.json"), null);
  await writeJsonFile(php, "/state.json", { installed: true });
  assert.equal(
    new TextDecoder().decode(php.fs.get("/state.json")),
    '{\n  "installed": true\n}\n',
  );
  assert.deepEqual(await readJsonFile(php, "/state.json"), { installed: true });
});
