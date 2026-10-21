import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { checkPhpResult } from "../../src/blueprint/steps/check-result.js";
import { getStepHandler } from "../../src/blueprint/steps/index.js";
import {
  isResourceDescriptor,
  resolveJsonPayload,
  resolveXmlItem,
  toEntryArray,
} from "../../src/blueprint/steps/payload.js";
import {
  clearBlueprint,
  loadBlueprint,
  saveBlueprint,
} from "../../src/blueprint/storage.js";

const decoder = new TextDecoder();

// Records every php call; run/request results are configurable per test.
function createPhp({
  run = () => ({ text: '{"ok":true}', errors: "" }),
  request = () => new Response('{"ok":true}', { status: 200 }),
  files = {},
} = {}) {
  const calls = { run: [], writeFile: [], request: [], mkdirTree: [] };
  const fs = new Map(Object.entries(files));
  const php = {
    calls,
    fs,
    run: async (code) => {
      calls.run.push(code);
      return run(code);
    },
    writeFile: async (path, data) => {
      calls.writeFile.push(path);
      fs.set(path, data);
    },
    readFile: async (path) => {
      if (!fs.has(path)) throw new Error(`ENOENT ${path}`);
      return fs.get(path);
    },
    request: async (req) => {
      calls.request.push(req);
      return request(req);
    },
    _php: {
      mkdirTree: (dir) => calls.mkdirTree.push(dir),
      writeFile: (path, data) => fs.set(path, data),
    },
  };
  return php;
}

const resources = (map = {}) => ({
  resolve: async (ref) => map[typeof ref === "string" ? ref : ref.literal],
  resolveText: async (ref) =>
    map[typeof ref === "string" ? ref : (ref.url ?? ref.literal)],
});

const step = (name) => getStepHandler(name);

