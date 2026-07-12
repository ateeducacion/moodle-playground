import { MOODLE_BASE_PATH, MOODLEDATA_ROOT, MOODLE_ROOT, TEMP_ROOT } from "./constants.js";

function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

// PHP constant names allowed in a blueprint's `phpConstants` map. Anything that
// does not match this pattern is silently skipped so a blueprint can never emit
// invalid PHP into config.php.
const PHP_CONSTANT_NAME = /^[A-Z_][A-Z0-9_]*$/;

// Encode a JS value as a PHP literal for use inside define(): booleans become
// the bare keywords true/false, numbers become numeric literals and everything
// else is treated as a single-quoted PHP string.
function encodePhpConstantValue(value) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `'${escapePhpSingleQuoted(value)}'`;
}

// Render a blueprint's `phpConstants` map as guarded define() blocks. Each entry
// is emitted as `if (!defined('NAME')) { define('NAME', <value>); }` so the
// engine never overrides a constant Moodle (or another runtime hook) already set.
// Returns "" when there is nothing to emit so the caller can interpolate it
// directly without producing stray whitespace.
function renderPhpConstantDefines(phpConstants) {
  if (!phpConstants || typeof phpConstants !== "object") {
    return "";
  }
  const blocks = [];
  for (const [name, value] of Object.entries(phpConstants)) {
    if (!PHP_CONSTANT_NAME.test(name)) {
      continue;
    }
    blocks.push(
      `if (!defined('${name}')) {\n    define('${name}', ${encodePhpConstantValue(value)});\n}`,
    );
  }
  return blocks.length ? `${blocks.join("\n")}\n\n` : "";
}

export function createMoodleConfigPhp({
  origin,
  adminUser,
  dbFile,
  dbHost,
  dbName,
  dbPassword,
  dbUser,
  prefix,
  phpConstants = {},
}) {
  const wwwroot = `${origin}${MOODLE_BASE_PATH}`;
  // Blueprint-driven PHP constants are defined before lib/setup.php loads so a
  // plugin blueprint can enable plugin-specific behaviour without the engine
  // knowing which constants exist.
  const phpConstantDefines = renderPhpConstantDefines(phpConstants);

  return `<?php
unset($CFG);
global $CFG;
$CFG = new stdClass();

$CFG->dbtype = 'sqlite3';
$CFG->dblibrary = 'pdo';
$CFG->dbhost = '${escapePhpSingleQuoted(dbHost)}';
$CFG->dbname = '${escapePhpSingleQuoted(dbName)}';
$CFG->dbuser = '${escapePhpSingleQuoted(dbUser)}';
$CFG->dbpass = '${escapePhpSingleQuoted(dbPassword)}';
$CFG->prefix = '${escapePhpSingleQuoted(prefix)}';
$CFG->dboptions = [
    'dbpersist' => 0,
    'dbport' => '',
    'dbsocket' => '',
    'dbhandlesoptions' => false,
    'file' => '${escapePhpSingleQuoted(dbFile)}',
];

$CFG->wwwroot = '${escapePhpSingleQuoted(wwwroot)}';
$CFG->dataroot = '${escapePhpSingleQuoted(MOODLEDATA_ROOT)}';
$CFG->cachedir = '${escapePhpSingleQuoted(MOODLEDATA_ROOT)}/cache';
$CFG->localcachedir = '${escapePhpSingleQuoted(MOODLEDATA_ROOT)}/localcache';
$CFG->tempdir = '${escapePhpSingleQuoted(MOODLEDATA_ROOT)}/temp';
$CFG->backuptempdir = '${escapePhpSingleQuoted(MOODLEDATA_ROOT)}/temp/backup';
$CFG->admin = '${escapePhpSingleQuoted(adminUser)}';
$CFG->directorypermissions = 0777;
$CFG->sslproxy = false;
$CFG->reverseproxy = false;
$CFG->disableupdatenotifications = true;
$CFG->updateautocheck = false;
$CFG->cachejs = false;
$CFG->cachetemplates = true;
$CFG->langstringcache = true;
$CFG->themedesignermode = false;
$CFG->slasharguments = 1;
$CFG->yuicomboloading = false;
$CFG->yui3version = '3.18.1';
$CFG->yui2version = '2.9.0';
if (!property_exists($CFG, 'navcourselimit')) {
    $CFG->navcourselimit = 10;
}
if (!property_exists($CFG, 'enablecompletion')) {
    $CFG->enablecompletion = 1;
}
if (!property_exists($CFG, 'frontpage')) {
    $CFG->frontpage = '6';
}
if (!property_exists($CFG, 'frontpageloggedin')) {
    $CFG->frontpageloggedin = '6';
}
if (!property_exists($CFG, 'frontpagecourselimit')) {
    $CFG->frontpagecourselimit = 200;
}
if (!property_exists($CFG, 'guestloginbutton')) {
    $CFG->guestloginbutton = 0;
}
if (!property_exists($CFG, 'rememberusername')) {
    $CFG->rememberusername = 0;
}
if (!property_exists($CFG, 'auth_instructions')) {
    $CFG->auth_instructions = '';
}
if (!property_exists($CFG, 'maintenance_enabled')) {
    $CFG->maintenance_enabled = 0;
}
if (!property_exists($CFG, 'maxbytes')) {
    $CFG->maxbytes = 0;
}
if (!property_exists($CFG, 'registerauth')) {
    $CFG->registerauth = '';
}
if (!property_exists($CFG, 'langmenu')) {
    $CFG->langmenu = 0;
}

if (!defined('NO_DEBUG_DISPLAY')) {
    define('NO_DEBUG_DISPLAY', false);
}
if (!defined('MOODLE_INTERNAL')) {
    define('MOODLE_INTERNAL', false);
}
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', false);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', false);
}

if (!isset($_SERVER['REMOTE_ADDR'])) {
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
}

if (!isset($_SERVER['SERVER_NAME'])) {
    $_SERVER['SERVER_NAME'] = 'localhost';
}

${phpConstantDefines}require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/setup.php');
`;
}

export function createPhpIni({ timezone = "UTC" } = {}) {
  return `[PHP]
date.timezone=${timezone}
display_errors=0
error_reporting=E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_STRICT
max_execution_time=15
max_input_vars=5000
memory_limit=256M
post_max_size=64M
upload_max_filesize=64M
opcache.jit=0
sys_temp_dir=${TEMP_ROOT}
upload_tmp_dir=${TEMP_ROOT}
session.save_handler=files
session.save_path=${TEMP_ROOT}/sessions
`;
}

export function createBootstrapNotice() {
  return `<?php
header('Content-Type: text/plain; charset=utf-8');
echo "Moodle Playground bootstrap ready. Open ${MOODLE_BASE_PATH}/install.php\\n";
`;
}
