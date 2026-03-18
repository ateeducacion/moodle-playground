import { setPhpIniEntries } from "@php-wasm/universal";
import {
  extractZipEntries,
  fetchBundleWithCache,
  writeEntriesToPhp,
} from "../../lib/moodle-loader.js";
import { mountReadonlyVfs } from "../../lib/vfs-mount.js";
import { buildInstallConfig } from "../blueprint/index.js";
import {
  DEFAULT_MOODLE_BRANCH,
  getBranchMetadata,
} from "../shared/version-resolver.js";
import {
  ensureDir,
  readJsonFile,
  resolveBootstrapArchive,
  writeJsonFile,
} from "./bootstrap-fs.js";
import {
  ADMIN_DIRECTORY,
  COMPONENT_CACHE_PATH,
  createMoodleConfigPhp,
  MOODLE_ROOT,
  MOODLEDATA_ROOT,
  TEMP_ROOT,
} from "./config-template.js";
import { buildManifestState, resolveManifestUrl } from "./manifest.js";

const DOCROOT = "/www";
const CONFIG_ROOT = "/persist/config";
const MANIFEST_STATE_PATH = `${CONFIG_ROOT}/moodle-playground-manifest.json`;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Build runtime paths that depend on the webRoot (document root where PHP scripts live).
 * For Moodle <=5.0: webRoot = "/www/moodle"
 * For Moodle 5.1+:  webRoot = "/www/moodle/public"
 *
 * Playground internal scripts (prefixed with __) are placed at webRoot so they
 * are reachable via HTTP through php-compat.js's webRoot-based routing.
 * config.php stays at MOODLE_ROOT (Moodle expects it above public/ for 5.1+).
 */
function buildRuntimePaths(webRoot) {
  return {
    AUTOLOAD_CHECK_PATH: `${webRoot}/__autoload_check.php`,
    INSTALL_CHECK_PATH: `${webRoot}/__install_check.php`,
    INSTALL_RUNNER_PATH: `${webRoot}/__install_database.php`,
    PDO_PROBE_PATH: `${webRoot}/__pdo_probe.php`,
    PDO_DDL_PROBE_PATH: `${webRoot}/__pdo_ddl_probe.php`,
    CONFIG_NORMALIZER_PATH: `${webRoot}/__config_normalizer.php`,
    ADMIN_DEFAULTS_SEEDER_PATH: `${webRoot}/__admin_defaults_seeder.php`,
    CACHE_CONFIG_PATH: `${webRoot}/cache/classes/config.php`,
    COMPONENT_CLASS_PATH: `${webRoot}/lib/classes/component.php`,
    ADMINLIB_PATH: `${webRoot}/lib/adminlib.php`,
    MOODLELIB_PATH: `${webRoot}/lib/moodlelib.php`,
    DATAPRIVACY_SETTINGS_PATH: `${webRoot}/admin/tool/dataprivacy/settings.php`,
    LOG_SETTINGS_PATH: `${webRoot}/admin/tool/log/settings.php`,
    HTTPSREPLACE_SETTINGS_PATH: `${webRoot}/admin/tool/httpsreplace/settings.php`,
    THEME_CSS_WARMUP_PATH: `${webRoot}/__theme_css_warmup.php`,
  };
}

function buildInternalRuntimeFiles(webRoot) {
  const paths = buildRuntimePaths(webRoot);
  return [
    `${MOODLE_ROOT}/config.php`,
    paths.AUTOLOAD_CHECK_PATH,
    paths.INSTALL_CHECK_PATH,
    paths.INSTALL_RUNNER_PATH,
    paths.PDO_PROBE_PATH,
    paths.PDO_DDL_PROBE_PATH,
    paths.CONFIG_NORMALIZER_PATH,
    paths.CACHE_CONFIG_PATH,
    paths.COMPONENT_CLASS_PATH,
    paths.ADMINLIB_PATH,
    paths.MOODLELIB_PATH,
    paths.ADMIN_DEFAULTS_SEEDER_PATH,
    paths.DATAPRIVACY_SETTINGS_PATH,
    paths.LOG_SETTINGS_PATH,
    paths.HTTPSREPLACE_SETTINGS_PATH,
    paths.THEME_CSS_WARMUP_PATH,
  ];
}

function nowIso() {
  return new Date().toISOString();
}

function buildPublicBase(appBaseUrl) {
  return new URL("./", appBaseUrl).toString().replace(/\/$/u, "");
}

function buildDatabaseName(scopeId, runtimeId) {
  const scope = String(scopeId || "default").replace(/[^A-Za-z0-9_]/gu, "_");
  const runtime = String(runtimeId || "php").replace(/[^A-Za-z0-9_]/gu, "_");
  return `moodle_${scope}_${runtime}`;
}

function buildDatabaseFilePath(scopeId, runtimeId) {
  return `${MOODLEDATA_ROOT}/${buildDatabaseName(scopeId, runtimeId)}.sq3.php`;
}

function buildInstallStatePath(scopeId, runtimeId) {
  const scope = String(scopeId || "default").replace(/[^A-Za-z0-9_]/gu, "_");
  const runtime = String(runtimeId || "php").replace(/[^A-Za-z0-9_]/gu, "_");
  return `${CONFIG_ROOT}/moodle-playground-install-${scope}-${runtime}.json`;
}

function manifestStateMatches(savedState, manifestState) {
  return (
    savedState?.runtimeId === manifestState.runtimeId &&
    savedState?.bundleVersion === manifestState.bundleVersion &&
    savedState?.release === manifestState.release &&
    savedState?.sha256 === manifestState.sha256
  );
}

function installStateMatches(savedState, manifestState, dbName) {
  return (
    manifestStateMatches(savedState, manifestState) &&
    savedState?.dbName === dbName &&
    savedState?.installed === true
  );
}

