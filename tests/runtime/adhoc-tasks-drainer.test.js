import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAdhocTasksDrainerPhp } from "../../src/runtime/bootstrap.js";

describe("createAdhocTasksDrainerPhp", () => {
  const php = createAdhocTasksDrainerPhp();

  it("starts with a PHP opening tag", () => {
    assert.ok(php.startsWith("<?php"));
  });

  it("declares CLI_SCRIPT and loads config.php", () => {
    assert.ok(php.includes("define('CLI_SCRIPT', true)"));
    assert.ok(php.includes("require_once('/www/moodle/config.php')"));
  });

  it("invokes Moodle's adhoc task manager and inner runner", () => {
    assert.match(php, /core\\task\\manager::get_next_adhoc_task/);
    assert.match(php, /core\\cron::run_inner_adhoc_task/);
  });

  it("bounds the loop to protect the WASM runtime", () => {
    assert.match(
      php,
      /\$max(Iterations|Tasks)\s*=\s*\d+/,
      "expected a numeric loop cap on the drainer",
    );
  });

  it("wraps each task execution in try/catch so one failure cannot abort the run", () => {
    assert.match(php, /try\s*{/);
    assert.match(php, /catch\s*\(\s*\\?Throwable/);
  });

  it("emits a JSON body with ok/executed/failed keys", () => {
    assert.match(php, /header\('content-type:\s*application\/json/);
    assert.match(php, /'ok'\s*=>/);
    assert.match(php, /'executed'\s*=>/);
    assert.match(php, /'failed'\s*=>/);
    assert.match(php, /json_encode\(/);
  });
});
