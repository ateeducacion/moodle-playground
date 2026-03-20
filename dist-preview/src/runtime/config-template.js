export const TEMP_ROOT = "/tmp/moodle";
export const MOODLEDATA_ROOT = "/persist/moodledata";
export const MOODLE_ROOT = "/www/moodle";
export const ADMIN_DIRECTORY = "admin";
export const COMPONENT_CACHE_PATH = `${MOODLE_ROOT}/.playground/core_component.php`;

function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function buildComponentCachePath(moodleRoot) {
  return `${moodleRoot}/.playground/core_component.php`;
}

export function createMoodleConfigPhp({
  adminDirectory = ADMIN_DIRECTORY,
  componentCachePath,
  moodleRoot = MOODLE_ROOT,
  dbFile,
  dbHost,
  dbName,
  dbPassword,
  dbUser,
  prefix,
  wwwroot,
  debugdisplay = 0,
}) {
  const resolvedComponentCachePath =
    componentCachePath || buildComponentCachePath(moodleRoot);
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
$CFG->alternative_component_cache = '${escapePhpSingleQuoted(resolvedComponentCachePath)}';
$CFG->directorypermissions = 0777;
$CFG->sslproxy = false;
$CFG->reverseproxy = false;
// Display debug messages on page when explicitly enabled for this runtime.
$CFG->debugdisplay = ${Number(debugdisplay) ? 1 : 0};
$CFG->showcrondebugging = false;
// Enable all caching layers — the filesystem is MEMFS (pure memory) so file-backed
// caches are fast and persist for the lifetime of the worker session.
// cachejs must stay false: when enabled, Moodle rewrites JS module URLs to serve
// combined bundles through javascript.php. The caching endpoint fails silently
// in the WASM environment, causing "No define call for core/first" RequireJS errors.
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
    define('NO_DEBUG_DISPLAY', ${Number(debugdisplay) ? "false" : "true"});
}
if (!defined('MOODLE_INTERNAL')) {
    define('MOODLE_INTERNAL', true);
}
if (!defined('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE')) {
    define('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE', true);
}
// MUC caching is enabled — the filesystem is MEMFS (pure memory) so file-backed
// cache stores are fast and persist for the lifetime of the worker session.
// Cache store admin settings are seeded in the install snapshot and config normalizer
// to prevent admin/index.php from redirecting to upgradesettings.php.
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', false);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', false);
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
spl_autoload_register(function ($class) {
    global $CFG;
    static $fallbackMap = null;
    if ($fallbackMap === null) {
        $cachefile = '${escapePhpSingleQuoted(resolvedComponentCachePath)}';
        if (file_exists($cachefile)) {
            $cache = [];
            include($cachefile);
            $fallbackMap = $cache['classmap'] ?? [];
        } else {
            $fallbackMap = [];
        }
    }
    if (isset($fallbackMap[$class]) && file_exists($fallbackMap[$class])) {
        require_once($fallbackMap[$class]);
    }
});

require_once('${escapePhpSingleQuoted(moodleRoot)}/lib/setup.php');
`;
}

export const CHDIR_FIX_PATH = `${MOODLE_ROOT}/__chdir_fix.php`;
export const CHDIR_FIX_PRELOAD_PATH =
  "/internal/shared/preload/moodle_chdir.php";

export function createChdirFixPhp() {
  return `<?php
// Set cwd to the script's directory so relative paths (e.g.,
// admin/index.php's file_exists('../config.php')) resolve correctly,
// matching what a real web server does for CGI scripts.
if (!empty($_SERVER['SCRIPT_FILENAME'])) {
    $dir = dirname($_SERVER['SCRIPT_FILENAME']);
    if ($dir && is_dir($dir)) {
        chdir($dir);
    }
}

// Polyfill: glob() returns [] on Emscripten's readonly WASM VFS because
// musl's libc glob implementation doesn't go through Emscripten's
// FS.readdir(). We override glob globally via this auto_prepend_file so
// every call site benefits without individual patches.
if (!function_exists('playground_glob_polyfill_installed')) {
    function playground_glob_polyfill_installed(): bool { return true; }

    // Rename the builtin so we can call it as fallback.
    // Since we cannot truly rename a builtin, we wrap it instead.
    function playground_glob(string $pattern, int $flags = 0): array {
        $result = @\\glob($pattern, $flags);
        if (!empty($result)) {
            return $result;
        }
        // Fallback: scandir + fnmatch (works on Emscripten VFS).
        $dir = dirname($pattern);
        $mask = basename($pattern);
        $entries = @scandir($dir);
        if ($entries === false) {
            return [];
        }
        $matched = [];
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (fnmatch($mask, $entry)) {
                $matched[] = $dir . '/' . $entry;
            }
        }
        sort($matched);
        return ($flags & GLOB_ONLYDIR)
            ? array_filter($matched, 'is_dir')
            : $matched;
    }
}
`;
}

/**
 * Return php.ini entries as a Record<string, string> for use with
 * setPhpIniEntries() from @php-wasm/universal.  WP Playground hardcodes
 * /internal/shared/php.ini — writing a separate file has no effect.
 */
export function createPhpIniEntries({
  timezone = "UTC",
  debugdisplay = 0,
} = {}) {
  const showErrors = Number(debugdisplay) ? "1" : "0";
  return {
    "date.timezone": timezone,
    display_errors: showErrors,
    display_startup_errors: showErrors,
    error_reporting: "32759", // E_ALL & ~E_NOTICE & ~E_DEPRECATED & ~E_STRICT
    html_errors: "0",
    log_errors: "1",
    // max_execution_time stays at 0 (WP Playground default) — no timeout in WASM
    max_input_vars: "5000",
    memory_limit: "512M",
    post_max_size: "128M",
    upload_max_filesize: "128M",
    sys_temp_dir: TEMP_ROOT,
    upload_tmp_dir: TEMP_ROOT,
    "session.save_handler": "files",
    "session.save_path": `${TEMP_ROOT}/sessions`,
  };
}
