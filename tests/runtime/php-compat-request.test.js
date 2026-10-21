/**
 * Drives wrapPhpInstance().request() and its FS helpers against a fake
 * @php-wasm PHP instance, asserting the CGI environment handed to php.run(),
 * cookie-jar behaviour, static serving and non-zero-exit pass-through.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __private__dont__use } from "@php-wasm/universal";
import {
  discardOpcacheFileCache,
  wrapPhpInstance,
} from "../../src/runtime/php-compat.js";

const encode = (s) => new TextEncoder().encode(s);

function makePhp({ files = {}, dirs = [], run, FS = {} } = {}) {
  const calls = [];
  const listeners = [];
  const php = {
    [__private__dont__use]: Promise.resolve({ FS }),
    calls,
    listeners,
    fileExists: (path) => path in files || dirs.includes(path),
    isDir: (path) => dirs.includes(path),
    readFileAsBuffer(path) {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
    mkdir: (path) => dirs.push(path),
    writeFile: (path, data) => {
      files[path] = data;
    },
    addEventListener: (type, handler) => listeners.push(["add", type, handler]),
    removeEventListener: (type, handler) =>
      listeners.push(["remove", type, handler]),
    async run(request) {
      calls.push(request);
      return run
        ? run(request)
        : { httpStatusCode: 200, headers: {}, bytes: encode("ok") };
    },
  };
  return php;
}

describe("wrapPhpInstance request()", () => {
  it("builds a CGI environment that keeps the deploy subpath and decodes PATH_INFO", async () => {
    const php = makePhp({
      files: { "/www/moodle/pluginfile.php": encode("") },
    });
    const wrapped = wrapPhpInstance(php, {
      absoluteUrl: "https://example.test/moodle-playground/",
    });
    const response = await wrapped.request(
      new Request(
        "https://example.test/pluginfile.php/5/user/My%20File.pdf?forcedownload=1",
        { headers: { "X-Custom-Thing": "yes", Accept: "text/html" } },
      ),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    const [call] = php.calls;
    assert.equal(call.scriptPath, "/www/moodle/pluginfile.php");
    assert.equal(call.method, "GET");
    assert.equal(call.body, undefined);
    const env = call.$_SERVER;
    assert.equal(env.SCRIPT_NAME, "/moodle-playground/pluginfile.php");
    assert.equal(env.PHP_SELF, "/moodle-playground/pluginfile.php");
    assert.equal(
      env.REQUEST_URI,
      "/moodle-playground/pluginfile.php/5/user/My%20File.pdf?forcedownload=1",
    );
    assert.equal(env.PATH_INFO, "/5/user/My File.pdf");
    assert.equal(env.QUERY_STRING, "forcedownload=1");
    assert.equal(env.SERVER_PORT, "443");
    assert.equal(env.HTTPS, "on");
    assert.equal(env.HTTP_HOST, "example.test");
    assert.equal(env.HTTP_X_CUSTOM_THING, "yes");
    assert.equal(env.HTTP_ACCEPT, "text/html");
  });

  it("keeps a malformed PATH_INFO escape as-is", async () => {
    const php = makePhp({ files: { "/www/moodle/file.php": encode("") } });
    await wrapPhpInstance(php).request(
      new Request("http://localhost:8080/file.php/1/bad%E0%A4%A"),
    );
    assert.equal(php.calls[0].$_SERVER.PATH_INFO, "/1/bad%E0%A4%A");
  });

  it("maps content headers to CONTENT_* and forwards a POST body", async () => {
    const php = makePhp({
      files: { "/www/moodle/login/index.php": encode("") },
    });
    const wrapped = wrapPhpInstance(php, {
      absoluteUrl: "http://localhost:8081",
    });
    await wrapped.request(
      new Request("http://localhost:8081/login/index.php", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "username=admin",
      }),
    );
    const [call] = php.calls;
    assert.equal(call.method, "POST");
    assert.equal(new TextDecoder().decode(call.body), "username=admin");
    assert.equal(
      call.$_SERVER.CONTENT_TYPE,
      "application/x-www-form-urlencoded",
    );
    assert.equal(call.$_SERVER.CONTENT_LENGTH, "14");
    assert.equal(call.$_SERVER.SERVER_PORT, "8081");
    assert.equal(call.$_SERVER.HTTPS, "");
    assert.equal(call.$_SERVER.SCRIPT_NAME, "/login/index.php");
  });

  it("warns about an empty POST body but still runs the script", async () => {
    const php = makePhp({ files: { "/www/moodle/a.php": encode("") } });
    const wrapped = wrapPhpInstance(php);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      await wrapped.request(
        new Request("http://localhost:8080/a.php", { method: "POST" }),
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(php.calls[0].$_SERVER.CONTENT_LENGTH, "0");
    assert.match(warnings[0], /POST \/a\.php has empty body/);
  });

  it("treats an unreadable (already consumed) body as empty", async () => {
    const php = makePhp({ files: { "/www/moodle/a.php": encode("") } });
    const request = new Request("http://localhost:8080/a.php", {
      method: "PUT",
      body: "x",
    });
    await request.text();
    await wrapPhpInstance(php).request(request);
    assert.equal(php.calls[0].body.byteLength, 0);
    assert.equal(php.calls[0].method, "PUT");
  });

  it("accepts a pre-normalized request descriptor and skips the host header", async () => {
    const php = makePhp({ files: { "/www/moodle/index.php": encode("") } });
    const wrapped = wrapPhpInstance(php);
    await wrapped.request({
      url: "/",
      headers: { host: "evil.test", "x-a": "1" },
    });
    const [call] = php.calls;
    assert.equal(call.scriptPath, "/www/moodle/index.php");
    assert.equal(call.method, "GET");
    assert.equal(call.$_SERVER.REQUEST_METHOD, "GET");
    assert.equal(call.$_SERVER.HTTP_HOST, "localhost:8080");
    assert.equal(call.$_SERVER.HTTP_X_A, "1");
    assert.equal(call.$_SERVER.SCRIPT_NAME, "/index.php");
  });

  it("serves static files from MEMFS and 404s missing files and scripts", async () => {
    const php = makePhp({
      files: { "/www/moodle/theme/x.css": encode("body{}") },
    });
    const wrapped = wrapPhpInstance(php);
    const hit = await wrapped.request(
      new Request("http://localhost:8080/theme/x.css?rev=1"),
    );
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await hit.text(), "body{}");
    const missingStatic = await wrapped.request(
      new Request("http://localhost:8080/theme/none.css"),
    );
    assert.equal(missingStatic.status, 404);
    const missingScript = await wrapped.request(
      new Request("http://localhost:8080/nope.php"),
    );
    assert.equal(missingScript.status, 404);
    assert.equal(php.calls.length, 0);
  });

  it("keeps a cookie jar: stores Set-Cookie, merges with request cookies and expires them", async () => {
    const responses = [
      { "Set-Cookie": ["MoodleSession=abc; path=/", "bad-cookie-no-equals"] },
      { "set-cookie": ["MoodleSession=; path=/"] },
      { "set-cookie": ["Other=1; Max-Age=0"] },
    ];
    const php = makePhp({
      files: { "/www/moodle/index.php": encode("") },
      run: () => ({
        httpStatusCode: 200,
        headers: responses.shift() || {},
        bytes: encode(""),
      }),
    });
    const wrapped = wrapPhpInstance(php);
    await wrapped.request(new Request("http://localhost:8080/index.php"));
    await wrapped.request(
      new Request("http://localhost:8080/index.php", {
        headers: { cookie: "lang=es" },
      }),
    );
    assert.equal(
      php.calls[1].$_SERVER.HTTP_COOKIE,
      "lang=es; MoodleSession=abc",
    );
    assert.equal(php.calls[1].headers.cookie, "lang=es; MoodleSession=abc");

    // MoodleSession= (empty) deleted the cookie on the second response.
    wrapped.setCookie("Other", "1");
    await wrapped.request(new Request("http://localhost:8080/index.php"));
    assert.equal(php.calls[2].$_SERVER.HTTP_COOKIE, "Other=1");
    // Max-Age=0 deleted Other; setCookie with empty value is also a delete.
    wrapped.setCookie("Gone", "x");
    wrapped.setCookie("Gone", "");
    await wrapped.request(new Request("http://localhost:8080/index.php"));
    assert.equal(php.calls[3].$_SERVER.HTTP_COOKIE, undefined);
    assert.equal(php.calls[3].headers.cookie, undefined);
  });

  it("passes through a non-zero-exit CGI response with diagnostic headers", async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    const php = makePhp({
      files: { "/www/moodle/repository/repository_ajax.php": encode("") },
      run: () => {
        const error = new Error("exit 1");
        error.name = "PHPExecutionFailureError";
        error.response = {
          httpStatusCode: 200,
          headers: { "content-type": ["application/json"] },
          bytes: encode('{"error":"x"}'),
          exitCode: 1,
          errors: "PHP Warning: boom",
        };
        throw error;
      },
    });
    try {
      const response = await wrapPhpInstance(php).request(
        new Request("http://localhost:8080/repository/repository_ajax.php"),
      );
      assert.equal(await response.text(), '{"error":"x"}');
      assert.equal(response.headers.get("x-playground-php-exit-code"), "1");
      assert.equal(
        Buffer.from(
          response.headers.get("x-playground-php-stderr"),
          "base64",
        ).toString(),
        "PHP Warning: boom",
      );
      assert.match(
        warnings[0],
        /PHP exited 1 .* passing it through\.\nstderr: PHP Warning: boom/s,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("defaults the exit code to 1 and omits stderr when the failure has none", async () => {
    const php = makePhp({
      files: { "/www/moodle/x.php": encode("") },
      run: () => {
        throw Object.assign(new Error("exit"), {
          source: "request",
          response: {
            httpStatusCode: 500,
            headers: { "content-type": ["text/plain"] },
            bytes: encode("err"),
          },
        });
      },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const response = await wrapPhpInstance(php).request(
        new Request("http://localhost:8080/x.php"),
      );
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("x-playground-php-exit-code"), "1");
      assert.equal(response.headers.get("x-playground-php-stderr"), null);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("rethrows a real crash", async () => {
    const php = makePhp({
      files: { "/www/moodle/x.php": encode("") },
      run: () => {
        throw new Error("memory access out of bounds");
      },
    });
    await assert.rejects(
      wrapPhpInstance(php).request(new Request("http://localhost:8080/x.php")),
      /memory access out of bounds/,
    );
  });

  it("chdirs to the script directory, tolerates a failing chdir and calls syncFs", async () => {
    const chdirs = [];
    let synced = 0;
    const php = makePhp({
      files: { "/www/moodle/admin/index.php": encode("") },
      FS: { chdir: (dir) => chdirs.push(dir) },
    });
    const wrapped = wrapPhpInstance(php, {
      syncFs: async () => {
        synced += 1;
      },
    });
    await wrapped.request(new Request("http://localhost:8080/admin/index.php"));
    assert.deepEqual(chdirs, ["/www/moodle/admin"]);
    assert.equal(synced, 1);

    const failing = makePhp({
      files: { "/www/moodle/admin/index.php": encode("") },
      FS: {
        chdir() {
          throw new Error("ENOENT");
        },
      },
    });
    const response = await wrapPhpInstance(failing).request(
      new Request("http://localhost:8080/admin/index.php"),
    );
    assert.equal(response.status, 200);
  });

  it("drops CLI-compiled bytecode once before the next web request", async () => {
    const removed = [];
    const FS = {
      readdir: (path) =>
        path === "/internal/shared/opcache" ? [".", "..", "f.bin"] : [],
      stat: () => ({ mode: 0o100644 }),
      isDir: () => false,
      unlink: (path) => removed.push(path),
    };
    const php = makePhp({ files: { "/www/moodle/index.php": encode("") }, FS });
    const wrapped = wrapPhpInstance(php);
    await wrapped.run("<?php echo 1;");
    assert.deepEqual(php.calls[0], { code: "<?php echo 1;" });
    await wrapped.request(new Request("http://localhost:8080/index.php"));
    await wrapped.request(new Request("http://localhost:8080/index.php"));
    assert.deepEqual(removed, ["/internal/shared/opcache/f.bin"]);
  });
});

describe("wrapPhpInstance FS helpers", () => {
  it("analyzePath reports files, folders, missing paths and FS errors", async () => {
    const php = makePhp({
      files: { "/a.txt": encode("1") },
      dirs: ["/dir"],
    });
    const wrapped = wrapPhpInstance(php);
    assert.deepEqual(await wrapped.analyzePath("/a.txt"), {
      exists: true,
      object: { isFolder: false, mode: 0o100644 },
    });
    assert.deepEqual(await wrapped.analyzePath("/dir"), {
      exists: true,
      object: { isFolder: true, mode: 0o40755 },
    });
    assert.deepEqual(await wrapped.analyzePath("/missing"), { exists: false });
    php.fileExists = () => {
      throw new Error("FS gone");
    };
    assert.deepEqual(await wrapped.analyzePath("/a.txt"), { exists: false });
  });

  it("delegates mkdir/writeFile/readFile/listeners and exposes the raw instance", async () => {
    const php = makePhp();
    const wrapped = wrapPhpInstance(php);
    await wrapped.mkdir("/new");
    await wrapped.writeFile("/new/f", encode("hi"));
    assert.deepEqual(await wrapped.readFile("/new/f"), encode("hi"));
    assert.equal(php.isDir("/new"), true);
    const handler = () => {};
    wrapped.addEventListener("request.end", handler);
    wrapped.removeEventListener("request.end", handler);
    assert.deepEqual(php.listeners, [
      ["add", "request.end", handler],
      ["remove", "request.end", handler],
    ]);
    assert.equal(wrapped._php, php);
    assert.deepEqual(await wrapped.binary, { FS: {} });
  });
});

describe("discardOpcacheFileCache", () => {
  it("ignores a missing FS or a missing cache directory", () => {
    discardOpcacheFileCache(null);
    discardOpcacheFileCache({});
    discardOpcacheFileCache({
      readdir() {
        throw new Error("ENOENT");
      },
    });
  });

  it("removes nested directories and tolerates entries that vanish mid-walk", () => {
    const tree = {
      "/internal/shared/opcache": ["sub", "gone"],
      "/internal/shared/opcache/sub": [".", "..", "a.bin", "locked.bin"],
    };
    const removed = [];
    const FS = {
      readdir: (path) => tree[path],
      stat(path) {
        if (path.endsWith("/gone")) throw new Error("ENOENT");
        return { mode: path in tree ? 0o40755 : 0o100644 };
      },
      isDir: (mode) => mode === 0o40755,
      unlink(path) {
        if (path.endsWith("locked.bin")) throw new Error("EBUSY");
        removed.push(path);
      },
      rmdir() {
        throw new Error("ENOTEMPTY");
      },
    };
    discardOpcacheFileCache(FS);
    assert.deepEqual(removed, ["/internal/shared/opcache/sub/a.bin"]);
  });
});
