import { MOODLE_BASE_PATH, MOODLEDATA_ROOT, MOODLE_ROOT, TEMP_ROOT } from "./constants.js";

function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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
}) {
  const wwwroot = `${origin}${MOODLE_BASE_PATH}`;

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
$CFG->cachejs = false;
$CFG->cachetemplates = false;
$CFG->langstringcache = false;
$CFG->themedesignermode = true;
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
    $CFG->rememberusername = 1;
}
if (!property_exists($CFG, 'auth_instructions')) {
    $CFG->auth_instructions = '';
}
if (!property_exists($CFG, 'maintenance_enabled')) {
    $CFG->maintenance_enabled = 0;
}

define('NO_DEBUG_DISPLAY', false);
define('MOODLE_INTERNAL', false);
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', true);
}

if (!isset($_SERVER['REMOTE_ADDR'])) {
    $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
}

if (!isset($_SERVER['SERVER_NAME'])) {
    $_SERVER['SERVER_NAME'] = 'localhost';
}

require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/setup.php');
`;
}

export function createPhpIni({ timezone = "UTC" } = {}) {
  return `[PHP]
date.timezone=${timezone}
display_errors=1
error_reporting=E_ALL
max_execution_time=15
max_input_vars=5000
memory_limit=512M
post_max_size=128M
upload_max_filesize=128M
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
