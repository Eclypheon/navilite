# What was actually verified, and how

Written by the implementation pass. Every claim below is a command that was run or an output
that was observed; anything unverified is listed as such at the end rather than glossed over.

## 1. Unit tests

```
$ npm test
✔ matches the RFC 1321 test vectors
✔ handles multi-block input and UTF-8
✔ agrees with node:crypto on random passwords and salts
✔ salts are hex and comfortably above the API minimum length
✔ uses half the track when that is under four minutes
✔ caps at four minutes for long tracks
✔ an unknown duration falls back to the four-minute cap
✔ normalizeServerUrl handles the shapes a person actually types
✔ builds token auth with a fresh salt, and t really is md5(password + salt)
✔ same-origin is the default and is not treated as cross-origin
✔ parses an ok envelope
✔ surfaces Subsonic failures with their code and a readable message
✔ star/unstar use id for songs and albumId/artistId for the rest
✔ scrobble distinguishes now-playing from a real play
✔ play queue round-trips ids, current and position
✔ a non-JSON body is reported as "this is not a Navidrome"
ℹ tests 16  ℹ pass 16  ℹ fail 0
```

## 2. Web build

```
$ npm run build
dist/index.html                1.09 kB │ gzip:  0.50 kB
dist/assets/index-*.css        8.39 kB │ gzip:  2.43 kB
dist/assets/index-*.js        61.75 kB │ gzip: 20.50 kB
dist/assets/native-*.js        0.77 kB   (code-split: only loaded inside the Capacitor shell)
dist/assets/web-*.js           0.79 kB
dist/assets/base-*.js          2.85 kB
dist/assets/esm-*.js           1.28 kB
dist/assets/web-*.js          12.10 kB   (secure-storage plugin, native only)
```

## 3. End-to-end in a real browser, against a real-ish library

Harness: `node tools/mock-subsonic.mjs` (this repo) serving `dist/` and a synthetic Subsonic
library from one origin on `127.0.0.1:4533`, driven in Chrome. The mock **validates tokens for
real** — `t` must equal `md5(password + salt)` or every call fails with Subsonic error 40 — so a
broken client cannot pass this test.

**Connect and browse.** Typing server URL (blank = same origin), username and password, then
"Save and continue" → `#/artists` with the four mock artists listed. Requests the mock recorded:
`ping`, `getArtists`, `getArtist`, `getAlbum`, `getCoverArt`, `getPlaylists`, `stream`,
`scrobble`, `savePlayQueue` — the intended Subsonic surface, each carrying `u`, `s`, `t`, `v=1.16.1`,
`c=Navilite`, `f=json`, with a fresh salt per call.

**Playback + real spectrum.** Track 1 of the first mock album is generated PCM containing exactly
110 / 330 / 1320 Hz partials. The app's own analyser (sampleRate 48000, fftSize 2048 → 23.44 Hz per
bin) reported:

```
frame 0: max=255 peaks(bin,Hz,val)=[(5,117.2,255), (14,328.1,255), (56,1312.5,255), ...]
frame 1: max=255 peaks(bin,Hz,val)=[(14,328.1,255), (5,117.2,253), (56,1312.5,253), ...]
positions(ms): [6687, 7042, 7483, 7837, 8322, 8699, 9064, 9490]
silent 5000Hz+ band: [0, 0, 0, 0, 0, 0, 0, 0]
```

Peaks land on the declared partials within one 23.4 Hz bin, the position advances, and the
5–9 kHz band is exactly zero — it is measuring the audio, not animating.

Track 2 (declared 220 / 440 / 880 Hz) then auto-advanced and showed peaks at **210.9 / 445.3 /
890.6 Hz** — the spectrum follows the content, not a fixed pattern.

The UI's chip read `spectrum`, with the reason *"real spectrum — AnalyserNode reading the decoded
stream as it plays"*.

**Play reporting.** The mock recorded:

```
scrobbles: [(album-1-1-track-1, submission=false), (album-1-1-track-1, submission=true), (album-1-1-track-2, submission=false)]
playQueue: {entry: [track-1..track-4], current: album-1-1-track-1, position: 4969}
```

The `submission=true` arrived ~10 s into a 20 s track: half the track, exactly the Subsonic rule.
`savePlayQueue` was sent debounced, as designed.

**Favourites and playlists.** Starring the album fired `star` and `getStarred2` then listed it under
Favourites; creating "Test drive" fired `createPlaylist`; choosing it from the album's "Add to
playlist" fired `updatePlaylist` and the mock's playlist held the 4 tracks.