function createAutoloadCheckPhp() {
  return `<?php
header('content-type: application/json; charset=utf-8');
ini_set('display_errors', '0');
ini_set('log_errors', '0');
error_reporting(E_ALL);
ob_start();

$ignorecache = !empty($_GET['ignorecache']);
$result = [
    'ignoreComponentCache' => $ignorecache,
    'paths' => [],
    'classes' => [],
    'directories' => [],
    'manualRequires' => [],
];

$paths = [
    '/www/moodle/lib/classes/context_helper.php',
    '/www/moodle/lib/classes/context.php',
    '/www/moodle/lib/classes/context/system.php',
    '/www/moodle/lib/classes/string_manager_standard.php',
];

foreach ($paths as $path) {
    $result['paths'][$path] = [
        'exists' => file_exists($path),
        'readable' => is_readable($path),
    ];
}

$directories = [
    '/www/moodle/lib/classes',
    '/www/moodle/lib/classes/context',
];

foreach ($directories as $path) {
    $result['directories'][$path] = [
        'exists' => is_dir($path),
        'readable' => is_readable($path),
        'sample' => is_dir($path) ? array_slice(scandir($path), 0, 12) : [],
    ];
}

if ($ignorecache && !defined('IGNORE_COMPONENT_CACHE')) {
    define('IGNORE_COMPONENT_CACHE', true);
}

try {
    require_once('/www/moodle/config.php');
    $result['loaded'] = true;
    $result['autoloaders'] = array_map(
        static function($entry) {
            if (is_array($entry)) {
                return array_map(
                    static fn($part) => is_object($part) ? get_class($part) : (string) $part,
                    $entry
                );
            }
            return is_string($entry) ? $entry : gettype($entry);
        },
        spl_autoload_functions() ?: []
    );

    $classes = [
        '\\\\core_date',
        '\\\\core\\\\context_helper',
        '\\\\core\\\\context',
        '\\\\core\\\\context\\\\system',
        'core_string_manager_standard',
    ];

    foreach ($classes as $class) {
        $result['classes'][$class] = class_exists($class, true);
    }

    $manualRequires = [
        'core_date' => '/www/moodle/lib/classes/date.php',
        'core\\\\context_helper' => '/www/moodle/lib/classes/context_helper.php',
        'core_string_manager_standard' => '/www/moodle/lib/classes/string_manager_standard.php',
    ];

    foreach ($manualRequires as $class => $file) {
        try {
            require_once($file);
            $result['manualRequires'][$class] = [
                'file' => $file,
                'loaded' => class_exists($class, false),
            ];
        } catch (Throwable $requireError) {
            $result['manualRequires'][$class] = [
                'file' => $file,
                'loaded' => false,
                'error' => [
                    'type' => get_class($requireError),
                    'message' => $requireError->getMessage(),
                    'file' => $requireError->getFile(),
                    'line' => $requireError->getLine(),
                ],
            ];
        }
    }

    if (isset($CFG)) {
        $result['componentCache'] = [
            'cacheFile' => isset($CFG->cachedir) ? $CFG->cachedir . '/core_component.php' : null,
            'cacheExists' => isset($CFG->cachedir) ? file_exists($CFG->cachedir . '/core_component.php') : false,
        ];
    }
} catch (Throwable $error) {
    $result['loaded'] = false;
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => $error->getFile(),
        'line' => $error->getLine(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function createInstallCheckPhp() {
  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

unset($_SERVER['REMOTE_ADDR']);
define('CLI_SCRIPT', true);

$result = [
    'installed' => false,
    'tableCount' => 0,
];

try {
    require_once('/www/moodle/config.php');
    $result['cfg'] = [
        'dirroot' => $CFG->dirroot ?? null,
        'libdir' => $CFG->libdir ?? null,
    ];
    $release = $DB->get_field_select('config', 'value', 'name = ?', ['release'], IGNORE_MULTIPLE);
    $result['installed'] = $release !== false && $release !== null && $release !== '';
    $result['release'] = $result['installed'] ? $release : null;
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => $error->getFile(),
        'line' => $error->getLine(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function createInstallRunnerPhp(effectiveConfig) {
  const initialDebug = Number(effectiveConfig.debug) || 0;
  const options = {
    lang: effectiveConfig.locale || "en",
    adminuser: effectiveConfig.admin.username,
    adminpass: effectiveConfig.admin.password,
    adminemail: effectiveConfig.admin.email,
    fullname: effectiveConfig.siteTitle,
    shortname: effectiveConfig.siteTitle,
    summary: "",
    supportemail: effectiveConfig.admin.email,
    "agree-license": true,
  };

  const encodedOptions = JSON.stringify(options)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");

  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

unset($_SERVER['REMOTE_ADDR']);
define('CLI_SCRIPT', true);
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', true);
}
if (!defined('PLAYGROUND_SKIP_INITIALISE_CFG')) {
    define('PLAYGROUND_SKIP_INITIALISE_CFG', true);
}
if (!defined('PLAYGROUND_SKIP_INSTALL_BOOTSTRAP')) {
    define('PLAYGROUND_SKIP_INSTALL_BOOTSTRAP', true);
}

$configfile = '/www/moodle/config.php';
$options = json_decode('${encodedOptions}', true);
$stage = $_GET['stage'] ?? 'full';

require $configfile;
require_once($CFG->libdir.'/clilib.php');
require_once($CFG->libdir.'/installlib.php');
require_once($CFG->libdir.'/adminlib.php');
require_once($CFG->libdir.'/componentlib.class.php');
require_once($CFG->libdir.'/environmentlib.php');
require_once($CFG->libdir.'/upgradelib.php');

$CFG->early_install_lang = true;
get_string_manager(true);
raise_memory_limit(MEMORY_EXTRA);

if (!empty($options['lang'])) {
    $options['lang'] = clean_param($options['lang'], PARAM_SAFEDIR);
    if (!file_exists($CFG->dirroot.'/install/lang/'.$options['lang'])) {
        $options['lang'] = 'en';
    }
    $CFG->lang = $options['lang'];
}

$CFG->early_install_lang = false;
get_string_manager(true);
require($CFG->dirroot.'/version.php');
$CFG->version = $version;
$CFG->release = $release;
$CFG->branch = $branch;

$playgroundDiagnostics = [
    'extensions' => [
        'libxml' => extension_loaded('libxml'),
        'xml' => extension_loaded('xml'),
        'dom' => extension_loaded('dom'),
        'simplexml' => extension_loaded('simplexml'),
        'pdo' => extension_loaded('pdo'),
        'pdo_sqlite' => extension_loaded('pdo_sqlite'),
        'sqlite3' => extension_loaded('sqlite3'),
    ],
    'classes' => [
        'DOMDocument' => class_exists('DOMDocument', false),
        'SimpleXMLElement' => class_exists('SimpleXMLElement', false),
        'XMLReader' => class_exists('XMLReader', false),
    ],
    'paths' => [
        'installxml' => "$CFG->libdir/db/install.xml",
        'installxmlexists' => file_exists("$CFG->libdir/db/install.xml"),
        'installxmlreadable' => is_readable("$CFG->libdir/db/install.xml"),
    ],
];

if ($playgroundDiagnostics['paths']['installxmlexists'] && class_exists('DOMDocument', false)) {
    try {
        $dom = new DOMDocument();
        $playgroundDiagnostics['xmlprobe'] = [
            'domload' => @$dom->load($playgroundDiagnostics['paths']['installxml']),
            'root' => $dom->documentElement ? $dom->documentElement->tagName : null,
        ];
    } catch (Throwable $diagnosticerror) {
        $playgroundDiagnostics['xmlprobe'] = [
            'error' => get_class($diagnosticerror) . ': ' . $diagnosticerror->getMessage(),
        ];
    }
}

echo '[playground] diagnostics:' . json_encode($playgroundDiagnostics, JSON_UNESCAPED_SLASHES) . PHP_EOL;
flush();

$syncCoreConfigIntoCfg = static function() use (&$CFG): void {
    $localcfg = get_config('core');
    if (is_array($localcfg) || is_object($localcfg)) {
        foreach ($localcfg as $name => $value) {
            $CFG->{$name} = $value;
        }
    }
};

$runStage = static function(string $name) use (&$options, &$version, &$release, &$branch, &$CFG, &$DB, &$syncCoreConfigIntoCfg): void {
    switch ($name) {
        case 'core':
            echo "[playground] core:start\\n";
            flush();
            remove_dir($CFG->cachedir.'', true);
            make_cache_directory('', true);
            remove_dir($CFG->localcachedir.'', true);
            make_localcache_directory('', true);
            remove_dir($CFG->tempdir.'', true);
            make_temp_directory('', true);
            remove_dir($CFG->backuptempdir.'', true);
            make_backup_temp_directory('', true);
            remove_dir($CFG->dataroot.'/muc', true);
            make_writable_directory($CFG->dataroot.'/muc', true);
            echo "[playground] core:dirs-ready\\n";
            flush();

            core_php_time_limit::raise(600);
            require_once($CFG->libdir.'/xmldb/xmldb_file.php');
            $xmldbfile = new xmldb_file("$CFG->libdir/db/install.xml");
            echo "[playground] core:schema-load:start\\n";
            flush();
            $loaded = $xmldbfile->loadXMLStructure();
            echo "[playground] core:schema-load:done loaded=" . ($loaded ? '1' : '0') . "\\n";
            flush();
            if (!$loaded) {
                $structure = $xmldbfile->getStructure();
                $message = $structure && !empty($structure->errormsg) ? $structure->errormsg : 'Unknown XMLDB load failure';
                cli_error('Unable to load install.xml: ' . $message);
            }

            $xmldbstructure = $xmldbfile->getStructure();
            $tablecount = count($xmldbstructure->getTables());
            echo "[playground] core:schema-structure:tables={$tablecount}\\n";
            flush();

            $sqlarr = $DB->get_manager()->generator->getCreateStructureSQL($xmldbstructure);
            $sqlcount = is_array($sqlarr) ? count($sqlarr) : 0;
            echo "[playground] core:schema-sql:count={$sqlcount}\\n";
            if (!empty($sqlarr[0])) {
                echo "[playground] core:schema-sql:first=" . substr(str_replace(["\\r", "\\n"], ' ', $sqlarr[0]), 0, 240) . "\\n";
            }
            flush();

            $DB->get_manager()->install_from_xmldb_structure($xmldbstructure);
            echo "[playground] core:schema-installed\\n";
            flush();

            require_once("$CFG->libdir/db/install.php");
            xmldb_main_install();
            echo "[playground] core:defaults-installed\\n";
            flush();

            $syncCoreConfigIntoCfg();
            $installedversion = get_config('core', 'version');
            if ($installedversion === false || $installedversion === null || $installedversion === '') {
                set_config('version', $version);
                $installedversion = $version;
            }
            set_config('release', $release);
            set_config('branch', $branch);
            $syncCoreConfigIntoCfg();
            upgrade_component_updated('moodle', '', true);
            echo "[playground] core:installed version={$installedversion}\\n";
            flush();
            if (defined('PHPUNIT_TEST') && PHPUNIT_TEST) {
                set_config('phpunittest', 'na');
            }
            echo "[playground] core:config-written\\n";
            flush();
            break;

        case 'preflight':
            echo "[playground] preflight:start\\n";
            flush();
            if ($DB->get_tables()) {
                cli_error(get_string('clitablesexist', 'install'));
            }
            echo "[playground] preflight:ok\\n";
            flush();
            break;

        case 'plugins':
            echo "[playground] plugins:start\\n";
            flush();
            upgrade_noncore(false);
            echo "[playground] plugins:ok\\n";
            flush();
            break;

        case 'finalize':
            echo "[playground] finalize:start\\n";
            flush();
            $syncCoreConfigIntoCfg();
            $DB->set_field('user', 'password', hash_internal_user_password($options['adminpass']), ['username' => 'admin']);

            if (isset($options['adminemail'])) {
                $DB->set_field('user', 'email', $options['adminemail'], ['username' => 'admin']);
            }

            if (!empty($options['supportemail'])) {
                set_config('supportemail', $options['supportemail']);
            } else if (!empty($options['adminemail'])) {
                set_config('supportemail', $options['adminemail']);
            }

            set_config('rolesactive', 1);
            upgrade_finished();
            $syncCoreConfigIntoCfg();

            $siteadmins = get_config('core', 'siteadmins');
            if ($siteadmins !== false && $siteadmins !== null && $siteadmins !== '') {
                $CFG->siteadmins = (string)$siteadmins;
            }

            $adminuser = get_admin();
            if (!$adminuser) {
                $adminuser = $DB->get_record('user', [
                    'username' => 'admin',
                    'mnethostid' => $CFG->mnet_localhost_id,
                    'deleted' => 0,
                ]);
            }
            if (!$adminuser && !empty($options['adminuser']) && $options['adminuser'] !== 'guest') {
                $adminuser = $DB->get_record('user', [
                    'username' => $options['adminuser'],
                    'mnethostid' => $CFG->mnet_localhost_id,
                    'deleted' => 0,
                ]);
            }
            if (!$adminuser) {
                cli_error('Unable to resolve local admin user during finalize stage.');
            }

            if (empty($CFG->siteadmins) || strpos(',' . $CFG->siteadmins . ',', ',' . $adminuser->id . ',') === false) {
                set_config('siteadmins', $adminuser->id);
                $CFG->siteadmins = (string)$adminuser->id;
            }

            \\core\\session\\manager::set_user($adminuser);
            try {
                admin_apply_default_settings(NULL, true);
                echo "[playground] finalize:defaults-applied\\n";
            } catch (Throwable $finalizeerror) {
                echo "[playground] finalize:defaults-skipped="
                    . get_class($finalizeerror) . ': ' . $finalizeerror->getMessage() . "\\n";
            }
            flush();
            set_config('registerauth', '');

            if (isset($options['adminuser']) && $options['adminuser'] !== 'admin' && $options['adminuser'] !== 'guest') {
                $DB->set_field('user', 'username', $options['adminuser'], ['id' => $adminuser->id]);
            }

            if (isset($options['shortname']) && $options['shortname'] !== '') {
                $DB->set_field('course', 'shortname', $options['shortname'], ['format' => 'site']);
            }
            if (isset($options['fullname']) && $options['fullname'] !== '') {
                $DB->set_field('course', 'fullname', $options['fullname'], ['format' => 'site']);
            }
            if (isset($options['summary'])) {
                $DB->set_field('course', 'summary', $options['summary'], ['format' => 'site']);
            }

            set_config('registrationpending', 1);
            if (!empty($CFG->setsitepresetduringinstall)) {
                \\core_adminpresets\\helper::change_default_preset($CFG->setsitepresetduringinstall);
            }

            // Apply defaults for settings hidden during initial install (guarded by
            // "if (!during_initial_install())"). Setting them directly avoids reloading
            // the full admin tree, which would exhaust WASM memory.
            // This prevents admin/index.php from redirecting to upgradesettings.php.
            $postinstalldefaults = [
                // tool_mobile settings.php: guarded by !during_initial_install()
                ['enablemobilewebservice', 0, null],
                // Other settings commonly missing after install
                ['enablebadges', 1, null],
                ['messaging', 1, null],
                ['enablecompletion', 1, null],
                // message/classes/helper.php: $CFG->messagingdefaultpressenter
                ['messagingdefaultpressenter', 1, null],
                // admin/index.php: update notification settings
                ['updatenotifybuilds', 0, null],
                ['updateminmaturity', 200, null],
                // blocks/myoverview: dashboard block settings
                ['courselistshortnames', 0, null],
                ['coursecreationguide', '', null],
                ['docroot', 'https://docs.moodle.org', null],
                ['doctonewwindow', 0, null],
                // course/edit.php: auto-enrol admin in new courses
                ['enroladminnewcourse', 1, null],
                // server.php: noreplyaddress has a dynamic default based on wwwroot
                ['noreplyaddress', 'noreply@localhost', null],
                // server.php: supportemail (empty by default)
                ['supportemail', '', null],
                // Cache store plugin settings (needed when CACHE_DISABLE_ALL=false)
                ['testperformance', 0, 'cachestore_apcu'],
                ['test_clustermode', 0, 'cachestore_redis'],
                ['test_server', '', 'cachestore_redis'],
                ['test_encryption', 0, 'cachestore_redis'],
                ['test_cafile', '', 'cachestore_redis'],
                ['test_password', '', 'cachestore_redis'],
                ['test_ttl', 0, 'cachestore_redis'],
            ];
            foreach ($postinstalldefaults as [$key, $val, $plugin]) {
                if (get_config($plugin ?? 'core', $key) === false) {
                    set_config($key, $val, $plugin);
                }
            }
            set_config('debug', ${initialDebug});
            $CFG->debug = ${initialDebug};
            $CFG->debugdeveloper = (${initialDebug} >= 32767);
            echo "[playground] finalize:post-install-defaults-set\\n";

            // Ensure moodlecourse plugin defaults exist — course/edit_form.php reads these
            // and emits warnings if they are missing.
            $coursedefaults = [
                'format'             => 'topics',
                'maxsections'        => 52,
                'numsections'        => 4,
                'hiddensections'     => 1,
                'coursedisplay'      => 0,
                'lang'               => '',
                'newsitems'          => 5,
                'showgrades'         => 1,
                'showreports'        => 0,
                'showactivitydates'  => 1,
                'maxbytes'           => 0,
                'groupmode'          => 0,
                'visible'            => 1,
                'groupmodeforce'     => 0,
                'enablecompletion'   => 1,
            ];
            foreach ($coursedefaults as $k => $v) {
                if (get_config('moodlecourse', $k) === false) {
                    set_config($k, $v, 'moodlecourse');
                }
            }
            echo "[playground] finalize:course-defaults-ensured\\n";

            echo "[playground] finalize:ok\\n";
            flush();
            break;

        case 'themes':
            echo "[playground] themes:start\\n";
            flush();
            upgrade_themes();
            echo "[playground] themes:ok\\n";
            flush();
            break;

        default:
            cli_error('Unknown install stage: ' . $name);
    }
};

$runStage($stage);
echo 'stage:' . $stage . ':ok' . PHP_EOL;
if ($stage === 'themes') {
    echo get_string('cliinstallfinished', 'install') . PHP_EOL;
}
`;
}

