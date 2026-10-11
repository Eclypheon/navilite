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

Navilite asks for the **server URL**, **username** and **password**. Over Tailscale that URL is
`https://alienlab.tailbed832.ts.net:9443` — or blank when the app is served from that same origin
(the PWA case). **Keep the `:9443`:** the bare name `https://alienlab.tailbed832.ts.net` is port
443, a public Tailscale Funnel to a different service, not the library. The password is stored in the
**iOS Keychain** — never in the app bundle, never in the repo. It is used only to compute the
per-request Subsonic token `md5(password + salt)`.

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

## Step 4 — install Navilite as its own app, not inside LiveContainer (v1.7)

**This is the part of v1.7 that only you can do.** A music player needs to be the app iOS *launched*:
inside LiveContainer the guest's `UIBackgroundModes: audio` is never consulted (iOS reads it from
LiveContainer, not from the guest), so background audio there is the container's decision, not
Navilite's. Install the `.ipa` with Sideloadly as its own app and that key counts. It costs one of
the three free-app slots — see `DECISIONS.md` for the trade-off, and the researcher's cited note at
`~/.hermes/kanban/attachments/t_de189bde/navilite-livecontainer-background-audio.md`.

Nothing in the build depends on LiveContainer either way.

## What to check after you reinstall (v1.7)

Five things, in the order they are worth checking. These are the ones that need a real device — they
cannot be measured on this machine, because the audio path is the phone's own AVFoundation and the
lock screen is the phone's own lock screen. Everything else in this release is covered by the
existing checks in `tools/` (`npm test`).

1. **Play a track, then leave the app (swipe up to the home screen) and leave it a minute.** The music
   must keep playing. This is the report v1.7 exists for. If it stops here, then the app is still not
   the app iOS launched, or `UIBackgroundModes: audio` did not survive signing.
2. **Lock the screen while it plays.** It must keep playing, and the lock screen should show the track
   with play/pause **and previous/next** beside it. Press next from the lock screen: the app must move
   to the next track.
3. **Come back into the app.** The transport must answer on the first tap (play/pause, next), the
   track must be the same one, and it must be at the second you left it — the progress bar is the
   check.
4. **The spectrum, with the app open.** Open the spectrum screen while a track plays: it must move
   with the music (a real reading, not the album-art theme). Allow a second after playback starts —
   the reading comes from a second, silent copy of the stream that the app starts once a track is
   playing, and it is a foreground-only picture by design. So after a spell in the background, the
   first thing you see on return is the theme for a moment while that copy starts up: expected, not a
   regression.
5. **Kill the app (swipe it away in the app switcher) while a track is playing, then open it again.**
   It should come back on the same track, at the same second, and carry on playing. The old behaviour
   came back at the top of the song.

Two normal-looking things that are not faults: the status chip reads `native audio` while the app is
open, and nothing appears on the lock screen until a track has actually started.

**What could not be checked here:** that iOS keeps us alive in the background, that the lock-screen
buttons appear and are routed, and that a WebKit that has been suspended restarts the silent
analysis copy on return. All three are device-only. What *is* checked on this machine: the whole
JavaScript suite (`npm test`), the type check, that both artifacts build, and that the app, its
charts and its behaviour in a real browser are unchanged by the move to native playback.
