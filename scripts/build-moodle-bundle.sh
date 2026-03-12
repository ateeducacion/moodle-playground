#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-moodle"}
DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/moodle"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}
CHANNEL=${CHANNEL:-stable500}
RUNTIME_VERSION=${RUNTIME_VERSION:-0.0.9-alpha-32}

ARCHIVE_PATH=$("$SCRIPT_DIR/fetch-moodle-release.sh" "$CHANNEL" tgz)
STAGE_DIR="$WORK_DIR/stage"
SOURCE_DIR="$STAGE_DIR/source"

rm -rf "$STAGE_DIR"
mkdir -p "$SOURCE_DIR" "$DIST_DIR" "$MANIFEST_DIR"

echo "Extracting $ARCHIVE_PATH" >&2
tar -xzf "$ARCHIVE_PATH" -C "$SOURCE_DIR"

MOODLE_DIR=$(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)

if [ -z "$MOODLE_DIR" ]; then
  echo "Unable to locate extracted Moodle directory" >&2
  exit 1
fi

"$SCRIPT_DIR/patch-moodle-source.sh" "$MOODLE_DIR"

COMPONENT_CACHE_DIR="$MOODLE_DIR/.playground"
COMPONENT_CACHE_FILE="$COMPONENT_CACHE_DIR/core_component.php"
mkdir -p "$COMPONENT_CACHE_DIR"
php "$SCRIPT_DIR/generate-component-cache.php" "$MOODLE_DIR" "$COMPONENT_CACHE_FILE" "/www/moodle"

RELEASE=$(sed -n "s/^[[:space:]]*\\\$release[[:space:]]*=[[:space:]]*'\\([^']*\\)'.*/\\1/p" "$MOODLE_DIR/version.php" | head -n 1)

if [ -z "$RELEASE" ]; then
  RELEASE=$(basename "$MOODLE_DIR")
fi

SAFE_RELEASE=$(printf '%s' "$RELEASE" | sed 's/[^A-Za-z0-9._-]/_/g')
BUNDLE_NAME="moodle-core-$SAFE_RELEASE.zip"
BUNDLE_PATH="$DIST_DIR/$BUNDLE_NAME"
VFS_DATA_NAME="moodle-core-$SAFE_RELEASE.vfs.bin"
VFS_DATA_PATH="$DIST_DIR/$VFS_DATA_NAME"
VFS_INDEX_NAME="moodle-core-$SAFE_RELEASE.vfs.index.json"
VFS_INDEX_PATH="$DIST_DIR/$VFS_INDEX_NAME"
MANIFEST_PATH="$MANIFEST_DIR/latest.json"

echo "Packing $BUNDLE_NAME" >&2
(cd "$MOODLE_DIR" && zip -qr "$BUNDLE_PATH" .)

echo "Building VFS image $VFS_DATA_NAME" >&2
node "$SCRIPT_DIR/build-vfs-image.mjs" \
  --source "$MOODLE_DIR" \
  --data "$VFS_DATA_PATH" \
  --index "$VFS_INDEX_PATH"

FILE_COUNT=$(find "$MOODLE_DIR" -type f | wc -l | tr -d ' ')
SOURCE_URL="https://download.moodle.org/download.php/direct/$CHANNEL/$(basename "$ARCHIVE_PATH")"

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --bundle "$BUNDLE_PATH" \
  --channel "$CHANNEL" \
  --imageData "$VFS_DATA_PATH" \
  --imageFormat moodle-vfs-image-v1 \
  --imageIndex "$VFS_INDEX_PATH" \
  --manifest "$MANIFEST_PATH" \
  --runtimeVersion "$RUNTIME_VERSION" \
  --release "$RELEASE" \
  --fileCount "$FILE_COUNT" \
  --sourceUrl "$SOURCE_URL"

echo "Bundle written to $BUNDLE_PATH" >&2
echo "VFS data written to $VFS_DATA_PATH" >&2
echo "VFS index written to $VFS_INDEX_PATH" >&2
echo "Manifest written to $MANIFEST_PATH" >&2
