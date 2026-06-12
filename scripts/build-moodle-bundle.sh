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

# Moodle 5.1+ manages its runtime dependencies with Composer; vendor/ is no
# longer committed to the source tree, so the git checkout from
# fetch-moodle-source.sh lacks it. The component-cache and install-snapshot
# steps below boot Moodle, which without vendor/ fails its "Composer vendor
# directory not found" environment check (and can fatal on missing autoloaded
# classes). Materialize vendor/ with native Composer on the build machine
# before those steps; vendor/ then travels in the bundle (it is not excluded
# from the zip, and PHP autoloading is self-contained — composer.json/lock stay
# excluded). Pre-5.1 has no public/ webroot and ships its dependencies, so it is
# skipped. Idempotent: a no-op if vendor/ already exists.
if [ -f "$MOODLE_DIR/composer.json" ] \
  && [ ! -f "$MOODLE_DIR/vendor/autoload.php" ] \
  && [ -f "$MOODLE_DIR/public/version.php" ]; then
  echo "Installing Composer runtime dependencies (Moodle 5.1+)" >&2
  ( cd "$MOODLE_DIR" && composer install --no-dev --prefer-dist \
      --classmap-authoritative --no-interaction --no-progress )
fi

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
  SNAPSHOT_FINGERPRINT="${MOODLE_COMMIT}-$(printf '%.16s' "$SCRIPTS_HASH")-$(printf '%.16s' "$PATCHES_HASH")"
fi

# A valid cached snapshot is the DB plus the localcache seed (theme CSS +
# DI container) generated in the same run — restore only when both exist.
SNAPSHOT_CACHED=false
if [ -n "$SNAPSHOT_FINGERPRINT" ] \
  && [ -f "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/install.sq3" ] \
  && [ -f "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/localcache.zip" ]; then
  echo "Snapshot cache hit: $SNAPSHOT_FINGERPRINT" >&2
  mkdir -p "$SNAPSHOT_DIR"
  cp "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/install.sq3" "$SNAPSHOT_DIR/install.sq3"
  cp "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/localcache.zip" "$SNAPSHOT_DIR/localcache.zip"
  SNAPSHOT_CACHED=true
fi

if [ "$SNAPSHOT_CACHED" = false ]; then
  echo "Generating install snapshot (fingerprint: ${SNAPSHOT_FINGERPRINT:-none})" >&2
  if "$SCRIPT_DIR/generate-install-snapshot.sh" "$MOODLE_DIR" "$SNAPSHOT_DIR"; then
    echo "Snapshot generated successfully" >&2
    # Save to cache for future builds
    if [ -n "$SNAPSHOT_FINGERPRINT" ] \
      && [ -f "$SNAPSHOT_DIR/install.sq3" ] \
      && [ -f "$SNAPSHOT_DIR/localcache.zip" ]; then
      rm -rf "${SNAPSHOT_CACHE_DIR:?}/$BRANCH"
      mkdir -p "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT"
      cp "$SNAPSHOT_DIR/install.sq3" "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/install.sq3"
      cp "$SNAPSHOT_DIR/localcache.zip" "$SNAPSHOT_CACHE_DIR/$BRANCH/$SNAPSHOT_FINGERPRINT/localcache.zip"
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

echo "Packing $BUNDLE_NAME" >&2
# Remove any previous archive: zip -r UPDATES an existing file, which would
# keep entries that the exclusion list below no longer allows.
rm -f "$BUNDLE_PATH"

# Exclusion list. zip -x patterns match the stored entry paths (no leading
# "./"), so "README.md" anchors at the bundle root while "*/README*" matches
# nested entries only. Keep this an explicit, commented allowlist: audit any
# new pattern against ALL branches before landing — e.g. HISTORY* must NEVER
# be added (it would swallow real code: mod/wiki/history.php,
# lib/aws-sdk/src/History.php, question/bank/history/...). The PHP-parity
# tripwire below fails the build if a pattern ever swallows runtime PHP.
# See docs/decisions/0011-bundle-trim-and-runtime-tuning.md.
#
# The runtime never reads VCS metadata or PHPUnit/Behat test suites; excluding
# them cuts the download roughly in half (the shallow .git packfile alone is
# ~82 MB of incompressible data) and shrinks MEMFS/extraction accordingly.
# IMPORTANT: only */tests/* may be excluded. A standalone behat pattern would
# also delete lib/behat/ (required at runtime by theme/boost layouts via
# require_once($CFG->libdir . '/behat/lib.php')) and admin/tool/behat/ (an
# installed plugin); plugin Behat suites live under */tests/behat/ and are
# already covered by the tests pattern.
set -- -x ".git/*" -x "*/tests/*" -x "node_modules/*" -x "*/node_modules/*"

# AMD sources: Moodle serves the compiled amd/build/*.min.js. The dev-mode
# fallback in lib/requirejs.php only reads amd/src when a module's
# .min.js.map is MISSING, and every bundled min.js ships its map, so amd/src
# is dead weight (~845 files / ~13 MB uncompressed). INVARIANT: while
# $CFG->cachejs is false, amd/src XOR *.map must remain in the bundle —
# excluding BOTH breaks dev-mode JS (lib/requirejs.php falls back to reading
# amd/src when the map is absent).
set -- "$@" -x "*/amd/src/*"

# Root-level docs and build/CI/IDE metadata — never in the runtime include
# graph. security.txt is deliberately KEPT (it is a servable file).
set -- "$@" \
  -x "UPGRADING.md" -x "CONTRIBUTING.md" -x "README.md" -x "INSTALL.txt" \
  -x "COPYING.txt" -x "TRADEMARK.txt" \
  -x "Gruntfile.js" -x "package.json" -x "npm-shrinkwrap.json" \
  -x "composer.json" -x "composer.lock" \
  -x ".github/*" -x ".grunt/*" -x ".upgradenotes/*" -x ".esbuild/*" -x ".jest/*" \
  -x ".eslintrc" -x ".stylelintrc" -x ".gherkin-lintrc" -x ".jshintrc" \
  -x ".jshintignore" -x ".nvmrc" -x ".shifter.json" -x ".phpstorm.meta.php" \
  -x ".gitattributes" -x ".gitignore"

# Vendor/plugin documentation bundled by Moodle's dependency strategy —
# nothing in the runtime include graph reads these (~344 files / ~4.6 MB).
set -- "$@" \
  -x "*/README*" -x "*/readme*" \
  -x "*/CHANGELOG*" -x "*/changelog*" -x "*/CHANGES*" \
  -x "*/AUTHORS*" -x "*/CONTRIBUTING*" \
  -x "*/upgrade.txt" -x "*/UPGRADING*"

(cd "$MOODLE_DIR" && zip -qr "$BUNDLE_PATH" . "$@")

# Keep the manifest fileCount consistent with what the zip actually contains:
# derive it from the artifact itself instead of mirroring the exclusion list
# in a parallel find (root-anchored patterns like "README.md" cannot be
# expressed as -not -path filters, so a mirror would silently drift).
mkdir -p "$WORK_DIR"
BUNDLE_LISTING="$WORK_DIR/bundle-listing.txt"
unzip -Z1 "$BUNDLE_PATH" > "$BUNDLE_LISTING"
FILE_COUNT=$(grep -cv '/$' "$BUNDLE_LISTING" || true)

