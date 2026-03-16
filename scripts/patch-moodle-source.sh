#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SHARED_PATCH_DIR="$SCRIPT_DIR/../patches/shared"
LEGACY_PATCH_DIR="$SCRIPT_DIR/../patches/moodle"
SOURCE_DIR=${1:-}
BRANCH=${2:-}

if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR" ]; then
  echo "Usage: $0 <moodle-source-dir> [branch]" >&2
  exit 1
fi

# Determine which patch directory to use for file copies:
# prefer patches/shared, fall back to legacy patches/moodle
if [ -d "$SHARED_PATCH_DIR" ]; then
  PATCH_DIR="$SHARED_PATCH_DIR"
else
  PATCH_DIR="$LEGACY_PATCH_DIR"
fi

# Per-branch patch directory (applied after shared patches)
BRANCH_PATCH_DIR=""
if [ -n "$BRANCH" ] && [ -d "$SCRIPT_DIR/../patches/$BRANCH" ]; then
  BRANCH_PATCH_DIR="$SCRIPT_DIR/../patches/$BRANCH"
fi

# Moodle 5.1+ moves core files under public/. Detect the prefix.
if [ -f "$SOURCE_DIR/public/lib/setup.php" ] && [ "$(wc -l < "$SOURCE_DIR/public/lib/setup.php")" -gt 100 ]; then
  PUB="public/"
else
  PUB=""
fi

DMLLIB="$SOURCE_DIR/${PUB}lib/dmllib.php"
INSTALLPHP="$SOURCE_DIR/${PUB}install.php"
CACHEPHP="$SOURCE_DIR/${PUB}cache/classes/cache.php"
INSTALL_LANG_EN="$SOURCE_DIR/${PUB}lang/en/install.php"
PDO_SQLITE_DRIVER_PATCH="$PATCH_DIR/lib/dml/sqlite3_pdo_moodle_database.php"
SQLITE_GENERATOR_PATCH="$PATCH_DIR/lib/ddl/sqlite_sql_generator.php"
XMLIZE_PATCH="$PATCH_DIR/lib/xmlize.php"
XMLDB_FILE_PATCH="$PATCH_DIR/lib/xmldb/xmldb_file.php"
ENCRYPTION_PATCH="$PATCH_DIR/lib/classes/encryption.php"
COMPONENTPHP="$SOURCE_DIR/${PUB}lib/classes/component.php"
SETUPLIBPHP="$SOURCE_DIR/${PUB}lib/setuplib.php"
SETUPPHP="$SOURCE_DIR/${PUB}lib/setup.php"

if [ -f "$DMLLIB" ] && [ -f "$SOURCE_DIR/lib/classes/exception/response_aware_exception.php" ] && ! grep -q "response_aware_exception.php" "$DMLLIB"; then
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

if [ -f "$PDO_SQLITE_DRIVER_PATCH" ]; then
  mkdir -p "$SOURCE_DIR/lib/dml"
  cp "$PDO_SQLITE_DRIVER_PATCH" "$SOURCE_DIR/lib/dml/sqlite3_pdo_moodle_database.php"
fi

if [ -f "$SQLITE_GENERATOR_PATCH" ]; then
  mkdir -p "$SOURCE_DIR/lib/ddl"
  cp "$SQLITE_GENERATOR_PATCH" "$SOURCE_DIR/lib/ddl/sqlite_sql_generator.php"
fi

if [ -f "$XMLIZE_PATCH" ]; then
  mkdir -p "$SOURCE_DIR/lib"
  cp "$XMLIZE_PATCH" "$SOURCE_DIR/lib/xmlize.php"
fi

if [ -f "$XMLDB_FILE_PATCH" ]; then
  mkdir -p "$SOURCE_DIR/lib/xmldb"
  cp "$XMLDB_FILE_PATCH" "$SOURCE_DIR/lib/xmldb/xmldb_file.php"
fi

if [ -f "$ENCRYPTION_PATCH" ]; then
  mkdir -p "$SOURCE_DIR/lib/classes"
  cp "$ENCRYPTION_PATCH" "$SOURCE_DIR/lib/classes/encryption.php"
fi

PDO_DATABASE="$SOURCE_DIR/lib/dml/pdo_moodle_database.php"
if [ -f "$PDO_DATABASE" ] && grep -q 'query_end(\$result)' "$PDO_DATABASE"; then
  python3 - "$PDO_DATABASE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

