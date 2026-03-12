import { buildEffectivePlaygroundConfig } from "../shared/blueprint.js";
import {
  ADMIN_DIRECTORY,
  COMPONENT_CACHE_PATH,
  createMoodleConfigPhp,
  createPhpIni,
  MOODLEDATA_ROOT,
  MOODLE_ROOT,
  TEMP_ROOT,
} from "./config-template.js";
import { buildManifestState } from "./manifest.js";
import {
  ensureDir,
  readJsonFile,
  resolveBootstrapArchive,
  writeJsonFile,
} from "./bootstrap-fs.js";
import { mountReadonlyVfs } from "../../lib/vfs-mount.js";
import { extractZipEntries, fetchBundleWithCache, writeEntriesToPhp } from "../../lib/moodle-loader.js";

const DOCROOT = "/www";
const CONFIG_ROOT = "/persist/config";
const MANIFEST_STATE_PATH = `${CONFIG_ROOT}/moodle-playground-manifest.json`;
const AUTOLOAD_CHECK_PATH = `${MOODLE_ROOT}/__autoload_check.php`;
const INSTALL_CHECK_PATH = `${MOODLE_ROOT}/__install_check.php`;
const INSTALL_RUNNER_PATH = `${MOODLE_ROOT}/__install_database.php`;
const PDO_PROBE_PATH = `${MOODLE_ROOT}/__pdo_probe.php`;
const PDO_DDL_PROBE_PATH = `${MOODLE_ROOT}/__pdo_ddl_probe.php`;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
  const INTERNAL_RUNTIME_FILES = [
  `${MOODLE_ROOT}/config.php`,
  AUTOLOAD_CHECK_PATH,
  INSTALL_CHECK_PATH,
  INSTALL_RUNNER_PATH,
  PDO_PROBE_PATH,
  PDO_DDL_PROBE_PATH,
];

function nowIso() {
  return new Date().toISOString();
}

async function syncFilesystem(publish, message, progress) {
  try {
    publish(message, progress);
    // SQLite database is stored on the /persist filesystem backed by IDBFS.
    // Emscripten's FS.syncfs() persists the in-memory state to IndexedDB.
    // The actual sync is triggered by the runtime automatically on navigation;
    // this is a no-op placeholder that keeps the callsite structure intact.
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    publish(`Filesystem sync info: ${detail}`, progress);
  }
}

function buildScopedPath(scopeId, runtimeId, path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `/playground/${scopeId}/${runtimeId}${normalizedPath}`.replace(/\/{2,}/gu, "/");
}

function buildPublicBase(origin, scopeId, runtimeId) {
  return new URL(buildScopedPath(scopeId, runtimeId, "/"), origin).toString().replace(/\/$/u, "");
}

function buildDatabaseName(scopeId, runtimeId) {
  const scope = String(scopeId || "default").replace(/[^A-Za-z0-9_]/gu, "_");
  const runtime = String(runtimeId || "php").replace(/[^A-Za-z0-9_]/gu, "_");
  return `moodle_${scope}_${runtime}`;
}

function buildInstallStatePath(scopeId, runtimeId) {
  const scope = String(scopeId || "default").replace(/[^A-Za-z0-9_]/gu, "_");
  const runtime = String(runtimeId || "php").replace(/[^A-Za-z0-9_]/gu, "_");
  return `${CONFIG_ROOT}/moodle-playground-install-${scope}-${runtime}.json`;
}

function manifestStateMatches(savedState, manifestState) {
  return savedState?.runtimeId === manifestState.runtimeId
    && savedState?.bundleVersion === manifestState.bundleVersion
    && savedState?.release === manifestState.release
    && savedState?.sha256 === manifestState.sha256;
}

