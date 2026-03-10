#!/bin/sh

set -eu

SOURCE_DIR=${1:-}

if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR" ]; then
  echo "Usage: $0 <moodle-source-dir>" >&2
  exit 1
fi

DMLLIB="$SOURCE_DIR/lib/dmllib.php"
INSTALLPHP="$SOURCE_DIR/install.php"
CACHEPHP="$SOURCE_DIR/cache/classes/cache.php"

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
