#!/bin/sh
# **The press rules, executed** (v2.0.0-beta.30).
#
# Compiles the file the App target compiles (`ios/App/App/NavilitePressRules.swift`) together with
# its behavioural test and runs it. Nothing of NaviliteRemote.swift is grepped and nothing here
# depends on AVFoundation, Capacitor or a simulator: the four decisions this release moved out of the
# remote are pure, so they can be driven as state.
#
# Exit status is the test's: 0 only when every branch answered what the release claims.
set -eu
cd "$(dirname "$0")/.."
OUT="$(mktemp -t navilite-press-rules)"
trap 'rm -f "$OUT"' EXIT INT TERM
xcrun swiftc -O \
  ios/App/App/NavilitePressRules.swift \
  test/swift/NavilitePressRulesTests.swift \
  -o "$OUT"
"$OUT"