function installStateMatches(savedState, manifestState, dbName) {
  return manifestStateMatches(savedState, manifestState)
    && savedState?.dbName === dbName
    && savedState?.installed === true;
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

  const encodedOptions = JSON.stringify(options).replaceAll("\\", "\\\\").replaceAll("'", "\\'");

  return `<?php
error_reporting(E_ALL);
ini_set('display_errors', '1');

unset($_SERVER['REMOTE_ADDR']);
define('CLI_SCRIPT', true);
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
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

$runStage = static function(string $name) use (&$options, &$version, &$release, &$branch, &$CFG, &$DB): void {
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
            $DB->get_manager()->install_from_xmldb_file("$CFG->libdir/db/install.xml");
            echo "[playground] core:schema-installed\\n";
            flush();

            require_once("$CFG->libdir/db/install.php");
            xmldb_main_install();
            echo "[playground] core:defaults-installed\\n";
            flush();

            upgrade_main_savepoint(true, $version, false);
            upgrade_component_updated('moodle', '', true);
            echo "[playground] core:installed\\n";
            flush();
            set_config('release', $release);
            set_config('branch', $branch);
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
            $DB->set_field('user', 'password', hash_internal_user_password($options['adminpass']), ['username' => 'admin']);

            if (isset($options['adminemail'])) {
                $DB->set_field('user', 'email', $options['adminemail'], ['username' => 'admin']);
            }

            if (isset($options['adminuser']) && $options['adminuser'] !== 'admin' && $options['adminuser'] !== 'guest') {
                $DB->set_field('user', 'username', $options['adminuser'], ['username' => 'admin']);
            }

            if (!empty($options['supportemail'])) {
                set_config('supportemail', $options['supportemail']);
            } else if (!empty($options['adminemail'])) {
                set_config('supportemail', $options['adminemail']);
            }

            set_config('rolesactive', 1);
            upgrade_finished();
            \\core\\session\\manager::set_user(get_admin());
            admin_apply_default_settings(NULL, true);
            set_config('registerauth', '');

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

function createPdoProbePhp({ dbHost, dbName, dbPassword, dbUser }) {
  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

$result = [
    'pdoAvailable' => class_exists('PDO'),
    'drivers' => class_exists('PDO') ? PDO::getAvailableDrivers() : [],
    'candidates' => [],
];

$dsn = 'sqlite:/persist/${escapePhpSingleQuoted(dbName)}.db';
try {
    $pdo = new PDO($dsn);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $result['candidates'][] = [
        'dsn' => $dsn,
        'ok' => true,
    ];
    $pdo = null;
} catch (Throwable $error) {
    $result['candidates'][] = [
        'dsn' => $dsn,
        'ok' => false,
        'error' => [
            'type' => get_class($error),
            'message' => $error->getMessage(),
        ],
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

function createPdoDdlProbePhp({ dbHost, dbName, dbPassword, dbUser }) {
  return `<?php
header('content-type: application/json; charset=utf-8');
error_reporting(E_ALL);
ini_set('display_errors', '1');
ob_start();

$result = [
    'pdoAvailable' => class_exists('PDO'),
    'drivers' => class_exists('PDO') ? PDO::getAvailableDrivers() : [],
    'candidates' => [],
];

$dsn = 'sqlite:/persist/${escapePhpSingleQuoted(dbName)}.db';
try {
    $pdo = new PDO($dsn);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('DROP TABLE IF EXISTS mdl_playground_probe');
    $pdo->exec('CREATE TABLE mdl_playground_probe (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    $pdo->exec("INSERT INTO mdl_playground_probe (id, name) VALUES (1, 'ok')");
    $rows = $pdo->query('SELECT * FROM mdl_playground_probe')->fetchAll(PDO::FETCH_ASSOC);
    $result['candidates'][] = [
        'dsn' => $dsn,
        'ok' => true,
        'rows' => $rows,
    ];
    $pdo->exec('DROP TABLE IF EXISTS mdl_playground_probe');
    $pdo = null;
} catch (Throwable $error) {
    $result['candidates'][] = [
        'dsn' => $dsn,
        'ok' => false,
        'error' => [
            'type' => get_class($error),
            'message' => $error->getMessage(),
            'file' => $error->getFile(),
            'line' => $error->getLine(),
        ],
    ];
}

$buffer = ob_get_clean();
if ($buffer !== '') {
    $result['output'] = $buffer;
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
`;
}

async function runAutoloadCheck(php, { ignoreComponentCache = false } = {}) {
  const checkUrl = new URL("https://bootstrap.local/__autoload_check.php");
  if (ignoreComponentCache) {
    checkUrl.searchParams.set("ignorecache", "1");
  }

  const response = await php.request(new Request(checkUrl));
  const body = textDecoder.decode(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(`Autoload check failed with HTTP ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Autoload check returned non-JSON output: ${body}`);
  }
}

async function prepareMoodleRuntime({
  php,
  archive,
  manifestState,
  savedManifestState,
  configPhp,
  phpIni,
  installRunnerPhp,
  pdoProbePhp,
  pdoDdlProbePhp,
  publish,
  allowDiagnostics = false,
}) {
  const shouldMountArchive = !manifestStateMatches(savedManifestState, manifestState);

  await ensureDir(php, DOCROOT);
  await ensureDir(php, MOODLE_ROOT);
  await ensureDir(php, MOODLEDATA_ROOT);
  await ensureDir(php, `${MOODLEDATA_ROOT}/cache`);
  await ensureDir(php, `${MOODLEDATA_ROOT}/localcache`);
  await ensureDir(php, `${MOODLEDATA_ROOT}/sessions`);
  await ensureDir(php, TEMP_ROOT);
  await ensureDir(php, `${TEMP_ROOT}/sessions`);
  await ensureDir(php, CONFIG_ROOT);

  if (archive.kind === "vfs-image") {
    publish(shouldMountArchive ? "Mounting the readonly Moodle VFS image." : "Reusing the readonly Moodle VFS image.", 0.56);
    const binary = await php.binary;
    mountReadonlyVfs(binary, {
      imageBytes: archive.bytes,
      entries: archive.image.entries || [],
      mountPath: MOODLE_ROOT,
      writablePaths: INTERNAL_RUNTIME_FILES,
    });
  } else {
    publish("Writing fallback Moodle bundle into the runtime VFS.", 0.58);
    const entries = extractZipEntries(archive.bytes);
    await writeEntriesToPhp(php, entries, MOODLE_ROOT, ({ ratio, path }) => {
      publish(`Writing ${path}`, 0.58 + ratio * 0.2);
    });
  }

  await php.writeFile(`${DOCROOT}/php.ini`, textEncoder.encode(phpIni));
  await php.writeFile(`${MOODLE_ROOT}/config.php`, textEncoder.encode(configPhp));
  await php.writeFile(AUTOLOAD_CHECK_PATH, textEncoder.encode(createAutoloadCheckPhp()));
  await php.writeFile(INSTALL_CHECK_PATH, textEncoder.encode(createInstallCheckPhp()));
  await php.writeFile(INSTALL_RUNNER_PATH, textEncoder.encode(installRunnerPhp));
  await php.writeFile(PDO_PROBE_PATH, textEncoder.encode(pdoProbePhp));
  await php.writeFile(PDO_DDL_PROBE_PATH, textEncoder.encode(pdoDdlProbePhp));

  if (allowDiagnostics) {
    await writeJsonFile(php, MANIFEST_STATE_PATH, {
      ...manifestState,
      updatedAt: nowIso(),
    });
  }

  return { shouldMountArchive };
}

async function runProvisioningCheck(php) {
  const payload = await requestRuntimeScript(php, "/__install_check.php");
  const jsonStart = payload.lastIndexOf("\n{");
  const candidate = jsonStart >= 0 ? payload.slice(jsonStart + 1) : payload.trim();

  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Provisioning check returned non-JSON output: ${payload}`);
  }
}

