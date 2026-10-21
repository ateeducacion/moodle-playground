import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

const realFetch = globalThis.fetch;
const handler = getStepHandler("applyPrOverlay");

function createPhp({ run, files = {}, mkdirTree = true } = {}) {
  const php = {
    runCalls: [],
    writes: [],
    fs: new Map(Object.entries(files)),
    async run(code) {
      php.runCalls.push(code);
      return run ? run(code) : { text: '{"ok":true}' };
    },
    async writeFile(path, data) {
      php.writes.push(path);
      php.fs.set(path, data);
    },
    async readFile(path) {
      return php.fs.get(path);
    },
  };
  if (mkdirTree) php._php = { mkdirTree() {} };
  return php;
}

const jsonRes = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const bytesRes = (bytes, declared = bytes.byteLength) => ({
  ok: true,
  status: 200,
  headers: { get: () => (declared == null ? null : String(declared)) },
  arrayBuffer: async () => bytes.buffer,
});
const file = (path, rawUrl = `https://raw/${path}`) => ({
  path,
  status: "modified",
  rawUrl,
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("applyPrOverlay restore", () => {
  const encode = (v) => new TextEncoder().encode(JSON.stringify(v));

  it("rejects saved operations outside the volatile tree or the archive", async () => {
    for (const saved of [
      [{ operation: "delete", path: "/persist/moodledata/x" }],
      [
        {
          operation: "write",
          path: "/www/moodle/a.php",
          dataPath: "/tmp/evil",
        },
      ],
    ]) {
      const php = createPhp({ files: { "/persist/ov": encode(saved) } });
      await assert.rejects(
        handler(
          {},
          { php, restoreOnly: true, overlayArchivePath: "/persist/ov" },
        ),
        /Invalid saved overlay path/,
      );
    }
  });

  it("rejects an unknown saved operation and can skip the cache reset", async () => {
    const php = createPhp({
      files: {
        "/persist/ov": encode([{ operation: "chmod", path: "/www/moodle/a" }]),
      },
    });
    await assert.rejects(
      handler(
        {},
        { php, restoreOnly: true, overlayArchivePath: "/persist/ov" },
      ),
      /Invalid saved overlay operation/,
    );

    const empty = createPhp({ files: { "/persist/ov": encode([]) } });
    await handler(
      { purgeCaches: false },
      { php: empty, restoreOnly: true, overlayArchivePath: "/persist/ov" },
    );
    assert.equal(empty.runCalls.length, 0);
  });
});

describe("applyPrOverlay apply-time reporting", () => {
  it("reports skipped files, failed upgrades, crashes and PHP warnings", async () => {
    globalThis.fetch = async (url) =>
      url.endsWith("big.php")
        ? bytesRes(new Uint8Array(10))
        : bytesRes(new Uint8Array([1]));
    let calls = 0;
    const php = createPhp({
      run: () => {
        calls += 1;
        if (calls === 1)
          return { text: '{"ok":true}', errors: "Deprecated: x" };
        throw new Error("upgrade OOM");
      },
    });
    const published = [];
    await handler(
      {
        files: [file("lib/ok.php"), file("lib/big.php")],
        maxFileBytes: 5,
        runUpgrade: "on",
      },
      { php, publish: (m) => published.push(m) },
    );
    assert.deepEqual(php.writes, ["/www/moodle/lib/ok.php"]);
    assert.ok(
      published.some((m) =>
        /skipped lib\/big\.php .*10 bytes \(> maxFileBytes=5\)/.test(m),
      ),
    );
    assert.ok(
      published.includes("Overlay applied: 1 written, 0 removed, 1 skipped."),
    );
    assert.ok(
      published.some((m) =>
        m.startsWith("applyPrOverlay cache purge warnings: Deprecated"),
      ),
    );
    assert.ok(published.includes("Running Moodle upgrade after overlay…"));
    assert.ok(
      published.some((m) =>
        m.startsWith("applyPrOverlay upgrade crashed: upgrade OOM"),
      ),
    );
    assert.ok(
      published.some((m) =>
        m.startsWith("Moodle upgrade did not complete cleanly"),
      ),
    );
  });

  it("enforces the size cap on the received body when no length is declared", async () => {
    globalThis.fetch = async () => bytesRes(new Uint8Array(10), null);
    const published = [];
    await handler(
      {
        files: [file("a.php")],
        maxFileBytes: 4,
        runUpgrade: "off",
        purgeCaches: false,
      },
      { php: createPhp(), publish: (m) => published.push(m) },
    );
    assert.match(published[0], /a\.php is 10 bytes \(> maxFileBytes=4\)/);
  });

  it("creates parent dirs through PHP without a raw module and stays quiet without publish", async () => {
    globalThis.fetch = async () => bytesRes(new Uint8Array([1]));
    const php = createPhp({
      mkdirTree: false,
      run: () => ({ text: '{"ok":false}' }),
    });
    await handler({ files: [file("lib/x.php")], runUpgrade: "on" }, { php });
    assert.equal(
      php.runCalls[0],
      "<?php @mkdir('/www/moodle/lib', 0777, true);",
    );
    assert.deepEqual(php.writes, ["/www/moodle/lib/x.php"]);
  });
});

describe("applyPrOverlay GitHub manifests", () => {
  it("reports PR API failures and a missing head SHA", async () => {
    globalThis.fetch = async () => jsonRes({}, 403);
    await assert.rejects(
      handler({ repo: "o/r", pr: 1 }, { php: createPhp(), publish() {} }),
      /GitHub API returned HTTP 403 for o\/r#1/,
    );
    globalThis.fetch = async () => jsonRes({ head: {} });
    await assert.rejects(
      handler({ repo: "o/r", pr: 1 }, { php: createPhp() }),
      /could not resolve the head SHA for o\/r#1/,
    );
    globalThis.fetch = async (url) =>
      /files/.test(url) ? jsonRes({}, 500) : jsonRes({ head: { sha: "abc" } });
    await assert.rejects(
      handler({ repo: "o/r", pr: 1 }, { php: createPhp() }),
      /GitHub API returned HTTP 500 for o\/r#1/,
    );
  });

  it("follows PR file pagination until a short page", async () => {
    const pages = [];
    globalThis.fetch = async (url) => {
      const page = new URL(url).searchParams.get("page");
      if (!page) return jsonRes({ head: { sha: "abc" } });
      pages.push(page);
      const count = page === "1" ? 100 : 0;
      return jsonRes(
        Array.from({ length: count }, (_, i) => ({
          filename: `f${i}.php`,
          status: "removed",
        })),
      );
    };
    const php = createPhp();
    await handler(
      {
        repo: "o/r",
        pr: 2,
        runUpgrade: "off",
        purgeCaches: false,
        maxFiles: 500,
      },
      { php },
    );
    assert.deepEqual(pages, ["1", "2"]);
    assert.equal(php.runCalls.length, 100);
  });

  it("compare mode defaults the base, falls back to the raw_url SHA and reports failures", async () => {
    const fetched = [];
    globalThis.fetch = async (url) => {
      fetched.push(url);
      if (/compare/.test(url))
        return jsonRes({
          files: [
            {
              filename: "a.php",
              status: "modified",
              raw_url: "https://github.com/o/r/raw/0123abcd/a.php",
            },
          ],
        });
      return bytesRes(new Uint8Array([1]));
    };
    const published = [];
    await handler(
      { repo: "o/r", head: "feature", runUpgrade: "off", purgeCaches: false },
      { php: createPhp(), publish: (m) => published.push(m) },
    );
    assert.match(fetched[0], /compare\/main\.\.\.feature/);
    assert.equal(
      fetched[1],
      "https://raw.githubusercontent.com/o/r/0123abcd/a.php",
    );
    assert.equal(published[0], "Comparing o/r main…feature…");

    globalThis.fetch = async () =>
      jsonRes({ files: [{ filename: "a.php", status: "modified" }] });
    await assert.rejects(
      handler({ repo: "o/r", head: "h" }, { php: createPhp() }),
      /could not resolve the head SHA for o\/r main\.\.\.h/,
    );

    globalThis.fetch = async () => jsonRes({}, 404);
    await assert.rejects(
      handler({ repo: "o/r", baseRef: "dev", head: "h" }, { php: createPhp() }),
      /compare API returned HTTP 404 for o\/r dev\.\.\.h/,
    );

    globalThis.fetch = async () => jsonRes({ files: "nope" });
    const php = createPhp();
    await handler({ repo: "o/r", head: "h", runUpgrade: "off" }, { php });
    assert.equal(php.writes.length, 0);
  });
});
