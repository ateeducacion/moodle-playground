/**
 * PHP code generators for Moodle API calls.
 * All generated scripts use CLI_SCRIPT mode and echo JSON results.
 */

// config.php always lives at MOODLE_ROOT (/www/moodle) regardless of webRoot.
// We must use an absolute path because php.run() executes code without a
// script file, so __DIR__ does not resolve to the Moodle directory.
const MOODLE_ROOT = "/www/moodle";

// A valid PHP property-name identifier. Used to gate customField keys that are
// interpolated UNQUOTED as a property name (`$moduleInfo->NAME = ...`).
// escapePhp only neutralizes single-quoted-string context, not identifier
// context, so a key like `x=1;system("id");$y` would inject PHP. Any key that
// does not match this pattern is skipped before interpolation.
const VALID_PHP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Escape a value for interpolation into a SINGLE-QUOTED PHP literal.
// In a single-quoted PHP string only the backslash and the single quote are
// special; every other character (including newline and CR) is stored
// verbatim, so we must NOT convert "\n"/"\r" to the literal sequences \n/\r —
// doing so corrupts multi-line blueprint text (course summaries, intros).
// Null bytes have no single-quote escape, so we strip them outright.
export function escapePhp(value) {
  return String(value)
    .replaceAll("\0", "")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
}

const CLI_HEADER = `<?php
define('CLI_SCRIPT', true);
require('${MOODLE_ROOT}/config.php');
`;

// Shared graceful exception handler. Moodle's default handler aborts DB
// transactions and die(1)s on errors, which kills the WASM process before our
// JS try/catch sees anything. Overriding it lets a failing step echo a JSON
// error and exit(0) so the blueprint can keep going. See ADR-0005.
const GRACEFUL_HANDLER = `set_exception_handler(function($e) {
    while (ob_get_level()) ob_end_clean();
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit(0);
});`;

// Shared setup for addModule steps.
// Overrides Moodle's default_exception_handler to prevent exit(1) on DB errors —
// Moodle's handler calls abort_all_db_transactions() + die(1) which kills the
// WASM process before our try/catch can capture the error.
const ADD_MODULE_SETUP = `require_once($CFG->dirroot . '/course/lib.php');
global $DB;
set_exception_handler(function($e) {
    while (ob_get_level()) ob_end_clean();
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit(0);
});`;

// Shared execution block — inserts course module records directly.
// We avoid add_moduleinfo() because it uses delegated transactions that
// crash in SQLite PDO WASM (nested savepoints + events/calendar/completion
// writes cause "Error writing to database" + exit(1) via default_exception_handler).
//
// Returns the PHP code as a string. When fileSpecs is non-empty, appends
// Moodle file-storage calls that attach files to the newly created module.
function addModuleExec(fileSpecs = []) {
  let filesBlock = "";
  if (fileSpecs.length > 0) {
    const entries = fileSpecs
      .map(
        (f) =>
          `['filearea'=>'${escapePhp(f.filearea || "content")}','itemid'=>${parseInt(f.itemid || 0, 10)},'filepath'=>'${escapePhp(f.filepath || "/")}','filename'=>'${escapePhp(f.filename)}','tmppath'=>'${escapePhp(f.tmppath)}']`,
      )
      .join(",");
    filesBlock = `
    // Attach uploaded files to the module via Moodle file storage.
    $ctx = context_module::instance($cmid);
    $fs = get_file_storage();
    $component = 'mod_' . $moduleInfo->modulename;
    foreach ([${entries}] as $fSpec) {
        if (!file_exists($fSpec['tmppath'])) continue;
        $fileinfo = [
            'contextid' => $ctx->id,
            'component' => $component,
            'filearea'  => $fSpec['filearea'],
            'itemid'    => $fSpec['itemid'],
            'filepath'  => $fSpec['filepath'],
            'filename'  => $fSpec['filename'],
            'userid'    => 2,
            'source'    => $fSpec['filename'],
            'author'    => 'Admin User',
            'license'   => 'unknown',
        ];
        $fs->create_file_from_pathname($fileinfo, $fSpec['tmppath']);
        @unlink($fSpec['tmppath']);

        // If the file is in the 'package' filearea, extract it to 'content'
        // and detect the main entry file. This replicates the post-save
        // processing that modules like exeweb, resource, and scorm perform
        // when a package ZIP is uploaded through the Moodle form UI.
        if ($fSpec['filearea'] === 'package') {
            $storedFile = $fs->get_file(
                $ctx->id, $component, 'package',
                $fSpec['itemid'], $fSpec['filepath'], $fSpec['filename']
            );
            if ($storedFile) {
                $packer = get_file_packer('application/zip');
                $fs->delete_area_files($ctx->id, $component, 'content');
                $contentsList = $storedFile->extract_to_storage(
                    $packer, $ctx->id, $component, 'content', $fSpec['itemid'], '/'
                );
                if ($contentsList) {
                    // Find index.html as main entry file (common convention).
                    $entryNames = ['index.html', 'index.htm'];
                    $entryPath = '/';
                    $firstKey = key($contentsList);
                    if ($firstKey && mb_substr($firstKey, -1) === '/') {
                        $entryPath = '/' . $firstKey;
                    }
                    foreach ($entryNames as $eName) {
                        $mainFile = $fs->get_file(
                            $ctx->id, $component, 'content',
                            $fSpec['itemid'], $entryPath, $eName
                        );
                        if ($mainFile) {
                            file_set_sortorder(
                                $ctx->id, $component, 'content', $fSpec['itemid'],
                                $mainFile->get_filepath(), $mainFile->get_filename(), 1
                            );
                            // Update entrypath/entryname if the module supports them.
                            try {
                                $cols = $DB->get_columns($moduleInfo->modulename);
                                if (isset($cols['entrypath'])) {
                                    $DB->set_field($moduleInfo->modulename, 'entrypath',
                                        $mainFile->get_filepath(), ['id' => $instanceid]);
                                }
                                if (isset($cols['entryname'])) {
                                    $DB->set_field($moduleInfo->modulename, 'entryname',
                                        $mainFile->get_filename(), ['id' => $instanceid]);
                                }
                            } catch (\\Throwable $ignore) {}
                            break;
                        }
                    }
                }
            }
        }
    }`;
  }

  return `
try {
    $modid = $DB->get_field('modules', 'id', ['name' => $moduleInfo->modulename], MUST_EXIST);

    $cm = new stdClass();
    $cm->course = $course->id;
    $cm->module = $modid;
    $cm->instance = 0;
    $cm->section = 0;
    $cm->visible = $moduleInfo->visible ?? 1;
    $cm->groupmode = $moduleInfo->groupmode ?? 0;
    $cm->groupingid = $moduleInfo->groupingid ?? 0;
    $cm->added = time();
    $cmid = $DB->insert_record('course_modules', $cm);

    $instance = new stdClass();
    $instance->course = $course->id;
    $instance->name = $moduleInfo->name;
    $instance->intro = $moduleInfo->intro ?? '';
    $instance->introformat = $moduleInfo->introformat ?? 1;
    $instance->timemodified = time();
    // Copy module-specific fields (e.g. assign grade, submissiondrafts)
    // that type-specific generators set on $moduleInfo.
    $skip = ['modulename','name','intro','introformat','course','section',
             'visible','cmidnumber','groupmode','groupingid','files'];
    foreach (get_object_vars($moduleInfo) as $k => $v) {
        if (!isset($instance->$k) && !in_array($k, $skip)) {
            $instance->$k = $v;
        }
    }
    $instanceid = $DB->insert_record($moduleInfo->modulename, $instance);

    $DB->set_field('course_modules', 'instance', $instanceid, ['id' => $cmid]);
    context_module::instance($cmid);
    course_add_cm_to_section($course, $cmid, $moduleInfo->section);
${filesBlock}

    echo json_encode(['ok' => true, 'cmid' => $cmid]);
} catch (\\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}`;
}