**Service worker.** Registered at scope `/`, builds stamped with a build id. The debug endpoint read
back through the SW with fresh data after the fix below (before it, it returned a stale cached
response — see §5).

## 4. The two visualiser edge cases, exercised on purpose

**Cross-origin library that does send CORS** (app on `:4533`, library on `:4535`): real spectrum,
same peaks — the `crossOrigin="anonymous"` plumbing works.

**Cross-origin library with no `Access-Control-Allow-Origin` on `/rest/stream`** (library on
`:4534`, `--no-cors-stream`): the app plays the stream anyway (it drops the element's `crossOrigin`
flag after the failure), and reports honestly from the first sample:

```
t+1.0s -> playing | spectrum: False | chip: theme
t+2.0s -> playing | spectrum: False | chip: theme
reason: the library sent no Access-Control-Allow-Origin for this stream, so the browser will not
        hand over its samples — it is playing, but the spectrum cannot be real
```

## 5. Three real bugs this verification found (all fixed, all re-tested)

1. **The service worker cached API responses.** It cached every same-origin GET, so a non-`/rest`
   API path returned a stale body. Now it caches only app-shell assets (script/style/image/font/
   manifest + the shell list) and explicitly skips `/rest/`, any `Range` request, and audio/video.
2. **A stale analyser frame was reported as a live spectrum.** `getByteFrequencyData` on a tainted
   analyser can leave the destination array untouched, so the *previous* track's spectrum was
   displayed as real for ~2 s. The buffer is now cleared before every read, and a frame that stays
   byte-identical for ~2.5 s is treated as not-a-measurement.
3. **Overlapping `play()` calls double-reported "now playing."** A play token now guards the
   reporting, media-session and queue-save steps.

## 6. Build artifacts

```
$ npm run apk
BUILD SUCCESSFUL in 1m 3s
built /Users/neokester/navilite/artifacts/Navilite-0.1.0-debug.apk
bytes: 8772279
```

```
$ ~/Library/Android/sdk/build-tools/36.1.0/aapt2 dump badging artifacts/Navilite-0.1.0-debug.apk
package: name='app.navilite' versionCode='1' versionName='0.1.0' compileSdkVersion='36'
minSdkVersion:'24' targetSdkVersion:'36'
uses-permission: INTERNET, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK, WAKE_LOCK, POST_NOTIFICATIONS
```

```
$ apksigner verify --print-certs artifacts/Navilite-0.1.0-debug.apk
Verifies
Verified using v2 scheme (APK Signature Scheme v2): true
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
```

The APK contains the web payload (`assets/public/index.html`, `sw.js`, manifest, icons: 17 files)
and the app's own foreground service. It is debug-signed, so it installs straight onto a device.

```
$ npm run ipa:unsigned
** BUILD SUCCEEDED **
built  /Users/neokester/navilite/artifacts/Navilite-0.1.0-unsigned.ipa
bytes: 856821
app version 0.1.0 (1), UIBackgroundModes[0]=audio
$ file build-ios/.../App.app/App
Mach-O 64-bit executable arm64
```

The `.ipa` contains `Payload/App.app` with the arm64 device binary, `Info.plist` (background audio
mode), and the web payload. It is unsigned by design: AltStore / SideStore / Sideloadly / Xcode
attach the free personal-team signature — see `docs/ios-sideload.md`.

## 7. Not verified — read this before trusting the native builds

- **Nothing ran on a phone.** No Android device was attached (`adb devices` → empty list) and the
  iPhone reported as `unavailable` (`xcrun devicectl list devices`), so the following are *compiled
  and wired* but **unverified on hardware**:
  - background playback and the Android foreground service (`BackgroundAudioService`) actually
    keeping the process alive with the screen off;
  - the Web Audio ↔ native hand-off at the same position when the app is backgrounded and restored;
  - lock-screen / Now Playing controls (plugin `showNotification`);
  - Keychain and Android Keystore credential storage (`@aparajita/capacitor-secure-storage`).
- **The real Navidrome was not exercised.** It is LAN-only today and no credential was used; the
  client was tested against the mock, which implements the same API and the same auth. Nova's card
  (`t_138d33f8`) builds the tailnet HTTPS door; re-measure `Access-Control-Allow-Origin` on
  `/rest/stream` through the proxy afterwards.
- **iOS background suspension of Web Audio** is reported behaviour (research §2.4) and is handled in
  code and labelled in the UI, but not observed here — it needs a device.
- **No simulator run.** No iOS simulator runtime is installed on this machine; the iOS build here is
  a real device (arm64) build.
