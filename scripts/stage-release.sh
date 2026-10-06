#!/bin/sh
# Stage the files for a Pulse Metric Studio GitHub release from locally built installers.
#
# Copies the installers next to the one-line install scripts and writes the
# checksums.txt manifest that install.sh and install.ps1 verify against.
# Installers are picked up from native-artifacts/ (written by npm run tauri:build);
# pass extra installer paths (for example a Windows setup .exe copied over from
# the Windows build machine) as additional arguments. Only installers matching
# the version in package.json are staged, so stale builds are skipped.
# GitHub turns spaces in asset names into dots, so staged installers are named
# Pulse-Metric-Studio_<version>_<arch>.<ext>.
#
# The staged install scripts default to sfdc-qbranch-emu/pulse-metric-studio.
# Pass --repo OWNER/NAME to stage a release for another repository; the staged
# copies then default to that repository, so its one-line install command works
# without a --repo flag.
#
# Usage: sh scripts/stage-release.sh [--repo OWNER/NAME] OUTPUT_DIRECTORY [INSTALLER ...]
# Then:  gh release create vX.Y.Z OUTPUT_DIRECTORY/* --repo OWNER/pulse-metric-studio

set -eu

usage="usage: sh scripts/stage-release.sh [--repo OWNER/NAME] OUTPUT_DIRECTORY [INSTALLER ...]"
default_repo=sfdc-qbranch-emu/pulse-metric-studio
release_repo=$default_repo

if [ "${1:-}" = "--repo" ]; then
  [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
  release_repo=$2
  shift 2
fi

case $release_repo in
  */*/* | /* | */ | *[!A-Za-z0-9._/-]*)
    echo "error: --repo must look like OWNER/NAME, got: ${release_repo}" >&2
    exit 2
    ;;
  */*) ;;
  *)
    echo "error: --repo must look like OWNER/NAME, got: ${release_repo}" >&2
    exit 2
    ;;
esac

if [ $# -lt 1 ]; then
  echo "$usage" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "$0")/.." && pwd)
output_dir=$1
shift
version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -n 1)

if [ -e "$output_dir" ] && [ -n "$(ls -A "$output_dir" 2>/dev/null)" ]; then
  echo "error: ${output_dir} already exists and is not empty" >&2
  exit 1
fi
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)

for installer in \
  "$repo_root"/native-artifacts/dmg/*.dmg \
  "$repo_root"/native-artifacts/nsis/*-setup.exe \
  "$@"; do
  [ -f "$installer" ] || continue
  name=$(basename "$installer" | sed 's/ /-/g')
  case $name in
    "Pulse-Metric-Studio_${version}_"*) ;;
    *) echo "skipping ${installer}: not version ${version}" >&2; continue ;;
  esac
  cp "$installer" "$output_dir/$name"
done

if ! ls "$output_dir"/Pulse-Metric-Studio_"${version}"_* >/dev/null 2>&1; then
  echo "error: no Pulse Metric Studio ${version} installers found; build them first or pass their paths" >&2
  exit 1
fi

for script in install.sh install.ps1; do
  if ! grep -q "$default_repo" "$repo_root/scripts/$script"; then
    echo "error: scripts/${script} no longer mentions ${default_repo}; update stage-release.sh" >&2
    exit 1
  fi
  sed "s#${default_repo}#${release_repo}#g" "$repo_root/scripts/$script" > "$output_dir/$script"
done
chmod +x "$output_dir/install.sh"
echo "install scripts default to ${release_repo}"

cd "$output_dir"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum Pulse-Metric-Studio_* > checksums.txt
else
  shasum -a 256 Pulse-Metric-Studio_* > checksums.txt
fi

ls -l "$output_dir"
cat checksums.txt
