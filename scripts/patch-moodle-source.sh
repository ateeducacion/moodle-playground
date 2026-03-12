#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATCH_DIR="$SCRIPT_DIR/../patches/moodle"
SOURCE_DIR=${1:-}

if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR" ]; then
  echo "Usage: $0 <moodle-source-dir>" >&2
  exit 1
fi

DMLLIB="$SOURCE_DIR/lib/dmllib.php"
INSTALLPHP="$SOURCE_DIR/install.php"
CACHEPHP="$SOURCE_DIR/cache/classes/cache.php"
INSTALL_LANG_EN="$SOURCE_DIR/lang/en/install.php"
SQLITE_DRIVER_PATCH="$PATCH_DIR/lib/dml/sqlite_pdo_moodle_database.php"
TRANSLATING_PDO_PATCH="$PATCH_DIR/lib/dml/sqlite_translating_pdo.php"
SQLITE_AST_DIR="$PATCH_DIR/lib/dml/sqlite-ast-driver"
COMPONENTPHP="$SOURCE_DIR/lib/classes/component.php"
SETUPLIBPHP="$SOURCE_DIR/lib/setuplib.php"
SETUPPHP="$SOURCE_DIR/lib/setup.php"

if [ -f "$DMLLIB" ] && ! grep -q "response_aware_exception.php" "$DMLLIB"; then
  python3 - "$DMLLIB" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "defined('MOODLE_INTERNAL') || die();\n"
insert = (
    "defined('MOODLE_INTERNAL') || die();\n\n"
    "if (!interface_exists(\\core\\exception\\response_aware_exception::class, false)) {\n"
    "    require_once($CFG->dirroot.'/lib/classes/exception/response_aware_exception.php');\n"
    "}\n"
)

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

if [ -f "$CACHEPHP" ] && ! grep -q "loader_interface.php" "$CACHEPHP"; then
  python3 - "$CACHEPHP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "namespace core_cache;\n\n"
insert = (
    "namespace core_cache;\n\n"
    "require_once(__DIR__.'/loader_interface.php');\n\n"
)

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

if [ -f "$COMPONENTPHP" ] && ! grep -q "PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE" "$COMPONENTPHP"; then
  python3 - "$COMPONENTPHP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = """                if (CACHE_DISABLE_ALL) {\n                    // Verify the cache state only on upgrade pages.\n                    $content = self::get_cache_content();\n                    if (sha1_file($cachefile) !== sha1($content)) {\n                        die('Outdated component cache file defined in $CFG->alternative_component_cache, can not continue');\n                    }\n                    return;\n                }\n"""
insert = """                if (CACHE_DISABLE_ALL && (!defined('PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE') || !PLAYGROUND_ALLOW_OUTDATED_COMPONENT_CACHE)) {\n                    // Verify the cache state only on upgrade pages.\n                    $content = self::get_cache_content();\n                    if (sha1_file($cachefile) !== sha1($content)) {\n                        die('Outdated component cache file defined in $CFG->alternative_component_cache, can not continue');\n                    }\n                    return;\n                }\n"""

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

if [ -f "$SETUPLIBPHP" ] && ! grep -q "PLAYGROUND_SKIP_INITIALISE_CFG" "$SETUPLIBPHP"; then
  python3 - "$SETUPLIBPHP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = """function initialise_cfg() {\n    global $CFG, $DB;\n\n    if (!$DB) {\n"""
insert = """function initialise_cfg() {\n    global $CFG, $DB;\n\n    if (defined('PLAYGROUND_SKIP_INITIALISE_CFG') && PLAYGROUND_SKIP_INITIALISE_CFG) {\n        return;\n    }\n\n    if (!$DB) {\n"""

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

if [ -f "$SETUPPHP" ] && ! grep -q "PLAYGROUND_SKIP_INSTALL_BOOTSTRAP" "$SETUPPHP"; then
  python3 - "$SETUPPHP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = """// SYSCONTEXTID is cached in local cache to eliminate 1 query per page.\nif (!defined('SYSCONTEXTID')) {\n    context_system::instance();\n}\n\n// Defining the site - aka frontpage course\ntry {\n    $SITE = get_site();\n} catch (moodle_exception $e) {\n    $SITE = null;\n    if (empty($CFG->version)) {\n        $SITE = new stdClass();\n        $SITE->id = 1;\n        $SITE->shortname = null;\n    } else {\n        throw $e;\n    }\n}\n"""
insert = """// SYSCONTEXTID is cached in local cache to eliminate 1 query per page.\nif (!(defined('PLAYGROUND_SKIP_INSTALL_BOOTSTRAP') && PLAYGROUND_SKIP_INSTALL_BOOTSTRAP)) {\n    if (!defined('SYSCONTEXTID')) {\n        context_system::instance();\n    }\n\n    // Defining the site - aka frontpage course\n    try {\n        $SITE = get_site();\n    } catch (moodle_exception $e) {\n        $SITE = null;\n        if (empty($CFG->version)) {\n            $SITE = new stdClass();\n            $SITE->id = 1;\n            $SITE->shortname = null;\n        } else {\n            throw $e;\n        }\n    }\n} else {\n    $SITE = new stdClass();\n    $SITE->id = 1;\n    $SITE->shortname = null;\n}\n"""

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

if [ -f "$INSTALLPHP" ] && ! grep -q "lib/classes/session/manager.php" "$INSTALLPHP"; then
  python3 - "$INSTALLPHP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "require_once($CFG->libdir.'/componentlib.class.php');\n"
insert = (
    "require_once($CFG->libdir.'/componentlib.class.php');\n"
    "require_once($CFG->dirroot.'/lib/classes/session/manager.php');\n"
)

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

if [ -f "$SQLITE_DRIVER_PATCH" ]; then
  mkdir -p "$SOURCE_DIR/lib/dml"
  cp "$SQLITE_DRIVER_PATCH" "$SOURCE_DIR/lib/dml/sqlite_pdo_moodle_database.php"
  cp "$TRANSLATING_PDO_PATCH" "$SOURCE_DIR/lib/dml/sqlite_translating_pdo.php"
  cp -r "$SQLITE_AST_DIR" "$SOURCE_DIR/lib/dml/sqlite-ast-driver/"
fi

if [ -f "$INSTALL_LANG_EN" ] && ! grep -q "pdosqlite" "$INSTALL_LANG_EN"; then
  python3 - "$INSTALL_LANG_EN" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "$string['nativepgsqlhelp'] = '<p>The database is where most of the Moodle settings and data are stored and must be configured here.</p>\n<p>The database name, username, password and table prefix are required fields.</p>\n<p>The database must already exist and the user must have access to both read, and write to it.</p>';\n"
insert = needle + (
    "$string['pdosqlite'] = 'SQLite (PDO/AST Translator)';\n"
    "$string['pdosqlitehelp'] = '<p>The database is where most of the Moodle settings and data are stored and must be configured here.</p>\n"
    "<p>This runtime uses PDO SQLite with the WordPress sqlite-database-integration AST translator to run MySQL queries on SQLite.</p>\n"
    "<p>The database is stored locally in the browser using IDBFS persistence.</p>';\n"
)

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi
