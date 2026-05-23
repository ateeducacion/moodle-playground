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

  it("targets the qbank transfer task classnames", () => {
    assert.match(php, /mod_qbank\\\\task\\\\transfer_question_categories/);
    assert.match(php, /mod_qbank\\\\task\\\\transfer_questions/);
  });

  it("deletes task_adhoc records by classname", () => {
    assert.match(php, /delete_records\(\s*'task_adhoc'/);
  });

  it("wraps each delete in try/catch so one failure cannot abort the run", () => {
    assert.match(php, /try\s*{/);
    assert.match(php, /catch\s*\(\s*\\?Throwable/);
  });

  it("emits a JSON body with ok/cleared keys", () => {
    assert.match(php, /header\('content-type:\s*application\/json/);
    assert.match(php, /'ok'\s*=>/);
    assert.match(php, /'cleared'\s*=>/);
    assert.match(php, /json_encode\(/);
  });
});
