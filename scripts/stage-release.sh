#!/bin/sh
# Stage verified installers and sanitized source evidence for a manual release.
# Usage: sh scripts/stage-release.sh [--repo OWNER/NAME] OUTPUT_DIRECTORY [INSTALLER ...]
# External installers must travel with their sanitized release-evidence.json.
set -eu
repo_root=$(cd "$(dirname "$0")/.." && pwd)
exec node "$repo_root/scripts/stage-release.mjs" "$@"