describe("checkPhpResult", () => {
  it("throws on an ok:false payload and tolerates warnings", () => {
    assert.throws(
      () => checkPhpResult({ text: '{"ok":false,"error":"x"}' }, "demo"),
      /demo: PHP returned failure: \{"ok":false/,
    );
    checkPhpResult({ text: '{"ok":true}', errors: "Notice" }, "demo");
    checkPhpResult(undefined, "demo");
  });
});

describe("Moodle data steps", () => {
  const cases = [
    ["createCourse", { fullname: "F", shortname: "S" }, {}, /'fullname' and/],
    ["createCourses", { courses: [{ fullname: "F" }] }, {}, /must be an array/],
    ["createSection", { course: "S", name: "Week" }, {}, /'course' is/],
    ["createSections", { sections: [{ course: "S" }] }, {}, /must be an array/],
    ["enrolUser", { username: "u", course: "S" }, {}, /'username' and/],
    ["enrolUsers", { enrolments: [] }, {}, /must be an array/],
    ["createCategory", { name: "Cat" }, {}, /'name' is required/],
    ["createCategories", { categories: [] }, {}, /must be an array/],
    ["createUser", { username: "u" }, {}, /'username' is required/],
    ["createUsers", { users: [] }, {}, /must be an array/],
  ];

  for (const [name, valid, invalid, error] of cases) {
    it(`${name} validates input, runs PHP and surfaces PHP failures`, async () => {
      await assert.rejects(step(name)(invalid, { php: createPhp() }), error);

      const php = createPhp();
      await step(name)(valid, { php });
      assert.equal(php.calls.run.length, 1);
      assert.match(php.calls.run[0], /^<\?php/);

      const failing = createPhp({ run: () => ({ text: '{"ok":false}' }) });
      await assert.rejects(
        step(name)(valid, { php: failing }),
        new RegExp(`${name}: PHP returned failure`),
      );
    });
  }

  it("setConfig/setConfigs/setTheme run escaped PHP and validate input", async () => {
    const php = createPhp();
    await step("setConfig")({ name: "o'k", value: 1, plugin: "p" }, { php });
    await step("setConfig")({ name: "plain" }, { php });
    await step("setConfigs")({ configs: [{ name: "a", value: "b" }] }, { php });
    await step("setTheme")({ name: "boost" }, { php });
    assert.equal(php.calls.run.length, 4);
    assert.match(php.calls.run[0], /o\\'k/);
    assert.match(php.calls.run[3], /boost/);

    await assert.rejects(step("setConfig")({}, { php }), /'name' is required/);
    await assert.rejects(step("setConfigs")({}, { php }), /must be an array/);
    await assert.rejects(step("setTheme")({}, { php }), /'name' is required/);
    await assert.rejects(step("setLandingPage")({}, {}), /'path' is required/);
    assert.deepEqual(await step("setLandingPage")({ path: "/course/" }, {}), {
      landingPage: "/course/",
    });
  });
});

describe("install steps", () => {
  it("installMoodle is a no-op marker and setAdminAccount runs PHP", async () => {
    const php = createPhp({ run: () => ({ text: "", errors: "warn" }) });
    await step("installMoodle")({}, { php });
    assert.equal(php.calls.run.length, 0);
    await step("setAdminAccount")(
      { username: "root", password: "pw" },
      { php },
    );
    assert.equal(php.calls.run.length, 1);
    assert.match(php.calls.run[0], /hash_internal_user_password\('pw'\)/);
  });

  it("login writes a script under webRoot, requests it and always unlinks it", async () => {
    const php = createPhp();
    await step("login")({ username: "teacher" }, { php, webRoot: "/www/x" });
    assert.deepEqual(php.calls.writeFile, ["/www/x/__blueprint_login.php"]);
    assert.match(
      decoder.decode(php.fs.get("/www/x/__blueprint_login.php")),
      /teacher/,
    );
    assert.equal(
      new URL(php.calls.request[0].url).pathname,
      "/__blueprint_login.php",
    );
    assert.match(
      php.calls.run.at(-1),
      /@unlink\('\/www\/x\/__blueprint_login\.php'\)/,
    );

    const denied = createPhp({
      request: () => new Response("nope", { status: 403 }),
      run: () => {
        throw new Error("unlink failed is non-fatal");
      },
    });
    await assert.rejects(
      step("login")({}, { php: denied }),
      /Login failed for user 'admin': status=403/,
    );
    assert.deepEqual(denied.calls.writeFile, [
      "/www/moodle/__blueprint_login.php",
    ]);
  });
});

describe("request steps", () => {
  it("request sends method, headers and body (except for GET) and checks status", async () => {
    const php = createPhp();
    await step("request")(
      {
        url: "http://localhost/x",
        method: "POST",
        body: "a=1",
        headers: { "x-t": "1" },
      },
      { php },
    );
    const req = php.calls.request[0];
    assert.equal(req.method, "POST");
    assert.equal(req.headers.get("x-t"), "1");
    assert.equal(await req.text(), "a=1");

    await step("request")({ body: "ignored" }, { php });
    assert.equal(php.calls.request[1].url, "http://localhost:8080/");
    assert.equal(php.calls.request[1].method, "GET");

    const failing = createPhp({
      request: () => new Response("boom", { status: 500 }),
    });
    await assert.rejects(
      step("request")({}, { php: failing }),
      /status 500: boom/,
    );
    await step("request")({ expectOk: false }, { php: failing });
  });

  it("runPhpCode prefixes the open tag only when missing", async () => {
    const php = createPhp({ run: () => ({ errors: "warn" }) });
    await step("runPhpCode")({ code: "echo 1;" }, { php });
    await step("runPhpCode")({ code: "<?php echo 2;" }, { php });
    assert.deepEqual(php.calls.run, ["<?php\necho 1;", "<?php echo 2;"]);
    await assert.rejects(step("runPhpCode")({}, { php }), /'code' is required/);
  });

  it("runPhpScript serves the code over HTTP and cleans up even on failure", async () => {
    const php = createPhp();
    await step("runPhpScript")({ code: "echo 1;" }, { php, webRoot: "/www/w" });
    assert.equal(
      decoder.decode(php.fs.get("/www/w/__blueprint_tmp_script.php")),
      "<?php\necho 1;",
    );
    assert.match(
      php.calls.run[0],
      /@unlink\('\/www\/w\/__blueprint_tmp_script\.php'\)/,
    );

    const failing = createPhp({
      request: () => new Response("err", { status: 502 }),
      run: () => {
        throw new Error("ignored");
      },
    });
    await assert.rejects(
      step("runPhpScript")({ code: "<?php x();" }, { php: failing }),
      /runPhpScript returned status 502: err/,
    );
    assert.ok(failing.fs.has("/www/moodle/__blueprint_tmp_script.php"));
    await step("runPhpScript")(
      { code: "x", expectOk: false },
      { php: failing },
    );
    await assert.rejects(
      step("runPhpScript")({}, { php }),
      /'code' is required/,
    );
  });
});

describe("addModule step", () => {
  it("validates module, course and file specs", async () => {
    const php = createPhp();
    await assert.rejects(
      step("addModule")({}, { php }),
      /'module' type is required/,
    );
    await assert.rejects(
      step("addModule")({ module: "label" }, { php }),
      /'course' shortname is required/,
    );
    await assert.rejects(
      step("addModule")(
        { module: "resource", course: "c", files: [{}] },
        { php },
      ),
      /files\[0\]: 'filename' is required/,
    );
    await assert.rejects(
      step("addModule")(
        { module: "resource", course: "c", files: [{ filename: "a.txt" }] },
        { php },
      ),
      /files\[0\]: 'data' is required/,
    );
  });

  it("stages resolved files in /tmp and passes them to the generated PHP", async () => {
    const php = createPhp({
      run: () => ({ text: '{"ok":true}', errors: "deprecated" }),
    });
    const published = [];
    await step("addModule")(
      {
        module: "resource",
        course: "c1",
        name: "Doc",
        files: [{ filename: "a.txt", data: "@doc" }],
      },
      {
        php,
        publish: (msg) => published.push(msg),
        resources: resources({ "@doc": new Uint8Array([1]) }),
      },
    );
    const tmp = php.calls.writeFile[0];
    assert.match(tmp, /^\/tmp\/blueprint-modfile-0-\d+\.bin$/);
    assert.ok(php.calls.run[0].includes(tmp));
    assert.ok(php.calls.run[0].includes("a.txt"));
    assert.match(published[0], /addModule resource PHP errors: deprecated/);
  });

  it("treats a non-zero exit with ok:true stdout as success and reports other failures", async () => {
    const okStdout = createPhp({
      run: () => {
        throw new Error(
          'exit 255\n=== Stdout ===\n{"ok":true}\n=== Stderr ===\n',
        );
      },
    });
    await step("addModule")(
      { module: "label", course: "c" },
      { php: okStdout },
    );

    const published = [];
    const crashed = createPhp({
      run: () => {
        throw new Error("fatal");
      },
    });
    await assert.rejects(
      step("addModule")(
        { module: "label", course: "c" },
        { php: crashed, publish: (m) => published.push(m) },
      ),
      /addModule label failed: fatal/,
    );
    assert.equal(published.length, 1);
    await assert.rejects(
      step("addModule")({ module: "label", course: "c" }, { php: crashed }),
      /failed: fatal/,
    );

    const reported = createPhp({
      run: () => ({ text: '{"ok":false,"error":"no course"}' }),
    });
    await assert.rejects(
      step("addModule")(
        { module: "page", course: "c" },
        { php: reported, publish: () => {} },
      ),
      /addModule page failed: \{"ok":false/,
    );
    await assert.rejects(
      step("addModule")({ module: "page", course: "c" }, { php: reported }),
      /addModule page failed/,
    );
  });
});

describe("filesystem steps", () => {
  it("mkdir creates each path segment and ignores existing ones", async () => {
    let calls = 0;
    const php = createPhp({
      run: () => {
        calls += 1;
        if (calls === 1) throw new Error("exists");
        return {};
      },
    });
    await step("mkdir")({ path: "/a/b'c" }, { php });
    assert.deepEqual(php.calls.run, [
      "<?php @mkdir('/a', 0777);",
      "<?php @mkdir('/a/b\\'c', 0777);",
    ]);
    await assert.rejects(step("mkdir")({}, { php }), /'path' is required/);
  });

  it("rmdir passes the recursive flag and escaped path", async () => {
    const php = createPhp();
    await step("rmdir")({ path: "/x", recursive: true }, { php });
    await step("rmdir")({ path: "/y" }, { php });
    assert.match(php.calls.run[0], /rrmdir\('\/x', true\);/);
    assert.match(php.calls.run[1], /rrmdir\('\/y', false\);/);
    await assert.rejects(step("rmdir")({}, { php }), /'path' is required/);
  });

  it("writeFile accepts strings, @references and descriptors, rejects anything else", async () => {
    const php = createPhp();
    const res = resources({
      "@a": new Uint8Array([7]),
      lit: new Uint8Array([8]),
    });
    await step("writeFile")(
      { path: "/p1", data: "text" },
      { php, resources: res },
    );
    await step("writeFile")(
      { path: "/p2", data: "@a" },
      { php, resources: res },
    );
    await step("writeFile")(
      { path: "/p3", data: { literal: "lit" } },
      { php, resources: res },
    );
    assert.equal(decoder.decode(php.fs.get("/p1")), "text");
    assert.deepEqual([...php.fs.get("/p2")], [7]);
    assert.deepEqual([...php.fs.get("/p3")], [8]);
    await assert.rejects(step("writeFile")({}, { php }), /'path' is required/);
    await assert.rejects(
      step("writeFile")({ path: "/p", data: [1] }, { php }),
      /'data' is required/,
    );
    await assert.rejects(step("writeFiles")({}, { php }), /must be an array/);
  });

  it("writeFiles preserves volatile outputs as indexed artifacts", async () => {
    const php = createPhp();
    await step("writeFiles")(
      {
        files: [
          { path: "/www/moodle/x.php", data: "a" },
          { path: "/persist/moodledata/y", data: "b" },
        ],
      },
      { php, filesystemArtifactPath: "/persist/art/step" },
    );
    assert.ok(php.fs.has("/persist/art/step-0.bin"), "core path is volatile");
    assert.ok(!php.fs.has("/persist/art/step-1.bin"), "persisted path is not");
    assert.deepEqual(php.calls.mkdirTree, ["/persist/art"]);
  });

  it("copyFile and moveFile copy bytes and moveFile unlinks the source", async () => {
    const php = createPhp({ files: { "/src": new Uint8Array([1]) } });
    await step("copyFile")({ from: "/src", to: "/dst" }, { php });
    assert.deepEqual([...php.fs.get("/dst")], [1]);
    await step("moveFile")({ from: "/src", to: "/moved" }, { php });
    assert.deepEqual([...php.fs.get("/moved")], [1]);
    assert.match(php.calls.run[0], /@unlink\('\/src'\)/);
    await assert.rejects(
      step("copyFile")({ from: "/a" }, { php }),
      /'from' and 'to'/,
    );
    await assert.rejects(
      step("moveFile")({ to: "/a" }, { php }),
      /'from' and 'to'/,
    );
  });

  it("moveFile on restore reads the saved artifact and keeps a persisted source", async () => {
    const php = createPhp({
      files: { "/persist/a/s-0.bin": new Uint8Array([9]) },
    });
    await step("moveFile")(
      { from: "/persist/moodledata/f", to: "/persist/moodledata/g" },
      { php, restoreOnly: true, filesystemArtifactPath: "/persist/a/s" },
    );
    assert.deepEqual([...php.fs.get("/persist/moodledata/g")], [9]);
    assert.equal(php.calls.run.length, 0);
  });

  it("deleteFile(s) accept strings and objects and surface unlink failures", async () => {
    const php = createPhp();
    await step("deleteFiles")({ files: ["/a", { path: "/b" }] }, { php });
    assert.match(php.calls.run[0], /\$p = '\/a';/);
    assert.match(php.calls.run[1], /\$p = '\/b';/);
    const failing = createPhp({ run: () => ({ text: '{"ok":false}' }) });
    await assert.rejects(
      step("deleteFile")({ path: "/c" }, { php: failing }),
      /deleteFile: PHP/,
    );
    await assert.rejects(step("deleteFile")({}, { php }), /'path' is required/);
    await assert.rejects(step("deleteFiles")({}, { php }), /must be an array/);
  });

  it("unzip extracts every entry below the destination", async () => {
    const zip = zipSync({ "dir/a.txt": strToU8("A"), "b.txt": strToU8("B") });
    const php = createPhp();
    await step("unzip")(
      { path: "/www/out", data: "@zip" },
      { php, resources: resources({ "@zip": zip }) },
    );
    assert.equal(decoder.decode(php.fs.get("/www/out/dir/a.txt")), "A");
    assert.equal(decoder.decode(php.fs.get("/www/out/b.txt")), "B");
    assert.ok(php.calls.mkdirTree.includes("/www/out/dir"));
    await assert.rejects(step("unzip")({}, { php }), /'destination'/);
    await assert.rejects(
      step("unzip")({ destination: "/x" }, { php }),
      /'data' is required/,
    );
  });
});

describe("installLanguagePack step", () => {
  it("publishes progress, success and reported issues", async () => {
    const published = [];
    const publish = (m) => published.push(m);
    await step("installLanguagePack")(
      { language: "es" },
      { php: createPhp({ run: () => ({ text: '{"ok":true}' }) }), publish },
    );
    await step("installLanguagePack")(
      { language: "fr" },
      { php: createPhp({ run: () => ({ text: '{"ok":false}' }) }), publish },
    );
    assert.deepEqual(published, [
      "Installing language pack(s): es",
      "Language pack(s) installed: es",
      "Installing language pack(s): fr",
      'Language pack install reported issues: {"ok":false}',
    ]);
  });

  it("does not fail the blueprint when the runtime crashes", async () => {
    const crash = createPhp({
      run: () => {
        throw new Error("network down");
      },
    });
    const published = [];
    await step("installLanguagePack")(
      { language: "de" },
      { php: crash, publish: (m) => published.push(m) },
    );
    assert.match(published.at(-1), /crashed: network down/);
    await step("installLanguagePack")({ language: "de" }, { php: crash });
  });
});

describe("payload helpers", () => {
  it("recognises resource descriptors", () => {
    assert.equal(isResourceDescriptor({ url: "x" }), true);
    assert.equal(isResourceDescriptor({ scales: [] }), false);
    assert.equal(isResourceDescriptor([]), false);
    assert.equal(isResourceDescriptor(null), false);
  });

  it("resolves inline, raw, referenced and descriptor JSON", async () => {
    const res = resources({ "@j": "[1]", "https://x/j": '{"a":1}' });
    assert.deepEqual(await resolveJsonPayload("[2]", res, "s"), [2]);
    assert.deepEqual(await resolveJsonPayload("@j", res, "s"), [1]);
    assert.deepEqual(await resolveJsonPayload([3], res, "s"), [3]);
    assert.deepEqual(
      await resolveJsonPayload({ url: "https://x/j" }, res, "s"),
      { a: 1 },
    );
    assert.deepEqual(await resolveJsonPayload({ b: 2 }, res, "s"), { b: 2 });
    await assert.rejects(
      resolveJsonPayload(null, res, "s"),
      /s: missing or invalid payload/,
    );
    await assert.rejects(
      resolveJsonPayload("@j", undefined, "s"),
      /no ResourceRegistry is available/,
    );
  });

  it("normalises envelopes to entry arrays", () => {
    assert.deepEqual(toEntryArray([1], "k"), [1]);
    assert.deepEqual(toEntryArray({ k: [2] }, "k"), [2]);
    assert.deepEqual(toEntryArray({ other: [] }, "k"), []);
    assert.deepEqual(toEntryArray(null, "k"), []);
  });

  it("resolves XML items from every supported shape", async () => {
    const res = resources({
      "@r": "<r/>",
      "https://x/r": "<u/>",
      "@n": "<n/>",
    });
    assert.equal(await resolveXmlItem("@r", res, "s"), "<r/>");
    assert.equal(await resolveXmlItem("<raw/>", res, "s"), "<raw/>");
    assert.equal(await resolveXmlItem({ xml: "<i/>" }, res, "s"), "<i/>");
    assert.equal(await resolveXmlItem({ resource: "@n" }, res, "s"), "<n/>");
    assert.equal(
      await resolveXmlItem({ url: "https://x/r" }, res, "s"),
      "<u/>",
    );
    await assert.rejects(
      resolveXmlItem({}, res, "s"),
      /invalid role preset reference/,
    );
    await assert.rejects(
      resolveXmlItem(5, res, "s"),
      /invalid role preset reference/,
    );
  });
});

describe("blueprint session storage", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.window = {
      sessionStorage: {
        setItem: (k, v) => store.set(k, v),
        getItem: (k) => store.get(k) ?? null,
        removeItem: (k) => store.delete(k),
      },
    };
  });
  afterEach(() => {
    delete globalThis.window;
  });

  it("round-trips a blueprint per scope and clears it", () => {
    saveBlueprint("s1", { steps: [] });
    assert.deepEqual([...store.keys()], ["moodle-playground:blueprint:s1"]);
    assert.deepEqual(loadBlueprint("s1"), { steps: [] });
    assert.equal(loadBlueprint("s2"), null);
    clearBlueprint("s1");
    assert.equal(loadBlueprint("s1"), null);
  });

  it("is a no-op outside the browser", () => {
    delete globalThis.window;
    saveBlueprint("s", {});
    clearBlueprint("s");
    assert.equal(loadBlueprint("s"), null);
  });
});