# Fix begin_transaction, commit_transaction, rollback_transaction
# where $result is used without being initialised (PHP 8.x warning).
replacements = [
    (
        "    protected function begin_transaction() {\n"
        "        $this->query_start('', NULL, SQL_QUERY_AUX);\n"
        "        try {\n"
        "            $this->pdb->beginTransaction();\n"
        "        } catch(PDOException $ex) {\n"
        "            $this->lastError = $ex->getMessage();\n"
        "        }\n"
        "        $this->query_end($result);\n"
        "    }",
        "    protected function begin_transaction() {\n"
        "        $this->query_start('', NULL, SQL_QUERY_AUX);\n"
        "        $result = true;\n"
        "        try {\n"
        "            $this->pdb->beginTransaction();\n"
        "        } catch(PDOException $ex) {\n"
        "            $this->lastError = $ex->getMessage();\n"
        "            $result = false;\n"
        "        }\n"
        "        $this->query_end($result);\n"
        "    }",
    ),
    (
        "    protected function commit_transaction() {\n"
        "        $this->query_start('', NULL, SQL_QUERY_AUX);\n"
        "\n"
        "        try {\n"
        "            $this->pdb->commit();\n"
        "        } catch(PDOException $ex) {\n"
        "            $this->lastError = $ex->getMessage();\n"
        "        }\n"
        "        $this->query_end($result);\n"
        "    }",
        "    protected function commit_transaction() {\n"
        "        $this->query_start('', NULL, SQL_QUERY_AUX);\n"
        "        $result = true;\n"
        "        try {\n"
        "            $this->pdb->commit();\n"
        "        } catch(PDOException $ex) {\n"
        "            $this->lastError = $ex->getMessage();\n"
        "            $result = false;\n"
        "        }\n"
        "        $this->query_end($result);\n"
        "    }",
    ),
    (
        "    protected function rollback_transaction() {\n"
        "        $this->query_start('', NULL, SQL_QUERY_AUX);\n"
        "\n"
        "        try {\n"
        "            $this->pdb->rollBack();\n"
        "        } catch(PDOException $ex) {\n"
        "            $this->lastError = $ex->getMessage();\n"
        "        }\n"
        "        $this->query_end($result);\n"
        "    }",
        "    protected function rollback_transaction() {\n"
        "        $this->query_start('', NULL, SQL_QUERY_AUX);\n"
        "        $result = true;\n"
        "        try {\n"
        "            $this->pdb->rollBack();\n"
        "        } catch(PDOException $ex) {\n"
        "            $this->lastError = $ex->getMessage();\n"
        "            $result = false;\n"
        "        }\n"
        "        $this->query_end($result);\n"
        "    }",
    ),
]

for old, new in replacements:
    text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
PY
fi

ENVIRONMENT_XML="$SOURCE_DIR/admin/environment.xml"
if [ -f "$ENVIRONMENT_XML" ]; then
  python3 - "$ENVIRONMENT_XML" <<'PY'
from pathlib import Path
import sys, re

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

# Add sqlite as a supported vendor in every DATABASE block that does not already have it.
# Insert right after the last existing VENDOR line in each DATABASE section.
def add_sqlite_vendor(match):
    block = match.group(0)
    if 'name="sqlite"' in block:
        return block
    # Insert before </DATABASE>
    return block.replace(
        "    </DATABASE>",
        '      <VENDOR name="sqlite" version="3.0" />\n    </DATABASE>',
    )

patched = re.sub(r"<DATABASE level=\"required\">.*?</DATABASE>", add_sqlite_vendor, text, flags=re.DOTALL)

if patched == text:
    raise SystemExit("No DATABASE blocks found in environment.xml")

path.write_text(patched, encoding="utf-8")
PY
fi

if [ -f "$INSTALL_LANG_EN" ] && ! grep -q "pdosqlite" "$INSTALL_LANG_EN"; then
  python3 - "$INSTALL_LANG_EN" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = "$string['nativepgsqlhelp'] = '<p>The database is where most of the Moodle settings and data are stored and must be configured here.</p>\n<p>The database name, username, password and table prefix are required fields.</p>\n<p>The database must already exist and the user must have access to both read, and write to it.</p>';\n"
insert = needle + (
    "$string['pdosqlite'] = 'SQLite (PDO)';\n"
    "$string['pdosqlitehelp'] = '<p>The database is where most of the Moodle settings and data are stored and must be configured here.</p>\n"
    "<p>This runtime uses the deprecated Moodle SQLite PDO driver backed by a persistent SQLite file in the browser filesystem.</p>\n"
    "<p>The database name and table prefix are required fields. The playground runtime sets the SQLite file path explicitly in config.php.</p>';\n"
)

if needle not in text:
    raise SystemExit(f"Needle not found in {path}")

path.write_text(text.replace(needle, insert, 1), encoding="utf-8")
PY
fi

# Apply per-branch patches (file copies from patches/$BRANCH/)
if [ -n "$BRANCH_PATCH_DIR" ]; then
  echo "Applying per-branch patches from $BRANCH_PATCH_DIR" >&2
  find "$BRANCH_PATCH_DIR" -type f -name '*.php' | while IFS= read -r patchfile; do
    relpath="${patchfile#"$BRANCH_PATCH_DIR/"}"
    target_dir="$SOURCE_DIR/$(dirname "$relpath")"
    mkdir -p "$target_dir"
    cp "$patchfile" "$SOURCE_DIR/$relpath"
    echo "  Copied branch patch: $relpath" >&2
  done
fi
