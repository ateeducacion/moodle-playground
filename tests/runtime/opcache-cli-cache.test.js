/**
 * CLI php.run() compiles every include it touches into the OPcache file cache.
 * Those files were compiled with CLI_SCRIPT defined, and the web request must
 * not execute that bytecode. Discard happens on the next request(), once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import { wrapPhpInstance } from "../../src/runtime/php-compat.js";

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const CACHE = "/internal/shared/opcache";
const BIN = `${CACHE}/ab/setup.php.bin`;

function makeFs(paths) {
  const nodes = new Map(
    paths.map((path) => [path, { dir: path.endsWith("/") }]),
  );
  const FS = {
    readdir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      if (
        ![...nodes.keys()].some((key) => key === path || key.startsWith(prefix))
      ) {
        throw new Error(`ENOENT ${path}`);
      }
      const names = new Set();
      for (const key of nodes.keys()) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      return [".", "..", ...names];
    },
    stat(path) {
      const node = nodes.get(path) || nodes.get(`${path}/`);
      if (!node) throw new Error(`ENOENT ${path}`);
      return { mode: node.dir ? S_IFDIR : S_IFREG };
    },
    isDir(mode) {
      return (mode & S_IFDIR) === S_IFDIR;
    },
    unlink(path) {
      nodes.delete(path);
    },
    rmdir(path) {
      nodes.delete(`${path}/`);
      nodes.delete(path);
    },
  };
  return { FS, nodes };
}

function webResponse() {
  return {
    httpStatusCode: 200,
    headers: { "content-type": ["text/html"] },
    bytes: new TextEncoder().encode("ok"),
    exitCode: 0,
    errors: "",
  };
}

describe("OPcache file cache after CLI run", () => {
  it("drops CLI bytecode on the next web request and keeps later requests", async () => {
    const { FS, nodes } = makeFs([`${CACHE}/`, `${CACHE}/ab/`, BIN]);
    const events = [];
    const php = {
      [__private__dont__use]: { FS },
      fileExists: (path) => path === "/www/moodle/index.php",
      run: async (arg) => {
        if (arg?.code) {
          events.push("cli");
          return { text: "ok" };
        }
        events.push(`web:${nodes.has(BIN)}`);
        return webResponse();
      },
    };
    const wrapped = wrapPhpInstance(php, {
      absoluteUrl: "http://localhost:8080/",
      webRoot: "/www/moodle",
    });

    await wrapped.run("<?php define('CLI_SCRIPT', true);");
    assert.equal(nodes.has(BIN), true, "CLI steps still share the cache");

    const response = await wrapped.request("/index.php");
    assert.equal(response.status, 200);
    assert.equal(nodes.has(BIN), false);
    assert.equal(nodes.has(`${CACHE}/`), true, "the cache root stays");
    assert.deepEqual(events, ["cli", "web:false"]);

    nodes.set(BIN, { dir: false });
    await wrapped.request("/index.php");
    assert.equal(nodes.has(BIN), true, "a web request does not discard again");
  });

  it("still discards when the CLI snippet itself exits non-zero", async () => {
    const { FS, nodes } = makeFs([`${CACHE}/`, `${CACHE}/ab/`, BIN]);
    const php = {
      [__private__dont__use]: { FS },
      fileExists: () => true,
      run: async (arg) => {
        if (arg?.code) throw new Error("PHP.run() failed with exit code 1.");
        assert.equal(nodes.has(BIN), false);
        return webResponse();
      },
    };
    const wrapped = wrapPhpInstance(php, {
      absoluteUrl: "http://localhost:8080/",
      webRoot: "/www/moodle",
    });
    await assert.rejects(() => wrapped.run("<?php exit(1);"));
    const response = await wrapped.request("/index.php");
    assert.equal(response.status, 200);
  });
});
