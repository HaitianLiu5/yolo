#!/bin/sh
# Archives an Apple app in Release and uploads it to App Store Connect, where
# TestFlight installs it on the owner's devices (Agent Notes
# 2026-10-19-apple-tv-client, Building and installing, and
# 2026-10-23-iphone-and-ipad-client). The first argument picks the app:
# `tvos` (the default) or `ios`. The build number is the UTC time,
# YYYYMMDD.HHMM, so every upload is newer than the last. Signing comes from
# the ignored Local.xcconfig; the app's record must exist in App Store
# Connect first. `--no-upload` only archives, to check a Release build.
set -eu
cd "$(dirname "$0")"
platform=tvos
upload=yes
for arg in "$@"; do
  case "$arg" in
    tvos|ios) platform=$arg ;;
    --no-upload) upload=no ;;
    *) echo "usage: archive.sh [tvos|ios] [--no-upload]" >&2; exit 64 ;;
  esac
done
if [ "$platform" = ios ]; then
  scheme=YoloiOS destination='generic/platform=iOS'
else
  scheme=YoloTV destination='generic/platform=tvOS'
fi
build=$(date -u +%Y%m%d.%H%M)
out="${TMPDIR:-/tmp}/yolo-$platform-$build"
xcodebuild -project Yolo.xcodeproj -scheme "$scheme" -configuration Release -destination "$destination" \
  -archivePath "$out/Yolo.xcarchive" -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$build" archive
if [ "$upload" = no ]; then
  echo "Archived build $build at $out/Yolo.xcarchive"
  exit 0
fi
# Packaging runs /usr/bin/rsync, whose other end is the first rsync on PATH;
# Homebrew's rsync 3 there refuses its options ("Copy failed").
PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive -archivePath "$out/Yolo.xcarchive" -exportOptionsPlist ExportOptions.plist \
  -exportPath "$out/export" -allowProvisioningUpdates
echo "Uploaded build $build; it appears in TestFlight once App Store Connect has processed it."
