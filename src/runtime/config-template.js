export const TEMP_ROOT = "/tmp/moodle";
export const MOODLEDATA_ROOT = "/persist/moodledata";
export const MOODLE_ROOT = "/www/moodle";
export const ADMIN_DIRECTORY = "admin";
export const COMPONENT_CACHE_PATH = `${MOODLE_ROOT}/.playground/core_component.php`;

function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function createMoodleConfigPhp({
  adminDirectory = ADMIN_DIRECTORY,
  componentCachePath = COMPONENT_CACHE_PATH,
  dbFile,
  dbHost,
  dbName,
  dbPassword,
  dbUser,
  ignoreComponentCache = false,
  prefix,
  wwwroot,
}) {
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
$CFG->admin = '${escapePhpSingleQuoted(adminDirectory)}';
$CFG->alternative_component_cache = '${escapePhpSingleQuoted(componentCachePath)}';
$CFG->directorypermissions = 0777;
$CFG->sslproxy = false;
$CFG->reverseproxy = false;
$CFG->debug = E_ALL;
$CFG->debugdisplay = 1;
$CFG->debugdeveloper = true;
$CFG->showcrondebugging = true;
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

${ignoreComponentCache ? "define('IGNORE_COMPONENT_CACHE', true);\n" : ""}define('NO_DEBUG_DISPLAY', false);
define('MOODLE_INTERNAL', false);
define('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE', true);
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', true);
}

if (!isset($_SERVER['REMOTE_ADDR'])) {
    if (!defined('CLI_SCRIPT') || !CLI_SCRIPT) {
        $_SERVER['REMOTE_ADDR'] = '127.0.0.1';
    }
}

if (!isset($_SERVER['SERVER_NAME'])) {
    $_SERVER['SERVER_NAME'] = 'localhost';
}

require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/output/renderable.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/output/templatable.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/output/bootstrap_renderer.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/lang_string.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/date.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/string_manager.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/string_manager_standard.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/exception/moodle_exception.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/exception/coding_exception.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/cache.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/data_source_interface.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/versionable_data_source_interface.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/loader_interface.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/loader_with_locking_interface.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/store_interface.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/store.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/definition.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/disabled_cache.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/dummy_cachestore.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/factory.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/cache/classes/disabled_factory.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context_helper.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context/system.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context/user.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context/coursecat.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context/course.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context/module.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/classes/context/block.php');
require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/setup.php');
`;
}

export function createPhpIni({ timezone = "UTC" } = {}) {
  return `[PHP]
date.timezone=${timezone}
display_errors=1
display_startup_errors=1
error_reporting=E_ALL
html_errors=0
log_errors=1
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
