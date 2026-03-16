#!/bin/sh

# fetch-moodle-source.sh
#
# Fetches Moodle source from GitHub for a given branch.
# Uses shallow clone + caching for efficiency.
#
# Usage: fetch-moodle-source.sh <branch>
#
# Examples:
#   fetch-moodle-source.sh MOODLE_500_STABLE
#   fetch-moodle-source.sh main

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR=${CACHE_DIR:-"$REPO_DIR/.cache/moodle"}
BRANCH=${1:-MOODLE_500_STABLE}
GITHUB_REPO="https://github.com/moodle/moodle.git"

SOURCE_DIR="$CACHE_DIR/$BRANCH"
mkdir -p "$CACHE_DIR"

if [ -d "$SOURCE_DIR/.git" ]; then
  echo "Updating cached source for $BRANCH" >&2
  (cd "$SOURCE_DIR" && git fetch --depth 1 origin "$BRANCH" >&2 && git reset --hard "origin/$BRANCH" >&2)
else
  echo "Cloning $GITHUB_REPO branch $BRANCH" >&2
  rm -rf "$SOURCE_DIR"
  git clone --depth 1 --branch "$BRANCH" "$GITHUB_REPO" "$SOURCE_DIR" >&2
fi

printf '%s\n' "$SOURCE_DIR"