function createConfigNormalizerPhp(effectiveDebug = 0) {
  const normalizedDebug = Number(effectiveDebug) || 0;
  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

unset($_SERVER['REMOTE_ADDR']);
define('CLI_SCRIPT', true);
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', true);
}

$result = [
    'ok' => false,
    'set' => [],
    'kept' => [],
];

try {
    require_once('/www/moodle/config.php');
    require_once($CFG->libdir . '/moodlelib.php');

    $defaults = [
        'navcourselimit' => '10',
        'enablecompletion' => '1',
        'frontpage' => '6',
        'frontpageloggedin' => '6',
        'frontpagecourselimit' => '200',
        'guestloginbutton' => '0',
        'rememberusername' => '0',
        'auth_instructions' => '',
        'maintenance_enabled' => '0',
        'maxbytes' => '0',
        'registerauth' => '',
        'langmenu' => '0',
        'defaultrequestcategory' => '1',
        'customusermenuitems' => '',
        'gradepointdefault' => '100',
        'gradepointmax' => '100',
        'downloadcoursecontentallowed' => '0',
        'enablesharingtomoodlenet' => '0',
    ];

    foreach ($defaults as $name => $value) {
        $current = get_config('core', $name);
        if ($current === false || $current === null || $current === '') {
            set_config($name, $value);
            $result['set'][$name] = $value;
            $CFG->{$name} = $value;
        } else {
            $result['kept'][$name] = $current;
            $CFG->{$name} = $current;
        }
    }

    set_config('debug', ${normalizedDebug});
    $result['set']['debug'] = (string) ${normalizedDebug};
    $CFG->debug = ${normalizedDebug};
    $CFG->debugdeveloper = (${normalizedDebug} >= 32767);

    $pluginDefaults = [
        'moodlecourse' => [
            'hiddensections' => '1',
            'coursedisplay' => '0',
            'enablecompletion' => '1',
        ],
        'cachestore_apcu' => [
            'testperformance' => '0',
        ],
        'cachestore_redis' => [
            'test_clustermode' => '0',
            'test_server' => '',
            'test_encryption' => '0',
            'test_cafile' => '',
            'test_password' => '',
            'test_ttl' => '0',
        ],
    ];
    foreach ($pluginDefaults as $plugin => $settings) {
        foreach ($settings as $name => $value) {
            $current = get_config($plugin, $name);
            if ($current === false || $current === null) {
                set_config($name, $value, $plugin);
                $result['set']["{$plugin}/{$name}"] = $value;
            }
        }
    }

    // Clear adminsetuppending — the snapshot sets this during CLI install
    // (admin/index.php line 726) and it never gets cleared because the web-based
    // admin setup flow doesn't run. With MUC enabled, this flag causes
    // is_major_upgrade_required() to redirect ALL pages to /admin/index.php.
    if (!empty($CFG->adminsetuppending)) {
        unset_config('adminsetuppending');
        unset($CFG->adminsetuppending);
        $result['set']['adminsetuppending'] = 'unset';
    }

    $result['ok'] = true;
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => $error->getFile(),
        'line' => $error->getLine(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

/**
 * Generate a PHP script that applies ALL admin default settings with
 * CACHE_DISABLE_ALL = false, matching the runtime configuration.
 * This catches cache-store plugin settings and any other admin settings
 * that are only registered when MUC is active.
 */
function createAdminDefaultsSeederPhp() {
  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

unset($_SERVER['REMOTE_ADDR']);
define('CLI_SCRIPT', true);

$result = ['ok' => false];

try {
    require_once('/www/moodle/config.php');
    require_once($CFG->libdir . '/adminlib.php');
    admin_apply_default_settings(NULL, false);
    $result['ok'] = true;
    $result['applied'] = true;
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function createThemeCssWarmupPhp() {
  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

unset($_SERVER['REMOTE_ADDR']);
define('CLI_SCRIPT', true);

$result = ['ok' => false];

try {
    require_once('/www/moodle/config.php');
    require_once($CFG->libdir . '/outputlib.php');

    $themename = 'boost';
    $type = 'all';

    $theme = theme_config::load($themename);
    $rev = theme_get_revision();

    // Compile the full theme CSS (SCSS -> CSS).
    $csscontent = $theme->get_css_content();

    // Store in the local cache where theme/styles.php expects it.
    $candidatedir = make_localcache_directory("theme/$rev/$themename", false);
    file_put_contents("$candidatedir/$type.css", $csscontent);

    $result = [
        'ok' => true,
        'rev' => (int) $rev,
        'size' => strlen($csscontent),
        'path' => "$candidatedir/$type.css",
    ];
} catch (Throwable $error) {
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function createPdoProbePhp({ dbFile }) {
  const dsn = `sqlite:${dbFile}`;

  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

$result = [
    'pdoAvailable' => class_exists('PDO'),
    'drivers' => class_exists('PDO') ? PDO::getAvailableDrivers() : [],
    'dsn' => '${escapePhpSingleQuoted(dsn)}',
    'dbFile' => '${escapePhpSingleQuoted(dbFile)}',
    'dbFileExistsBeforeConnect' => file_exists('${escapePhpSingleQuoted(dbFile)}'),
];

try {
    $pdo = new PDO('${escapePhpSingleQuoted(dsn)}');
    $result['ok'] = true;
    $result['dbFileExistsAfterConnect'] = file_exists('${escapePhpSingleQuoted(dbFile)}');
    $pdo = null;
} catch (Throwable $error) {
    $result['ok'] = false;
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function createPdoDdlProbePhp({ dbFile }) {
  const dsn = `sqlite:${dbFile}`;

  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

$result = [
    'pdoAvailable' => class_exists('PDO'),
    'drivers' => class_exists('PDO') ? PDO::getAvailableDrivers() : [],
    'dsn' => '${escapePhpSingleQuoted(dsn)}',
    'dbFile' => '${escapePhpSingleQuoted(dbFile)}',
];

try {
    $pdo = new PDO('${escapePhpSingleQuoted(dsn)}');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('DROP TABLE IF EXISTS mdl_playground_probe');
    $pdo->exec('CREATE TABLE mdl_playground_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
    $pdo->exec("INSERT INTO mdl_playground_probe (name) VALUES ('ok')");
    $result['ok'] = true;
    $result['rows'] = $pdo->query('SELECT * FROM mdl_playground_probe')->fetchAll(PDO::FETCH_ASSOC);
    $pdo->exec('DROP TABLE IF EXISTS mdl_playground_probe');
    $pdo = null;
} catch (Throwable $error) {
    $result['ok'] = false;
    $result['error'] = [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => $error->getFile(),
        'line' => $error->getLine(),
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function createPatchedDataprivacySettingsPhp() {
  return `<?php
defined('MOODLE_INTERNAL') || die;

if ($hassiteconfig) {
    $privacysettings = $ADMIN->locate('privacysettings');

    if ($privacysettings && $ADMIN->fulltree) {
        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/contactdataprotectionofficer',
                new lang_string('contactdataprotectionofficer', 'tool_dataprivacy'),
                new lang_string('contactdataprotectionofficer_desc', 'tool_dataprivacy'), 0)
        );

        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/automaticdataexportapproval',
                new lang_string('automaticdataexportapproval', 'tool_dataprivacy'),
                new lang_string('automaticdataexportapproval_desc', 'tool_dataprivacy'), 0)
        );

        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/automaticdatadeletionapproval',
                new lang_string('automaticdatadeletionapproval', 'tool_dataprivacy'),
                new lang_string('automaticdatadeletionapproval_desc', 'tool_dataprivacy'), 0)
        );

        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/automaticdeletionrequests',
                new lang_string('automaticdeletionrequests', 'tool_dataprivacy'),
                new lang_string('automaticdeletionrequests_desc', 'tool_dataprivacy'), 1)
        );

        $privacysettings->add(new admin_setting_configduration('tool_dataprivacy/privacyrequestexpiry',
                new lang_string('privacyrequestexpiry', 'tool_dataprivacy'),
                new lang_string('privacyrequestexpiry_desc', 'tool_dataprivacy'),
                WEEKSECS, 1));

        $assignableroles = get_assignable_roles(context_system::instance());
        $capableroles = get_roles_with_capability('tool/dataprivacy:managedatarequests');
        $roles = [];
        foreach ($capableroles as $key => $role) {
            if (array_key_exists($key, $assignableroles)) {
                $roles[$key] = $assignableroles[$key];
            }
        }
        if (!empty($roles)) {
            $privacysettings->add(new admin_setting_configmulticheckbox('tool_dataprivacy/dporoles',
                    new lang_string('dporolemapping', 'tool_dataprivacy'),
                    new lang_string('dporolemapping_desc', 'tool_dataprivacy'), null, $roles)
            );
        }

        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/requireallenddatesforuserdeletion',
                new lang_string('requireallenddatesforuserdeletion', 'tool_dataprivacy'),
                new lang_string('requireallenddatesforuserdeletion_desc', 'tool_dataprivacy'),
                1));

        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/showdataretentionsummary',
            new lang_string('showdataretentionsummary', 'tool_dataprivacy'),
            new lang_string('showdataretentionsummary_desc', 'tool_dataprivacy'),
            1));

        $privacysettings->add(new admin_setting_configcheckbox('tool_dataprivacy/allowfiltering',
            new lang_string('allowfiltering', 'tool_dataprivacy'),
            new lang_string('allowfiltering_desc', 'tool_dataprivacy'),
            0));
        $privacysettings->hide_if('tool_dataprivacy/allowfiltering', 'tool_dataprivacy/automaticdataexportapproval', 'checked', 1);
    }
}

if (tool_dataprivacy\\api::is_site_dpo($USER->id)) {
    $ADMIN->add('privacy', new admin_externalpage('datarequests', get_string('datarequests', 'tool_dataprivacy'),
        new moodle_url('/admin/tool/dataprivacy/datarequests.php'), 'tool/dataprivacy:managedatarequests')
    );

    $ADMIN->add('privacy', new admin_externalpage('dataregistry', get_string('dataregistry', 'tool_dataprivacy'),
        new moodle_url('/admin/tool/dataprivacy/dataregistry.php'), 'tool/dataprivacy:managedataregistry')
    );

    $ADMIN->add('privacy', new admin_externalpage('datadeletion', get_string('datadeletion', 'tool_dataprivacy'),
            new moodle_url('/admin/tool/dataprivacy/datadeletion.php'), 'tool/dataprivacy:managedataregistry')
    );
}
`;
}

function createPatchedLogSettingsPhp() {
  return `<?php
defined('MOODLE_INTERNAL') || die();

if ($hassiteconfig) {

    $privacysettings = $ADMIN->locate('privacysettings');

    if ($privacysettings && $ADMIN->fulltree) {
        $privacysettings->add(new admin_setting_configcheckbox('tool_log/exportlog',
                new lang_string('exportlog', 'tool_log'),
                new lang_string('exportlogdetail', 'tool_log'), 1)
        );
    }

    $ADMIN->add('modules', new admin_category('logging', new lang_string('logging', 'tool_log')));

    $temp = new admin_settingpage('managelogging', new lang_string('managelogging', 'tool_log'));
    $temp->add(new tool_log_setting_managestores());
    $ADMIN->add('logging', $temp);

    foreach (core_plugin_manager::instance()->get_plugins_of_type('logstore') as $plugin) {
        $plugin->load_settings($ADMIN, 'logging', $hassiteconfig);
    }
}
`;
}

function createPatchedHttpsreplaceSettingsPhp() {
  return `<?php
defined('MOODLE_INTERNAL') || die;

if ($hassiteconfig) {
    $pluginname = get_string('pluginname', 'tool_httpsreplace');
    $url = $CFG->wwwroot.'/'.$CFG->admin.'/tool/httpsreplace/index.php';
    $ADMIN->add('security', new admin_externalpage('toolhttpsreplace', $pluginname, $url, 'moodle/site:config', true));

    $httpsecurity = $ADMIN->locate('httpsecurity');
    if ($httpsecurity) {
        $httpsreplaceurl = $CFG->wwwroot.'/'.$CFG->admin.'/tool/httpsreplace/index.php';
        $httpsecurity->add(
            new admin_setting_heading(
                'tool_httpsreplaceheader',
                new lang_string('pluginname', 'tool_httpsreplace'),
                new lang_string('toolintro', 'tool_httpsreplace', $httpsreplaceurl)
            )
        );
    }
}
`;
}

async function patchRuntimePhpSources(php, webRoot) {
  const patchFile = async (path, replacers) => {
    const current = textDecoder.decode(await php.readFile(path));
    let next = current;
    for (const [search, replace] of replacers) {
      if (next.includes(search)) {
        next = next.replace(search, replace);
      }
    }
    if (next !== current) {
      await php.writeFile(path, textEncoder.encode(next));
    }
  };

  const rp = buildRuntimePaths(webRoot);

  await patchFile(rp.CACHE_CONFIG_PATH, [
    [
      "debugging('Invalid cache store in config. Missing name or plugin.', DEBUG_DEVELOPER);",
      "if (!(defined('CACHE_DISABLE_ALL') && CACHE_DISABLE_ALL)) { debugging('Invalid cache store in config. Missing name or plugin.', DEBUG_DEVELOPER); }",
    ],
    [
      "debugging('Invalid cache store in config. Not an available plugin.', DEBUG_DEVELOPER);",
      "if (!(defined('CACHE_DISABLE_ALL') && CACHE_DISABLE_ALL)) { debugging('Invalid cache store in config. Not an available plugin.', DEBUG_DEVELOPER); }",
    ],
    [
      "debugging('A cache mode mapping entry is invalid.', DEBUG_DEVELOPER);",
      "if (!(defined('CACHE_DISABLE_ALL') && CACHE_DISABLE_ALL)) { debugging('A cache mode mapping entry is invalid.', DEBUG_DEVELOPER); }",
    ],
    [
      "debugging('A cache mode mapping exists for a mode or store that does not exist.', DEBUG_DEVELOPER);",
      "if (!(defined('CACHE_DISABLE_ALL') && CACHE_DISABLE_ALL)) { debugging('A cache mode mapping exists for a mode or store that does not exist.', DEBUG_DEVELOPER); }",
    ],
  ]);

  // In WASM, the filesystem scan triggered by IGNORE_COMPONENT_CACHE produces an
  // incomplete component registry (missing plugins, themes, lang strings, classes).
  // Patch core_component::init() to skip the scan and fall through to the prebuilt
  // alternative_component_cache when PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE is set.
  await patchFile(rp.COMPONENT_CLASS_PATH, [
    [
      "if (defined('IGNORE_COMPONENT_CACHE') && IGNORE_COMPONENT_CACHE) {\n            self::fill_all_caches();\n            return;\n        }",
      "if (defined('IGNORE_COMPONENT_CACHE') && IGNORE_COMPONENT_CACHE\n                && !(defined('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE') && PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE)) {\n            self::fill_all_caches();\n            return;\n        }",
    ],
  ]);

  // PLAYGROUND: the ephemeral runtime never needs upgrading — the VFS image
  // and the snapshot are built together. moodle_needs_upgrading() returns true
  // when allversionshash is missing or stale, causing /my/ to redirect to admin.
  await patchFile(rp.MOODLELIB_PATH, [
    [
      "function moodle_needs_upgrading($checkupgradeflag = true) {",
      "function moodle_needs_upgrading($checkupgradeflag = true) {\n    return false; // PLAYGROUND: ephemeral runtime, no upgrades possible",
    ],
  ]);

  await patchFile(rp.ADMINLIB_PATH, [
    [
      "        $parent = $this->locate($parentname);\n        if (is_null($parent)) {\n            debugging('parent does not exist!');\n            return false;\n        }",
      "        $parent = $this->locate($parentname);\n        if (is_null($parent)) {\n            return false;\n        }",
    ],
    // PLAYGROUND: skip the "new admin settings" check that causes admin/index.php
    // to redirect to ?cache=1 on every page load. admin_apply_default_settings()
    // doesn't cover all settings (some return NULL from get_setting() even after
    // defaults are applied), so we neutralize the check entirely.
    [
      "function any_new_admin_settings($node) {",
      "function any_new_admin_settings($node) {\n    return false; // PLAYGROUND: skip new settings redirect\n    // Original implementation follows (unreachable):",
    ],
    // glob() returns [] on the readonly WASM VFS because musl's libc glob
    // doesn't go through Emscripten's FS.readdir(). We replace the glob loop
    // with a hardcoded list of admin settings files from Moodle core.
    [
      "        foreach (glob($CFG->dirroot.'/'.$CFG->admin.'/settings/*.php') as $file) {\n            if ($file == $CFG->dirroot.'/'.$CFG->admin.'/settings/top.php') {\n                continue;\n            }\n            if ($file == $CFG->dirroot.'/'.$CFG->admin.'/settings/plugins.php') {\n            // plugins are loaded last - they may insert pages anywhere\n                continue;\n            }\n            require($file);",
      "        $__settingsdir = $CFG->dirroot.'/'.$CFG->admin.'/settings';\n        foreach (['ai','analytics','appearance','badges','competency','courses','development','fileredact','frontpage','grades','h5p','language','license','location','messaging','mnet','moodlenet','payment','reportbuilder','security','server','subsystems','userfeedback','users'] as $__sf) {\n            $file = $__settingsdir . '/' . $__sf . '.php';\n            if (!file_exists($file)) { continue; }\n            require($file);",
    ],
  ]);
}

async function prepareMoodleRuntime({
  php,
  archive,
  manifestState,
  savedManifestState,
  configPhp,
  installRunnerPhp,
  pdoProbePhp,
  pdoDdlProbePhp,
  configNormalizerPhp,
  publish,
  allowDiagnostics = false,
  webRoot = MOODLE_ROOT,
}) {
  const shouldMountArchive = !manifestStateMatches(
    savedManifestState,
    manifestState,
  );
  const rp = buildRuntimePaths(webRoot);
  const internalFiles = buildInternalRuntimeFiles(webRoot);

  const tDirs = performance.now();
  await ensureDir(php, DOCROOT);
  await ensureDir(php, MOODLE_ROOT);
  // For 5.1+, ensure the public/ subdirectory exists before VFS mount
  if (webRoot !== MOODLE_ROOT) {
    await ensureDir(php, webRoot);
  }
  await ensureDir(php, MOODLEDATA_ROOT);
  await ensureDir(php, `${MOODLEDATA_ROOT}/cache`);
  await ensureDir(php, `${MOODLEDATA_ROOT}/localcache`);
  await ensureDir(php, `${MOODLEDATA_ROOT}/muc`);
  await ensureDir(php, `${MOODLEDATA_ROOT}/sessions`);
  await ensureDir(php, TEMP_ROOT);
  await ensureDir(php, `${TEMP_ROOT}/sessions`);
  await ensureDir(php, CONFIG_ROOT);
  const dirsMs = Math.round(performance.now() - tDirs);

  const tMount = performance.now();
  if (archive.kind === "vfs-image") {
    publish(
      shouldMountArchive
        ? "Mounting the readonly Moodle VFS image."
        : "Reusing the readonly Moodle VFS image.",
      0.56,
    );
    const binary = await php.binary;
    mountReadonlyVfs(binary, {
      imageBytes: archive.bytes,
      entries: archive.image.entries || [],
      mountPath: MOODLE_ROOT,
      writablePaths: internalFiles,
    });
  } else {
    publish("Writing fallback Moodle bundle into the runtime VFS.", 0.58);
    const entries = extractZipEntries(archive.bytes);
    await writeEntriesToPhp(php, entries, MOODLE_ROOT, ({ ratio, path }) => {
      publish(`Writing ${path}`, 0.58 + ratio * 0.2);
    });
  }
  const mountMs = Math.round(performance.now() - tMount);

  const tFiles = performance.now();
  await php.writeFile(
    `${MOODLE_ROOT}/config.php`,
    textEncoder.encode(configPhp),
  );
  await php.writeFile(
    rp.AUTOLOAD_CHECK_PATH,
    textEncoder.encode(createAutoloadCheckPhp()),
  );
  await php.writeFile(
    rp.INSTALL_CHECK_PATH,
    textEncoder.encode(createInstallCheckPhp()),
  );
  await php.writeFile(
    rp.INSTALL_RUNNER_PATH,
    textEncoder.encode(installRunnerPhp),
  );
  await php.writeFile(rp.PDO_PROBE_PATH, textEncoder.encode(pdoProbePhp));
  await php.writeFile(
    rp.PDO_DDL_PROBE_PATH,
    textEncoder.encode(pdoDdlProbePhp),
  );
  await php.writeFile(
    rp.CONFIG_NORMALIZER_PATH,
    textEncoder.encode(configNormalizerPhp),
  );
  await php.writeFile(
    rp.ADMIN_DEFAULTS_SEEDER_PATH,
    textEncoder.encode(createAdminDefaultsSeederPhp()),
  );
  await php.writeFile(
    rp.DATAPRIVACY_SETTINGS_PATH,
    textEncoder.encode(createPatchedDataprivacySettingsPhp()),
  );
  await php.writeFile(
    rp.LOG_SETTINGS_PATH,
    textEncoder.encode(createPatchedLogSettingsPhp()),
  );
  await php.writeFile(
    rp.HTTPSREPLACE_SETTINGS_PATH,
    textEncoder.encode(createPatchedHttpsreplaceSettingsPhp()),
  );
  await php.writeFile(
    rp.THEME_CSS_WARMUP_PATH,
    textEncoder.encode(createThemeCssWarmupPhp()),
  );
  const filesMs = Math.round(performance.now() - tFiles);

  const tPatch = performance.now();
  await patchRuntimePhpSources(php, webRoot);
  const patchMs = Math.round(performance.now() - tPatch);

  publish(
    `Prepare sub-timings: dirs=${dirsMs}ms mount=${mountMs}ms files=${filesMs}ms patches=${patchMs}ms`,
    0.83,
  );

  if (allowDiagnostics) {
    await writeJsonFile(php, MANIFEST_STATE_PATH, {
      ...manifestState,
      updatedAt: nowIso(),
    });
  }

  return { shouldMountArchive };
}

async function loadInstallSnapshot(
  php,
  { dbFile, appBaseUrl, publish, moodleBranch },
) {
  const branch = moodleBranch || DEFAULT_MOODLE_BRANCH;
  const meta = getBranchMetadata(branch);

  // Try branch-specific snapshot first, then fall back to legacy path
  const snapshotPaths = [];
  if (meta) {
    snapshotPaths.push(`assets/moodle/${meta.snapshotDir}/install.sq3`);
  }
  snapshotPaths.push("assets/moodle/snapshot/install.sq3");

  publish("Downloading pre-installed database snapshot.", 0.87);

  let response;
  for (const snapshotPath of snapshotPaths) {
    const snapshotUrl = new URL(`./${snapshotPath}`, appBaseUrl);
    try {
      response = await fetch(snapshotUrl);
      if (response.ok) {
        break;
      }
      response = null;
    } catch {
      response = null;
    }
  }

  if (!response || !response.ok) {
    publish("Snapshot not available, falling back to full install.", 0.875);
    return false;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 100) {
    publish("Snapshot too small, falling back to full install.", 0.875);
    return false;
  }

  await php.writeFile(dbFile, bytes);

  // Note: $CFG->wwwroot comes from config.php (already written by
  // prepareMoodleRuntime), not from mdl_config. No DB rewriting needed.

  publish(`Pre-installed snapshot loaded (${bytes.length} bytes).`, 0.885);
  return true;
}

async function runProvisioningCheck(php, webRoot) {
  const payload = await requestRuntimeScript(
    php,
    "/__install_check.php",
    undefined,
    webRoot,
  );
  const jsonStart = payload.lastIndexOf("\n{");
  const candidate =
    jsonStart >= 0 ? payload.slice(jsonStart + 1) : payload.trim();

  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`Provisioning check returned non-JSON output: ${payload}`);
  }
}

async function runCliProvisioning(php, publish, webRoot) {
  const stages = [
    { id: "core", label: "Installing Moodle core schema." },
    { id: "plugins", label: "Installing bundled Moodle plugins." },
    { id: "finalize", label: "Finalizing Moodle admin and site defaults." },
    { id: "themes", label: "Building Moodle theme caches." },
  ];

  const outputs = [];
  for (const [index, stage] of stages.entries()) {
    const stageStart = performance.now();
    publish(stage.label, 0.89 + index * 0.01);
    const output = await requestRuntimeScript(
      php,
      "/__install_database.php",
      { stage: stage.id },
      webRoot,
    );
    const stageMs = Math.round(performance.now() - stageStart);
    publish(`${stage.label} [${stageMs}ms]`, 0.89 + (index + 0.5) * 0.01);
    outputs.push({ stage: stage.id, output });
  }

  return {
    output: outputs
      .map((entry) => `# ${entry.stage}\n${entry.output}`)
      .join("\n"),
    errorOutput: "",
  };
}

async function runPdoProbe(php, webRoot) {
  const output = await requestRuntimeScript(
    php,
    "/__pdo_probe.php",
    undefined,
    webRoot,
  );
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return {
    ...(jsonPayload ? JSON.parse(jsonPayload) : {}),
    errorOutput: "",
  };
}

async function _runPdoDdlProbe(php, webRoot) {
  const output = await requestRuntimeScript(
    php,
    "/__pdo_ddl_probe.php",
    undefined,
    webRoot,
  );
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return jsonPayload ? JSON.parse(jsonPayload) : {};
}

async function runConfigNormalizer(php, webRoot) {
  const output = await requestRuntimeScript(
    php,
    "/__config_normalizer.php",
    undefined,
    webRoot,
  );
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return jsonPayload ? JSON.parse(jsonPayload) : {};
}

async function runAdminDefaultsSeeder(php, webRoot) {
  const output = await requestRuntimeScript(
    php,
    "/__admin_defaults_seeder.php",
    undefined,
    webRoot,
  );
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return jsonPayload ? JSON.parse(jsonPayload) : {};
}

async function runThemeCssWarmup(php, webRoot) {
  const output = await requestRuntimeScript(
    php,
    "/__theme_css_warmup.php",
    undefined,
    webRoot,
  );
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return jsonPayload ? JSON.parse(jsonPayload) : {};
}

async function requestRuntimeScript(
  php,
  path,
  searchParams,
  webRoot = MOODLE_ROOT,
) {
  const url = new URL(path, "https://bootstrap.local/");

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const runtimePath = `${webRoot}${url.pathname}`;
  const beforeRequest = await php.analyzePath(runtimePath);
  const response = await php.request(new Request(url));
  const body = textDecoder.decode(await response.arrayBuffer());

  if (!response.ok) {
    const afterRequest = await php.analyzePath(runtimePath);
    const beforeMode =
      beforeRequest?.exists && beforeRequest.object
        ? beforeRequest.object.mode
        : null;
    const afterMode =
      afterRequest?.exists && afterRequest.object
        ? afterRequest.object.mode
        : null;
    throw new Error(
      `Runtime bootstrap request failed for ${url.pathname}: HTTP ${response.status}: ${body}\n` +
        `Resolved FS path: ${runtimePath}\n` +
        `FS existed before request: ${Boolean(beforeRequest?.exists)}${beforeMode != null ? ` mode=${beforeMode}` : ""}\n` +
        `FS exists after request: ${Boolean(afterRequest?.exists)}${afterMode != null ? ` mode=${afterMode}` : ""}`,
    );
  }

  return body;
}

export async function bootstrapMoodle({
  config,
  blueprint,
  php,
  publish,
  runtimeId,
  scopeId,
  appBaseUrl,
  origin,
  moodleBranch,
  webRoot: webRootParam,
}) {
  const runtime =
    config.runtimes.find((entry) => entry.id === runtimeId) ||
    config.runtimes[0];
  const blueprintOverlay = buildInstallConfig(blueprint);
  // Extract debug settings from blueprint runtime section
  const blueprintRuntime = blueprint?.runtime || {};
  const effectiveDebug =
    blueprintRuntime.debug != null ? Number(blueprintRuntime.debug) : 0;
  const effectiveDebugDisplay =
    blueprintRuntime.debugdisplay != null
      ? Number(blueprintRuntime.debugdisplay)
      : 0;
  const effectiveConfig = {
    ...config,
    ...(blueprintOverlay.siteTitle
      ? { siteTitle: blueprintOverlay.siteTitle }
      : {}),
    ...(blueprintOverlay.locale ? { locale: blueprintOverlay.locale } : {}),
    ...(blueprintOverlay.timezone
      ? { timezone: blueprintOverlay.timezone }
      : {}),
    ...(blueprintOverlay.landingPath
      ? { landingPath: blueprintOverlay.landingPath }
      : {}),
    admin: {
      ...config.admin,
      ...(blueprintOverlay.admin || {}),
    },
    debug: effectiveDebug,
    debugdisplay: effectiveDebugDisplay,
  };
  const resolvedBranch = moodleBranch || DEFAULT_MOODLE_BRANCH;
  const branchMeta = getBranchMetadata(resolvedBranch);
  const webRoot = webRootParam || branchMeta?.webRoot || MOODLE_ROOT;
  const tArchive = performance.now();
  const manifestUrl = await resolveManifestUrl(
    resolvedBranch,
    appBaseUrl || self.location.href,
  );
  let archive = await resolveBootstrapArchive(
    {
      manifestUrl,
    },
    ({ ratio, cached, phase, detail }) => {
      if (phase === "manifest") {
        publish(detail, 0.16);
        return;
      }

      if (phase === "cache-bust") {
        publish(detail, 0.24);
        return;
      }

      const progress = cached
        ? 0.44
        : 0.2 + (typeof ratio === "number" ? ratio * 0.22 : 0.22);
      // Only publish at ~10% intervals to avoid log spam
      const pct = Math.floor((typeof ratio === "number" ? ratio : 0) * 10);
      if (cached || pct !== bootstrapMoodle._lastDownloadPct) {
        bootstrapMoodle._lastDownloadPct = pct;
        const label =
          typeof ratio === "number"
            ? `Downloading Moodle bundle (${Math.round(ratio * 100)}%).`
            : detail || "Downloading Moodle bundle.";
        publish(label, progress);
      }
    },
  );
  const archiveMs = Math.round(performance.now() - tArchive);
  publish(`Bundle resolved in ${archiveMs}ms.`, 0.45);

  if (
    runtime.mountStrategy === "zip-extract" &&
    archive.manifest?.bundle?.url
  ) {
    const tZip = performance.now();
    publish(
      "Switching Moodle runtime to ZIP extraction to avoid readonly VFS parser issues.",
      0.5,
    );
    const zipBytes = await fetchBundleWithCache(
      archive.manifest,
      ({ ratio, cached }) => {
        const progress = cached
          ? 0.56
          : 0.5 + (typeof ratio === "number" ? ratio * 0.12 : 0.12);
        publish("Downloading writable Moodle ZIP bundle.", progress);
      },
    );

    archive = {
      kind: "zip",
      manifest: archive.manifest,
      bytes: zipBytes,
      sourceUrl: archive.manifest.bundle.url,
    };
    const zipMs = Math.round(performance.now() - tZip);
    publish(`ZIP extraction completed in ${zipMs}ms.`, 0.56);
  }

  const manifestState = buildManifestState(
    archive.manifest,
    runtimeId,
    config.bundleVersion,
  );
  const savedManifestState = await readJsonFile(php, MANIFEST_STATE_PATH);

  const wwwroot = buildPublicBase(appBaseUrl || origin);
  const dbName = buildDatabaseName(scopeId, runtimeId);
  const dbFile = buildDatabaseFilePath(scopeId, runtimeId);
  const installStatePath = buildInstallStatePath(scopeId, runtimeId);
  const savedInstallState = await readJsonFile(php, installStatePath);
  const dbConfig = {
    dbFile,
    dbHost: "localhost",
    dbName,
    dbPassword: "",
    dbUser: "",
  };
  const installRunnerPhp = createInstallRunnerPhp(effectiveConfig);
  const pdoProbePhp = createPdoProbePhp(dbConfig);
  const pdoDdlProbePhp = createPdoDdlProbePhp(dbConfig);
  const configNormalizerPhp = createConfigNormalizerPhp(effectiveConfig.debug);
  const configPhp = createMoodleConfigPhp({
    adminDirectory: ADMIN_DIRECTORY,
    componentCachePath: COMPONENT_CACHE_PATH,
    moodleRoot: webRoot,
    ...dbConfig,
    prefix: "mdl_",
    wwwroot,
    debugdisplay: effectiveConfig.debugdisplay,
  });

  const tPrepare = performance.now();
  publish("Writing Moodle runtime configuration.", 0.84);
  await prepareMoodleRuntime({
    php,
    archive,
    manifestState,
    savedManifestState,
    configPhp,
    installRunnerPhp,
    pdoProbePhp,
    pdoDdlProbePhp,
    configNormalizerPhp,
    publish,
    allowDiagnostics: true,
    webRoot,
  });
  const prepareMs = Math.round(performance.now() - tPrepare);
  publish(`Runtime preparation completed in ${prepareMs}ms.`, 0.86);

  // Update php.ini entries if blueprint specifies non-default timezone or debug display
  const iniOverrides = {};
  if (effectiveConfig.timezone && effectiveConfig.timezone !== "UTC") {
    iniOverrides["date.timezone"] = effectiveConfig.timezone;
  }
  if (effectiveConfig.debugdisplay) {
    iniOverrides.display_errors = "1";
    iniOverrides.display_startup_errors = "1";
  }
  if (Object.keys(iniOverrides).length > 0) {
    await setPhpIniEntries(php._php, iniOverrides);
  }

  const tPdo = performance.now();
  publish("Probing PDO SQLite connectivity.", 0.865);
  const pdoProbe = await runPdoProbe(php, webRoot);
  const pdoMs = Math.round(performance.now() - tPdo);
  if (pdoProbe.ok) {
    publish(
      `PDO SQLite probe connected successfully with ${pdoProbe.dsn}. [${pdoMs}ms]`,
      0.868,
    );
  } else {
    const detail = pdoProbe.error?.message || "SQLite PDO connection failed.";
    publish(`PDO SQLite probe failed: ${detail} [${pdoMs}ms]`, 0.868);
  }

  publish(
    "Skipping standalone SQLite DDL probe and continuing with Moodle bootstrap.",
    0.869,
  );

  let installState = null;
  const hasSavedInstallState = Boolean(savedInstallState?.installed);
  let installMarkerMatches = installStateMatches(
    savedInstallState,
    manifestState,
    dbName,
  );

  if (installMarkerMatches) {
    publish(
      "Using persisted install marker to skip Moodle install checks.",
      0.87,
    );
  } else if (hasSavedInstallState) {
    publish("Checking whether Moodle is already installed.", 0.87);
    installState = await runProvisioningCheck(php, webRoot);
    if (installState.error) {
      publish(
        `Provisioning check failed: ${installState.error.type}: ${installState.error.message}`,
        0.88,
      );
    } else if (installState.installed) {
      publish("Moodle installation detected from the config table.", 0.885);
      await writeJsonFile(php, installStatePath, {
        ...manifestState,
        dbName,
        installed: true,
        updatedAt: nowIso(),
      });
      installMarkerMatches = true;
    }
  } else {
    publish(
      "No persisted install marker found. Checking if Moodle is already installed in the database.",
      0.87,
    );
    try {
      installState = await runProvisioningCheck(php, webRoot);
      if (installState.installed) {
        publish(
          "Moodle installation detected from the config table (marker was missing).",
          0.885,
        );
        await writeJsonFile(php, installStatePath, {
          ...manifestState,
          dbName,
          installed: true,
          updatedAt: nowIso(),
        });
        installMarkerMatches = true;
      }
    } catch {
      publish(
        "Provisioning check failed — will proceed with fresh install.",
        0.88,
      );
    }
  }

  if (!installMarkerMatches && !installState?.installed) {
    const tInstall = performance.now();

    // Try loading a pre-built install snapshot first (skips the 3-8s install)
    const snapshotLoaded = await loadInstallSnapshot(php, {
      dbFile,
      appBaseUrl: appBaseUrl || origin,
      publish,
      moodleBranch: resolvedBranch,
    });

    if (snapshotLoaded) {
      await writeJsonFile(php, installStatePath, {
        ...manifestState,
        dbName,
        installed: true,
        source: "snapshot",
        updatedAt: nowIso(),
      });
      const snapshotMs = Math.round(performance.now() - tInstall);
      publish(
        `Install snapshot loaded in ${snapshotMs}ms (skipped full install).`,
        0.91,
      );
    } else {
      // Fallback: run the full Moodle CLI installer
      publish("Running Moodle installation inside the CGI runtime.", 0.89);
      const provisioningResult = await runCliProvisioning(
        php,
        publish,
        webRoot,
      );
      if (provisioningResult.errorOutput.trim()) {
        publish(
          `CLI installer stderr: ${provisioningResult.errorOutput.slice(0, 400)}`,
          0.9,
        );
      }
      if (
        /fatal error|warning|exception|error/iu.test(
          provisioningResult.errorOutput,
        ) &&
        !/cliinstallfinished/iu.test(provisioningResult.output)
      ) {
        throw new Error(
          `Moodle CLI provisioning failed: ${provisioningResult.errorOutput || provisioningResult.output}`,
        );
      }
      await writeJsonFile(php, installStatePath, {
        ...manifestState,
        dbName,
        installed: true,
        source: "cli",
        updatedAt: nowIso(),
      });
      const installMs = Math.round(performance.now() - tInstall);
      publish(`Moodle CLI provisioning finished in ${installMs}ms.`, 0.91);

      // Verify database is accessible after install
      try {
        const verifyResult = await php.run(`<?php
          error_reporting(0);
          $dbFile = '${escapePhpSingleQuoted(dbFile)}';
          $result = ['dbFileExists' => file_exists($dbFile), 'dbFileSize' => @filesize($dbFile)];
          try {
            $pdo = new PDO('sqlite:' . $dbFile);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $version = $pdo->query("SELECT value FROM mdl_config WHERE name = 'version'")->fetchColumn();
            $result['version'] = $version;
            $result['tableCount'] = $pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")->fetchColumn();
          } catch (Throwable $e) {
            $result['error'] = $e->getMessage();
          }
          echo json_encode($result);
        `);
        publish(`Post-install DB verify: ${verifyResult.text}`, 0.915);
      } catch (verifyError) {
        publish(`Post-install DB verify failed: ${verifyError.message}`, 0.915);
      }
    }
  } else {
    publish(
      "Moodle database already installed, skipping CLI provisioning.",
      0.89,
    );
  }

  const tNorm = performance.now();
  publish("Normalizing persisted Moodle configuration defaults.", 0.915);
  const configNormalizer = await runConfigNormalizer(php, webRoot);
  const normMs = Math.round(performance.now() - tNorm);
  if (configNormalizer?.ok) {
    const setKeys = Object.keys(configNormalizer.set || {});
    publish(
      setKeys.length > 0
        ? `Seeded missing config defaults: ${setKeys.join(", ")}. [${normMs}ms]`
        : `Persisted config defaults already present. [${normMs}ms]`,
      0.918,
    );
  } else if (configNormalizer?.error?.message) {
    publish(
      `Config default normalization failed: ${configNormalizer.error.message} [${normMs}ms]`,
      0.918,
    );
  }

  // Apply ALL admin default settings with CACHE_DISABLE_ALL = false (matching the
  // runtime config.php). This catches cache-store plugin settings and any other
  // admin settings only registered when MUC is active, preventing
  // any_new_admin_settings() from redirecting to upgradesettings.php.
  const tAdminDefaults = performance.now();
  const adminDefaults = await runAdminDefaultsSeeder(php, webRoot);
  const adminDefaultsMs = Math.round(performance.now() - tAdminDefaults);
  if (adminDefaults?.ok) {
    publish(`Admin default settings applied. [${adminDefaultsMs}ms]`, 0.919);
  } else if (adminDefaults?.error?.message) {
    publish(
      `Admin defaults seeder failed: ${adminDefaults.error.message} [${adminDefaultsMs}ms]`,
      0.919,
    );
  }

  // Pre-compile theme CSS so that theme/styles.php can serve it from cache.
  // SCSS compilation is memory-intensive and can crash the WASM runtime if
  // triggered lazily on the first HTTP request.  Warming the cache here
  // (during the loading screen) avoids that runtime crash.
  const tThemeCss = performance.now();
  try {
    publish("Compiling theme CSS (this may take a moment).", 0.92);
    const themeCss = await runThemeCssWarmup(php, webRoot);
    const themeCssMs = Math.round(performance.now() - tThemeCss);
    if (themeCss?.ok) {
      publish(
        `Theme CSS compiled and cached (${themeCss.size} bytes, rev ${themeCss.rev}). [${themeCssMs}ms]`,
        0.925,
      );
    } else {
      publish(
        `Theme CSS warmup failed: ${themeCss?.error?.message || "unknown error"}. [${themeCssMs}ms]`,
        0.925,
      );
    }
  } catch (themeCssError) {
    const themeCssMs = Math.round(performance.now() - tThemeCss);
    publish(
      `Theme CSS warmup crashed (${themeCssError.message}). Pages may be unstyled. [${themeCssMs}ms]`,
      0.925,
    );
  }

  publish(
    "Skipping custom Moodle autoload diagnostics for the current runtime strategy.",
    0.93,
  );

  publish(
    "All PHP extensions are provided by the @php-wasm/web runtime.",
    0.94,
  );

  // Blueprint step execution: run user-defined provisioning steps (categories,
  // courses, users, enrolments, etc.) between config normalization and auto-login.
  let blueprintLandingPage = null;
  const hasLoginStep = blueprint?.steps?.some((s) => s.step === "login");
  if (blueprint?.steps?.length > 0) {
    try {
      const { executeBlueprint } = await import("../blueprint/executor.js");
      const result = await executeBlueprint(blueprint, {
        php,
        publish,
        appBaseUrl,
        webRoot,
        scopeId,
        runtimeId,
      });
      if (result.landingPage) {
        blueprintLandingPage = result.landingPage;
      }
      if (!result.success) {
        publish(
          `Blueprint failed at step ${result.failedStep}: ${result.error}`,
          0.95,
        );
      }
    } catch (blueprintError) {
      publish(`Blueprint execution error: ${blueprintError.message}`, 0.95);
    }
  }

  // Auto-login: create a Moodle session for the admin user so the playground
  // opens directly to the dashboard, just like WordPress Playground does.
  // If the blueprint already includes a `login` step, skip this hardcoded login.
  const AUTO_LOGIN_PATH = `${webRoot}/__playground_autologin.php`;
  let readyPath = blueprintLandingPage || "/my/";
  if (!hasLoginStep) {
    try {
      publish("Creating admin session for auto-login.", 0.95);
      const autoLoginPhp = [
        "<?php",
        "define('NO_OUTPUT_BUFFERING', true);",
        "require(__DIR__ . '/config.php');",
        "$admin = get_admin();",
        "complete_user_login($admin);",
        "echo json_encode(['ok' => true, 'user' => $admin->username]);",
      ].join("\n");
      await php.writeFile(
        AUTO_LOGIN_PATH,
        new TextEncoder().encode(autoLoginPhp),
      );
      const loginResponse = await php.request(
        new Request("http://localhost:8080/__playground_autologin.php"),
      );
      const loginText = await loginResponse.text();
      if (loginResponse.status === 200 && loginText.includes('"ok"')) {
        publish("Auto-login session created for admin user.", 0.96);
      } else {
        publish(
          "Auto-login returned unexpected response, falling back to login page.",
          0.96,
        );
        readyPath = "/login/index.php";
      }
    } catch (loginError) {
      publish(
        "Auto-login failed: " +
          loginError.message +
          ". Falling back to login page.",
        0.96,
      );
      readyPath = "/login/index.php";
    }
    // Clean up the temporary auto-login script
    try {
      await php.run(`<?php @unlink('${AUTO_LOGIN_PATH}');`);
    } catch {
      /* non-fatal */
    }
  }

  return {
    manifest: archive.manifest,
    manifestState,
    readyPath,
  };
}
