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

  it("downloads inside PHP (streamed to a file) for a url source", async () => {
    const { php, runCalls } = createPhpMock();
    await handler(
      {
        url: "https://raw.githubusercontent.com/owner/repo/main/course.mbz",
        category: "PRUEBAS",
      },
      { php },
    );
    assert.strictEqual(runCalls.length, 1);
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
    // Exception-handler guard (exit(0), not exit(1)).
    assert.ok(code.includes("set_exception_handler"));
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
    await handler({ url: "https://h/x.mbz", category: "PRUEBAS" }, { php });
    const withCat = runCalls[0];
    assert.ok(withCat.includes("$categoryname = 'PRUEBAS';"));
    assert.ok(withCat.includes("core_course_category::create"));

    const mock2 = createPhpMock();
    await handler({ url: "https://h/x.mbz" }, { php: mock2.php });
    assert.ok(mock2.runCalls[0].includes("$categoryname = null;"));
    assert.ok(mock2.runCalls[0].includes("$categoryid = 1;"));
  });

  it("requires an existing category when createCategory is false", async () => {
    const { php, runCalls } = createPhpMock();
    await handler(
      { url: "https://h/x.mbz", category: "PRUEBAS", createCategory: false },
      { php },
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
      { php },
    );
    const code = runCalls[0];
    // The single quote must be backslash-escaped, never closing the literal.
    assert.ok(code.includes("x\\'); system(\\'id\\'); //"));
    assert.ok(code.includes("'a\\'b'"));
  });

  it("sets visibility to 0 when visible is false", async () => {
    const { php, runCalls } = createPhpMock();
    await handler({ url: "https://h/x.mbz", visible: false }, { php });
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
    await handler({ url: "https://h/x.mbz" }, { php });
    assert.strictEqual(runCalls.length, 1);
  });
});
