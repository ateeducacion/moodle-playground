#!/bin/sh
#
# Prepares a local PHP environment to run Moodle with SQLite,
# using the same patched source that the WASM runtime uses.
#
# Usage: scripts/setup-local.sh [PORT] [PHP_BIN]
#   PORT defaults to 8081
#   PHP_BIN defaults to "php" (override with e.g. "php84")
#
# After setup, it starts php -S on the patched Moodle source.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PORT=${1:-8081}
PHP_BIN=${2:-php}
BRANCH=${BRANCH:-MOODLE_500_STABLE}
BRANCH_KEY=$(printf '%s' "$BRANCH" | sed 's/[^A-Za-z0-9._-]/_/g')

MOODLE_DIR="$REPO_DIR/.cache/moodle/$BRANCH"
LOCAL_DIR="$REPO_DIR/.cache/local/$BRANCH_KEY"
MOODLEDATA_DIR="$LOCAL_DIR/moodledata"
DB_FILE="$MOODLEDATA_DIR/moodle_local_${BRANCH_KEY}.sq3.php"
CONFIG_FILE="$MOODLE_DIR/config.php"
DOCROOT="$MOODLE_DIR"

if [ ! -d "$MOODLE_DIR" ]; then
  echo "Patched Moodle source not found at $MOODLE_DIR" >&2
  echo "Run 'BRANCH=$BRANCH make bundle' first to download and patch Moodle." >&2
  exit 1
fi

if [ -f "$MOODLE_DIR/public/lib/setup.php" ]; then
  DOCROOT="$MOODLE_DIR/public"
fi

# Keep local native PHP aligned with the minimum Moodle settings used by the
# WASM runtime and snapshot generation scripts.
PHP_COMMON_ARGS="
-d max_input_vars=5000
-d memory_limit=512M
-d post_max_size=128M
-d upload_max_filesize=128M
"

# Check native PHP has pdo_sqlite
if ! "$PHP_BIN" -m 2>/dev/null | grep -qi pdo_sqlite; then
  echo "$PHP_BIN does not have pdo_sqlite enabled." >&2
  exit 1
fi

# Create moodledata and subdirectories
mkdir -p "$MOODLEDATA_DIR/cache"
mkdir -p "$MOODLEDATA_DIR/localcache"
mkdir -p "$MOODLEDATA_DIR/sessions"
mkdir -p "$MOODLEDATA_DIR/temp/backup"
mkdir -p "$MOODLEDATA_DIR/temp/sessions"

WWWROOT="http://localhost:$PORT"

# Write config.php into the Moodle source directory.
# For public-root Moodle branches, public/config.php already loads ../config.php.
cat > "$CONFIG_FILE" <<CONFIGEOF
<?php
unset(\$CFG);
global \$CFG;
\$CFG = new stdClass();

\$CFG->dbtype = 'sqlite3';
\$CFG->dblibrary = 'pdo';
\$CFG->dbhost = 'localhost';
\$CFG->dbname = 'moodle_local_${BRANCH_KEY}';
\$CFG->dbuser = '';
\$CFG->dbpass = '';
\$CFG->prefix = 'mdl_';
\$CFG->dboptions = [
    'dbpersist' => 0,
    'dbport' => '',
    'dbsocket' => '',
    'dbhandlesoptions' => false,
    'file' => '$DB_FILE',
];

\$CFG->wwwroot = '$WWWROOT';
\$CFG->dataroot = '$MOODLEDATA_DIR';
\$CFG->cachedir = '$MOODLEDATA_DIR/cache';
\$CFG->localcachedir = '$MOODLEDATA_DIR/localcache';
\$CFG->tempdir = '$MOODLEDATA_DIR/temp';
\$CFG->backuptempdir = '$MOODLEDATA_DIR/temp/backup';
\$CFG->admin = 'admin';
\$CFG->directorypermissions = 0777;
\$CFG->sslproxy = false;
\$CFG->reverseproxy = false;
\$CFG->debug = E_ALL;
\$CFG->debugdisplay = 1;
\$CFG->debugdeveloper = true;
\$CFG->cachejs = false;
\$CFG->cachetemplates = false;
\$CFG->langstringcache = true;
\$CFG->themedesignermode = false;

if (!property_exists(\$CFG, 'maxbytes')) {
    \$CFG->maxbytes = 0;
}
if (!property_exists(\$CFG, 'navcourselimit')) {
    \$CFG->navcourselimit = 10;
}
if (!property_exists(\$CFG, 'guestloginbutton')) {
    \$CFG->guestloginbutton = 0;
}
if (!property_exists(\$CFG, 'rememberusername')) {
    \$CFG->rememberusername = 0;
}
if (!property_exists(\$CFG, 'maintenance_enabled')) {
    \$CFG->maintenance_enabled = 0;
}
if (!property_exists(\$CFG, 'registerauth')) {
    \$CFG->registerauth = '';
}
if (!property_exists(\$CFG, 'langmenu')) {
    \$CFG->langmenu = 0;
}

if (!defined('NO_DEBUG_DISPLAY')) {
    define('NO_DEBUG_DISPLAY', false);
}

require_once(__DIR__ . '/lib/setup.php');
CONFIGEOF

# If no database exists, run CLI install automatically
if [ ! -f "$DB_FILE" ]; then
  echo "=== First run: installing Moodle via CLI ===" >&2
  cd "$MOODLE_DIR"
  # shellcheck disable=SC2086
  "$PHP_BIN" $PHP_COMMON_ARGS admin/cli/install_database.php \
    --lang=en \
    --adminuser=admin \
    --adminpass='password' \
    --adminemail=admin@example.com \
    --fullname='Moodle Playground (local)' \
    --shortname='Playground' \
    --agree-license
  echo "" >&2
  echo "Installation complete. Admin credentials:" >&2
  echo "  Username: admin" >&2
  echo "  Password: password" >&2
  echo "" >&2
fi

echo "=== Moodle local PHP setup ===" >&2
echo "Branch:        $BRANCH" >&2
echo "Moodle source: $MOODLE_DIR" >&2
echo "Docroot:       $DOCROOT" >&2
echo "Config:        $CONFIG_FILE" >&2
echo "Moodledata:    $MOODLEDATA_DIR" >&2
echo "Database:      $DB_FILE" >&2
echo "URL:           $WWWROOT" >&2
echo "" >&2
echo "PHP binary:    $PHP_BIN ($("$PHP_BIN" -v 2>&1 | head -1))" >&2
echo "Starting $PHP_BIN -S on port $PORT with docroot $DOCROOT..." >&2
echo "Open $WWWROOT in your browser." >&2
echo "" >&2

cd "$MOODLE_DIR"
# shellcheck disable=SC2086
exec "$PHP_BIN" $PHP_COMMON_ARGS -S "localhost:$PORT" -t "$DOCROOT"
