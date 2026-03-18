#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORK_DIR=${WORK_DIR:-"$REPO_DIR/.cache/build-moodle"}
MANIFEST_DIR=${MANIFEST_DIR:-"$REPO_DIR/assets/manifests"}
RUNTIME_VERSION=${RUNTIME_VERSION:-0.0.9-alpha-32}

# Support both old CHANNEL-based and new BRANCH-based invocation.
# BRANCH takes precedence if set.
BRANCH=${BRANCH:-}
CHANNEL=${CHANNEL:-stable500}

if [ -n "$BRANCH" ]; then
  # New: GitHub-based source fetching
  MOODLE_DIR=$("$SCRIPT_DIR/fetch-moodle-source.sh" "$BRANCH")
  DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/moodle/$BRANCH"}
  MANIFEST_PATH="$MANIFEST_DIR/$BRANCH.json"
  SOURCE_URL="https://github.com/moodle/moodle/tree/$BRANCH"
else
  # Legacy: download.moodle.org-based fetching
  ARCHIVE_PATH=$("$SCRIPT_DIR/fetch-moodle-release.sh" "$CHANNEL" tgz)
  STAGE_DIR="$WORK_DIR/stage"
  SOURCE_DIR="$STAGE_DIR/source"
  rm -rf "$STAGE_DIR"
  mkdir -p "$SOURCE_DIR"
  echo "Extracting $ARCHIVE_PATH" >&2
  tar -xzf "$ARCHIVE_PATH" -C "$SOURCE_DIR"
  MOODLE_DIR=$(find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [ -z "$MOODLE_DIR" ]; then
    echo "Unable to locate extracted Moodle directory" >&2
    exit 1
  fi
  DIST_DIR=${DIST_DIR:-"$REPO_DIR/assets/moodle"}
  MANIFEST_PATH="$MANIFEST_DIR/latest.json"
  SOURCE_URL="https://download.moodle.org/download.php/direct/$CHANNEL/$(basename "$ARCHIVE_PATH")"
fi

mkdir -p "$DIST_DIR" "$MANIFEST_DIR"

"$SCRIPT_DIR/patch-moodle-source.sh" "$MOODLE_DIR" "$BRANCH"

COMPONENT_CACHE_DIR="$MOODLE_DIR/.playground"
COMPONENT_CACHE_FILE="$COMPONENT_CACHE_DIR/core_component.php"
mkdir -p "$COMPONENT_CACHE_DIR"
${PHP_BIN:-php} "$SCRIPT_DIR/generate-component-cache.php" "$MOODLE_DIR" "$COMPONENT_CACHE_FILE" "/www/moodle"

SNAPSHOT_DIR="$DIST_DIR/snapshot"

# Snapshot caching: compute a fingerprint from the inputs that affect the snapshot
# (Moodle source commit + patches + snapshot/patch/component-cache scripts).
# If a cached snapshot with a matching fingerprint exists, skip regeneration.
SNAPSHOT_CACHE_DIR=${SNAPSHOT_CACHE_DIR:-"$REPO_DIR/.cache/snapshots"}
SNAPSHOT_FINGERPRINT=""
if [ -n "$BRANCH" ] && [ -d "$MOODLE_DIR/.git" ]; then
  MOODLE_COMMIT=$(git -C "$MOODLE_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
  SCRIPTS_HASH=$(cat \
    "$SCRIPT_DIR/generate-install-snapshot.sh" \
    "$SCRIPT_DIR/patch-moodle-source.sh" \
    "$SCRIPT_DIR/generate-component-cache.php" \
    2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  PATCHES_HASH=$(find "$REPO_DIR/patches" -type f 2>/dev/null | sort | xargs cat 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  SNAPSHOT_FINGERPRINT="${MOODLE_COMMIT}-${SCRIPTS_HASH:0:16}-${PATCHES_HASH:0:16}"
fi

SNAPSHOT_CACHED=false
if [ -n "$SNAPSHOT_FINGERPRINT" ] && [ -f "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/install.sq3" ]; then
  echo "Snapshot cache hit: $SNAPSHOT_FINGERPRINT" >&2
  mkdir -p "$SNAPSHOT_DIR"
  cp "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/install.sq3" "$SNAPSHOT_DIR/install.sq3"
  SNAPSHOT_CACHED=true
fi

if [ "$SNAPSHOT_CACHED" = false ]; then
  echo "Generating install snapshot (fingerprint: ${SNAPSHOT_FINGERPRINT:-none})" >&2
  if "$SCRIPT_DIR/generate-install-snapshot.sh" "$MOODLE_DIR" "$SNAPSHOT_DIR"; then
    echo "Snapshot generated successfully" >&2
    # Save to cache for future builds
    if [ -n "$SNAPSHOT_FINGERPRINT" ] && [ -f "$SNAPSHOT_DIR/install.sq3" ]; then
      rm -rf "${SNAPSHOT_CACHE_DIR:?}/$BRANCH"
      mkdir -p "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT"
      cp "$SNAPSHOT_DIR/install.sq3" "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/install.sq3"
      echo "Snapshot cached: $SNAPSHOT_FINGERPRINT" >&2
    fi
  else
    echo "WARNING: Snapshot generation failed (exit $?) — bundle will work without it (runtime falls back to CLI install)" >&2
  fi
fi

# Moodle 5.1+ moves version.php under public/
if [ -f "$MOODLE_DIR/version.php" ]; then
  VERSION_PHP="$MOODLE_DIR/version.php"
elif [ -f "$MOODLE_DIR/public/version.php" ]; then
  VERSION_PHP="$MOODLE_DIR/public/version.php"
else
  VERSION_PHP=""
fi

RELEASE=""
if [ -n "$VERSION_PHP" ]; then
  RELEASE=$(sed -n "s/^[[:space:]]*\\\$release[[:space:]]*=[[:space:]]*'\\([^']*\\)'.*/\\1/p" "$VERSION_PHP" | head -n 1)
fi
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

echo "Packing $BUNDLE_NAME" >&2
(cd "$MOODLE_DIR" && zip -qr "$BUNDLE_PATH" .)

echo "Building VFS image $VFS_DATA_NAME" >&2
node "$SCRIPT_DIR/build-vfs-image.mjs" \
  --source "$MOODLE_DIR" \
  --data "$VFS_DATA_PATH" \
  --index "$VFS_INDEX_PATH"

FILE_COUNT=$(find "$MOODLE_DIR" -type f | wc -l | tr -d ' ')

SNAPSHOT_ARGS=""
if [ -f "$SNAPSHOT_DIR/install.sq3" ]; then
  SNAPSHOT_ARGS="--snapshot $SNAPSHOT_DIR/install.sq3"
fi

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --bundle "$BUNDLE_PATH" \
  --channel "${BRANCH:-$CHANNEL}" \
  --imageData "$VFS_DATA_PATH" \
  --imageFormat moodle-vfs-image-v1 \
  --imageIndex "$VFS_INDEX_PATH" \
  --manifest "$MANIFEST_PATH" \
  --runtimeVersion "$RUNTIME_VERSION" \
  --release "$RELEASE" \
  --fileCount "$FILE_COUNT" \
  --sourceUrl "$SOURCE_URL" \
  $SNAPSHOT_ARGS

echo "Bundle written to $BUNDLE_PATH" >&2
echo "VFS data written to $VFS_DATA_PATH" >&2
echo "VFS index written to $VFS_INDEX_PATH" >&2
if [ -f "$SNAPSHOT_DIR/install.sq3" ]; then
  echo "Snapshot written to $SNAPSHOT_DIR/install.sq3" >&2
fi
echo "Manifest written to $MANIFEST_PATH" >&2

# If building the default branch, also copy manifest to latest.json for backward compat
DEFAULT_BRANCH="MOODLE_500_STABLE"
if [ "$BRANCH" = "$DEFAULT_BRANCH" ] && [ "$MANIFEST_PATH" != "$MANIFEST_DIR/latest.json" ]; then
  cp "$MANIFEST_PATH" "$MANIFEST_DIR/latest.json"
  echo "Also wrote $MANIFEST_DIR/latest.json (backward compat)" >&2
fi
