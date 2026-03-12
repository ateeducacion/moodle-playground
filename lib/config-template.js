import { MOODLE_BASE_PATH, MOODLEDATA_ROOT, MOODLE_ROOT, TEMP_ROOT } from "./constants.js";

function escapePhpSingleQuoted(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export function createMoodleConfigPhp({
  origin,
  adminUser,
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

$CFG->dbtype = 'sqlite';
$CFG->dblibrary = 'pdo';
$CFG->dbhost = '';
$CFG->dbname = '/persist/${escapePhpSingleQuoted(dbName)}.db';
$CFG->dbuser = '';
$CFG->dbpass = '';
$CFG->prefix = '${escapePhpSingleQuoted(prefix)}';
$CFG->dboptions = [
    'dbpersist' => 0,
    'dbport' => '',
    'dbsocket' => '',
    'dbhandlesoptions' => false,
];

$CFG->wwwroot = '${escapePhpSingleQuoted(wwwroot)}';
$CFG->dataroot = '${escapePhpSingleQuoted(MOODLEDATA_ROOT)}';
$CFG->admin = '${escapePhpSingleQuoted(adminUser)}';
$CFG->directorypermissions = 0777;
$CFG->sslproxy = false;
$CFG->reverseproxy = false;

define('NO_DEBUG_DISPLAY', false);
define('MOODLE_INTERNAL', false);

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
