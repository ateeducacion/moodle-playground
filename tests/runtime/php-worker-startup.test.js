import assert from "node:assert/strict";
import { it } from "node:test";
import { resolveRuntimeSelection } from "../../src/shared/version-resolver.js";

it("reports a startup failure to the host before rethrowing it", async () => {
  const messages = [];
  globalThis.self = {
    location: new URL(
      "https://example.test/php-worker.js?scope=s9&runtime=php83-moodle500",
    ),
    addEventListener() {
      throw new Error("listeners unavailable");
    },
    postMessage: (message) => messages.push(message),
  };
  await assert.rejects(import("../../php-worker.js"), /listeners unavailable/);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "worker-startup-error");
  assert.equal(messages[0].scopeId, "s9");
  assert.equal(
    messages[0].runtimeId,
    resolveRuntimeSelection({ runtimeId: "php83-moodle500" }).runtimeId,
  );
  assert.match(messages[0].detail, /listeners unavailable/);
});
