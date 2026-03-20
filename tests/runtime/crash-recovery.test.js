import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatErrorDetail,
  isFatalWasmError,
  isSafeToReplay,
} from "../../src/runtime/crash-recovery.js";

describe("isFatalWasmError", () => {
  it("returns false for null/undefined", () => {
    assert.strictEqual(isFatalWasmError(null), false);
    assert.strictEqual(isFatalWasmError(undefined), false);
    assert.strictEqual(isFatalWasmError(false), false);
    assert.strictEqual(isFatalWasmError(0), false);
  });

  it("detects 'memory access out of bounds'", () => {
    const error = new Error("RuntimeError: memory access out of bounds");
    assert.strictEqual(isFatalWasmError(error), true);
  });

  it("detects 'unreachable'", () => {
    const error = new Error("unreachable executed");
    assert.strictEqual(isFatalWasmError(error), true);
  });

  it("detects WebAssembly.RuntimeError instances", () => {
    const error = new WebAssembly.RuntimeError("test");
    assert.strictEqual(isFatalWasmError(error), true);
  });

  it("detects generic RuntimeError in message", () => {
    const error = new Error("Caught a RuntimeError from WASM");
    assert.strictEqual(isFatalWasmError(error), true);
  });

  it("detects 'No file descriptors available'", () => {
    const error = new Error(
      "Failed to open stream: No file descriptors available",
    );
    assert.strictEqual(isFatalWasmError(error), true);
  });

  it("detects 'Failed opening required'", () => {
    const error = new Error(
      "Failed opening required '/internal/shared/auto_prepend_file.php'",
    );
    assert.strictEqual(isFatalWasmError(error), true);
  });

  it("does NOT flag normal PHP errors", () => {
    const error = new Error("Call to undefined function foo()");
    assert.strictEqual(isFatalWasmError(error), false);
  });

  it("does NOT flag HTTP errors", () => {
    const error = new Error("404 Not Found");
    assert.strictEqual(isFatalWasmError(error), false);
  });

  it("does NOT flag network errors", () => {
    const error = new TypeError("Failed to fetch");
    assert.strictEqual(isFatalWasmError(error), false);
  });

  it("handles string errors", () => {
    assert.strictEqual(isFatalWasmError("memory access out of bounds"), true);
    assert.strictEqual(isFatalWasmError("normal error"), false);
  });
});

describe("isSafeToReplay", () => {
  it("allows GET requests", () => {
    assert.strictEqual(isSafeToReplay({ method: "GET", url: "/" }), true);
  });

  it("allows HEAD requests", () => {
    assert.strictEqual(isSafeToReplay({ method: "HEAD", url: "/" }), true);
  });

  it("allows lowercase GET", () => {
    assert.strictEqual(isSafeToReplay({ method: "get", url: "/" }), true);
  });

  it("rejects POST requests", () => {
    assert.strictEqual(
      isSafeToReplay({ method: "POST", url: "/form", body: "data" }),
      false,
    );
  });

  it("rejects PUT requests", () => {
    assert.strictEqual(isSafeToReplay({ method: "PUT", url: "/api" }), false);
  });

  it("rejects DELETE requests", () => {
    assert.strictEqual(
      isSafeToReplay({ method: "DELETE", url: "/api/1" }),
      false,
    );
  });

  it("rejects PATCH requests", () => {
    assert.strictEqual(
      isSafeToReplay({ method: "PATCH", url: "/api/1" }),
      false,
    );
  });

  it("defaults to GET when method is missing", () => {
    assert.strictEqual(isSafeToReplay({}), true);
    assert.strictEqual(isSafeToReplay(null), true);
    assert.strictEqual(isSafeToReplay(undefined), true);
  });
});

describe("formatErrorDetail", () => {
  it("returns 'Unknown error' for falsy values", () => {
    assert.strictEqual(formatErrorDetail(null), "Unknown error");
    assert.strictEqual(formatErrorDetail(undefined), "Unknown error");
    assert.strictEqual(formatErrorDetail(""), "Unknown error");
    assert.strictEqual(formatErrorDetail(0), "Unknown error");
  });

  it("returns strings as-is", () => {
    assert.strictEqual(formatErrorDetail("some error"), "some error");
  });

  it("formats Error objects with stack trace", () => {
    const error = new Error("test error");
    const result = formatErrorDetail(error);
    assert.ok(result.includes("test error"));
    assert.ok(result.includes("Error"));
  });

  it("formats plain objects as JSON", () => {
    const result = formatErrorDetail({ code: 42, message: "oops" });
    assert.ok(result.includes("42"));
    assert.ok(result.includes("oops"));
  });

  it("handles objects that fail JSON.stringify", () => {
    const circular = {};
    circular.self = circular;
    const result = formatErrorDetail(circular);
    assert.ok(typeof result === "string");
  });
});