# Tripwire 1: no exclusion pattern may ever swallow runtime PHP. Compare the
# bundled .php count against the tree filtered by the structural exclusions
# plus the two known non-runtime PHP locations (.phpstorm.meta.php and the
# root .github CI tooling — both excluded deliberately above; the .github
# filter is anchored to the root, matching the zip pattern's anchoring).
ZIP_PHP_COUNT=$(grep -c '\.php$' "$BUNDLE_LISTING" || true)
TREE_PHP_COUNT=$(find "$MOODLE_DIR" -type f -name '*.php' \
  -not -path "*/.git/*" \
  -not -path "*/tests/*" \
  -not -path "*/node_modules/*" \
  -not -path "$MOODLE_DIR/.github/*" \
  -not -name '.phpstorm.meta.php' \
  | wc -l | tr -d ' ')
if [ "$ZIP_PHP_COUNT" -ne "$TREE_PHP_COUNT" ]; then
  echo "ERROR: bundle PHP entry count ($ZIP_PHP_COUNT) != source tree PHP count ($TREE_PHP_COUNT)." >&2
  echo "An exclusion pattern is swallowing runtime PHP files. Audit the -x list above." >&2
  exit 1
fi

# Tripwire 2: required runtime files must be present (Moodle 5.1+ nests the
# docroot under public/).
for REQUIRED_RE in \
  '^(public/)?lib/requirejs\.php$' \
  '^(public/)?lib/behat/lib\.php$' \
  '^(public/)?lang/en/moodle\.php$'; do
  if ! grep -Eq "$REQUIRED_RE" "$BUNDLE_LISTING"; then
    echo "ERROR: required runtime file matching $REQUIRED_RE missing from bundle." >&2
    exit 1
  fi
done

SNAPSHOT_ARGS=""
if [ -f "$SNAPSHOT_DIR/install.sq3" ]; then
  SNAPSHOT_ARGS="--snapshot $SNAPSHOT_DIR/install.sq3"
  if [ -f "$SNAPSHOT_DIR/localcache.zip" ]; then
    # The seed and the drained task queue are produced together by
    # generate-install-snapshot.sh, so advertise both to the runtime.
    SNAPSHOT_ARGS="$SNAPSHOT_ARGS --snapshotLocalcache $SNAPSHOT_DIR/localcache.zip --snapshotDrained 1"
    # Advertise the combined RequireJS seed ONLY if it is actually in the zip,
    # so the runtime cachejs flip is keyed off the shipped artifact: cached
    # pre-warmup seeds and legacy bundles keep cachejs=false (graceful
    # degradation). See ADR 0013.
    if unzip -l "$SNAPSHOT_DIR/localcache.zip" 2>/dev/null | grep -q ' requirejs/'; then
      SNAPSHOT_ARGS="$SNAPSHOT_ARGS --snapshotRequirejs 1"
    fi
  fi
fi

node "$SCRIPT_DIR/generate-manifest.mjs" \
  --bundle "$BUNDLE_PATH" \
  --channel "${BRANCH:-$CHANNEL}" \
  --manifest "$MANIFEST_PATH" \
  --runtimeVersion "$RUNTIME_VERSION" \
  --release "$RELEASE" \
  --fileCount "$FILE_COUNT" \
  --sourceUrl "$SOURCE_URL" \
  $SNAPSHOT_ARGS

echo "Bundle written to $BUNDLE_PATH" >&2
if [ -f "$SNAPSHOT_DIR/install.sq3" ]; then
  echo "Snapshot written to $SNAPSHOT_DIR/install.sq3" >&2
fi
if [ -f "$SNAPSHOT_DIR/localcache.zip" ]; then
  echo "Localcache seed written to $SNAPSHOT_DIR/localcache.zip" >&2
fi
echo "Manifest written to $MANIFEST_PATH" >&2

# If building the default branch, also copy manifest to latest.json for backward compat
DEFAULT_BRANCH="MOODLE_500_STABLE"
if [ "$BRANCH" = "$DEFAULT_BRANCH" ] && [ "$MANIFEST_PATH" != "$MANIFEST_DIR/latest.json" ]; then
  cp "$MANIFEST_PATH" "$MANIFEST_DIR/latest.json"
  echo "Also wrote $MANIFEST_DIR/latest.json (backward compat)" >&2
fi