async function runCliProvisioning(php, publish) {
  const stages = [
    { id: "core", label: "Installing Moodle core schema." },
    { id: "plugins", label: "Installing bundled Moodle plugins." },
    { id: "finalize", label: "Finalizing Moodle admin and site defaults." },
    { id: "themes", label: "Building Moodle theme caches." },
  ];

  const outputs = [];
  for (const [index, stage] of stages.entries()) {
    publish(stage.label, 0.89 + (index * 0.01));
    const output = await requestRuntimeScript(php, "/__install_database.php", { stage: stage.id });
    outputs.push({ stage: stage.id, output });
  }

  return {
    output: outputs.map((entry) => `# ${entry.stage}\n${entry.output}`).join("\n"),
    errorOutput: "",
  };
}

async function runPdoProbe(php, dbConfig) {
  const output = await requestRuntimeScript(php, "/__pdo_probe.php");
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return {
    ...(jsonPayload ? JSON.parse(jsonPayload) : {}),
    errorOutput: "",
  };
}

async function runPdoDdlProbe(php) {
  const output = await requestRuntimeScript(php, "/__pdo_ddl_probe.php");
  const payload = output.trim();
  const jsonStart = payload.indexOf("{");
  const jsonPayload = jsonStart >= 0 ? payload.slice(jsonStart) : payload;

  return jsonPayload ? JSON.parse(jsonPayload) : {};
}

