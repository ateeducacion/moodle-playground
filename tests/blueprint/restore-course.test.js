import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getStepHandler } from "../../src/blueprint/steps/index.js";

function createPhpMock() {
  const runCalls = [];
  const writes = [];
  return {
    runCalls,
    writes,
    php: {
      async run(code) {
        runCalls.push(code);
        return { text: '{"ok":true,"courseid":7,"shortname":"PENSAR"}' };
      },
      async writeFile(path, data) {
        writes.push([path, data]);
      },
    },
  };
}

// A fetch that always fails, forcing the in-PHP download fallback.
const failingFetch = async () => {
  throw new Error("network down");
};

// A mock fetch returning a streaming Response built from `chunks`.
function makeMockFetch(
  chunks,
  { contentLength, ok = true, status = 200 } = {},
) {
  const total =
    contentLength ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return async () => ({
    ok,
    status,
    headers: {
      get: (h) => (h.toLowerCase() === "content-length" ? String(total) : null),
    },
    body: {
      getReader() {
        let i = 0;
        return {
          async read() {
            if (i >= chunks.length) {
              return { done: true, value: undefined };
            }
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
    async arrayBuffer() {
      const all = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      return all.buffer;
    },
  });
}

describe("restoreCourse: handler", () => {
  const handler = getStepHandler("restoreCourse");

  it("is registered", () => {
    assert.strictEqual(typeof handler, "function");
  });

  it("throws when no source is provided", async () => {
    const { php, runCalls } = createPhpMock();
    await assert.rejects(
      () => handler({ category: "PRUEBAS" }, { php }),
      /one of 'url', 'path', or 'data' is required/i,
    );
    assert.strictEqual(runCalls.length, 0);
  });

  it("rejects a non-http url before running PHP", async () => {
    const { php, runCalls } = createPhpMock();
    await assert.rejects(
      () => handler({ url: "ftp://example.com/x.mbz" }, { php }),
      /must be an http\(s\) URL/i,
    );
    assert.strictEqual(runCalls.length, 0);
  });

  it("downloads the backup browser-side and restores from a MEMFS file", async () => {
    const { php, runCalls, writes } = createPhpMock();
    const published = [];
    const chunks = [new Uint8Array(6000), new Uint8Array(6000)];
    await handler(
      {
        url: "https://raw.githubusercontent.com/owner/repo/main/course.mbz",
        category: "PRUEBAS",
      },
      {
        php,
        fetch: makeMockFetch(chunks, { contentLength: 12000 }),
        publish: (detail) => published.push(detail),
      },
    );
    // The backup is written to a MEMFS file...
    assert.strictEqual(writes.length, 1);
    const [writtenPath, data] = writes[0];
    assert.match(writtenPath, /\.mbz$/u);
    assert.strictEqual(data.length, 12000);
    // ...and restored from that local path — NOT downloaded again inside PHP.
    assert.ok(runCalls[0].includes(`$mbz = '${writtenPath}';`));
    assert.ok(!runCalls[0].includes("download_file_content("));
    // Progress is reported during the download.
    assert.ok(published.some((d) => /Downloading course backup/u.test(d)));
  });

  it("falls back to the in-PHP download when the browser fetch fails", async () => {
    const { php, runCalls, writes } = createPhpMock();
    await handler(
      { url: "https://raw.githubusercontent.com/owner/repo/main/course.mbz" },
      { php, fetch: failingFetch, publish: () => {} },
    );
    assert.strictEqual(writes.length, 0);
    const code = runCalls[0];
    // Streamed download into a MEMFS file (download_file_content with $tofile).
    assert.ok(code.includes("download_file_content("));
    assert.ok(code.includes("make_request_directory()"));
    assert.ok(
      code.includes(
        "https://raw.githubusercontent.com/owner/repo/main/course.mbz",
      ),
    );
    // Restores via Moodle's restore_controller into a new course.
    assert.ok(code.includes("new restore_controller"));
    assert.ok(code.includes("backup::TARGET_NEW_COURSE"));
    assert.ok(code.includes("raise_memory_limit(MEMORY_EXTRA)"));
    assert.ok(code.includes("set_exception_handler"));
  });

  it("falls back to the in-PHP download when the backup exceeds the browser size cap", async () => {
    const { php, runCalls, writes } = createPhpMock();
    await handler(
      { url: "https://h/big.mbz" },
      {
        php,
        fetch: makeMockFetch([new Uint8Array(16)], {
          contentLength: 200 * 1024 * 1024,
        }),
        publish: () => {},
      },
    );
    assert.strictEqual(writes.length, 0);
    assert.ok(runCalls[0].includes("download_file_content("));
  });

  it("emits restore phase sub-timings in the generated PHP", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ url: "https://h/x.mbz" }, { php, fetch: failingFetch });
    const code = runCalls[0];
    assert.ok(code.includes("'timings' => $__phase"));
    assert.ok(code.includes("$__mark('download')"));
    assert.ok(code.includes("$__mark('execute')"));
  });

  it("uses an existing MEMFS path without downloading", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ path: "/tmp/my.mbz" }, { php });
    const code = runCalls[0];
    assert.ok(code.includes("$mbz = '/tmp/my.mbz';"));
    assert.ok(!code.includes("download_file_content("));
  });

  it("resolves embedded data to a temp MEMFS file then restores from it", async () => {
    const { php, runCalls, writes } = createPhpMock();
    const resources = {
      async resolve() {
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      },
    };
    await handler({ data: "@courseBackup" }, { php, resources });
    assert.strictEqual(writes.length, 1);
    const [writtenPath] = writes[0];
    assert.match(writtenPath, /^\/tmp\/restore_\d+\.mbz$/u);
    assert.ok(runCalls[0].includes(`$mbz = '${writtenPath}';`));
    assert.ok(!runCalls[0].includes("download_file_content("));
  });

  it("auto-creates the category by default and falls back to id 1 when omitted", async () => {
    const { php, runCalls } = createPhpMock();
    await handler(
      { url: "https://h/x.mbz", category: "PRUEBAS" },
      { php, fetch: failingFetch },
    );
    const withCat = runCalls[0];
    assert.ok(withCat.includes("$categoryname = 'PRUEBAS';"));
    assert.ok(withCat.includes("core_course_category::create"));

    const mock2 = createPhpMock();
    await handler(
      { url: "https://h/x.mbz" },
      { php: mock2.php, fetch: failingFetch },
    );
    assert.ok(mock2.runCalls[0].includes("$categoryname = null;"));
    assert.ok(mock2.runCalls[0].includes("$categoryid = 1;"));
  });

  it("requires an existing category when createCategory is false", async () => {
    const { php, runCalls } = createPhpMock();
    await handler(
      { url: "https://h/x.mbz", category: "PRUEBAS", createCategory: false },
      { php, fetch: failingFetch },
    );
    assert.ok(runCalls[0].includes("fail('Target category does not exist: '"));
  });

  it("escapes a malicious shortname/category into the single-quoted literal", async () => {
    const { php, runCalls } = createPhpMock();
    await handler(
      {
        url: "https://h/x.mbz",
        shortname: "x'); system('id'); //",
        category: "a'b",
      },
      { php, fetch: failingFetch },
    );
    const code = runCalls[0];
    assert.ok(code.includes("x\\'); system(\\'id\\'); //"));
    assert.ok(code.includes("'a\\'b'"));
  });

  it("sets visibility to 0 when visible is false", async () => {
    const { php, runCalls } = createPhpMock();
    await handler(
      { url: "https://h/x.mbz", visible: false },
      { php, fetch: failingFetch },
    );
    assert.ok(runCalls[0].includes("$course->visible = 0;"));
  });

  it("does not throw when php.run crashes (graceful)", async () => {
    const runCalls = [];
    const php = {
      async run(code) {
        runCalls.push(code);
        throw new Error("memory access out of bounds");
      },
    };
    await handler({ url: "https://h/x.mbz" }, { php, fetch: failingFetch });
    assert.strictEqual(runCalls.length, 1);
  });
});
