#!/bin/sh

# generate-install-snapshot.sh
#
# Runs a full Moodle CLI install against the patched SQLite driver using
# the system PHP, then captures the resulting database file as a pre-built
# snapshot. This snapshot is loaded at runtime instead of re-running the
# installer on every page load.
#
# Usage: generate-install-snapshot.sh <moodle-source-dir> <output-dir>
#
# Prerequisites:
#   - PHP CLI with pdo_sqlite extension
#   - Moodle source already patched (patch-moodle-source.sh)
#   - Component cache already generated (generate-component-cache.php)

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR=${1:-}
OUTPUT_DIR=${2:-}

if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR" ]; then
  echo "Usage: $0 <moodle-source-dir> <output-dir>" >&2
  exit 1
fi

if [ -z "$OUTPUT_DIR" ]; then
  echo "Usage: $0 <moodle-source-dir> <output-dir>" >&2
  exit 1
fi

# Verify the patched SQLite driver exists in the source (Moodle 5.1+ uses public/ prefix)
if [ -f "$SOURCE_DIR/lib/dml/sqlite3_pdo_moodle_database.php" ]; then
  PUB=""
elif [ -f "$SOURCE_DIR/public/lib/dml/sqlite3_pdo_moodle_database.php" ]; then
  PUB="public/"
else
  echo "Error: Patched SQLite driver not found. Run patch-moodle-source.sh first." >&2
  exit 1
fi

# Verify PHP has pdo_sqlite
if ! ${PHP_BIN:-php} -m 2>/dev/null | grep -qi pdo_sqlite; then
  echo "Error: PHP pdo_sqlite extension is required but not available." >&2
  exit 1
fi

TMPROOT=$(mktemp -d)
MOODLEDATA="$TMPROOT/moodledata"
DBFILE="$TMPROOT/moodle.sq3.php"

mkdir -p "$MOODLEDATA"
mkdir -p "$MOODLEDATA/cache"
mkdir -p "$MOODLEDATA/localcache"
mkdir -p "$MOODLEDATA/temp"
mkdir -p "$MOODLEDATA/temp/backup"
mkdir -p "$MOODLEDATA/sessions"
mkdir -p "$MOODLEDATA/muc"
mkdir -p "$OUTPUT_DIR"

cleanup() {
  rm -rf "$TMPROOT"
  # Remove the temporary config.php we write into the source tree
  rm -f "$SOURCE_DIR/config.php"
}
trap cleanup EXIT

# Do NOT use the alternative_component_cache during snapshot generation.
# It was built with /www/moodle paths for the WASM runtime, which don't match
# the build machine filesystem. Moodle will scan the real filesystem instead.

# Write a temporary config.php into the Moodle source tree.
# Uses placeholder paths that will be rewritten at runtime.
cat > "$SOURCE_DIR/config.php" <<CFGEOF
<?php
unset(\$CFG);
global \$CFG;
\$CFG = new stdClass();

\$CFG->dbtype = 'sqlite3';
\$CFG->dblibrary = 'pdo';
\$CFG->dbhost = 'localhost';
\$CFG->dbname = 'moodle_snapshot';
\$CFG->dbuser = '';
\$CFG->dbpass = '';
\$CFG->prefix = 'mdl_';
\$CFG->dboptions = [
    'dbpersist' => 0,
    'dbport' => '',
    'dbsocket' => '',
    'dbhandlesoptions' => false,
    'file' => '$DBFILE',
];

\$CFG->wwwroot = 'http://localhost';
\$CFG->dataroot = '$MOODLEDATA';
\$CFG->cachedir = '$MOODLEDATA/cache';
\$CFG->localcachedir = '$MOODLEDATA/localcache';
\$CFG->tempdir = '$MOODLEDATA/temp';
\$CFG->backuptempdir = '$MOODLEDATA/temp/backup';
\$CFG->admin = 'admin';
\$CFG->directorypermissions = 0777;
\$CFG->debug = 0;
\$CFG->debugdisplay = 0;

if (!defined('NO_DEBUG_DISPLAY')) {
    define('NO_DEBUG_DISPLAY', true);
}
if (!defined('MOODLE_INTERNAL')) {
    define('MOODLE_INTERNAL', true);
}
if (!defined('CACHE_DISABLE_ALL')) {
    define('CACHE_DISABLE_ALL', true);
}
if (!defined('CACHE_DISABLE_STORES')) {
    define('CACHE_DISABLE_STORES', true);
}
if (!defined('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE')) {
    define('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE', true);
}

require_once('$SOURCE_DIR/lib/setup.php');
CFGEOF

echo "Running Moodle CLI install to generate snapshot..." >&2

# Run the Moodle CLI installer
INSTALL_LOG="$TMPROOT/install.log"
${PHP_BIN:-php} -d max_input_vars=5000 "$SOURCE_DIR/admin/cli/install_database.php" \
  --agree-license \
  --adminuser=admin \
  --adminpass=admin \
  --adminemail=admin@example.com \
  --fullname="Moodle Playground" \
  --shortname="Playground" \
  >"$INSTALL_LOG" 2>&1
INSTALL_EXIT=$?

# Show output prefixed for readability
sed 's/^/[snapshot] /' "$INSTALL_LOG" >&2

if [ $INSTALL_EXIT -ne 0 ]; then
  echo "Error: Moodle CLI installer exited with code $INSTALL_EXIT" >&2
  exit 1
