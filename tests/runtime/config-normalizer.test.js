import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createConfigNormalizerPhp } from "../../src/runtime/bootstrap.js";

describe("createConfigNormalizerPhp", () => {
  const php = createConfigNormalizerPhp(0);

  it("starts with a PHP opening tag and loads config.php", () => {
    assert.ok(php.startsWith("<?php"));
    assert.ok(php.includes("define('CLI_SCRIPT', true)"));
    assert.ok(php.includes("require_once('/www/moodle/config.php')"));
  });

  it("interpolates the effective debug level", () => {
    assert.match(php, /set_config\('debug', 0\)/);
    const verbose = createConfigNormalizerPhp(32767);
    assert.match(verbose, /set_config\('debug', 32767\)/);
  });

  // The qbank clearing used to be a separate boot-time PHP request
  // (__adhoc_tasks_drainer.php); it is folded into the normalizer so every
  // boot path pays one request fewer. Same invariants as the old drainer:
  it("clears the qbank transfer task classnames from task_adhoc", () => {
    assert.match(php, /mod_qbank\\\\task\\\\transfer_question_categories/);
    assert.match(php, /mod_qbank\\\\task\\\\transfer_questions/);
    assert.match(php, /delete_records\('task_adhoc'/);
  });

  it("wraps each qbank delete in try/catch so one failure cannot abort the run", () => {
    assert.match(php, /catch\s*\(\s*\\?Throwable\s*\$taskError\s*\)/);
  });

  it("reseeds allversionshash and clears adminsetuppending", () => {
    assert.match(php, /allversionshash/);
    assert.match(php, /adminsetuppending/);
  });

  it("emits a JSON body with ok/set/kept keys", () => {
    assert.match(php, /header\('content-type:\s*application\/json/);
    assert.match(php, /'ok'\s*=>/);
    assert.match(php, /'set'\s*=>/);
    assert.match(php, /'kept'\s*=>/);
    assert.match(php, /json_encode\(/);
  });
});
