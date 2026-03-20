#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-preview}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$repo_root"

strip_vfs_from_manifest() {
  local manifest_path="$1"
  # Strip VFS references so preview E2E uses the same smaller deployable artifact
  # that the Netlify preview deploy publishes.
  node --input-type=module -e '
    import { readFileSync, writeFileSync, existsSync } from "node:fs";

    const manifestPath = process.argv[1];
    if (!existsSync(manifestPath)) {
      process.exit(0);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.vfs;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$manifest_path"
}

case "$artifact" in
  preview)
    rm -rf dist-preview
    mkdir -p dist-preview
    rsync -a ./ ./dist-preview/ \
      --exclude ".git/" \
      --exclude ".github/" \
      --exclude ".venv/" \
      --exclude ".cache/" \
      --exclude "dist-preview/" \
      --exclude "docs/" \
      --exclude "node_modules/" \
      --exclude "playwright-artifacts/" \
      --exclude "playwright-report/" \
      --exclude "site/" \
      --exclude "test-results/" \
      --exclude "tests/" \
      --exclude "patches/" \
      --exclude "scripts/"
    ;;
  pages)
    rm -rf dist-pages validate-root
    mkdir -p dist-pages/docs
    rsync -a ./ ./dist-pages/ \
      --exclude ".git/" \
      --exclude ".github/" \
      --exclude ".venv/" \
      --exclude ".cache/" \
      --exclude "dist-pages/" \
      --exclude "docs/" \
      --exclude "node_modules/" \
      --exclude "playwright-artifacts/" \
      --exclude "playwright-report/" \
      --exclude "site/" \
      --exclude "test-results/"
    mkdocs build --strict --site-dir dist-pages/docs
    touch dist-pages/.nojekyll
    mkdir -p validate-root/moodle-playground
    rsync -a dist-pages/ validate-root/moodle-playground/
    ;;
  *)
    echo "Unknown artifact type: $artifact" >&2
    exit 1
    ;;
esac
