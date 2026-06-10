/**
 * Tests for the static fast-path method serveStaticSync(), exposed by
 * wrapPhpInstance() in php-compat.js. The worker (php-worker.js) calls this to
 * serve non-.php MEMFS files WITHOUT waiting in the serial PHP request queue.
 *
 * Unlike the sibling php-compat.test.js (which replicates pure helpers), this
 * imports the real wrapPhpInstance and drives serveStaticSync against a mock
 * PHP instance whose readFileAsBuffer is backed by an in-memory file map.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import { wrapPhpInstance } from "../../src/runtime/php-compat.js";

const WEB_ROOT = "/www/moodle";

function makeWrapped(files) {
  const php = {
    [__private__dont__use]: {},
    readFileAsBuffer(path) {
      if (Object.hasOwn(files, path)) {
        return files[path];
      }
      throw new Error(`ENOENT: ${path}`);
    },
  };
  return wrapPhpInstance(php, {
    absoluteUrl: "http://localhost:8080/",
    webRoot: WEB_ROOT,
  });
}

describe("serveStaticSync", () => {
  it("serves an existing static file with the right MIME type and bytes", () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const w = makeWrapped({ [`${WEB_ROOT}/lib/javascript-static.js`]: bytes });
    const hit = w.serveStaticSync("/lib/javascript-static.js");
    assert.ok(hit);
    assert.equal(hit.status, 200);
    assert.equal(
      hit.headers["content-type"],
      "application/javascript; charset=utf-8",
    );
    assert.deepEqual(hit.bytes, bytes);
  });

  it("ignores the query string when resolving the file", () => {
    const bytes = new Uint8Array([1]);
    const w = makeWrapped({ [`${WEB_ROOT}/theme/photo.svg`]: bytes });
    const hit = w.serveStaticSync("/theme/photo.svg?ver=12345");
    assert.ok(hit);
    assert.equal(hit.headers["content-type"], "image/svg+xml");
  });

  it("returns null for a .php script (must stay on the queued path)", () => {
    const w = makeWrapped({
      [`${WEB_ROOT}/admin/index.php`]: new Uint8Array([1]),
    });
    assert.equal(w.serveStaticSync("/admin/index.php"), null);
  });

  it("returns null for a .php/PATH_INFO route (e.g. theme/styles.php)", () => {
    const w = makeWrapped({});
    assert.equal(w.serveStaticSync("/theme/styles.php/boost/123/all"), null);
  });

  it("returns null for a directory request (resolves to index.php)", () => {
    const w = makeWrapped({});
    assert.equal(w.serveStaticSync("/course/"), null);
  });

  it("returns null for a path traversal attempt", () => {
    const w = makeWrapped({ [`${WEB_ROOT}/secret.css`]: new Uint8Array([1]) });
    assert.equal(w.serveStaticSync("/../../etc/passwd"), null);
    assert.equal(w.serveStaticSync("/a/../b.css"), null);
  });

  it("returns null for a missing file (falls back to the queue, never 404)", () => {
    const w = makeWrapped({});
    assert.equal(w.serveStaticSync("/lib/does-not-exist.js"), null);
  });

  it("falls back to octet-stream for an unknown extension", () => {
    const bytes = new Uint8Array([7]);
    const w = makeWrapped({ [`${WEB_ROOT}/files/blob.bin`]: bytes });
    const hit = w.serveStaticSync("/files/blob.bin");
    assert.ok(hit);
    assert.equal(hit.headers["content-type"], "application/octet-stream");
  });
});
