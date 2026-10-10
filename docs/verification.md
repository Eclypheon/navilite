# What was actually verified, and how

Written by the implementation pass. Every claim below is a command that was run or an output
that was observed; anything unverified is listed as such at the end rather than glossed over.

## 1. Unit tests

```
$ npm test
✔ the canonical origin is HTTPS on the :9443 door, not port 443
✔ the Server URL placeholder keeps the port — never the bare host
✔ the door origin round-trips through the client normaliser
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
ℹ tests 19  ℹ pass 19  ℹ fail 0
```

## 2. Web build

```
$ npm run build
dist/index.html                1.09 kB │ gzip:  0.50 kB
dist/assets/index-*.css        8.39 kB │ gzip:  2.43 kB
dist/assets/index-*.js        61.76 kB │ gzip: 20.52 kB
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
- **The real Navidrome was originally exercised only against the mock.** At the time of that pass it
  was LAN-only and no credential was used; the client was tested against the mock, which implements
  the same API and the same auth. Since then the tailnet HTTPS door exists
  (`https://alienlab.tailbed832.ts.net:9443`, host-side card `t_d66d8c1e`) and was verified **from
  the box**: real Subsonic token auth (`/rest/ping.view` → `status ok`), a `Range` request answered
  `206` with the whole 29,088,598-byte flac, and `Access-Control-Allow-Origin: *` on
  `/rest/stream.view` through the proxy — see §8 and `DOOR.md` on the host.
- **iOS background suspension of Web Audio** is reported behaviour (research §2.4) and is handled in
  code and labelled in the UI, but not observed here — it needs a device.
- **No simulator run.** No iOS simulator runtime is installed on this machine; the iOS build here is
  a real device (arm64) build.

## 8. The tailnet door, and the placeholder correction (2026-10-10)

The recommended one-origin deployment now exists on the host:

```
https://alienlab.tailbed832.ts.net:9443
tailscale serve --bg --https=9443 http://127.0.0.1:5702   # tailscaled TLS -> Caddy :5702 -> navidrome:4533
```

Verified from the box (host-side card `t_d66d8c1e`, `DOOR.md` on the host): `GET /`, `/sw.js` and
`/manifest.webmanifest` → 200, unknown paths falling back to the SPA shell; `/rest`, `/api`, `/auth`
and `/share` proxied to Navidrome 0.64.2; `/rest/ping.view` with a real token → `status ok`;
`Range` → `206` + `Content-Range`, a whole 29,088,598-byte flac in one request; `Vary: Origin` with
`Access-Control-Allow-Origin: *` on `/rest/stream.view` when the request carries an `Origin`;
Let's Encrypt certificate valid to 2026-12-15, renewed by tailscaled; **not** reachable off the
tailnet (three independent public checkers time out on `:9443` while the same probe reaches Funnel
`:10000`).

Two corrections came out of that deployment, both in this repo:

1. **The connect form's placeholder named the wrong server.** It read
   `https://alienlab.tailbed832.ts.net (or leave blank for same origin)` — no port, i.e. **443**,
   which is a *public Tailscale Funnel to a different service* (wizarr), not the library. It now
   reads `https://alienlab.tailbed832.ts.net:9443 (or leave blank for same origin)`, sourced from one
   constant (`src/config.ts`), and `test/connect-copy.test.ts` fails if the port is dropped again.
   Checked that the guard bites: the old string fails it, the new one passes.
2. **The URL is written down where a human looks** — `README.md`, `DECISIONS.md`,
   `docs/ios-sideload.md` — naming `https://alienlab.tailbed832.ts.net:9443` as the canonical origin
   (tailnet-only, publicly trusted certificate, so the PWA installs from it with nothing to install
   on the phone, and Android's user-CA restriction does not apply), and stating that port 443 is
   **not** it.

The rebuilt `dist/` (19 unit tests and `tsc --noEmit` clean before the build) was installed to the
host's served copy at `/home/k/docker/data/navilite/dist/` — the directory the Caddy container mounts
read-only at `/srv/navilite` — after snapshotting it to `dist.bak-20261010-235955` (undo: move it
back). Read back **through the door** over the tailnet:

```
$ curl -sS -o /dev/null -w 'http=%{http_code} tls=%{ssl_verify_result}\n' https://alienlab.tailbed832.ts.net:9443/
http=200 tls=0
$ curl -sS https://alienlab.tailbed832.ts.net:9443/assets/index-Cd0kb3q2.js | grep -oF 'https://alienlab.tailbed832.ts.net:9443 (or leave blank for same origin)'
https://alienlab.tailbed832.ts.net:9443 (or leave blank for same origin)
# portless placeholder remaining in the served bundle: 0
$ curl -sS 'https://alienlab.tailbed832.ts.net:9443/rest/ping.view?v=1.16.1&c=navilite&f=json'
{"subsonic-response":{"status":"failed","version":"1.16.1","type":"navidrome","serverVersion":"0.64.2 (10114574)",...,"error":{"code":10,"message":"missing parameter: 'u'"}}}
```

(The Subsonic probe carries no credentials on purpose, so Navidrome's error 10 is the expected
answer — it proves the same-origin proxy is still wired after the file swap. `/sw.js`,
`/manifest.webmanifest`, the icons, and `/favicon.svg` all returned 200 over the door too.)
