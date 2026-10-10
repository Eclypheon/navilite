#!/usr/bin/env bash
#
# Builds the iOS app and packages an UNSIGNED .ipa into artifacts/.
#
#   bash tools/build-ios-ipa.sh              # device build (arm64), unsigned .ipa
#   bash tools/build-ios-ipa.sh --simulator  # simulator build, .app zipped (sanity check)
#
# Why unsigned: DECISIONS.md locks the build to the free Apple ID path (sideload and
# re-sign every 7 days). An unsigned .ipa is exactly what AltStore / SideStore / Sideloadly /
# Xcode want as input — they attach the personal-team signature on the way in. Nothing here
# needs TestFlight, the App Store, or a paid certificate.
#
# The signed variant, for the record, is a two-line change and is documented in
# docs/ios-sideload.md: set DEVELOPMENT_TEAM to your free team id and drop
# CODE_SIGNING_ALLOWED=NO, then `xcodebuild -exportArchive` with method "development".
set -euo pipefail

MODE="device"
for arg in "$@"; do
  case "${arg}" in
    --simulator) MODE="simulator" ;;
    *) echo "usage: $0 [--simulator]" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT}/package.json').version")"
OUT="${ROOT}/artifacts"
DERIVED="${ROOT}/build-ios"
mkdir -p "${OUT}" "${DERIVED}"

if [ "${MODE}" = "simulator" ]; then
  SDK="iphonesimulator"
  DESTINATION="generic/platform=iOS Simulator"
  CONFIG_DIR="Release-iphonesimulator"
else
  SDK="iphoneos"
  DESTINATION="generic/platform=iOS"
  CONFIG_DIR="Release-iphoneos"
fi

cd "${ROOT}/ios/App"

# Unsigned build: no team, no provisioning profile, no keychain prompt.
xcodebuild \
  -project App.xcodeproj \
  -scheme App \
  -configuration Release \
  -sdk "${SDK}" \
  -destination "${DESTINATION}" \
  -derivedDataPath "${DERIVED}" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

APP="${DERIVED}/Build/Products/${CONFIG_DIR}/App.app"
if [ ! -d "${APP}" ]; then
  echo "build produced no ${APP}" >&2
  exit 1
fi

BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Info.plist" 2>/dev/null || echo "${VERSION}")"
BUILT_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP}/Info.plist" 2>/dev/null || echo '1')"
BACKGROUND="$(/usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes:0' "${APP}/Info.plist" 2>/dev/null || echo '(missing)')"

if [ "${MODE}" = "simulator" ]; then
  NAME="Navilite-${VERSION}-simulator.zip"
  (cd "${DERIVED}/Build/Products/${CONFIG_DIR}" && zip -qry "${OUT}/${NAME}" App.app)
else
  NAME="Navilite-${VERSION}-unsigned.ipa"
  STAGE="$(mktemp -d)"
  mkdir -p "${STAGE}/Payload"
  cp -R "${APP}" "${STAGE}/Payload/"
  (cd "${STAGE}" && zip -qry "${OUT}/${NAME}" Payload)
  rm -rf "${STAGE}"
fi

SIZE=$(wc -c < "${OUT}/${NAME}" | tr -d ' ')
echo
echo "built  ${OUT}/${NAME}"
echo "bytes: ${SIZE}"
echo "app version ${BUILT_VERSION} (${BUILT_BUILD}), UIBackgroundModes[0]=${BACKGROUND}"
unzip -l "${OUT}/${NAME}" | tail -4