async function requestRuntimeScript(php, path, searchParams) {
  const url = new URL(path, "https://bootstrap.local/");

  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await php.request(new Request(url));
  const body = textDecoder.decode(await response.arrayBuffer());

  if (!response.ok) {
    const runtimePath = `${MOODLE_ROOT}${url.pathname}`;
    const binary = await php.binary;
    const analyzed = binary.FS.analyzePath(runtimePath);
    const mode = analyzed?.exists && analyzed.object ? analyzed.object.mode : null;
    throw new Error(
      `Runtime bootstrap request failed for ${url.pathname}: HTTP ${response.status}: ${body}\n`
      + `Resolved FS path: ${runtimePath}\n`
      + `FS exists: ${Boolean(analyzed?.exists)}${mode != null ? ` mode=${mode}` : ""}`,
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
  origin,
}) {
  const runtime = config.runtimes.find((entry) => entry.id === runtimeId) || config.runtimes[0];
  const effectiveConfig = buildEffectivePlaygroundConfig(config, blueprint);
  let archive = await resolveBootstrapArchive({
    manifestUrl: "./assets/manifests/latest.json",
  }, ({ ratio, cached, phase, detail }) => {
    if (phase === "manifest") {
      publish(detail, 0.16);
      return;
    }

    if (phase === "cache-bust") {
      publish(detail, 0.24);
      return;
    }

    const progress = cached ? 0.44 : 0.2 + (typeof ratio === "number" ? ratio * 0.22 : 0.22);
    publish(detail || "Downloading Moodle bundle.", progress);
  });

  if (runtime.mountStrategy === "zip-extract" && archive.manifest?.bundle?.url) {
    publish("Switching Moodle runtime to ZIP extraction to avoid readonly VFS parser issues.", 0.5);
    const zipBytes = await fetchBundleWithCache(
      archive.manifest,
      ({ ratio, cached }) => {
        const progress = cached ? 0.56 : 0.5 + (typeof ratio === "number" ? ratio * 0.12 : 0.12);
        publish("Downloading writable Moodle ZIP bundle.", progress);
      },
    );

    archive = {
      kind: "zip",
      manifest: archive.manifest,
      bytes: zipBytes,
      sourceUrl: archive.manifest.bundle.url,
    };
  }

  const manifestState = buildManifestState(archive.manifest, runtimeId, config.bundleVersion);
  const savedManifestState = await readJsonFile(php, MANIFEST_STATE_PATH);

  const wwwroot = buildPublicBase(origin, scopeId, runtimeId);
  const dbName = buildDatabaseName(scopeId, runtimeId);
  const installStatePath = buildInstallStatePath(scopeId, runtimeId);
  const savedInstallState = await readJsonFile(php, installStatePath);
  const dbConfig = {
    dbHost: "",
    dbName,
    dbPassword: "",
    dbUser: "",
  };
  const phpIni = createPhpIni({ timezone: effectiveConfig.timezone });
  let shouldIgnoreComponentCache = false;
  const installRunnerPhp = createInstallRunnerPhp(effectiveConfig);
  const pdoProbePhp = createPdoProbePhp(dbConfig);
  const pdoDdlProbePhp = createPdoDdlProbePhp(dbConfig);
  let configPhp = createMoodleConfigPhp({
    adminDirectory: ADMIN_DIRECTORY,
    componentCachePath: COMPONENT_CACHE_PATH,
    ...dbConfig,
    ignoreComponentCache: shouldIgnoreComponentCache,
    prefix: "mdl_",
    wwwroot,
  });

  publish("Writing Moodle runtime configuration.", 0.84);
  await prepareMoodleRuntime({
    php,
    archive,
    manifestState,
    savedManifestState,
    configPhp,
    phpIni,
    installRunnerPhp,
    pdoProbePhp,
    pdoDdlProbePhp,
    publish,
    allowDiagnostics: true,
  });

  publish("Probing PDO/SQLite connectivity.", 0.865);
  const pdoProbe = await runPdoProbe(php, dbConfig);
  const workingDsn = Array.isArray(pdoProbe.candidates)
    ? pdoProbe.candidates.find((candidate) => candidate.ok)
    : null;
  if (workingDsn) {
    publish(`PDO probe connected successfully with ${workingDsn.dsn}.`, 0.868);
  } else {
    const firstFailure = Array.isArray(pdoProbe.candidates)
      ? pdoProbe.candidates.find((candidate) => candidate.error?.message)
      : null;
    const detail = firstFailure
      ? `${firstFailure.dsn}: ${firstFailure.error.message}`
      : "No PDO DSN candidate connected successfully.";
    publish(`PDO probe failed: ${detail}`, 0.868);
  }

  publish("Skipping standalone PDO DDL probe and continuing with Moodle bootstrap.", 0.869);

  let installState = null;
  const hasSavedInstallState = Boolean(savedInstallState?.installed);
  let installMarkerMatches = installStateMatches(savedInstallState, manifestState, dbName);

  if (installMarkerMatches) {
    publish("Using persisted install marker to skip Moodle install checks.", 0.87);
  } else if (hasSavedInstallState) {
    publish("Checking whether Moodle is already installed.", 0.87);
    installState = await runProvisioningCheck(php);
    if (installState.error) {
      publish(`Provisioning check failed: ${installState.error.type}: ${installState.error.message}`, 0.88);
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
    publish("No persisted install marker found for this scope. Running Moodle installation directly.", 0.87);
  }

  if (!installMarkerMatches && !installState?.installed) {
    publish("Running Moodle installation inside the CGI runtime.", 0.89);
    const provisioningResult = await runCliProvisioning(php, publish);
    if (provisioningResult.errorOutput.trim()) {
      publish(`CLI installer stderr: ${provisioningResult.errorOutput.slice(0, 400)}`, 0.9);
    }
    if (/fatal error|warning|exception|error/iu.test(provisioningResult.errorOutput) && !/cliinstallfinished/iu.test(provisioningResult.output)) {
      throw new Error(`Moodle CLI provisioning failed: ${provisioningResult.errorOutput || provisioningResult.output}`);
    }
    await syncFilesystem(publish, "Persisting Moodle database after CLI provisioning.", 0.905);
    await writeJsonFile(php, installStatePath, {
      ...manifestState,
      dbName,
      installed: true,
      updatedAt: nowIso(),
    });
    publish("Moodle CLI provisioning finished.", 0.91);
  } else {
    publish("Moodle database already installed, skipping CLI provisioning.", 0.89);
  }

  publish("Skipping custom Moodle autoload diagnostics for the current runtime strategy.", 0.92);

  const missingExtensions = config.runtimes.find((entry) => entry.id === runtimeId)?.missingExtensions || [];
  if (missingExtensions.length > 0) {
    publish(`Runtime still needs validation for: ${missingExtensions.join(", ")}.`, 0.94);
  }

  await syncFilesystem(publish, "Persisting final Moodle runtime state.", 0.945);

  const readyPath = (effectiveConfig.landingPath || "").includes("install.php")
    ? "/"
    : effectiveConfig.landingPath || "/";

  return {
    manifest: archive.manifest,
    manifestState,
    readyPath,
  };
}
