/**
 * PHP code generators for Moodle API calls.
 * All generated scripts use CLI_SCRIPT mode and echo JSON results.
 */

// config.php always lives at MOODLE_ROOT (/www/moodle) regardless of webRoot.
// We must use an absolute path because php.run() executes code without a
// script file, so __DIR__ does not resolve to the Moodle directory.
const MOODLE_ROOT = "/www/moodle";

function escapePhp(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

const CLI_HEADER = `<?php
define('CLI_SCRIPT', true);
require('${MOODLE_ROOT}/config.php');
`;

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
  const blocks = sections.map(
    (s, i) => `
$course${i} = $DB->get_record('course', ['shortname' => '${escapePhp(s.course)}'], '*', MUST_EXIST);
$sec${i} = course_create_section($course${i}->id, ${parseInt(s.position || 0, 10)});
$results[] = $sec${i};`,
  );

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

export function phpAddModule(mod) {
  const course = escapePhp(mod.course);
  const section = parseInt(mod.section || 0, 10);
  const name = escapePhp(mod.name || mod.module);

  switch (mod.module) {
    case "label":
      return phpAddLabel(course, section, name, escapePhp(mod.intro || ""));
    case "folder":
      return phpAddFolder(course, section, name, escapePhp(mod.intro || ""));
    case "assign":
      return phpAddAssign(course, section, name, escapePhp(mod.intro || ""));
    default:
      return phpAddGenericModule(
        mod.module,
        course,
        section,
        name,
        escapePhp(mod.intro || ""),
      );
  }
}

function phpAddLabel(course, section, name, intro) {
  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/course/lib.php');
global $DB;
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
$cm = add_moduleinfo($moduleInfo, $course);
echo json_encode(['ok' => true, 'cmid' => $cm->coursemodule]);
`;
}

function phpAddFolder(course, section, name, intro) {
  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/course/lib.php');
global $DB;
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
$cm = add_moduleinfo($moduleInfo, $course);
echo json_encode(['ok' => true, 'cmid' => $cm->coursemodule]);
`;
}

function phpAddAssign(course, section, name, intro) {
  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/assign/lib.php');
global $DB;
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
$cm = add_moduleinfo($moduleInfo, $course);
echo json_encode(['ok' => true, 'cmid' => $cm->coursemodule]);
`;
}

function phpAddGenericModule(moduleName, course, section, name, intro) {
  return `${CLI_HEADER}
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/course/lib.php');
global $DB;
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
$cm = add_moduleinfo($moduleInfo, $course);
echo json_encode(['ok' => true, 'cmid' => $cm->coursemodule]);
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
