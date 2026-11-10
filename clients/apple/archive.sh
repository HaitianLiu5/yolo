#!/bin/sh
# Archives an Apple app in Release and uploads it to App Store Connect, where
# TestFlight installs it on the owner's devices (Agent Notes
# 2026-10-19-apple-tv-client, Building and installing, and
# 2026-10-23-iphone-and-ipad-client). The first argument picks the app:
# `tvos` (the default) or `ios`. The build number is the UTC time,
# YYYYMMDD.HHMM, so every upload is newer than the last. Signing comes from
# the ignored Local.xcconfig; the app's record must exist in App Store
# Connect first. `--no-upload` only archives, to check a Release build.
# When Local.xcconfig names an App Store Connect API key (ASC_KEY_ID and
# ASC_ISSUER_ID, the .p8 at ~/.appstoreconnect/private_keys/), Xcode signs
# and uploads with it instead of the Apple ID signed in to Xcode, and
# testflight.js then waits until TestFlight's internal testers can install
# the build.
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
setting() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\1/p" Local.xcconfig 2>/dev/null | tail -1; }
key_id=${ASC_KEY_ID:-$(setting ASC_KEY_ID)}
issuer_id=${ASC_ISSUER_ID:-$(setting ASC_ISSUER_ID)}
set --
if [ -n "$key_id" ] && [ -n "$issuer_id" ]; then
  set -- -authenticationKeyPath "${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_$key_id.p8}" \
    -authenticationKeyID "$key_id" -authenticationKeyIssuerID "$issuer_id"
fi
build=$(date -u +%Y%m%d.%H%M)
out="${TMPDIR:-/tmp}/yolo-$platform-$build"
xcodebuild -project Yolo.xcodeproj -scheme "$scheme" -configuration Release -destination "$destination" \
  -archivePath "$out/Yolo.xcarchive" -allowProvisioningUpdates "$@" CURRENT_PROJECT_VERSION="$build" archive
if [ "$upload" = no ]; then
  echo "Archived build $build at $out/Yolo.xcarchive"
  exit 0
fi
# Packaging runs /usr/bin/rsync, whose other end is the first rsync on PATH;
# Homebrew's rsync 3 there refuses its options ("Copy failed").
PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive -archivePath "$out/Yolo.xcarchive" -exportOptionsPlist ExportOptions.plist \
  -exportPath "$out/export" -allowProvisioningUpdates "$@"
if [ $# -gt 0 ]; then
  echo "Uploaded build $build; waiting for App Store Connect to process it."
  exec node testflight.js "$platform" "$build"
fi
echo "Uploaded build $build; it appears in TestFlight once App Store Connect has processed it."
