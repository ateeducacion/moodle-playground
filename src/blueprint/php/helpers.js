/**
 * PHP code generators for Moodle API calls.
 * All generated scripts use CLI_SCRIPT mode and echo JSON results.
 */

// config.php always lives at MOODLE_ROOT (/www/moodle) regardless of webRoot.
// We must use an absolute path because php.run() executes code without a
// script file, so __DIR__ does not resolve to the Moodle directory.
const MOODLE_ROOT = "/www/moodle";

export function escapePhp(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\0", "\\0")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

const CLI_HEADER = `<?php
define('CLI_SCRIPT', true);
require('${MOODLE_ROOT}/config.php');
`;

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
    .map(([k, v]) => {
      if (typeof v === "number" || typeof v === "boolean") {
        return `$moduleInfo->${escapePhp(k)} = ${typeof v === "boolean" ? (v ? 1 : 0) : v};`;
      }
      return `$moduleInfo->${escapePhp(k)} = '${escapePhp(String(v))}';`;
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
