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
$CFG->themedesignermode = false;
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
    define('MOODLE_INTERNAL', true);
}
if (!defined('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE')) {
    define('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE', true);
}
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

// Fallback autoloader: when Moodle's core_component classmap is wiped (e.g. during
// "Purge all caches" which defines IGNORE_COMPONENT_CACHE), the filesystem scan in
// WASM's VFS can produce an incomplete classmap. This fallback re-reads the prebuilt
// alternative_component_cache to resolve any class that Moodle's autoloader misses.
spl_autoload_register(function (\$class) {
    global \$CFG;
    static \$fallbackMap = null;
    if (\$fallbackMap === null) {
        \$cachefile = '${escapePhpSingleQuoted(componentCachePath)}';
        if (file_exists(\$cachefile)) {
            \$cache = [];
            include(\$cachefile);
            \$fallbackMap = \$cache['classmap'] ?? [];
        } else {
            \$fallbackMap = [];
        }
    }
    if (isset(\$fallbackMap[\$class]) && file_exists(\$fallbackMap[\$class])) {
        require_once(\$fallbackMap[\$class]);
    }
});

require_once('${escapePhpSingleQuoted(MOODLE_ROOT)}/lib/setup.php');
`;
}

export const CHDIR_FIX_PATH = `${MOODLE_ROOT}/__chdir_fix.php`;

export function createChdirFixPhp() {
  return `<?php
// Set cwd to the script's directory so relative paths (e.g.,
// admin/index.php's file_exists('../config.php')) resolve correctly,
// matching what a real web server does for CGI scripts.
if (!empty(\$_SERVER['SCRIPT_FILENAME'])) {
    \$dir = dirname(\$_SERVER['SCRIPT_FILENAME']);
    if (\$dir && is_dir(\$dir)) {
        chdir(\$dir);
    }
}
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
auto_prepend_file=${CHDIR_FIX_PATH}
`;
}
