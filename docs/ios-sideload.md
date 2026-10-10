# Sideloading Navilite on iOS — the free path

Locked by `DECISIONS.md`: **no paid Apple Developer account**, and the iPhone build is a
**sideloaded dev build, re-signed every 7 days**. Nothing in this project needs TestFlight, the
App Store, or any paid entitlement. This document is the whole path, start to finish.

## What you need

- A Mac with Xcode (built and verified here with Xcode 26.1.1).
- A free Apple ID. That is enough: a free account grants a "personal team", which can sign apps
  for your own devices.
- The phone, connected once by cable (or over Wi-Fi once it has been paired).
- A sideloader if you would rather not re-plug weekly: **AltStore** (needs AltServer on the Mac)
  or **SideStore** (refreshes on-device via a local VPN, no computer needed after setup).

Free-account limits, so nothing here surprises you: **3 apps per device, 10 App IDs and 3 devices
per 7 days, and provisioning profiles expire after 7 days** — after which the app stops launching
until it is re-signed. That is Apple's rule, not Navilite's.

## 1. Build the unsigned IPA

```bash
npm run ipa:unsigned
# → artifacts/Navilite-<version>-unsigned.ipa
```

That runs `xcodebuild -sdk iphoneos -configuration Release` with
`CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`, then packages `Payload/App.app` as a `.ipa`.
An unsigned `.ipa` is exactly what a sideloader wants as input: it attaches your personal-team
signature itself.

## 2. Install it

Pick whichever you have:

**Xcode (first time, or after a change to the native code)**

```bash
cd ios/App && npx cap open ios      # opens App.xcodeproj
```

Then, in Xcode: select the `App` target → **Signing & Capabilities** → tick *Automatically manage
signing* and choose your personal team (add your Apple ID under Settings → Accounts if it is not
listed). Change the bundle identifier if Xcode complains that `app.navilite` is taken on your
account (any unique `com.<you>.navilite` works). Plug in the phone, select it as the run
destination, press ⌘R. The first launch needs *Settings → General → VPN & Device Management →
trust your developer certificate*.

**AltStore / SideStore (for living with the 7-day cycle)**

1. Install AltServer (Mac) + AltStore on the phone, or SideStore following its own setup.
2. Side-load `artifacts/Navilite-<version>-unsigned.ipa` from the sideloader's file picker.
3. Enable *Refresh* (AltStore: background refresh with AltServer on the same Wi-Fi; SideStore:
   on-device refresh), so the 7-day expiry renews itself.

Sideloadly also works and is the simplest one-shot: drop the `.ipa` in, enter your Apple ID, press
start.

## 3. First run

Navilite asks for the **server URL**, **username** and **password**. Over Tailscale that URL is the
tailnet name (e.g. `https://alienlab.tailbed832.ts.net`) or blank if the app is served from the same
origin as Navidrome. The password is stored in the **iOS Keychain** — never in the app bundle, never
in the repo. It is used only to compute the per-request Subsonic token `md5(password + salt)`.

## Adding a signing team to the build instead (optional)

If you ever want a signed-and-archived `.ipa` without touching Xcode's UI:

```bash
cd ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath ../../build-ios \
  DEVELOPMENT_TEAM=<your 10-character team id> \
  CODE_SIGN_STYLE=Automatic \
  archive -archivePath ../../build-ios/Navilite.xcarchive

cat > /tmp/export.plist <<'PLIST'
<plist version="1.0"><dict>
  <key>method</key><string>development</string>
  <key>teamID</key><string>YOURTEAMID</string>
  <key>compileBitcode</key><false/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath ../../build-ios/Navilite.xcarchive \
  -exportOptionsPlist /tmp/export.plist -exportPath ../../artifacts
```

That still uses a free personal team. It becomes a *pleasant* path only with the $99/yr programme
(TestFlight, 1-year certificates) — deferred by the owner, see `DECISIONS.md`.
