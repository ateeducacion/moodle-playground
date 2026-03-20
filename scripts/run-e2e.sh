#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-preview}"
browser="${2:-chromium}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$repo_root"

port="${PLAYWRIGHT_PORT:-4173}"
case "$artifact" in
  preview)
    default_web_root="dist-preview"
    default_base_url="http://127.0.0.1:${port}/"
    ;;
  pages)
    default_web_root="validate-root"
    default_base_url="http://127.0.0.1:${port}/moodle-playground/"
    ;;
  *)
    echo "Unknown artifact type: $artifact" >&2
    exit 1
    ;;
esac

output_prefix="${E2E_OUTPUT_PREFIX:-$artifact}"
workflow_label="${E2E_WORKFLOW_LABEL:-$artifact}"
output_root="${E2E_OUTPUT_ROOT:-playwright-artifacts/${output_prefix}-${browser}}"

mkdir -p "$output_root"

PLAYWRIGHT_WEB_ROOT="${PLAYWRIGHT_WEB_ROOT:-$default_web_root}" \
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-$default_base_url}" \
PLAYWRIGHT_SERVER_LOG="${PLAYWRIGHT_SERVER_LOG:-$output_root/server.log}" \
PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-$output_root/test-results}" \
PLAYWRIGHT_REPORT_DIR="${PLAYWRIGHT_REPORT_DIR:-$output_root/playwright-report}" \
PLAYWRIGHT_WORKFLOW_LABEL="${PLAYWRIGHT_WORKFLOW_LABEL:-$workflow_label}" \
npx playwright test --project="$browser"
