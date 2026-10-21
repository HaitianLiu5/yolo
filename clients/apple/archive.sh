#!/bin/sh
# Archives the Apple TV app in Release and uploads it to App Store Connect,
# where TestFlight installs it on the owner's Apple TV (Agent Note
# 2026-10-19-apple-tv-client, Building and installing). The build number is
# the UTC time, YYYYMMDD.HHMM, so every upload is newer than the last. Signing
# comes from the ignored Local.xcconfig; the app's record must exist in App
# Store Connect first. `--no-upload` only archives, to check a Release build.
set -eu
cd "$(dirname "$0")"
build=$(date -u +%Y%m%d.%H%M)
out="${TMPDIR:-/tmp}/yolo-tv-$build"
xcodebuild -project Yolo.xcodeproj -scheme YoloTV -configuration Release -destination 'generic/platform=tvOS' \
  -archivePath "$out/Yolo.xcarchive" -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$build" archive
if [ "${1:-}" = "--no-upload" ]; then
  echo "Archived build $build at $out/Yolo.xcarchive"
  exit 0
fi
xcodebuild -exportArchive -archivePath "$out/Yolo.xcarchive" -exportOptionsPlist ExportOptions.plist \
  -exportPath "$out/export" -allowProvisioningUpdates
echo "Uploaded build $build; it appears in TestFlight once App Store Connect has processed it."
