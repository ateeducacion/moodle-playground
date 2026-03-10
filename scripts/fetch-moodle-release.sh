#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/moodle"}
CHANNEL=${1:-stable500}
FORMAT=${2:-tgz}

case "$CHANNEL" in
  stable500)
    FILE_BASE="moodle-latest-500"
    ;;
  stable404)
    FILE_BASE="moodle-latest-404"
    ;;
  *)
    echo "Unsupported channel: $CHANNEL" >&2
    exit 1
    ;;
esac

case "$FORMAT" in
  tgz|zip)
    ;;
  *)
    echo "Unsupported format: $FORMAT" >&2
    exit 1
    ;;
esac

mkdir -p "$CACHE_DIR"

ARCHIVE_NAME="$FILE_BASE.$FORMAT"
ARCHIVE_PATH="$CACHE_DIR/$ARCHIVE_NAME"
ARCHIVE_URL="https://download.moodle.org/download.php/direct/$CHANNEL/$ARCHIVE_NAME"

validate_archive() {
  case "$FORMAT" in
    tgz)
      tar -tzf "$ARCHIVE_PATH" >/dev/null 2>&1
      ;;
    zip)
      unzip -tq "$ARCHIVE_PATH" >/dev/null 2>&1
      ;;
  esac
}

if [ ! -f "$ARCHIVE_PATH" ]; then
  echo "Downloading $ARCHIVE_URL" >&2
  curl -L --fail --output "$ARCHIVE_PATH" "$ARCHIVE_URL"
else
  echo "Using cached archive $ARCHIVE_PATH" >&2
fi

if ! validate_archive; then
  rm -f "$ARCHIVE_PATH"
  echo "Cached archive invalid, redownloading $ARCHIVE_URL" >&2
  curl -L --fail --output "$ARCHIVE_PATH" "$ARCHIVE_URL"
  validate_archive
fi

printf '%s\n' "$ARCHIVE_PATH"
