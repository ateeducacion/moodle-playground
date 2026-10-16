import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createBlueprintCheckpoint,
  getReloadStep,
  isVolatilePath,
} from "../../src/blueprint/checkpoint.js";
import { executeBlueprint } from "../../src/blueprint/executor.js";
import {
  getStepHandler,
  registerStep,
} from "../../src/blueprint/steps/index.js";

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

it("persists archive hashes with the completed steps and reads them back", async () => {
  const hash = "a".repeat(64);
  let stored = "null";
  const php = {
    run: async (code) => {
      if (code.includes("SELECT value")) return { text: stored };
      stored = code.match(/:value' => '(.+?)'\]/)[1];
      return { text: "checkpoint-saved" };
    },
  };
  const blueprint = { steps: [{}, {}] };
  const first = await createBlueprintCheckpoint({
    blueprint,
    php,
    dbFile: "/persist/db",
    resume: false,
  });
  assert.equal(first.archives.size, 0);
  assert.doesNotMatch(stored, /archives/);
  first.archives.set(1, hash);
  await first.save(1);
  assert.deepEqual(JSON.parse(stored), {
    version: 1,
    fingerprint: first.fingerprint,
    completed: [1],
    archives: { 1: hash },
  });

  const reloaded = await createBlueprintCheckpoint({
    blueprint,
    php,
    dbFile: "/persist/db",
    resume: true,
  });
  assert.equal(reloaded.changed, false);
  assert.deepEqual([...reloaded.archives], [[1, hash]]);

  // Malformed hashes are dropped without invalidating the checkpoint.
  stored = JSON.stringify({
    version: 1,
    fingerprint: first.fingerprint,
    completed: [1],
    archives: { 1: "not-a-hash" },
  });
  const malformed = await createBlueprintCheckpoint({
    blueprint,
    php,
    dbFile: "/persist/db",
    resume: true,
  });
  assert.equal(malformed.changed, false);
  assert.equal(malformed.archives.size, 0);
});

it("passes each step its index so archive steps can address their checkpoint entry", async () => {
  const seen = [];
  registerStep("__index_probe", async (_step, context) =>
    seen.push(context.stepIndex),
  );
  await executeBlueprint(
    { steps: [{ step: "__index_probe" }, { step: "__index_probe" }] },
    {},
  );
  assert.deepEqual(seen, [0, 1]);
});

it("treats mismatched, malformed and unsupported checkpoints as a changed blueprint", async () => {
  for (const stored of [
    {},
    { version: 2 },
    { version: 1, fingerprint: "different", completed: [0] },
  ]) {
    const checkpoint = await createBlueprintCheckpoint({
      blueprint: { steps: [{}] },
      php: { run: async () => ({ text: JSON.stringify(stored) }) },
      dbFile: "/persist/db",
      resume: true,
    });
    assert.equal(checkpoint.changed, true);
    assert.equal(checkpoint.legacy, false);
    assert.equal(checkpoint.completed.size, 0);
  }
});

it("keeps login and landing when the same source now has a different blueprint", async () => {
  const ran = [];
  registerStep("__changed_data", async () => ran.push("data"));
  const php = {
    writeFile: async () => {},
    run: async () => ({ text: "" }),
    request: async () => {
      ran.push("login");
      return new Response('{"ok":true}');
    },
  };
  const result = await executeBlueprint(
    { steps: [{ step: "__changed_data" }, { step: "login" }] },
    {
      php,
      checkpoint: {
        resuming: true,
        changed: true,
        completed: new Set(),
        fingerprint: "f",
      },
    },
  );
  assert.equal(result.success, true);
  assert.deepEqual(ran, ["login"]);
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

it("treats corrupt serialized metadata as changed, not legacy or a reason to lose login", async () => {
  for (const text of ['{"invalid":true}', "false", "0", '""']) {
    const checkpoint = await createBlueprintCheckpoint({
      blueprint: { steps: [{}] },
      php: { run: async () => ({ text }) },
      dbFile: "/persist/db",
      resume: true,
    });
    assert.equal(checkpoint.changed, true);
    assert.equal(checkpoint.legacy, false);
  }
});

it("restores declared journal-excluded cache files but never real persisted data", () => {
  for (const directory of ["cache", "localcache", "temp", "muc"]) {
    assert.equal(
      isVolatilePath(`/persist/moodledata/${directory}/fixture`),
      true,
    );
    assert.equal(
      isVolatilePath(`/www/../persist/moodledata/${directory}/fixture`),
      true,
    );
  }
  for (const path of [
    "/persist/moodledata/filedir/a",
    "/persist/moodledata/cache-backup/a",
    "/persist/moodledata/localcache/../filedir/a",
    "/dev/null",
    "/www/../../",
  ]) {
    assert.equal(isVolatilePath(path), false);
  }
  // Only /persist is journaled, so other MEMFS roots must be restored too.
  for (const path of ["/home/web_user/a", "/internal/shared/x", "/opt/a"]) {
    assert.equal(isVolatilePath(path), true);
  }
});

it("preserves critical on transformed copy and move reload steps", () => {
  for (const step of [
    { step: "copyFile", from: "/persist/a", to: "/www/a", critical: true },
    { step: "moveFile", from: "/www/a", to: "/persist/a", critical: true },
  ])
    assert.equal(getReloadStep(step, true, "/persist/artifact").critical, true);
});

it("restores an unfinished plugin's code by downloading it again, without upgrading or declaring it complete", async () => {
  const { strToU8, zipSync } = await import("fflate");
  const files = [];
  const scripts = [];
  const fetched = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(zipSync({ "partial/version.php": strToU8("<?php") }));
  };
  const result = await executeBlueprint(
    {
      steps: [
        {
          step: "installMoodlePlugin",
          pluginType: "local",
          pluginName: "partial",
          url: "https://example.invalid/moving.zip",
        },
      ],
    },
    {
      runtimeId: "php83-moodle53",
      checkpoint: {
        fingerprint: "partial",
        resuming: true,
        completed: new Set(),
      },
      php: {
        readFile: async () => assert.fail("must not read a saved ZIP copy"),
        _php: { mkdirTree() {}, writeFile: (path) => files.push(path) },
        run: async (code) => {
          scripts.push(code);
          return { text: '{"ok":true}' };
        },
      },
    },
  );
  globalThis.fetch = originalFetch;
  assert.deepEqual(fetched, ["https://example.invalid/moving.zip"]);
  assert.ok(files.includes("/www/moodle/local/partial/version.php"));
  assert.ok(!files.some((path) => path.startsWith("/persist/")));
  assert.ok(
    scripts[0].indexOf("return;") < scripts[0].indexOf("upgrade_noncore(true)"),
  );
  // MUC warmed by boot requests without this code must be emptied on restore.
  assert.ok(
    scripts[0].indexOf("cache_helper::purge_all()") <
      scripts[0].indexOf("return;"),
  );
  assert.equal(result.success, false);
  assert.match(result.error, /unfinished/);
});

it("keeps going to login on reload when a critical restore fails", async () => {
  const ran = [];
  const result = await executeBlueprint(
    {
      steps: [
        { step: "installMoodlePlugin", critical: true, url: "x" },
        { step: "login" },
      ],
    },
    {
      php: {
        writeFile: async () => {},
        run: async () => ({ text: "" }),
        request: async () => {
          ran.push("login");
          return new Response('{"ok":true}');
        },
        readFile: async () => {
          throw new Error("artifact missing");
        },
      },
      checkpoint: { resuming: true, completed: new Set([0]), fingerprint: "f" },
    },
  );
  assert.equal(result.success, false);
  assert.deepEqual(ran, ["login"]);
});

it("warns when arbitrary PHP is skipped because volatile effects cannot be restored", async () => {
  const messages = [];
  await executeBlueprint(
    { steps: [{ step: "runPhpCode", code: "sensitive-fixture" }] },
    {
      checkpoint: { resuming: true, completed: new Set([0]) },
      publish: (message) => messages.push(message),
    },
  );
  assert.ok(
    messages.some((message) => /volatile.*not restored/i.test(message)),
  );
  assert.ok(
    messages.every((message) => !message.includes("sensitive-fixture")),
  );
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
    { step: "deleteFile", path: "/www/a", critical: undefined },
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

it("re-resolves unzip archives on reload instead of keeping a copy", async () => {
  const { strToU8, zipSync } = await import("fflate");
  const step = {
    step: "unzip",
    destination: "/www/moodle/public/fixture",
    data: { url: "https://example.invalid/archive.zip" },
  };
  // Same resource as the first boot: nothing points at a saved copy (ADR-0036).
  assert.equal(getReloadStep(step, true, "/persist/artifact"), step);
  const written = [];
  await getStepHandler("unzip")(step, {
    filesystemArtifactPath: "/persist/blueprints/runtime/f/0-files",
    resources: { resolve: async () => zipSync({ "a.txt": strToU8("a") }) },
    php: {
      writeFile: async () => assert.fail("must not save an archive copy"),
      _php: { mkdirTree() {}, writeFile: (path) => written.push(path) },
    },
  });
  assert.deepEqual(written, ["/www/moodle/public/fixture/a.txt"]);
});
