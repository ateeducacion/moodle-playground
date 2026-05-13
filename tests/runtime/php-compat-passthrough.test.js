/**
 * Tests for the non-zero-exit pass-through helpers in php-compat.js.
 *
 * Background:
 *   When `php.run({ scriptPath, ... })` finishes with a non-zero exit code,
 *   `@php-wasm/universal` throws a `PHPExecutionFailureError` even if the
 *   PHP script already wrote a fully-formed CGI response (headers + body).
 *   This is what Moodle's AJAX error paths do — for example
 *   `repository_ajax.php` catches a `moodle_exception`, prints a JSON error
 *   payload, then exits 1.
 *
 *   Before this fix the worker mis-treated those responses as crashes and
 *   replaced them with an HTML diagnostic page, producing
 *   `SyntaxError: Unexpected token '<'` in any client expecting JSON.
 *
 *   These tests exercise the discriminator (`shouldPassThroughFailedPhpResponse`)
 *   and the error-shape detector (`isPhpExecutionFailure`) used by
 *   `wrapPhpInstance().request()` to choose between pass-through and the
 *   existing diagnostic wrapper.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __testing } from "../../src/runtime/php-compat.js";

const {
  encodeHeaderValue,
  isPhpExecutionFailure,
  phpResponseToResponse,
  shouldPassThroughFailedPhpResponse,
} = __testing;

function makePhpResponse({
  status = 200,
  headers = { "content-type": ["application/json; charset=utf-8"] },
  body = "",
  exitCode = 0,
  errors = "",
} = {}) {
  return {
    httpStatusCode: status,
    headers,
    bytes: new TextEncoder().encode(body),
    exitCode,
    errors,
  };
}

describe("shouldPassThroughFailedPhpResponse", () => {
  it("passes through a real Moodle JSON-AJAX error response (exit 1 with headers and body)", () => {
    const resp = makePhpResponse({
      status: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      body: JSON.stringify({
        error: "Omeka-S API error: Bad request",
        errorcode: "repositoryomeka_apierror",
        stacktrace: null,
        debuginfo: null,
        reproductionlink: null,
      }),
      exitCode: 1,
      errors: "",
    });
    assert.strictEqual(shouldPassThroughFailedPhpResponse(resp), true);
  });

  it("does not pass through when body is empty (true crash / segfault style)", () => {
    const resp = makePhpResponse({
      status: 200,
      headers: { "content-type": ["text/html; charset=utf-8"] },
      body: "",
      exitCode: 1,
    });
    assert.strictEqual(shouldPassThroughFailedPhpResponse(resp), false);
  });

  it("does not pass through when there are no CGI headers", () => {
    const resp = makePhpResponse({
      status: 200,
      headers: {},
      body: "anything",
      exitCode: 1,
    });
    assert.strictEqual(shouldPassThroughFailedPhpResponse(resp), false);
  });

  it("does not pass through for null/undefined responses", () => {
    assert.strictEqual(shouldPassThroughFailedPhpResponse(null), false);
    assert.strictEqual(shouldPassThroughFailedPhpResponse(undefined), false);
    assert.strictEqual(shouldPassThroughFailedPhpResponse({}), false);
  });

  it("treats a single string header value the same as a one-element array", () => {
    const resp = {
      httpStatusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      bytes: new TextEncoder().encode('{"error":"x"}'),
      exitCode: 1,
      errors: "",
    };
    assert.strictEqual(shouldPassThroughFailedPhpResponse(resp), true);
  });
});

describe("isPhpExecutionFailure", () => {
  it("recognises the named error from @php-wasm/universal", () => {
    const err = new Error("PHP.run() failed with exit code 1.");
    err.name = "PHPExecutionFailureError";
    err.response = makePhpResponse();
    err.source = "request";
    assert.strictEqual(isPhpExecutionFailure(err), true);
  });

  it("falls back to the source/response shape when name is unavailable", () => {
    const err = new Error("PHP.run() failed with exit code 1.");
    err.response = makePhpResponse();
    err.source = "request";
    assert.strictEqual(isPhpExecutionFailure(err), true);
  });

  it("ignores unrelated errors", () => {
    assert.strictEqual(isPhpExecutionFailure(new Error("boom")), false);
    assert.strictEqual(isPhpExecutionFailure(null), false);
    assert.strictEqual(isPhpExecutionFailure("string"), false);
  });
});

describe("phpResponseToResponse", () => {
  it("baseline: exit 0 → Response carries PHP headers and body untouched", async () => {
    const phpResponse = makePhpResponse({
      status: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      body: '{"ok":true}',
      exitCode: 0,
    });
    const response = phpResponseToResponse(phpResponse);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.strictEqual(await response.text(), '{"ok":true}');
    assert.strictEqual(
      response.headers.get("x-playground-php-exit-code"),
      null,
    );
  });

  it("exit 1 with headers + body → pass-through, no HTML wrapper, extra diagnostic headers attached", async () => {
    const phpResponse = makePhpResponse({
      status: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      body: '{"error":"Omeka-S API error"}',
      exitCode: 1,
      errors: "Notice: undefined index in /www/moodle/foo.php on line 9\n",
    });
    assert.strictEqual(shouldPassThroughFailedPhpResponse(phpResponse), true);

    const response = phpResponseToResponse(phpResponse, {
      "x-playground-php-exit-code": "1",
      "x-playground-php-stderr": encodeHeaderValue(phpResponse.errors),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.strictEqual(response.headers.get("x-playground-php-exit-code"), "1");
    const stderrHeader = response.headers.get("x-playground-php-stderr");
    assert.ok(stderrHeader);
    // round-trip base64 decode to make sure stderr survives the header round trip
    const decoded = Buffer.from(stderrHeader, "base64").toString("utf8");
    assert.match(decoded, /Notice: undefined index/u);
    // Body must be the original JSON, NOT an HTML diagnostic page.
    const text = await response.text();
    assert.strictEqual(text, '{"error":"Omeka-S API error"}');
    assert.doesNotMatch(text, /<!doctype html/iu);
    assert.doesNotMatch(text, /PHP\.run\(\) failed with exit code/u);
  });

  it("exit 1 with empty body → discriminator rejects pass-through (diagnostic wrapper still runs upstream)", () => {
    const phpResponse = makePhpResponse({
      status: 200,
      headers: { "content-type": ["text/html; charset=utf-8"] },
      body: "",
      exitCode: 1,
      errors: "PHP Fatal error: Uncaught Error in /www/moodle/foo.php\n",
    });
    assert.strictEqual(shouldPassThroughFailedPhpResponse(phpResponse), false);
  });
});

describe("encodeHeaderValue", () => {
  it("base64-encodes multi-line stderr so it survives HTTP header grammar", () => {
    const input =
      "Notice: undefined index in /foo.php on line 9\nWarning: something else\n";
    const encoded = encodeHeaderValue(input);
    // Header values must be ASCII and contain no CR/LF.
    assert.match(encoded, /^[A-Za-z0-9+/=]+$/u);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    assert.strictEqual(decoded, input);
  });

  it("handles non-ASCII bytes", () => {
    const input = "Errör — fühl dich frei";
    const encoded = encodeHeaderValue(input);
    assert.match(encoded, /^[A-Za-z0-9+/=]+$/u);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    assert.strictEqual(decoded, input);
  });
});