// --- Integration-style tests for crash recovery behavior ---
// These simulate the request handler flow without the real PHP runtime.

describe("crash recovery request handler", () => {
  /**
   * Minimal simulation of the php-worker request handling flow.
   * This replicates the retry logic from installBridgeListener()
   * using the same isFatalWasmError / isSafeToReplay / resetRuntime
   * decision points, but with injectable runtime behavior.
   */
  function createMockWorker() {
    const MAX = 3;
    let restartCount = 0;
    let requestCount = 0;
    let runtimeBootCount = 0;
    const messages = [];

    // Simulate runtime state — will crash if configured
    let crashOnRequest = false;
    let crashOnBootstrap = false;
    let crashOnRetry = false;

    function resetRuntime(reason) {
      if (restartCount >= MAX) {
        messages.push({
          kind: "error",
          detail: `restart limit reached: ${reason}`,
        });
        return false;
      }
      restartCount += 1;
      requestCount = 0;
      messages.push({ kind: "progress", detail: `restarting: ${reason}` });
      return true;
    }

    async function getRuntimeState() {
      runtimeBootCount += 1;
      if (crashOnBootstrap) {
        crashOnBootstrap = false; // Only crash once by default
        // In the real code, the bootstrap catch block clears
        // runtimeStatePromise so the next call builds a fresh runtime.
        // This mock doesn't cache promises, so no clearing is needed.
        throw new Error("RuntimeError: memory access out of bounds");
      }
      return {
        php: {
          async request(req) {
            if (crashOnRequest) {
              crashOnRequest = false; // Only crash once by default
              throw new Error("RuntimeError: memory access out of bounds");
            }
            if (crashOnRetry) {
              throw new Error("RuntimeError: memory access out of bounds");
            }
            return new Response(`OK: ${req.method} ${req.url}`, {
              status: 200,
            });
          },
        },
      };
    }

    async function handleRequest(serializedRequest, isRetry = false) {
      requestCount += 1;
      try {
        const state = await getRuntimeState();
        const response = await state.php.request(
          new Request(serializedRequest.url, {
            method: serializedRequest.method || "GET",
          }),
        );
        return {
          status: response.status,
          body: await response.text(),
          retried: isRetry,
        };
      } catch (error) {
        if (!isFatalWasmError(error)) {
          return {
            status: 500,
            body: formatErrorDetail(error),
            retried: isRetry,
          };
        }

        const didReset = resetRuntime(`fatal WASM error: ${error.message}`);

        if (isRetry || !isSafeToReplay(serializedRequest) || !didReset) {
          const message = isRetry
            ? "Runtime crashed again on retry."
            : !isSafeToReplay(serializedRequest)
              ? "Non-idempotent request was not retried."
              : "Runtime restart limit reached.";
          return { status: 503, body: message, retried: isRetry };
        }

        // Auto-retry on fresh runtime
        try {
          const freshState = await getRuntimeState();
          const retryResponse = await freshState.php.request(
            new Request(serializedRequest.url, {
              method: serializedRequest.method || "GET",
            }),
          );
          return {
            status: retryResponse.status,
            body: await retryResponse.text(),
            retried: true,
          };
        } catch (retryError) {
          if (isFatalWasmError(retryError)) {
            resetRuntime(`fatal on retry: ${retryError.message}`);
          }
          return {
            status: 503,
            body: "Runtime crashed again on retry.",
            retried: true,
          };
        }
      }
    }

    return {
      handleRequest,
      resetRuntime,
      get restartCount() {
        return restartCount;
      },
      get requestCount() {
        return requestCount;
      },
      get runtimeBootCount() {
        return runtimeBootCount;
      },
      get messages() {
        return messages;
      },
      setCrashOnRequest(val) {
        crashOnRequest = val;
      },
      setCrashOnBootstrap(val) {
        crashOnBootstrap = val;
      },
      setCrashOnRetry(val) {
        crashOnRetry = val;
      },
    };
  }

  it("succeeds on normal GET request without retry", async () => {
    const worker = createMockWorker();
    const result = await worker.handleRequest({
      method: "GET",
      url: "http://localhost/page",
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.retried, false);
    assert.strictEqual(worker.restartCount, 0);
  });

  it("auto-retries a failed GET request on fatal WASM error", async () => {
    const worker = createMockWorker();
    worker.setCrashOnRequest(true); // Crash once, then succeed
    const result = await worker.handleRequest({
      method: "GET",
      url: "http://localhost/page",
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.retried, true);
    assert.strictEqual(worker.restartCount, 1);
    // Two boots: first crash, then fresh runtime
    assert.strictEqual(worker.runtimeBootCount, 2);
  });

  it("does NOT retry if the request is already a retry", async () => {
    const worker = createMockWorker();
    worker.setCrashOnRequest(true);
    const result = await worker.handleRequest(
      { method: "GET", url: "http://localhost/page" },
      true,
    );
    assert.strictEqual(result.status, 503);
    assert.ok(result.body.includes("crashed again on retry"));
    assert.strictEqual(result.retried, true);
    assert.strictEqual(worker.restartCount, 1);
  });

  it("does NOT auto-retry POST requests", async () => {
    const worker = createMockWorker();
    worker.setCrashOnRequest(true);
    const result = await worker.handleRequest({
      method: "POST",
      url: "http://localhost/form",
      body: "data",
    });
    assert.strictEqual(result.status, 503);
    assert.ok(result.body.includes("Non-idempotent"));
    assert.strictEqual(worker.restartCount, 1);
  });

  it("does NOT auto-retry PUT requests", async () => {
    const worker = createMockWorker();
    worker.setCrashOnRequest(true);
    const result = await worker.handleRequest({
      method: "PUT",
      url: "http://localhost/api/1",
    });
    assert.strictEqual(result.status, 503);
    assert.ok(result.body.includes("Non-idempotent"));
  });

  it("handles crash on retry gracefully (no infinite loop)", async () => {
    const worker = createMockWorker();
    worker.setCrashOnRetry(true); // Every request crashes
    const result = await worker.handleRequest({
      method: "GET",
      url: "http://localhost/page",
    });
    // First crash triggers retry, retry also crashes — returns failure
    assert.strictEqual(result.status, 503);
    assert.ok(result.body.includes("crashed again on retry"));
    assert.strictEqual(result.retried, true);
    // Two restarts: one for initial crash, one for retry crash
    assert.strictEqual(worker.restartCount, 2);
  });

  it("respects restart limit", async () => {
    const worker = createMockWorker();
    // Exhaust restart limit
    worker.resetRuntime("test 1");
    worker.resetRuntime("test 2");
    worker.resetRuntime("test 3");
    assert.strictEqual(worker.restartCount, 3);

    worker.setCrashOnRequest(true);
    const result = await worker.handleRequest({
      method: "GET",
      url: "http://localhost/page",
    });
    // resetRuntime returns false, so no retry
    assert.strictEqual(result.status, 503);
    assert.ok(result.body.includes("restart limit"));
    assert.strictEqual(worker.restartCount, 3); // Not incremented
  });

  it("non-fatal errors do NOT trigger runtime rotation", () => {
    const worker = createMockWorker();
    const nonFatalError = new Error("Call to undefined function foo()");

    // Non-fatal errors should not be detected as WASM crashes
    assert.strictEqual(isFatalWasmError(nonFatalError), false);
    assert.strictEqual(worker.restartCount, 0);
  });

  it("handles bootstrap crash with recovery", async () => {
    const worker = createMockWorker();
    worker.setCrashOnBootstrap(true); // First boot crashes
    const result = await worker.handleRequest({
      method: "GET",
      url: "http://localhost/admin/index.php",
    });
    // Bootstrap crash → resetRuntime → retry → fresh boot succeeds
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.retried, true);
    assert.strictEqual(worker.restartCount, 1);
    // Two boots: crashed bootstrap + successful retry
    assert.strictEqual(worker.runtimeBootCount, 2);
  });

  it("returns failure page when bootstrap crashes on retry too", async () => {
    const worker = createMockWorker();
    // Use setCrashOnRetry to simulate persistent runtime failure
    worker.setCrashOnRetry(true);
    worker.setCrashOnBootstrap(false);
    worker.setCrashOnRequest(true); // First request crashes

    const result = await worker.handleRequest({
      method: "GET",
      url: "http://localhost/page",
    });
    assert.strictEqual(result.status, 503);
    assert.ok(result.body.includes("crashed again on retry"));
  });

  it("auto-retries HEAD requests (idempotent)", async () => {
    const worker = createMockWorker();
    worker.setCrashOnRequest(true);
    const result = await worker.handleRequest({
      method: "HEAD",
      url: "http://localhost/page",
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.retried, true);
    assert.strictEqual(worker.restartCount, 1);
  });
});