// Backward-compatible constant for callers that don't need files.
const ADD_MODULE_EXEC = addModuleExec();

export function phpSetConfig(name, value, plugin = null) {
  const pluginArg = plugin ? `'${escapePhp(plugin)}'` : "null";
  return `${CLI_HEADER}
set_config('${escapePhp(name)}', '${escapePhp(value)}', ${pluginArg});
echo json_encode(['ok' => true, 'name' => '${escapePhp(name)}']);
`;
}

export function phpSetTheme(name) {
  return `${CLI_HEADER}
require_once($CFG->libdir . '/outputlib.php');
set_config('theme', '${escapePhp(name)}');
// Reset theme CSS caches so the next request serves the new theme.
if (function_exists('theme_reset_all_caches')) {
    theme_reset_all_caches();
}
echo json_encode(['ok' => true, 'theme' => '${escapePhp(name)}']);
`;
}

export function phpSetConfigs(configs) {
  const lines = configs.map(({ name, value, plugin }) => {
    const pluginArg = plugin ? `'${escapePhp(plugin)}'` : "null";
    return `set_config('${escapePhp(name)}', '${escapePhp(value)}', ${pluginArg});`;
  });
  return `${CLI_HEADER}
${lines.join("\n")}
echo json_encode(['ok' => true, 'count' => ${configs.length}]);
`;
}

// Cache purge used by the file-backed config generators. Theme file settings
// (logos, favicons, marketing images) are served from cached CSS/markup, so a
// purge is often needed before a freshly stored file becomes visible. This is
// opt-in via `purgeCaches: true` — we do NOT purge by default because purging
// is expensive and most plugin settings do not need it.
const PURGE_CACHES_BLOCK = `if (function_exists('theme_reset_all_caches')) {
    theme_reset_all_caches();
}
purge_all_caches();`;

