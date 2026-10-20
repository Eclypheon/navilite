#!/usr/bin/env bash
#
# Builds a sideloadable APK and drops it in artifacts/.
#
#   bash tools/build-apk.sh [debug|release]
#
# debug (default) is signed with the standard Android debug keystore, so it installs on a
# device straight away — no Play account, no keystore setup. That is the point: DECISIONS.md
# asks for a sideloaded APK.
#
# release produces an UNSIGNED apk: the Capacitor template has no release signingConfig, and
# inventing one here would mean committing a keystore. README explains how to add your own
# if you ever want a release-signed build.
set -euo pipefail

VARIANT="${1:-debug}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT}/package.json').version")"
OUT="${ROOT}/artifacts"
mkdir -p "${OUT}"

# Gradle 8.14 supports Java 17..24, and the native-audio plugin compiles for Java 21,
# so a JDK 21 is the sweet spot. Homebrew's openjdk@21 is keg-only: no PATH changes.
if [ -z "${JAVA_HOME:-}" ]; then
  if [ -x /opt/homebrew/opt/openjdk@21/bin/java ]; then
    export JAVA_HOME=/opt/homebrew/opt/openjdk@21
  elif [ -x /usr/libexec/java_home ] && /usr/libexec/java_home -v 21 >/dev/null 2>&1; then
    export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
  fi
fi
echo "JAVA_HOME=${JAVA_HOME:-<unset, using default java>}"

case "${VARIANT}" in
  debug) TASK=assembleDebug; APK_PATH=app/build/outputs/apk/debug/app-debug.apk; NAME="Navilite-${VERSION}-debug.apk" ;;
  release) TASK=assembleRelease; APK_PATH=app/build/outputs/apk/release/app-release-unsigned.apk; NAME="Navilite-${VERSION}-release-unsigned.apk" ;;
  *) echo "usage: $0 [debug|release]" >&2; exit 2 ;;
esac

cd "${ROOT}/android"

./gradlew --no-daemon "${TASK}"

cp "${APK_PATH}" "${OUT}/${NAME}"
SIZE=$(wc -c < "${OUT}/${NAME}" | tr -d ' ')
echo
echo "built ${OUT}/${NAME}"
echo "bytes: ${SIZE}"
# A zip listing proves it is a real APK, not an empty file.
unzip -l "${OUT}/${NAME}" | tail -3
