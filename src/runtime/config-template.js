export const TEMP_ROOT = "/tmp/moodle";
export const MOODLEDATA_ROOT = "/persist/moodledata";
export const MOODLE_ROOT = "/www/moodle";
export const ADMIN_DIRECTORY = "admin";
export const COMPONENT_CACHE_PATH = `${MOODLE_ROOT}/.playground/core_component.php`;

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
  playgroundProxyUrl = "",
  debugdisplay = 0,
  requirejsSeeded = false,
  phpConstants = {},
}) {
  const resolvedComponentCachePath =
    componentCachePath || buildComponentCachePath(moodleRoot);
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
$CFG->admin = '${escapePhpSingleQuoted(adminDirectory)}';
$CFG->alternative_component_cache = '${escapePhpSingleQuoted(resolvedComponentCachePath)}';
$CFG->directorypermissions = 0777;
$CFG->sslproxy = false;
$CFG->reverseproxy = false;
$CFG->disableupdatenotifications = true;
$CFG->updateautocheck = false;
// Display debug messages on page when explicitly enabled for this runtime.
$CFG->debugdisplay = ${Number(debugdisplay) ? 1 : 0};
$CFG->showcrondebugging = false;
// Enable all caching layers — the filesystem is MEMFS (pure memory) so file-backed
// caches are fast and persist for the lifetime of the worker session.
${
  requirejsSeeded
    ? `// RequireJS combined bundle is seeded at build time (manifest
// snapshot.requirejs), so we re-enable $CFG->cachejs: the browser makes ONE
// combined JS request per page (/lib/requirejs.php/1/core/first.js) instead of
// dozens of per-module requests through the serial worker queue. See ADR 0013.
// - jsrev is FORCED to 1 (not time()): config.php overrides DB config, so
//   js_reset_all_caches()'s set_config('jsrev', time()) cannot desync the URL
//   revision from the seeded sha1(1) file across journaled reloads. Bundle JS
//   is immutable per build, so in-session JS cache-busting being a no-op is fine.
// - The runtime NEVER builds the combine (lib/requirejs.php is patched at build
//   time; find_all_amd_modules is unreliable on the Emscripten VFS).
// - 'Purge all caches' wipes localcache including requirejs/, so the is_dir()
//   probe flips cachejs back to false (dev-mode per-module serving — today's
//   behavior) for the rest of the session; the next boot re-extracts the seed.
$CFG->jsrev = 1;
$CFG->cachejs = is_dir($CFG->localcachedir . '/requirejs');`
    : `// cachejs stays false: without the build-time RequireJS seed, enabling it makes
// the runtime build the combine itself, which fails silently in the WASM
// environment ("No define call for core/first" RequireJS errors). See ADR 0013.
$CFG->cachejs = false;`
}
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
// Extend session timeout to 8 hours and disable the JS timeout warning.
// The runtime is ephemeral (tab close = full reset) so session expiry is
// irrelevant. The default config makes Moodle's network.js initialize a
// session-timeout watcher on every page load, logging "Starting Moodle
// session timeout warning" to the console — noise with no value here.
if (!property_exists($CFG, 'sessiontimeout')) {
    $CFG->sessiontimeout = 28800;
}
if (!property_exists($CFG, 'sessiontimeoutwarning')) {
    $CFG->sessiontimeoutwarning = 0;
}

if (!defined('NO_DEBUG_DISPLAY')) {
    define('NO_DEBUG_DISPLAY', ${Number(debugdisplay) ? "false" : "true"});
}
if (!defined('MOODLE_INTERNAL')) {
    define('MOODLE_INTERNAL', true);
}
if (!defined('MOODLE_PLAYGROUND')) {
    define('MOODLE_PLAYGROUND', true);
}
if (!defined('MOODLE_PLAYGROUND_PROXY_URL')) {
    define('MOODLE_PLAYGROUND_PROXY_URL', '${escapePhpSingleQuoted(playgroundProxyUrl)}');
}
if (!defined('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE')) {
    define('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE', true);
}
if (!defined('PLAYGROUND_SKIP_NAV_UPGRADE_REDIRECTS')) {
    define('PLAYGROUND_SKIP_NAV_UPGRADE_REDIRECTS', true);
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

${phpConstantDefines}require_once('${escapePhpSingleQuoted(moodleRoot)}/lib/setup.php');
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
    // memory_limit: 256M is a good balance for Moodle Playground.
    // Official Moodle recommendation (docs.moodle.org) is at least 96-128M.
    // 256M gives headroom for normal operation while greatly reducing WASM
    // heap usage vs the previous 512M. Heavy operations (course restore,
    // large plugin installs) call raise_memory_limit(MEMORY_EXTRA) which
    // temporarily increases it further.
    memory_limit: "256M",
    post_max_size: "64M",
    upload_max_filesize: "64M",
    sys_temp_dir: TEMP_ROOT,
    upload_tmp_dir: TEMP_ROOT,
    "session.save_handler": "files",
    "session.save_path": `${TEMP_ROOT}/sessions`,
    // Realpath cache — every include resolves each path component via lstat
    // through Emscripten's JS FS (cheap individually, but tens of thousands
    // of JS calls per Moodle request at path depth ~6). The bundle tree is
    // immutable within a session and there is exactly ONE PHP process, so
    // every mid-session unlink/rename happens inside PHP, which invalidates
    // its own realpath-cache entries; JS-side FS writes (journal hydration,
    // boot patches) all happen before the first request, and PHP does not
    // cache negative lookups, so files created later are never masked.
    // If a future feature ever deletes MEMFS files from the JS side between
    // requests, revisit this TTL.
    realpath_cache_size: "8M",
    realpath_cache_ttl: "86400",
    // OPcache tuning — compiled bytecode is kept in /internal/shared/opcache
    // with no timestamp checks (the readonly bundle never changes within a
    // session), so PHP avoids recompiling on every request.
    // NOTE: with file_cache_only=1 OPcache allocates NO shared memory
    // segment, so max_accelerated_files / memory_consumption /
    // interned_strings_buffer are inert in this mode. They are kept (with
    // max_accelerated_files sized above Moodle's ~15k bundled PHP files)
    // only as future-proofing should file_cache_only ever be revisited.
    // See docs/architecture/adr/ADR-0011-bundle-trim-and-runtime-tuning.md (amends
    // ADR 0004).
    "opcache.enable": "1",
    "opcache.file_cache": "/internal/shared/opcache",
    "opcache.file_cache_only": "1",
    "opcache.max_accelerated_files": "20000",
    "opcache.memory_consumption": "96",
    "opcache.interned_strings_buffer": "16",
    "opcache.validate_timestamps": "0",
    "opcache.file_cache_consistency_checks": "0",
  };
}
