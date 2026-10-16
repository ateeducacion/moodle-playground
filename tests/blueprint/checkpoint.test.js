import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createBlueprintCheckpoint,
  getReloadStep,
} from "../../src/blueprint/checkpoint.js";
import { executeBlueprint } from "../../src/blueprint/executor.js";
import { registerStep } from "../../src/blueprint/steps/index.js";

it("checkpoints before provisioning and only marks completed steps after a successful write", async () => {
  const calls = [];
  let failSave = false;
  const php = {
    run: async (code) => {
      calls.push(code);
      return {
        text: code.includes("SELECT value")
          ? "null"
          : failSave
            ? "failed"
            : "checkpoint-saved",
      };
    },
  };
  const checkpoint = await createBlueprintCheckpoint({
    blueprint: { steps: [{}] },
    php,
    dbFile: "/persist/db'file",
    resume: false,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /db\\'file/);
  assert.match(checkpoint.fingerprint, /^[a-f0-9]{64}$/);
  failSave = true;
  await assert.rejects(checkpoint.save(0), /could not be saved/);
  assert.equal(checkpoint.completed.size, 0);
  failSave = false;
  await checkpoint.save(0);
  assert.deepEqual([...checkpoint.completed], [0]);
});

it("rejects mismatched, malformed and unsupported checkpoints without provisioning", async () => {
  for (const stored of [
    {},
    { version: 2 },
    { version: 1, fingerprint: "different", completed: [] },
  ]) {
    await assert.rejects(
      createBlueprintCheckpoint({
        blueprint: { steps: [{}] },
        php: { run: async () => ({ text: JSON.stringify(stored) }) },
        dbFile: "/persist/db",
        resume: true,
      }),
      /does not match/,
    );
  }
});

it("does not initialize a new checkpoint on legacy persisted sites", async () => {
  let calls = 0;
  const checkpoint = await createBlueprintCheckpoint({
    blueprint: { steps: [{}] },
    php: {
      run: async () => {
        calls++;
        return { text: "null" };
      },
    },
    dbFile: "/persist/db",
    resume: true,
  });
  assert.equal(checkpoint.legacy, true);
  assert.equal(checkpoint.resuming, true);
  assert.equal(calls, 1);
});

it("restores only finished volatile operations, resolving mixed and traversing paths safely", () => {
  for (const step of [
    { step: "createCourse" },
    { step: "setConfig" },
    { step: "runPhpCode" },
    { step: "request", method: "POST" },
    { step: "writeFile", path: "/persist/state" },
    { step: "writeFile", path: "/www/../persist/state" },
    { step: "moveFile", from: "/persist/a", to: "/persist/b" },
  ])
    assert.equal(getReloadStep(step, true), null);
  const volatile = { step: "writeFile", path: "/www/file" };
  assert.deepEqual(
    getReloadStep(
      { step: "moveFile", from: "/www/a", to: "/persist/a" },
      true,
      "/persist/artifact",
    ),
    { step: "deleteFile", path: "/www/a" },
  );
  assert.deepEqual(getReloadStep(volatile, true, "/persist/artifact"), {
    ...volatile,
    data: { vfs: "/persist/artifact-0.bin" },
  });
  assert.equal(getReloadStep(volatile, false), null);
  assert.deepEqual(
    getReloadStep(
      {
        step: "writeFiles",
        files: [{ path: "/persist/a" }, { path: "/www/a" }],
      },
      true,
      "/persist/artifact",
    ).files,
    [{ path: "/www/a", data: { vfs: "/persist/artifact-1.bin" } }],
  );
  assert.deepEqual(
    getReloadStep(
      { step: "deleteFiles", files: ["/persist/a", "/www/a"] },
      true,
    ).files,
    ["/www/a"],
  );
  for (const step of [
    { step: "login" },
    { step: "setLandingPage", path: "/my/" },
  ])
    assert.equal(getReloadStep(step, false), step);
});

it("reload skips persistent mutations and arbitrary requests but restores files and landing page", async () => {
  const writes = [];
  const blueprint = {
    constants: { ROOT: "/www" },
    steps: [
      { step: "runPhpCode", code: "throw new Exception('must not run');" },
      { step: "request", method: "POST" },
      {
        step: "writeFiles",
        files: [
          { path: "{{ROOT}}/fixture", data: "restored" },
          { path: "/persist/state", data: "must not overwrite" },
        ],
      },
      { step: "setLandingPage", path: "/course/" },
    ],
  };
  const result = await executeBlueprint(blueprint, {
    php: {
      writeFile: async (path) => writes.push(path),
      readFile: async () => new TextEncoder().encode("restored"),
    },
    checkpoint: { resuming: true, completed: new Set([0, 1, 2, 3]) },
  });
  assert.equal(result.success, true);
  assert.equal(result.landingPage, "/course/");
  assert.deepEqual(writes, ["/www/fixture"]);
  assert.deepEqual(
    result.timings.map((t) => t.status),
    ["skipped", "skipped", "success", "success"],
  );
});

it("restores saved filesystem bytes without rereading moving resources or re-deleting persisted move sources", async () => {
  const encode = (text) => new TextEncoder().encode(text);
  const files = new Map([
    ["/persist/source", encode("original")],
    ["/persist/move-source", encode("moved")],
    ["/www/core-source", encode("core source")],
    ["/www/core-to-persist", encode("persisted source")],
  ]);
  let deletes = 0;
  const php = {
    _php: { mkdirTree() {} },
    writeFile: async (path, bytes) => files.set(path, bytes),
    readFile: async (path) => {
      assert.ok(files.has(path), `missing file ${path}`);
      return files.get(path);
    },
    run: async (code) => {
      deletes++;
      const path =
        code.match(/@unlink\('([^']+)'\)/)?.[1] ||
        code.match(/\$p = '([^']+)'/)?.[1];
      assert.ok(path);
      files.delete(path);
      return { text: '{"ok":true}' };
    },
  };
  const checkpoint = {
    fingerprint: "fixture",
    resuming: false,
    completed: new Set(),
    save: async (index) => checkpoint.completed.add(index),
  };
  const blueprint = {
    steps: [
      {
        step: "writeFiles",
        files: [
          { path: "/persist/marker", data: "initial" },
          { path: "/www/fixture", data: { vfs: "/persist/source" } },
        ],
      },
      { step: "moveFile", from: "/persist/move-source", to: "/www/moved" },
      {
        step: "moveFile",
        from: "/www/core-source",
        to: "/www/core-destination",
      },
      {
        step: "moveFile",
        from: "/www/core-to-persist",
        to: "/persist/moved-destination",
      },
    ],
  };
  assert.equal(
    (await executeBlueprint(blueprint, { php, checkpoint })).success,
    true,
  );
  files.set("/persist/source", encode("user edited"));
  files.set("/persist/marker", encode("user edited"));
  files.set("/persist/moved-destination", encode("user edited"));
  for (const path of files.keys())
    if (path.startsWith("/www/")) files.delete(path);
  files.set("/www/core-source", encode("fresh core"));
  files.set("/www/core-to-persist", encode("fresh core"));
  checkpoint.resuming = true;
  assert.equal(
    (await executeBlueprint(blueprint, { php, checkpoint })).success,
    true,
  );
  assert.equal(new TextDecoder().decode(files.get("/www/fixture")), "original");
  assert.equal(new TextDecoder().decode(files.get("/www/moved")), "moved");
  assert.equal(
    new TextDecoder().decode(files.get("/persist/marker")),
    "user edited",
  );
  assert.equal(files.has("/persist/move-source"), false);
  assert.equal(files.has("/www/core-source"), false);
  assert.equal(files.has("/www/core-to-persist"), false);
  assert.equal(
    new TextDecoder().decode(files.get("/www/core-destination")),
    "core source",
  );
  assert.equal(
    new TextDecoder().decode(files.get("/persist/moved-destination")),
    "user edited",
  );
  assert.equal(deletes, 5);
});

it("does not silently retry or declare success after an unfinished provisioning step", async () => {
  const result = await executeBlueprint(
    { steps: [{ step: "createCourse", shortname: "ambiguous" }] },
    { checkpoint: { resuming: true, completed: new Set() } },
  );
  assert.equal(result.success, false);
  assert.match(result.error, /unfinished step/);
});

it("aborts further mutations when checkpoint persistence fails even on a noncritical step", async () => {
  const calls = [];
  registerStep("__checkpoint_mutation", async () => calls.push("mutation"));
  await assert.rejects(
    executeBlueprint(
      {
        steps: [
          { step: "__checkpoint_mutation" },
          { step: "__checkpoint_mutation" },
        ],
      },
      {
        checkpoint: {
          resuming: false,
          save: async () => {
            throw new Error("disk failure");
          },
        },
      },
    ),
    /disk failure/,
  );
  assert.deepEqual(calls, ["mutation"]);
});