// Build the optional metadata lines for a Moodle file record. Only emitted when
// provided; each value is escaped for a single-quoted PHP literal.
function fileMetaEntries({ author, license, source }) {
  const lines = [];
  if (author != null) lines.push(`    'author'    => '${escapePhp(author)}',`);
  if (license != null)
    lines.push(`    'license'   => '${escapePhp(license)}',`);
  if (source != null) lines.push(`    'source'    => '${escapePhp(source)}',`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

// Resolve the file owner: an explicit userid (as int), otherwise the site admin
// id, falling back to user id 2 (Moodle's default admin) when none is set.
function fileUseridExpr(userid) {
  return userid != null
    ? String(parseInt(userid, 10) || 0)
    : "($admin ? $admin->id : 2)";
}

// Store a single file in Moodle's File API and (by default) point a config value
// at it. Backs admin_setting_configstoredfile-style settings (theme logos,
// favicons, plugin assets) that set_config() alone cannot reproduce: Moodle
// serves these through pluginfile.php, which reads the `files` table, not the
// raw filesystem. The file lives in the system context under the given
// component (plugin) / filearea / itemid / filepath / filename, and the config
// value is set to "<filepath><filename>" (e.g. "/logo.png").
export function phpSetConfigFile(opts) {
  const {
    plugin,
    name,
    filename,
    filearea,
    itemid = 0,
    filepath = "/",
    replace = true,
    setConfigValue = true,
    purgeCaches = false,
    author = null,
    license = null,
    source = null,
    userid = null,
    tmppath,
  } = opts;

  const deleteBlock = replace
    ? "$fs->delete_area_files($context->id, $component, $filearea, $itemid);\n"
    : "";
  const setConfigBlock = setConfigValue
    ? `set_config('${escapePhp(name)}', $filepath . $filename, $component);\n`
    : "";
  const purgeBlock = purgeCaches ? `${PURGE_CACHES_BLOCK}\n` : "";

  return `${CLI_HEADER}
${GRACEFUL_HANDLER}
$context = context_system::instance();
$fs = get_file_storage();
$admin = get_admin();
$component = '${escapePhp(plugin)}';
$filearea = '${escapePhp(filearea)}';
$itemid = ${parseInt(itemid, 10) || 0};
$filepath = '${escapePhp(filepath)}';
$filename = '${escapePhp(filename)}';
$tmppath = '${escapePhp(tmppath)}';
if (!file_exists($tmppath)) {
    throw new Exception('setConfigFile: resolved file not found at ' . $tmppath);
}
${deleteBlock}$filerecord = [
    'contextid' => $context->id,
    'component' => $component,
    'filearea'  => $filearea,
    'itemid'    => $itemid,
    'filepath'  => $filepath,
    'filename'  => $filename,
    'userid'    => ${fileUseridExpr(userid)},${fileMetaEntries({ author, license, source })}
];
$fs->create_file_from_pathname($filerecord, $tmppath);
@unlink($tmppath);
${setConfigBlock}${purgeBlock}echo json_encode(['ok' => true, 'name' => '${escapePhp(name)}', 'plugin' => $component, 'filearea' => $filearea, 'filename' => $filename]);
`;
}

// Store several files in the same File API area (system context) under one
// component/filearea, deleting the area once first (by default) and pointing the
// config value at the FIRST stored file's path. Backs multi-file settings such
// as a theme's marketing/header image galleries. `files` entries carry a
// pre-resolved temp path plus optional per-file metadata; the area-level
// filearea/itemid are shared by every file (that is the point of the area).
export function phpSetConfigFiles(opts) {
  const {
    plugin,
    name,
    filearea,
    itemid = 0,
    replace = true,
    setConfigValue = true,
    purgeCaches = false,
    files = [],
  } = opts;

  const entries = files
    .map((f) => {
      const parts = [
        `'filename'=>'${escapePhp(f.filename)}'`,
        `'filepath'=>'${escapePhp(f.filepath || "/")}'`,
        `'tmppath'=>'${escapePhp(f.tmppath)}'`,
        `'userid'=>${fileUseridExpr(f.userid)}`,
      ];
      if (f.author != null) parts.push(`'author'=>'${escapePhp(f.author)}'`);
      if (f.license != null) parts.push(`'license'=>'${escapePhp(f.license)}'`);
      if (f.source != null) parts.push(`'source'=>'${escapePhp(f.source)}'`);
      return `    [${parts.join(",")}]`;
    })
    .join(",\n");

  const deleteBlock = replace
    ? "$fs->delete_area_files($context->id, $component, $filearea, $itemid);\n"
    : "";
  const setConfigBlock = setConfigValue
    ? `if ($firstpath !== null) {
    set_config('${escapePhp(name)}', $firstpath, $component);
}\n`
    : "";
  const purgeBlock = purgeCaches ? `${PURGE_CACHES_BLOCK}\n` : "";

  return `${CLI_HEADER}
${GRACEFUL_HANDLER}
$context = context_system::instance();
$fs = get_file_storage();
$admin = get_admin();
$component = '${escapePhp(plugin)}';
$filearea = '${escapePhp(filearea)}';
$itemid = ${parseInt(itemid, 10) || 0};
${deleteBlock}$stored = 0;
$firstpath = null;
foreach ([
${entries}
] as $f) {
    if (!file_exists($f['tmppath'])) continue;
    $filerecord = [
        'contextid' => $context->id,
        'component' => $component,
        'filearea'  => $filearea,
        'itemid'    => $itemid,
        'filepath'  => $f['filepath'],
        'filename'  => $f['filename'],
        'userid'    => $f['userid'],
    ];
    foreach (['author', 'license', 'source'] as $meta) {
        if (isset($f[$meta])) $filerecord[$meta] = $f[$meta];
    }
    $fs->create_file_from_pathname($filerecord, $f['tmppath']);
    @unlink($f['tmppath']);
    if ($firstpath === null) {
        $firstpath = $f['filepath'] . $f['filename'];
    }
    $stored++;
}
if ($stored === 0) {
    echo json_encode(['ok' => false, 'error' => 'setConfigFiles: no valid files stored']);
    exit(0);
}
${setConfigBlock}${purgeBlock}echo json_encode(['ok' => true, 'name' => '${escapePhp(name)}', 'plugin' => $component, 'filearea' => $filearea, 'count' => $stored]);
`;
}

// Install one or more language packs using Moodle's own lang_installer
// (lib/componentlib.class.php) — the same engine the admin Language packs UI
// uses. It downloads the langpack index + per-language ZIPs from
// $CFG->langotherroot (download.moodle.org/langpack), which the github-proxy
// authorizes, and extracts them into $CFG->dataroot/lang. Works in every
// browser because these are GET requests over tcpOverFetch (no half-duplex
// streaming body). See docs/decisions/0006-*.
//
// `codes` must be pre-validated against /^[a-z][a-z0-9_]*$/ by the caller; the
// values are interpolated into a PHP array literal here.
export function phpInstallLanguagePacks(codes, setDefault = false) {
  const list = codes.map((c) => `'${escapePhp(c)}'`).join(", ");
  const setDefaultBlock = setDefault
    ? `if (!empty($installed)) {
    set_config('lang', '${escapePhp(codes[0])}');
}`
    : "";
  return `${CLI_HEADER}
require_once($CFG->libdir . '/componentlib.class.php');
$requested = [${list}];
// lang_installer::set_queue() expects an array of codes; it also auto-queues
// parent languages (e.g. pt_br pulls pt). Network/parse failures are caught so
// a single bad pack does not abort the blueprint — the filesystem check below
// reports what actually landed.
$installed = [];
$failed = [];
try {
    $installer = new lang_installer($requested);
    $installer->run();
} catch (\\Throwable $e) {
    // fall through to the filesystem check
}
foreach ($requested as $lang) {
    if (is_file($CFG->dataroot . '/lang/' . $lang . '/langconfig.php')) {
        $installed[] = $lang;
    } else {
        $failed[] = $lang;
    }
}
${setDefaultBlock}
get_string_manager()->reset_caches();
echo json_encode(['ok' => empty($failed), 'installed' => $installed, 'failed' => $failed]);
`;
}

// Restore a single Moodle course backup (.mbz) using Moodle's own
// restore_controller. The .mbz is either downloaded inside PHP (streamed
// straight to a MEMFS file via download_file_content's $tofile, so no large JS
// arrayBuffer is allocated and no 50MB resource cap applies) or read from an
// existing MEMFS path. Restore is memory-heavy and can hit SQLite-WASM limits
// (nested savepoints, see ADR-0003), so large/complex backups may fail — the
// exception-handler override turns that into a graceful JSON error (exit(0),
// not exit(1)) instead of killing the runtime (ADR-0005).
//
// String options are interpolated into single-quoted PHP literals via escapePhp;
// none is used as a PHP identifier.
export function phpRestoreCourse({
  downloadUrl = null,
  localPath = null,
  category = null,
  createCategory = true,
  fullname = null,
  shortname = null,
  visible = true,
} = {}) {
  const visibleInt = visible === false ? 0 : 1;

  const sourceBlock = downloadUrl
    ? `$mbz = make_request_directory() . '/source.mbz';
$dlok = download_file_content('${escapePhp(downloadUrl)}', null, null, false, 600, 30, false, $mbz);
if ($dlok === false || !is_file($mbz) || filesize($mbz) < 1000) {
    fail('Could not download the course backup. The URL must be reachable and CORS-accessible (e.g. raw.githubusercontent.com) or proxy-allowlisted.');
}`
    : `$mbz = '${escapePhp(localPath)}';
if (!is_file($mbz) || filesize($mbz) < 1000) {
    fail('Course backup file is missing or too small: ' . $mbz);
}`;

  const categoryExpr = category ? `'${escapePhp(category)}'` : "null";
  const categoryBlock = `$categoryname = ${categoryExpr};
if ($categoryname === null || $categoryname === '') {
    $categoryid = 1;
} else {
    $cat = $DB->get_record('course_categories', ['name' => $categoryname], 'id');
    if ($cat) {
        $categoryid = $cat->id;
    } else if (${createCategory ? "true" : "false"}) {
        $newcat = new stdClass();
        $newcat->name = $categoryname;
        $newcat->descriptionformat = FORMAT_HTML;
        $categoryid = core_course_category::create($newcat)->id;
    } else {
        fail('Target category does not exist: ' . $categoryname);
    }
}`;

  const fullnameExpr = fullname ? `'${escapePhp(fullname)}'` : "null";
  const shortnameExpr = shortname ? `'${escapePhp(shortname)}'` : "null";

  return `${CLI_HEADER}
raise_memory_limit(MEMORY_EXTRA);
@set_time_limit(0);
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->dirroot . '/course/lib.php');
global $CFG, $DB, $USER;

// Report failures as JSON and exit(0). Moodle's default_exception_handler would
// otherwise exit(1) on a DB/restore error and kill the WASM runtime (ADR-0005).
function fail($msg) {
    while (ob_get_level()) { ob_end_clean(); }
    echo json_encode(['ok' => false, 'error' => $msg]);
    exit(0);
}
set_exception_handler(function($e) { fail($e->getMessage()); });

$admin = get_admin();
if (!$admin) { fail('Administrator account not found.'); }
$USER = $admin;

${sourceBlock}

${categoryBlock}

// Extract the .mbz into a Moodle backup temp dir and validate it is a course backup.
$backupdir = restore_controller::get_tempdir_name(SITEID, $admin->id);
$path = make_backup_temp_directory($backupdir);
$packer = get_file_packer('application/vnd.moodle.backup');
if (!$packer->extract_to_pathname($mbz, $path)) {
    fulldelete($path);
    fail('Could not extract the Moodle backup (.mbz).');
}
if (!is_file($path . '/moodle_backup.xml')) {
    fulldelete($path);
    fail('The .mbz does not contain moodle_backup.xml (not a valid Moodle backup).');
}
$tmprc = new restore_controller($backupdir, SITEID, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_EXISTING_ADDING);
$backuptype = $tmprc->get_type();
$tmprc->destroy();
if ($backuptype !== backup::TYPE_1COURSE) {
    fulldelete($path);
    fail('The supplied .mbz is not a single-course backup.');
}

// Create the destination course shell with a guaranteed-unique shortname, then
// restore the backup into it.
$wantfullname = ${fullnameExpr};
$wantshortname = ${shortnameExpr};
list($newfullname, $newshortname) = restore_dbops::calculate_course_names(
    0,
    $wantfullname !== null ? $wantfullname : 'Restored course',
    $wantshortname !== null ? $wantshortname : 'restored'
);
$courseid = restore_dbops::create_new_course($newfullname, $newshortname, $categoryid);
$rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_NEW_COURSE);
try {
    $rc->execute_precheck();
    $rc->execute_plan();
    $rc->destroy();
} catch (\\Throwable $e) {
    $rc->destroy();
    fulldelete($path);
    fail('Course restore failed: ' . $e->getMessage());
}

// Enforce the requested name/visibility (the backup may have set its own).
$course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);
if ($wantfullname !== null) {
    $course->fullname = $wantfullname;
}
if ($wantshortname !== null &&
    !$DB->record_exists_select('course', 'shortname = ? AND id <> ?', [$wantshortname, $courseid])) {
    $course->shortname = $wantshortname;
}
$course->visible = ${visibleInt};
update_course($course);
rebuild_course_cache($courseid, true);
fulldelete($path);
purge_all_caches();
echo json_encode(['ok' => true, 'courseid' => $courseid, 'shortname' => $course->shortname, 'fullname' => $course->fullname]);
`;
}

export function phpCreateUser(user) {
  return phpCreateUsers([user]);
}

export function phpCreateUsers(users) {
  const blocks = users.map((user, i) => {
    const username = escapePhp(user.username);
    const password = escapePhp(user.password || "password");
    const email = escapePhp(user.email || `${user.username}@example.com`);
    const firstname = escapePhp(user.firstname || user.username);
    const lastname = escapePhp(user.lastname || "User");
    return `
$u${i} = new stdClass();
$u${i}->username = '${username}';
$u${i}->password = '${password}';
$u${i}->email = '${email}';
$u${i}->firstname = '${firstname}';
$u${i}->lastname = '${lastname}';
$u${i}->confirmed = 1;
$u${i}->mnethostid = $CFG->mnet_localhost_id;
$u${i}->auth = 'manual';
$created[] = user_create_user($u${i}, true, false);`;
  });

  return `${CLI_HEADER}
require_once($CFG->dirroot . '/user/lib.php');
global $CFG;
$CFG->passwordpolicy = false;
$created = [];
${blocks.join("\n")}
echo json_encode(['ok' => true, 'created' => $created]);
`;
}

export function phpCreateCategory(cat) {
  return phpCreateCategories([cat]);
}

export function phpCreateCategories(categories) {
  const blocks = categories.map((cat, i) => {
    const name = escapePhp(cat.name);
    const description = escapePhp(cat.description || "");
    const parent = cat.parent ? `'${escapePhp(cat.parent)}'` : "null";
    return `
$data${i} = new stdClass();
$data${i}->name = '${name}';
$data${i}->description = '${description}';
$data${i}->descriptionformat = FORMAT_HTML;
if (${parent} !== null) {
    $parentCat = $DB->get_record('course_categories', ['name' => ${parent}], 'id');
    if ($parentCat) {
        $data${i}->parent = $parentCat->id;
    }
}
$catIds[] = core_course_category::create($data${i})->id;`;
  });

  return `${CLI_HEADER}
global $DB;
$catIds = [];
${blocks.join("\n")}
echo json_encode(['ok' => true, 'ids' => $catIds]);
`;
}

export function phpCreateCourse(course) {
  return phpCreateCourses([course]);
}

export function phpCreateCourses(courses) {
  const blocks = courses.map((course, i) => {
    const fullname = escapePhp(course.fullname);
    const shortname = escapePhp(course.shortname);
    const summary = escapePhp(course.summary || "");
    const category = escapePhp(course.category || "");
    const format = escapePhp(course.format || "topics");
    const numsections =
      course.numsections !== undefined ? parseInt(course.numsections, 10) : 5;
    return `
$c${i} = new stdClass();
$c${i}->fullname = '${fullname}';
$c${i}->shortname = '${shortname}';
$c${i}->summary = '${summary}';
$c${i}->summaryformat = FORMAT_HTML;
$c${i}->format = '${format}';
$c${i}->numsections = ${numsections};
$c${i}->newsitems = 0;
$c${i}->visible = 1;
if ('${category}') {
    $cat = $DB->get_record('course_categories', ['name' => '${category}'], 'id');
    $c${i}->category = $cat ? $cat->id : 1;
} else {
    $c${i}->category = 1;
}
$courseIds[] = create_course($c${i})->id;`;
  });

  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/lib.php');
global $DB;
$courseIds = [];
${blocks.join("\n")}
echo json_encode(['ok' => true, 'ids' => $courseIds]);
`;
}

export function phpCreateSection(section) {
  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/lib.php');
global $DB;
$course = $DB->get_record('course', ['shortname' => '${escapePhp(section.course)}'], '*', MUST_EXIST);
$sectionnum = course_create_section($course->id, ${parseInt(section.position || 0, 10)});
if ('${escapePhp(section.name || "")}') {
    course_update_section($course->id, $sectionnum, ['name' => '${escapePhp(section.name || "")}']);
}
echo json_encode(['ok' => true, 'section' => $sectionnum]);
`;
}

export function phpCreateSections(sections) {
  const blocks = sections.map((s, i) => {
    const nameEscaped = escapePhp(s.name || "");
    return `
$course${i} = $DB->get_record('course', ['shortname' => '${escapePhp(s.course)}'], '*', MUST_EXIST);
$sec${i} = course_create_section($course${i}->id, ${parseInt(s.position || 0, 10)});
if ('${nameEscaped}') {
    course_update_section($course${i}->id, $sec${i}, ['name' => '${nameEscaped}']);
}
$results[] = $sec${i};`;
  });

  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/lib.php');
global $DB;
$results = [];
${blocks.join("\n")}
echo json_encode(['ok' => true, 'sections' => $results]);
`;
}

export function phpEnrolUser(enrol) {
  return phpEnrolUsers([enrol]);
}

export function phpEnrolUsers(enrolments) {
  const blocks = enrolments.map((e, i) => {
    const role = escapePhp(e.role || "student");
    return `
$user${i} = $DB->get_record('user', ['username' => '${escapePhp(e.username)}'], '*', MUST_EXIST);
$course${i} = $DB->get_record('course', ['shortname' => '${escapePhp(e.course)}'], '*', MUST_EXIST);
$roleId${i} = $DB->get_field('role', 'id', ['shortname' => '${role}']);
if (!$roleId${i}) { throw new \\moodle_exception('invalidroleid', 'error', '', '${role}'); }
enrol_try_internal_enrol($course${i}->id, $user${i}->id, $roleId${i});
$enrolled[] = ['user' => '${escapePhp(e.username)}', 'course' => '${escapePhp(e.course)}'];`;
  });

  return `${CLI_HEADER}
require_once($CFG->dirroot . '/lib/enrollib.php');
global $DB;
$enrolled = [];
${blocks.join("\n")}
echo json_encode(['ok' => true, 'enrolled' => $enrolled]);
`;
}

export function phpAddModule(mod, fileSpecs = []) {
  const course = escapePhp(mod.course);
  const section = parseInt(mod.section || 0, 10);
  const name = escapePhp(mod.name || mod.module);
  const intro = escapePhp(mod.intro || "");

  // Extract module-specific custom fields (e.g. exeorigin, revision)
  // that should be set on the module instance record.
  const standardKeys = new Set([
    "step",
    "module",
    "course",
    "section",
    "name",
    "intro",
    "files",
  ]);
  const customFields = {};
  for (const [k, v] of Object.entries(mod)) {
    if (!standardKeys.has(k) && v !== undefined && v !== null) {
      customFields[k] = v;
    }
  }

  // When files or custom fields are present, always use the generic handler
  // (it supports custom fields AND file attachment in one pass).
  if (fileSpecs.length > 0 || Object.keys(customFields).length > 0) {
    return phpAddGenericModule(
      mod.module,
      course,
      section,
      name,
      intro,
      fileSpecs,
      customFields,
    );
  }

  switch (mod.module) {
    case "label":
      return phpAddLabel(course, section, name, intro);
    case "folder":
      return phpAddFolder(course, section, name, intro);
    case "assign":
      return phpAddAssign(course, section, name, intro);
    default:
      return phpAddGenericModule(mod.module, course, section, name, intro);
  }
}

function phpAddLabel(course, section, name, intro) {
  return `${CLI_HEADER}
${ADD_MODULE_SETUP}
$course = $DB->get_record('course', ['shortname' => '${course}'], '*', MUST_EXIST);
$moduleInfo = new stdClass();
$moduleInfo->modulename = 'label';
$moduleInfo->name = '${name}';
$moduleInfo->intro = '${intro}';
$moduleInfo->introformat = FORMAT_HTML;
$moduleInfo->course = $course->id;
$moduleInfo->section = ${section};
$moduleInfo->visible = 1;
$moduleInfo->cmidnumber = '';
$moduleInfo->groupmode = 0;
$moduleInfo->groupingid = 0;
${ADD_MODULE_EXEC}
`;
}

function phpAddFolder(course, section, name, intro) {
  return `${CLI_HEADER}
${ADD_MODULE_SETUP}
$course = $DB->get_record('course', ['shortname' => '${course}'], '*', MUST_EXIST);
$moduleInfo = new stdClass();
$moduleInfo->modulename = 'folder';
$moduleInfo->name = '${name}';
$moduleInfo->intro = '${intro}';
$moduleInfo->introformat = FORMAT_HTML;
$moduleInfo->course = $course->id;
$moduleInfo->section = ${section};
$moduleInfo->visible = 1;
$moduleInfo->cmidnumber = '';
$moduleInfo->groupmode = 0;
$moduleInfo->groupingid = 0;
$moduleInfo->files = 0;
$moduleInfo->display = 0;
${ADD_MODULE_EXEC}
`;
}

function phpAddAssign(course, section, name, intro) {
  return `${CLI_HEADER}
${ADD_MODULE_SETUP}
require_once($CFG->dirroot . '/mod/assign/lib.php');
$course = $DB->get_record('course', ['shortname' => '${course}'], '*', MUST_EXIST);
$moduleInfo = new stdClass();
$moduleInfo->modulename = 'assign';
$moduleInfo->name = '${name}';
$moduleInfo->intro = '${intro}';
$moduleInfo->introformat = FORMAT_HTML;
$moduleInfo->course = $course->id;
$moduleInfo->section = ${section};
$moduleInfo->visible = 1;
$moduleInfo->cmidnumber = '';
$moduleInfo->groupmode = 0;
$moduleInfo->groupingid = 0;
$moduleInfo->submissiondrafts = 0;
$moduleInfo->requiresubmissionstatement = 0;
$moduleInfo->sendnotifications = 0;
$moduleInfo->sendlatenotifications = 0;
$moduleInfo->sendstudentnotifications = 1;
$moduleInfo->grade = 100;
$moduleInfo->teamsubmission = 0;
$moduleInfo->requireallteammemberssubmit = 0;
$moduleInfo->blindmarking = 0;
$moduleInfo->markingworkflow = 0;
$moduleInfo->markingallocation = 0;
${ADD_MODULE_EXEC}
`;
}

function phpAddGenericModule(
  moduleName,
  course,
  section,
  name,
  intro,
  fileSpecs = [],
  customFields = {},
) {
  const customLines = Object.entries(customFields)
    // The key is interpolated as a PHP property name (not a string literal), so
    // escapePhp cannot make a malicious key safe. Skip any key that is not a
    // plain PHP identifier to prevent code injection through customField names.
    .filter(([k]) => VALID_PHP_IDENTIFIER.test(k))
    .map(([k, v]) => {
      if (typeof v === "number" || typeof v === "boolean") {
        return `$moduleInfo->${k} = ${typeof v === "boolean" ? (v ? 1 : 0) : v};`;
      }
      return `$moduleInfo->${k} = '${escapePhp(String(v))}';`;
    })
    .join("\n");

  return `${CLI_HEADER}
${ADD_MODULE_SETUP}
$course = $DB->get_record('course', ['shortname' => '${course}'], '*', MUST_EXIST);
$moduleInfo = new stdClass();
$moduleInfo->modulename = '${escapePhp(moduleName)}';
$moduleInfo->name = '${name}';
$moduleInfo->intro = '${intro}';
$moduleInfo->introformat = FORMAT_HTML;
$moduleInfo->course = $course->id;
$moduleInfo->section = ${section};
$moduleInfo->visible = 1;
$moduleInfo->cmidnumber = '';
$moduleInfo->groupmode = 0;
$moduleInfo->groupingid = 0;
${customLines}
${addModuleExec(fileSpecs)}
`;
}

export function phpLogin(username) {
  return `<?php
define('NO_OUTPUT_BUFFERING', true);
require('${MOODLE_ROOT}/config.php');
$user = $DB->get_record('user', ['username' => '${escapePhp(username)}'], '*', MUST_EXIST);
complete_user_login($user);
echo json_encode(['ok' => true, 'user' => $user->username]);
`;
}

export function phpSetAdminAccount({
  username: _username,
  password,
  email,
  firstname,
  lastname,
}) {
  const parts = [];
  if (password)
    parts.push(
      `$admin->password = hash_internal_user_password('${escapePhp(password)}');`,
    );
  if (email) parts.push(`$admin->email = '${escapePhp(email)}';`);
  if (firstname) parts.push(`$admin->firstname = '${escapePhp(firstname)}';`);
  if (lastname) parts.push(`$admin->lastname = '${escapePhp(lastname)}';`);
  if (parts.length === 0) {
    return `${CLI_HEADER}
echo json_encode(['ok' => true, 'changed' => false]);
`;
  }

  return `${CLI_HEADER}
global $DB;
$admin = get_admin();
${parts.join("\n")}
$DB->update_record('user', $admin);
echo json_encode(['ok' => true, 'changed' => true, 'user' => $admin->username]);
`;
}

// ---------------------------------------------------------------------------
// Roles, scales and cohorts
// ---------------------------------------------------------------------------

// Graceful fatal handler — turns an uncaught error into a JSON {"ok":false}
// response + exit(0) so a failing provisioning step does not kill the WASM
// process before the executor can read the result (see ADR-0005, mirrors
// ADD_MODULE_SETUP). Used by the role/scale/cohort generators below.
// Map blueprint context-level names to Moodle CONTEXT_* numeric constants.
// Values are resolved in JS so only integers are interpolated into PHP.
const CONTEXT_LEVELS = {
  system: 10,
  user: 30,
  coursecat: 40,
  category: 40,
  course: 50,
  module: 70,
  activity: 70,
  block: 80,
};

// Map blueprint permission names to Moodle CAP_* numeric constants.
const CAP_PERMISSIONS = {
  inherit: 0,
  allow: 1,
  prevent: -1,
  prohibit: -1000,
};

function normalizeContextLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const out = [];
  for (const lvl of levels) {
    if (typeof lvl === "number" && Number.isInteger(lvl)) {
      out.push(lvl);
      continue;
    }
    const n = CONTEXT_LEVELS[String(lvl).toLowerCase()];
    if (n !== undefined) out.push(n);
  }
  return out;
}

// Moodle stores scale items as a single comma-separated string (low to high).
// Accept either an array or an already-joined string.
export function normalizeScaleItems(items) {
  const arr = Array.isArray(items) ? items : String(items ?? "").split(",");
  return arr
    .map((x) => String(x).trim())
    .filter((x) => x !== "")
    .join(", ");
}

// Import one or more native Moodle role presets (the <role> XML produced by
// Site administration > Users > Permissions > Define roles > Export). Reuses
// Moodle core's own parser (core_role_preset) so any exported role drops in.
// Runs in two passes so inter-role allow* relationships resolve even when
// several new roles reference each other. Idempotent on role shortname.
// Adapted from the reference apply-role-presets.php but accepts XML strings
// instead of file paths (no filesystem in WASM CLI mode).
export function phpImportRolePresets(xmls) {
  const xmlLiterals = xmls.map((xml) => `'${escapePhp(xml)}'`).join(",\n");
  return `${CLI_HEADER}
${GRACEFUL_HANDLER}
require_once($CFG->dirroot . '/admin/roles/classes/preset.php');
require_once($CFG->libdir . '/accesslib.php');
global $DB, $USER;
$admin = get_admin();
if ($admin) { $USER = $admin; }
$systemcontext = context_system::instance();
$xmls = [
${xmlLiterals}
];
$presets = [];
foreach ($xmls as $xml) {
    if (trim($xml) === '' || !core_role_preset::is_valid_preset($xml)) {
        throw new moodle_exception('Invalid Moodle role preset XML.');
    }
    $info = core_role_preset::parse_preset($xml);
    if (!is_array($info) || empty($info['shortname'])) {
        throw new moodle_exception('Role preset lacks a valid shortname.');
    }
    $presets[(string)$info['shortname']] = ['xml' => $xml, 'initial' => $info];
}
$roleids = [];
// Pass 1: create or update every role record first.
foreach ($presets as $shortname => $preset) {
    $info = $preset['initial'];
    $name = (string)($info['name'] ?? $shortname);
    $description = (string)($info['description'] ?? '');
    $archetype = (string)($info['archetype'] ?? '');
    $role = $DB->get_record('role', ['shortname' => $shortname]);
    if ($role) {
        $role->name = $name;
        $role->description = $description;
        $role->archetype = $archetype;
        $DB->update_record('role', $role);
        $roleids[$shortname] = (int)$role->id;
    } else {
        $roleids[$shortname] = (int)create_role($name, $shortname, $description, $archetype);
    }
}
// Pass 2: context levels, capabilities and inter-role relationships.
$summary = [];
foreach ($presets as $shortname => $preset) {
    $info = core_role_preset::parse_preset($preset['xml']);
    $roleid = $roleids[$shortname];
    $contextlevels = array_values(array_map('intval', $info['contextlevels'] ?? []));
    set_role_contextlevels($roleid, $contextlevels);
    $DB->delete_records('role_capabilities', ['roleid' => $roleid, 'contextid' => $systemcontext->id]);
    $applied = 0;
    $skipped = 0;
    foreach (($info['permissions'] ?? []) as $capability => $permission) {
        $permission = (int)$permission;
        if ($permission === CAP_INHERIT) { continue; }
        // XML exports may reference capabilities from plugins absent here.
        if (!get_capability_info((string)$capability, false)) { $skipped++; continue; }
        assign_capability((string)$capability, $permission, $roleid, $systemcontext, true);
        $applied++;
    }
    $relations = [
        'allowassign'   => ['table' => 'role_allow_assign',   'field' => 'allowassign',   'helper' => 'core_role_set_assign_allowed'],
        'allowoverride' => ['table' => 'role_allow_override', 'field' => 'allowoverride', 'helper' => 'core_role_set_override_allowed'],
        'allowswitch'   => ['table' => 'role_allow_switch',   'field' => 'allowswitch',   'helper' => 'core_role_set_switch_allowed'],
        'allowview'     => ['table' => 'role_allow_view',     'field' => 'allowview',     'helper' => 'core_role_set_view_allowed'],
    ];
    foreach ($relations as $key => $rel) {
        $DB->delete_records($rel['table'], ['roleid' => $roleid]);
        foreach (($info[$key] ?? []) as $target) {
            $target = (int)$target;
            if ($target === -1) { $target = $roleid; } // self-reference marker
            if ($target <= 0 || !$DB->record_exists('role', ['id' => $target])) { continue; }
            if (!$DB->record_exists($rel['table'], ['roleid' => $roleid, $rel['field'] => $target])) {
                call_user_func($rel['helper'], $roleid, $target);
            }
        }
    }
    $summary[$shortname] = ['id' => $roleid, 'applied' => $applied, 'skipped' => $skipped];
}
accesslib_reset_role_cache();
purge_all_caches();
echo json_encode(['ok' => true, 'roles' => $summary]);
`;
}

export function phpCreateRole(role) {
  return phpCreateRoles([role]);
}

// Create or customize roles from a JSON-native definition. Idempotent on
// shortname. Capabilities are a {capability: allow|prevent|prohibit|inherit}
// map; context levels accept names (course, module, ...) or numbers; allow*
// relationships reference other roles by shortname. Permission and context
// values are resolved to integers in JS so only safe ints reach PHP.
export function phpCreateRoles(roles) {
  const createBlocks = roles.map((r) => {
    const shortname = escapePhp(r.shortname);
    const name = escapePhp(r.name || r.shortname);
    const description = escapePhp(r.description || "");
    const archetype = escapePhp(r.archetype || "");
    return `
$shortname = '${shortname}';
$existing = $DB->get_record('role', ['shortname' => $shortname]);
if ($existing) {
    $existing->name = '${name}';
    $existing->description = '${description}';
    $existing->archetype = '${archetype}';
    $DB->update_record('role', $existing);
    $roleids['${shortname}'] = (int)$existing->id;
} else {
    $roleids['${shortname}'] = (int)create_role('${name}', $shortname, '${description}', '${archetype}');
}`;
  });

  const applyBlocks = roles.map((r) => {
    const shortname = escapePhp(r.shortname);
    const lines = [`$roleid = $roleids['${shortname}'];`];
    if (r.resetToArchetype && r.archetype) {
      lines.push("reset_role_capabilities($roleid);");
    }
    const levels = normalizeContextLevels(r.contextlevels);
    if (levels.length > 0) {
      lines.push(`set_role_contextlevels($roleid, [${levels.join(", ")}]);`);
    }
    if (r.capabilities && typeof r.capabilities === "object") {
      for (const [cap, perm] of Object.entries(r.capabilities)) {
        const permInt = CAP_PERMISSIONS[String(perm).toLowerCase()];
        if (permInt === undefined) continue;
        lines.push(
          `if (get_capability_info('${escapePhp(cap)}', false)) { assign_capability('${escapePhp(cap)}', ${permInt}, $roleid, $systemcontext->id, true); }`,
        );
      }
    }
    const rels = [
      ["allowAssign", "core_role_set_assign_allowed"],
      ["allowOverride", "core_role_set_override_allowed"],
      ["allowSwitch", "core_role_set_switch_allowed"],
      ["allowView", "core_role_set_view_allowed"],
    ];
    for (const [key, helper] of rels) {
      const targets = Array.isArray(r[key]) ? r[key] : [];
      for (const t of targets) {
        lines.push(
          `$tid = $DB->get_field('role', 'id', ['shortname' => '${escapePhp(t)}']); if ($tid) { ${helper}($roleid, (int)$tid); }`,
        );
      }
    }
    return lines.join("\n");
  });

  return `${CLI_HEADER}
${GRACEFUL_HANDLER}
require_once($CFG->libdir . '/accesslib.php');
global $DB, $USER;
$admin = get_admin();
if ($admin) { $USER = $admin; }
$systemcontext = context_system::instance();
$roleids = [];
${createBlocks.join("\n")}
${applyBlocks.join("\n")}
accesslib_reset_role_cache();
purge_all_caches();
echo json_encode(['ok' => true, 'roles' => $roleids]);
`;
}

export function phpCreateScale(scale) {
  return phpCreateScales([scale]);
}

// Create or update grade scales. Idempotent on (courseid, name) via the
// grade_scale class. A 'course' shortname scopes the scale to that course;
// omitting it creates a site-wide ("standard") scale (courseid = 0).
// Adapted from the reference apply-scales.php but accepts inline data.
export function phpCreateScales(scales) {
  const blocks = scales.map((s) => {
    const name = escapePhp(s.name);
    const items = escapePhp(normalizeScaleItems(s.items));
    const description = escapePhp(s.description || "");
    const courseLookup = s.course
      ? `$c = $DB->get_record('course', ['shortname' => '${escapePhp(s.course)}'], 'id'); if ($c) { $courseid = (int)$c->id; }`
      : "";
    return `
$name = '${name}';
$items = '${items}';
$courseid = 0;
${courseLookup}
$existing = $DB->get_record('scale', ['courseid' => $courseid, 'name' => $name]);
if ($existing) {
    $scale = new grade_scale(['id' => (int)$existing->id]);
    $scale->courseid = $courseid;
    $scale->userid = (int)$admin->id;
    $scale->name = $name;
    $scale->scale = $items;
    $scale->description = '${description}';
    $scale->descriptionformat = FORMAT_HTML;
    $scale->update('playground_blueprint');
    $results[] = ['name' => $name, 'id' => (int)$scale->id, 'action' => 'updated'];
} else {
    $scale = new grade_scale(null, false);
    $scale->courseid = $courseid;
    $scale->userid = (int)$admin->id;
    $scale->name = $name;
    $scale->scale = $items;
    $scale->description = '${description}';
    $scale->descriptionformat = FORMAT_HTML;
    $sid = (int)$scale->insert('playground_blueprint');
    $results[] = ['name' => $name, 'id' => $sid, 'action' => 'created'];
}`;
  });

  return `${CLI_HEADER}
${GRACEFUL_HANDLER}
require_once($CFG->libdir . '/grade/grade_scale.php');
global $DB, $USER;
$admin = get_admin();
if ($admin) { $USER = $admin; }
$results = [];
${blocks.join("\n")}
purge_all_caches();
echo json_encode(['ok' => true, 'scales' => $results]);
`;
}

export function phpCreateCohort(cohort) {
  return phpCreateCohorts([cohort]);
}

// Create or update site-level cohorts. Idempotent on idnumber when provided,
// otherwise on name (both at the system context). Optional 'members' is a list
// of usernames added to the cohort.
export function phpCreateCohorts(cohorts) {
  const blocks = cohorts.map((c) => {
    const name = escapePhp(c.name);
    const idnumber = c.idnumber ? escapePhp(c.idnumber) : "";
    const description = escapePhp(c.description || "");
    const visible = c.visible === false ? 0 : 1;
    const members = Array.isArray(c.members) ? c.members : [];
    const lookup = idnumber
      ? `$existing = $DB->get_record('cohort', ['contextid' => $systemcontext->id, 'idnumber' => '${idnumber}']);`
      : `$existing = $DB->get_record('cohort', ['contextid' => $systemcontext->id, 'name' => '${name}']);`;
    const memberLines = members
      .map(
        (u) => `
$uid = $DB->get_field('user', 'id', ['username' => '${escapePhp(u)}']);
if ($uid && !$DB->record_exists('cohort_members', ['cohortid' => $cohortid, 'userid' => (int)$uid])) {
    cohort_add_member($cohortid, (int)$uid);
}`,
      )
      .join("\n");
    return `
${lookup}
if ($existing) {
    $cohortid = (int)$existing->id;
    $existing->name = '${name}';
    $existing->description = '${description}';
    $existing->descriptionformat = FORMAT_HTML;
    ${idnumber ? `$existing->idnumber = '${idnumber}';` : ""}
    $existing->visible = ${visible};
    cohort_update_cohort($existing);
} else {
    $cohort = new stdClass();
    $cohort->contextid = $systemcontext->id;
    $cohort->name = '${name}';
    $cohort->idnumber = '${idnumber}';
    $cohort->description = '${description}';
    $cohort->descriptionformat = FORMAT_HTML;
    $cohort->visible = ${visible};
    $cohortid = (int)cohort_add_cohort($cohort);
}
${memberLines}
$results[] = ['name' => '${name}', 'id' => $cohortid];`;
  });

  return `${CLI_HEADER}
${GRACEFUL_HANDLER}
require_once($CFG->dirroot . '/cohort/lib.php');
global $DB, $USER;
$admin = get_admin();
if ($admin) { $USER = $admin; }
$systemcontext = context_system::instance();
$results = [];
${blocks.join("\n")}
purge_all_caches();
echo json_encode(['ok' => true, 'cohorts' => $results]);
`;
}