fi

if [ ! -f "$DBFILE" ]; then
  echo "Error: Database file was not created at $DBFILE" >&2
  exit 1
fi

DBSIZE=$(wc -c < "$DBFILE" | tr -d ' ')
echo "Snapshot database created: $DBSIZE bytes" >&2

# Apply post-install defaults that the runtime installer normally does in its
# 'finalize' stage. We run a small PHP script to set these directly.
${PHP_BIN:-php} -d max_input_vars=5000 -r "
define('CLI_SCRIPT', true);
define('CACHE_DISABLE_ALL', true);
define('CACHE_DISABLE_STORES', true);
define('PLAYGROUND_SKIP_INITIALISE_CFG', true);
require('$SOURCE_DIR/config.php');

// Post-install defaults (mirrors bootstrap.js createInstallRunnerPhp finalize stage)
\$postinstalldefaults = [
    ['enablemobilewebservice', 0, null],
    ['enablebadges', 1, null],
    ['messaging', 1, null],
    ['enablecompletion', 1, null],
    ['messagingdefaultpressenter', 1, null],
    ['updatenotifybuilds', 0, null],
    ['updateminmaturity', 200, null],
    ['courselistshortnames', 0, null],
    ['coursecreationguide', '', null],
    ['docroot', 'https://docs.moodle.org', null],
    ['doctonewwindow', 0, null],
    ['enroladminnewcourse', 1, null],
    ['noreplyaddress', 'noreply@localhost', null],
    ['supportemail', '', null],
    ['registerauth', '', null],
    ['registrationpending', 1, null],
    ['rolesactive', 1, null],
];
foreach (\$postinstalldefaults as [\$key, \$val, \$plugin]) {
    if (get_config(\$plugin ?? 'core', \$key) === false) {
        set_config(\$key, \$val, \$plugin);
    }
}

// Course defaults (mirrors finalize stage)
\$coursedefaults = [
    'format' => 'topics', 'maxsections' => 52, 'numsections' => 4,
    'hiddensections' => 1, 'coursedisplay' => 0, 'lang' => '',
    'newsitems' => 5, 'showgrades' => 1, 'showreports' => 0,
    'showactivitydates' => 1, 'maxbytes' => 0, 'groupmode' => 0,
    'visible' => 1, 'groupmodeforce' => 0, 'enablecompletion' => 1,
];
foreach (\$coursedefaults as \$k => \$v) {
    if (get_config('moodlecourse', \$k) === false) {
        set_config(\$k, \$v, 'moodlecourse');
    }
}

// Config normalizer defaults
\$normDefaults = [
    'navcourselimit' => '10', 'enablecompletion' => '1',
    'frontpage' => '6', 'frontpageloggedin' => '6',
    'frontpagecourselimit' => '200', 'guestloginbutton' => '0',
    'rememberusername' => '0', 'auth_instructions' => '',
    'maintenance_enabled' => '0', 'maxbytes' => '0',
    'registerauth' => '', 'langmenu' => '0',
    'defaultrequestcategory' => '1', 'customusermenuitems' => '',
    'gradepointdefault' => '100', 'gradepointmax' => '100',
    'downloadcoursecontentallowed' => '0',
    'enablesharingtomoodlenet' => '0',
];
foreach (\$normDefaults as \$name => \$value) {
    \$current = get_config('core', \$name);
    if (\$current === false || \$current === null || \$current === '') {
        set_config(\$name, \$value);
    }
}

echo 'Post-install defaults applied.' . PHP_EOL;

// Cache store plugin settings (needed when CACHE_DISABLE_ALL=false at runtime)
\$cacheStoreDefaults = [
    ['testperformance', 0, 'cachestore_apcu'],
    ['test_clustermode', 0, 'cachestore_redis'],
    ['test_server', '', 'cachestore_redis'],
    ['test_encryption', 0, 'cachestore_redis'],
    ['test_cafile', '', 'cachestore_redis'],
    ['test_password', '', 'cachestore_redis'],
    ['test_ttl', 0, 'cachestore_redis'],
];
foreach (\$cacheStoreDefaults as [\$key, \$val, \$plugin]) {
    if (get_config(\$plugin, \$key) === false) {
        set_config(\$key, \$val, \$plugin);
    }
}
echo 'Cache store defaults applied.' . PHP_EOL;

// Broad sweep: save defaults for ALL admin settings registered in the admin tree.
// This catches any remaining missing defaults that would trigger upgradesettings.php.
try {
    require_once(\$CFG->libdir . '/adminlib.php');
    admin_apply_default_settings(NULL, false);
    echo 'All admin defaults applied.' . PHP_EOL;
} catch (Throwable \$e) {
    echo 'Warning: admin_apply_default_settings failed: ' . \$e->getMessage() . PHP_EOL;
}
" 2>&1 | while IFS= read -r line; do echo "[snapshot] $line" >&2; done

# Note: $CFG->wwwroot comes from config.php (generated at runtime), not from
# mdl_config. No wwwroot rewriting is needed in the snapshot.

# Copy snapshot to output
cp "$DBFILE" "$OUTPUT_DIR/install.sq3"

FINAL_SIZE=$(wc -c < "$OUTPUT_DIR/install.sq3" | tr -d ' ')
echo "Snapshot written to $OUTPUT_DIR/install.sq3 ($FINAL_SIZE bytes)" >&2
