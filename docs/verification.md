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
BUILD SUCCESSFUL in 7s
built /Users/neokester/navilite/artifacts/Navilite-0.1.0-debug.apk
bytes: 8773616
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
bytes: 856888
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

Three corrections came out of that deployment, all in this repo:

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
3. **A build-script bug surfaced while rebuilding the native artifacts.**
   `tools/build-ios-ipa.sh` had two ways to ship files that no longer exist in `dist/`: incremental
   `xcodebuild` does not drop bundle resources removed from the source, and `zip` *updates* an
   existing archive instead of replacing it, so a rebuild on top of an old `.ipa` kept the previous
   `index-*.js`. The first rebuild produced an 884,401-byte `.ipa` holding **both** the old and the
   new bundle (54 members); with `App.app` removed before the build and the target archive removed
   before zipping, it is 856,888 bytes with 47 members and exactly one `index-*.js` — the corrected
   one.

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

The two native artifacts in `artifacts/` were rebuilt from the corrected source as well, since both
embed the web payload and the old copies carried the portless placeholder:

```
$ npm run apk            → artifacts/Navilite-0.1.0-debug.apk    bytes: 8773616
$ npm run ipa:unsigned   → artifacts/Navilite-0.1.0-unsigned.ipa bytes: 856888
# index-Cd0kb3q2.js inside both: carries "…:9443 (or leave blank for same origin)", portless form: 0
```

## 9. v1.1 — the UI/UX pass (2026-10-11)

### 9.1 Tests and build

```
$ npm test           ℹ tests 53  ℹ pass 53  ℹ fail 0     (19 → 53: lyrics, romanisation, queue
$ npm run typecheck  (tsc --noEmit, clean)                order, changelog drift, connect copy)
$ npm run build      dist/assets/index-BlvTS-Cb.js  79.11 kB │ gzip: 27.12 kB
                     dist/assets/index-0MlfN5BE.css 10.62 kB │ gzip:  3.50 kB
```

### 9.2 "No need for sideways scrolling" — measured, and the cause was real

Method: Chrome via CDP with `Emulation.setDeviceMetricsOverride` at **390** and **360** CSS px
(mobile, dpr 2), then on each route: `document.documentElement.scrollWidth` vs `window.innerWidth`,
plus a walk of every element for `getBoundingClientRect().right > innerWidth`.

The first pass found one route where the page still wanted more room than the phone:
`#/settings` reported a **685 px** layout viewport on a 390 px device, because of the playback
select — a `<select>` is as wide as its longest option ("Automatic — real spectrum in the
foreground, native engine in the background"), and that option measured **671 px**. A select that
wide pushes the page, and iOS Safari shows it as the sideways scroll he reported. Fix in
`src/styles.css`: `.field` and `select.field` take `max-width: 100%`, `min-width: 0`, and the inline
variant is allowed to shrink.

After the fix, all six routes measure exactly the viewport width with **zero** offenders:

```
390 px: #/artists 390/390   #/playlists 390/390   #/settings 390/390
        #/changelog 390/390 #/album/album-1-1 390/390 #/playlist/pl-1 390/390
360 px: same six routes, all 360/360, offenders: none
```

Long Japanese titles (the case in the report): injecting
`夜のなかをあるいていく どこまでもつづくよるのうた きみのこえがきこえるようなきがした それでもぼくらはあるいていく`
into the album rows and the now-playing title leaves `scrollWidth == 360` and the title element
itself ellipsised (`scrollWidth 764 > clientWidth 244`) — it shortens instead of widening the page.

### 9.3 The spectrum — frame times, not adjectives

With the spectrum actually drawing (90 consecutive `requestAnimationFrame` intervals, 360 px
viewport, audio playing, real analyser frames):

```
p50 16.7 ms   p95 16.7 ms   max 16.8 ms   avg 16.5 ms    → 60 fps, no dropped frame in 1.5 s
```

Two controls, so the number means something. The same loop on `about:blank` in the same browser
gives `p95 116.7 ms` — this machine throttles a tab that is not compositing, which is where an
earlier measurement's scary numbers came from. And with the canvas hidden (Lyrics mode) the loop
sits at `p50 50.0 ms`, because nothing is asking Chrome to compose a frame; the visualiser itself
is what holds the 60 fps.

That the frames are *fresh* — the actual complaint ("draggy and laggy") — was measured directly:
120 consecutive animation frames while playing, hashing the analyser output each frame, gave
**0 byte-identical pairs**. The old design read the meter's 100 ms snapshot, so at 60 fps roughly
five of every six frames re-drew the same buffer; `smoothingTimeConstant` was also dropped from 0.8
to near-unsmoothed, and the stale-frame guard now keys on a same-non-zero reading rather than a
2.5 s byte-identical window.

The spectrum is still the real one: `getByteFrequencyData()`, `fftSize` 2048 at 48 kHz (23.44 Hz per
bin). Playing the mock's track whose partials are 440/1760/3520 Hz, the four loudest bins are
422/445, 1758, 3516 Hz — the declared partials, within one bin.

### 9.4 Lyrics — all four answers, end to end

Source is the library and nothing else: `getLyricsBySongId` (OpenSubsonic), with the legacy
`getLyrics` only as a fallback. The mock now implements those two endpoints the way Navidrome
serves sidecar files; its lines are invented for the harness and ship nowhere.

| Case | What was run | What came back |
|---|---|---|
| Timed sidecar | `npm run mock` (default: first album has a `.lrc`-style sidecar), play a track from it, open the Lyrics pill | 6 lines rendered; the mock recorded `getLyricsBySongId id=album-1-1-track-3 … served:true`; the highlighted line tracked the clock (line 2 active at ~5 s, line 4 at ~16 s) |
| Untimed sidecar | `npm run mock -- --lyrics-plain`, same track | 6 lines, **no** highlight in four samples over 5 s of playback (timings absent, so nothing lights up), and the panel scrolls (`scrollHeight 239 > clientHeight 154`) |
| No lyrics at all | a track from an album without a sidecar | `getLyricsBySongId … served:false` then `getLyrics … served:false` → the panel reads **"no romaji lyrics for this track yet"**. No spinner, nothing invented |
| Track changes | press Next twice with the panel open | panel reloaded per track (`album-1-1-track-1 → -2 → -3`, one library request each) |

The romaniser is a safety net, not the feature: a line that still holds kanji is shown as written
plus one line of small print (`Kanji is left as it is — reading it out needs a dictionary the app
does not carry.`), and `test/lyrics.test.ts` asserts kanji is never reported as romaji.

Nothing leaks into what ships:

```
$ shasum -a 256 dist/assets/index-BlvTS-Cb.js
e6ba262e…277caaa   dist/assets/index-BlvTS-Cb.js
       ^ the same hash for the copy inside Navilite-1.1.0-debug.apk and inside Navilite-1.1.0-unsigned.ipa
$ grep -c 'no romaji lyrics for this track yet' <bundle inside the APK>   → 1
$ grep -c '夜のなか' <bundle inside the APK>                                → 0
$ grep -c 'lrclib'  <bundle inside the APK>                                → 0
$ grep -r 'lrclib' src/ test/ dist/                      → only the guard in test/lyrics.test.ts
```

**Not verified:** lyrics served by the real Navidrome from his pilot sidecar. That needs his
credentials and lives behind the tailnet door, and the point of the change is that the text is his;
the mock answers the same endpoint with the same JSON shape, and the operator confirmed the
sidecar/`LyricsPriority` behaviour on the box.

### 9.5 Navigation, gesture, launch restore, (x/y), highlight

- **Logo → spectrum:** clicking the header `.brand` gives `#/now` with the now-playing screen
  visible.
- **Swipe left from the spectrum:** a synthesised touch drag leftwards across the now-playing
  screen lands on `#/playlists` (Playlists tab active) with playback untouched.
- **Search without a tab:** the Library screen carries the field
  (`input[type=search]`, placeholder *"Search your library"*) plus a Search button; typing
  "Transmission" and pressing Enter gives `#/search/Transmission` with the three matching albums
  listed, backed by a real `search3` call (`songCount=40 albumCount=10 artistCount=10`). The tab is
  gone, the ability is not.
- **Launch restore:** with a queue saved by `savePlayQueue`, a reload lands on `#/now` for that
  track (`Playing from your last session (4/4)`), shows the cover and duration, and does **not**
  start playing by itself; pressing play resumes at the saved position (the mock had
  `position: 10055`, the clock came up at `0:07`).
- **(x/y)** shows the track's place in the playlist, which is what he asked for. It follows the
  playlist position rather than the play-order cursor, so switching shuffle on does not rename the
  track from 3/4 to 1/4.
- **Blank Server URL:** the field is pre-filled with the canonical origin and reads
  `https://alienlab.tailbed832.ts.net:9443 (leave blank to use this)`, and the form says in as many
  words *"Left blank, the address above is used — that is your library."* Submitting a blank field
  from a page served by the mock issued a real
  `GET https://alienlab.tailbed832.ts.net:9443/rest/ping.view?…` — so it falls back to the door
  rather than failing on an empty box. That call reached the real library over the tailnet and came
  back `wrong username or password` (Subsonic error 40 — the credentials used here are the mock's,
  not his), which is the correct answer and incidentally another confirmation that the door is live.
- **Highlight:** playing a playlist's track marks exactly one row (`.row.song.playing`) with the
  title of the track that is playing.
- **Shuffle / repeat:** the buttons are state, not decoration — `aria-pressed` and the icon follow,
  and repeat cycles `off → all → one → off`; `test/queue-order.test.ts` covers the order maths and
  the end-of-queue behaviour.

### 9.6 Artifacts

```
$ npm run apk            → artifacts/Navilite-1.1.0-debug.apk    8,780,443 bytes  (v1.0: 8,772,279, +0.09%)
$ npm run ipa:unsigned   → artifacts/Navilite-1.1.0-unsigned.ipa   863,802 bytes  (v1.0:   856,822, +0.81%)
# .ipa: 47 members, one index-*.js — app version 1.1.0 (2), UIBackgroundModes[0]=audio
```

(The v1.0 figures are the released ones; the corrected v1.0 rebuild that is still in `artifacts/`
under its old `0.1.0` name is 8,773,616 / 856,888, so against that pair v1.1 is +6,827 / +6,914.)

Both embed the web payload that is current in `dist/`, byte for byte (SHA-256 above), so "verified
on the real build" means the browser run in §9.2–9.5 was served exactly the bundle that is inside
both binaries. Neither binary is in the repo (`artifacts/` is gitignored).

### 9.7 Still unverified without a device

- Native playback and the native-shell hand-off (ExoPlayer / AVFoundation), lock-screen controls,
  Keystore / Keychain behaviour, and the actual install on the iPhone — no device in this session.
- iOS backgrounding behaviour of the lyrics panel (Web Audio and the page timers stop; the panel
  paints from the clock on return).
- The real Navidrome's sidecars (§9.4).
- Scrolling "feel" on a physical phone; the overflow checks above are geometry, not touch comfort.

## 10. v1.2 — the three things the owner reported (2026-10-11)

Scope, from the card: the sideways scroll, Lyrics mode as a full-height text screen with no album
art, and the after-image in the spectrum. Nothing else was folded in — the lyrics *source* change
(a custom route for the sidecar text) is v1.3, behind Nova's route.

(§7's "No simulator run" is superseded here: v1.2 used an iOS 26.1 simulator, both Safari and a
real Capacitor WKWebView shell — §10.2.)

### 10.1 Tests, build, artifacts

```
$ npm test            ℹ tests 62  ℹ pass 62  ℹ fail 0  ℹ skipped 0     (v1.1: 53)
$ npm run typecheck   (tsc --noEmit, clean)
$ npm run build       dist/assets/index-CAjohe-r.js   78.61 kB │ gzip: 26.91 kB
                      dist/assets/index-DF1Dipzq.css  11.28 kB │ gzip:  3.03 kB
$ npm run apk            → artifacts/Navilite-1.2.0-debug.apk       8,780,787 bytes  (v1.1: 8,780,443, +344)
$ npm run ipa:unsigned   → artifacts/Navilite-1.2.0-unsigned.ipa      864,067 bytes  (v1.1:   863,802, +265)
# .ipa: app version 1.2.0 (3), UIBackgroundModes[0]=audio
```

New tests: `test/visualizer.test.ts` (the spectrum contract), `test/lyrics-cache.test.ts` (a
sidecar that lands after the track was first opened), `test/layout-393.test.ts` (the 393 px
regression), and the v1.2 changelog guard in `test/changelog.test.ts`.

### 10.2 "Still slightly too wide for my screen … horizontal scroll" — measured, and the honest answer

**The harness changed first, because the v1.1 claim ("clean at 390 and 360 px") was checking the
wrong thing.** Three engines now, all over one in-page measurement
(`tools/layout-probe-browser.js`, injected before the app's first paint):

| driver | engine | device |
|---|---|---|
| `tools/layout-audit.mjs` | Chrome via CDP | 393 x 852 CSS px, dpr 3, `Emulation.setSafeAreaInsetsOverride` top 59 / bottom 34 |
| `device-probe.mjs --device <sim>` | iOS 26.1 Safari (real WebKit) | iPhone 15 Pro simulator |
| `device-probe.mjs --serve --app …` | **the app itself**: Capacitor 8 WKWebView in the simulator, `app.navilite` installed and launched, driven through its own controls | same; reports `innerWidth 393`, `safe-area-inset-top 59px`, `bottom 34px` from the OS |

Fourteen states per run, on a library built to be hostile to layouts (`mock-subsonic.mjs --stress`:
artist `星野源と仲間たちと深夜のドライブ音楽団`, long Japanese album and track titles, an unbroken
Latin title, two very long playlist names):

```
Library (#/artists) — long Japanese artist name
Library — search field focused (the iOS focus-zoom case)
Artist — long Japanese album names in the grid
Album — long Japanese and unbroken-Latin track titles
Playlists — two very long playlist names
Playlist — long Japanese playlist name
Settings — the long playback-preference select
Changelog
Now (#/now, spectrum) — long title, long "Playing from" line
Now (#/now, lyrics) — long unbroken Japanese lyric lines
Now (#/now, lyrics) — mid-swipe, finger down and moved
Now (#/now, lyrics) — after the swipe completes
Library with the player bar showing a long Japanese title
Stress album with the player bar showing a long unbroken Latin title
```

Result, in all three engines, in every state:

```
document clientWidth 393 = documentElement.scrollWidth 393   → overflow 0 px
tightest content box in the layout: .now-close, right 381 → 12 px of slack
RESULT: no horizontal overflow anywhere.
```

The same run inside the native shell (`docs/layout-393-native-report.json`) reports it off the
phone's own numbers — `innerWidth 393`, `env(safe-area-inset-top) 59px`, `bottom 34px` from iOS,
`visualViewport scale 1` — and the same result: every state 393/393, overflow 0 px.

The width sweep (`--sweep 320:440 --step 1`, eight routes at every width) also comes back clean at
every width in the range.

So: **there is no element wider than the 393 px viewport, and I could not reproduce the sideways
scroll.** What v1.1 actually got wrong is the checking, and it got it wrong in four ways that are
now closed: it measured 390 and 360 (both *narrower* than the phone, and a tuned layout that fits
one width is not responsive), at dpr 2, with a fixture whose longest string was
`Track 1 · 110/330/1320 Hz` (nothing in it could push a layout), and it never looked at the states
that actually hold a long string in a non-wrapping row — the mini player bar while browsing, and
the search field focused. Those are states 13, 2 and 14 above.

What changed in the app anyway — structure, not symptom:

- **No viewport units left in the stylesheet.** `.toast` was `min(90vw, 520px)`; a `vw` ignores the
  safe area and counts a reserved scrollbar on engines that have one, and it is the class of sizing
  the owner's own words point at ("forcing some kind of set width"). It is now
  `min(calc(100% - 28px), 520px)`.
- **`-webkit-text-size-adjust: 100%`** on `html, body`. Inflated text is the one way a line gets
  wider without a width being declared anywhere.
- **Safe-area insets on the horizontal axis too** (`.topbar`, `.view`, `.playerbar`, `.now-top`,
  `.now-bar`, `.lyrics`), so landscape content stops running under the notch.
- **Deliberately not done: `overflow-x: hidden`.** There was nothing to hide, and adding it would
  both mask the next offender and defeat the regression test (which measures `scrollWidth`).
- **Found and reported, not changed:** `.now-art { width: 100%; height: 100% }` overrides
  `.now-cover > * { width: min(46vw, 190px) }` (same specificity, later in the file), so the album
  art on the spectrum screen is a 357 px square rather than the 190 px cap the stylesheet intends.
  It is not one of the three reported defects, so v1.2 leaves the spectrum screen's look alone;
  it is a one-line change if he wants a smaller cover there.

If a sideways scroll survives on his phone after installing this build, the measurement to take is
on his device, not here: the read-only seam (`window.__navilite.status()`,
`document.documentElement.scrollWidth` vs `window.innerWidth`) through Safari's Web Inspector
against the installed app, on the screen where it happens.

### 10.3 Lyrics mode is a text screen: no art, and the whole height

Measured on the same 393 x 852 target, in both engines, before and after:

```
before (v1.1):  lyrics: 1 of 12 lines fit whole · line box 55.09 px at 15px · panel 89.48 px · cover 359 px (visible)
after  (v1.2):  lyrics: 12 of 12 lines fit whole · line box 37.09 px at 13px · panel 452.48 px · cover hidden
                (the same run inside the native shell: panel 363 px, 12 of 12 lines, cover hidden, 13px)
```

Two causes, both measured rather than guessed: the album art was still on screen (a 357 px image,
§10.2), and the lyrics column was pinned at its own `min-height: 88px` because a flex item with
`flex-basis: auto` is sized by its (long) content first and then shrunk to the minimum by the rows
above it. Fix: a `lyrics-mode` class on `.now` (set in `setNowMode`) that hides `.now-cover` and
gives `.now-lyrics` `flex: 1 1 0; min-height: 0`, plus tighter line boxes.

Decisions, since two were mine to make:

- **13 px on a 1.35 line box.** iOS's own caption size; comfortable for kanji *and* romaji at arm's
  length; roughly 26 lines of the 852 px screen at once instead of 15 at 15 px. The active line
  keeps the same size and is picked out by colour and weight only, so following the highlight never
  reflows the column under the reader's eye.
- **The transport bar stays.** It costs 108 px — about six lines — and the alternative is leaving
  the screen to pause. The song title, artist and "Playing from …" rows (136 px, another eight)
  stay for the same reason: they are how you know what you are reading. Chrome costs about 13 of
  the ~39 lines the screen could hold; the remaining ~26 are lyrics.
- **Found and reported, not changed:** the native shell has ~89 px less room than Chrome for the
  same screen (lyrics panel 363 px vs 452 px), because `ios.contentInset: 'always'` already shrinks
  the web view's layout viewport by the safe-area insets *and* the app adds
  `padding-top: env(safe-area-inset-top)` on top of that. The inset is counted twice. It is
  vertical space, it is pre-existing (v1.1 behaves the same way), and it is not one of the three
  reported defects — but it is worth ~5 lines of lyrics on his phone, so it belongs in v1.3 rather
  than in a hotfix to a frozen scope.

### 10.4 "Some after image or some separation of the colors at the top of each bar"

Four separate memories of earlier frames were being drawn, all in the old `drawSpectrum`, plus one
in the engine:

1. **peak caps** — a 2 px rectangle above each bar at `globalAlpha 0.9` while the bar itself was
   drawn at 0.55–1.0, i.e. a differently-bright floating segment: this is the reported "separation
   of the colors at the top of each bar";
2. **a fixed release fall-off** (`BAR_FALLOFF = 0.78` per frame) — the bar showed the previous
   frame's level for ~115 ms after the music moved on: the "after image";
3. **the bar gradient's accent stop at the top** — a second colour by construction;
4. **the reflection** under the baseline — a deliberate second copy of the bar;
5. and `analyser.smoothingTimeConstant = 0.15`, so 15% of the previous frame was inside every
   reading to begin with.

v1.2 draws one flat colour, one rectangle per band, whose height is a pure function of the frame
just read, and sets the analyser smoothing to 0.

**Evidence 1 — the drawing itself** (`test/visualizer.test.ts`, the real `attachVisualizer` driven
by a recording 2D context):

```
v1.1: 192 rectangles per frame (64 bars + 64 reflections + 64 caps)
v1.2:  64 rectangles per frame
✖ (against v1.1, via git stash) every bar in a frame is one flat colour at full alpha … 192 !== 64
✔ (v1.2) a loud frame followed by silence collapses to the baseline on the very next frame
✔ (v1.2) a quiet frame is drawn from the quiet frame, not from the louder one before it
✔ (v1.2) two identical frames draw byte-identical rectangles
✔ (v1.2) every bar is one flat colour at full alpha, and each frame is fully cleared
```

**Evidence 2 — real pixels, real app** (`tools/spectrum-proof.mjs`): the app playing the mock's WAV
through its own transport, `getImageData` off the real canvas, the audio taken to silence by
setting `volume = 0` on the engine's media element (captured by wrapping `window.Audio` before the
bundle runs — pausing instead flips the screen to the album-art theme and would prove nothing about
the bars):

```
v1.1 (stashed src/player/{visualizer,engine}.ts, rebuilt):
  playing: 23356 lit pixels (checksum 1831121519)
  +50 ms:  37214 lit — 159% of the loud frame (caps and reflections *add* lit pixels)
  +160 ms: 18302 lit — 78%, the release fall-off
  +240 ms: 14409 lit, DIFFERENT from +160 ms — still decaying
  RESULT: FAIL — something of an earlier frame is still on screen.

v1.2:
  playing: 23617 lit pixels
  +50 ms:  1277 lit — 5.4% (informational: this reading depends on the media pipeline's own
           latency, which varies between runs; it is reported, not asserted)
  +160 ms: 1277 lit
  +240 ms: 1277 lit, byte-identical to +160 ms
  RESULT: every bar is the current frame only.
```

### 10.5 The lyrics cache the owner tripped over, pinned by test

`test/lyrics-cache.test.ts` covers the exact case: a track is opened *before* its sidecar exists
(the panel correctly says "no romaji lyrics for this track yet" and the miss is remembered for six
hours), the sidecar then lands, and the same track shows its words on the next visit after the miss
expires. Both halves are asserted, including the one that is easy to forget — inside the six-hour
window the app still says "no lyrics" for a track that now has them. The window is deliberate
(`MISS_TTL_MS`, and the file says why), so v1.2 does not change it; the refresh story belongs to
v1.3 with the lyrics source.

### 10.6 Still unverified

- **His phone.** Nothing here ran on it. iOS WebKit *is* covered twice (§10.2), including the real
  Capacitor shell reporting the OS's own insets, but a simulator is not his device.
- **The sideways scroll, if it survives.** No offending element could be found at 393 px in three
  engines, so the claim is "measured clean at the reported width", not "fixed a named offender"
  (§10.2, and the on-device measurement to take next).
- **His sidecar corpus.** 202 files / 213 tracks is what the lyrics view will meet in v1.3; v1.2
  was measured against the mock's stress corpus, which is one 12-line song (§10.3).
- Native playback, lock-screen controls, Keystore/Keychain and the sideload install: unchanged from
  §9.7 — still no device, still unverified.

## 11. v1.3 — lyrics from the library's own route first (2026-10-11)

The change: `src/api/sidecar.ts` is new (the route client), `src/api/lyrics.ts` tries it **first**
and falls back to `getLyricsBySongId` then legacy `getLyrics`, `src/storage/lyrics.ts` shortens the
cache windows, and the mock now serves the same route so the whole path is exercised end to end.

### 11.1 Unit tests

```
$ npm run typecheck && npm test
ℹ tests 70   ℹ pass 70   ℹ fail 0   (v1.2: 62)
```

The new ones, all in `test/lyrics.test.ts` / `test/lyrics-cache.test.ts` / `test/changelog.test.ts`:

- the route's answer is parsed as the file itself — timed `.lrc` gets times, plain `.txt` is a
  first-class untimed answer, empty bodies are `null`;
- the URL the route is asked with, asserted **literally** (the same shape as Nova's curl transcript):
  `'/lyrics?path=%E3%83%A8%E3%83%AB%E3%82%B7%E3%82%AB%2F…%20…%E3%83%80%E3%83%B3%E3%82%B9.opus'`;
- a route that is 404/400/503, empty, throwing, or answering `null` is always `null`, never a throw —
  and a song with no `path` never produces a request at all;
- the wrapped-build client: the options actually handed to `CapacitorHttp` (url, `GET`,
  `responseType: 'text'`, both timeouts), a JSON body from a 404 treated as "none", and a client that
  throws degrading to "none";
- the order: with the route answering, **neither** Subsonic call is made (`seen` contains only
  `route:<id>`), and with the route empty/throwing the Navidrome answer is used;
- the cache: a miss expires after five minutes and then the words appear, a miss written by the
  previous build (an hour old) is not inherited, a hit survives a day but is re-asked after a week.

### 11.2 The source order, end to end, in a real browser

`npm run build`, then the mock (`node tools/mock-subsonic.mjs --port 4631 --stress --dist dist`, which
now serves `/lyrics` as well as the Subsonic API) driven in real Chrome — the app's own connect path,
its own transport, its own Lyrics panel. The mock records **which endpoint each lyrics request went
to**, which is the point: rendering the words would not have proved the source.

Run twice: once while the change was being written, and again against the **final** `dist/` — the one
whose `dist/assets/index-B6xoPdyW.js` (sha256 `d641a317…`) is inside both artifacts (§11.7). The
numbers below are the second run; the page reported the asset it had loaded, not just the port.

1. **A track with a sidecar** (pilot album, `album-1-1-track-1`):

```
__navilite: { panel: 'album-1-1-track-1', panelLoaded: true, panelLines: 6 }
lyrics:     ['夜nonakao aruiteiku', 'kiminokoega kikoeru', 'hoshiga matataku soranoshita', …]
active:     '夜nonakao aruiteiku'          (kana romanised on device; kanji left as it is)

mock /__state:
  lyricsCalls: [{ endpoint: 'sidecar', path: 'Alien Lab/Alien Lab — Transmission/01 - Track 1 · 110-330-1320 Hz.wav',
                  trackId: 'album-1-1-track-1', served: true }]
  subsonic lyrics calls: []                 ← Navidrome was never asked
```

2. **A track with no sidecar** (`album-2-1-track-1`) — the full chain, in order, and the honest empty
   state:

```
route      → served: false     (404, no sidecar for that track)
getLyricsBySongId → served: false   (code 70)
getLyrics  → served: false     (code 70)
panel:     0 lines, "no romaji lyrics for this track yet"
```

3. **A route that cannot be reached** — the request blocked in the browser before it left
   (`Network.setBlockedURLs`), then a track whose sidecar *does* exist:

```
route hits for that track: 0            ← blocked, never arrived
getLyricsBySongId → served: true
panel:     6 lines, "…kiminokoega kikoeru…"    ← no error, no empty screen, no spinner
```

### 11.3 The real corpus, through the app's own URL builder

The route on his box answers (§ the host card's transcript); the question this pass had to answer is
whether **the URL this app builds** resolves against the real 355-sidecar corpus. `LyricsRoute` was
imported directly and pointed at the door (`node --experimental-strip-types`):

```
health: {"status":"ok","version":"1.0","root":"/music","sidecars":355,"timed":292,"plain":63,
         "audio_files":393,"index_age_s":25.3,"now":1791676735}
index:  count=355 timed=292 plain=63 audio=393

--- timed AKASAKI/Bunny Girl/01 - Bunny Girl ---
  .../lyrics?path=AKASAKI%2FBunny%20Girl%2F01%20-%20Bunny%20Girl
      http 200 format=lrc bytes=1470 matches_index=true
      first line: "[00:00.22] yoru no hajimari sa baniigaaru yuuwaku sareru kodou ni"
  .../lyrics?path=AKASAKI%2FBunny%20Girl%2F01%20-%20Bunny%20Girl.flac      (the audio-extension form)
      http 200 format=lrc bytes=1470 matches_index=true

--- plain Aimer/05. for ロンリー with 阿部真央 ---
  .../lyrics?path=Aimer%2F05.%20for%20%E3%83%AD%E3%83%B3%E3%83%AA%E3%83%BC%20with%20%E9%98%BF%E9%83%A8%E7%9C%9F%E5%A4%AE
      http 200 format=txt bytes=860 matches_index=true
      first line: "Daisuki na hito kimi wa dou omou?"

ヨルシカ/エルマ/01 - 車窓.opus   -> HTTP 404  no lyrics sidecar for this track
../../etc/passwd              -> HTTP 400  rejected path
/etc/passwd                   -> HTTP 400  rejected path
urlFor({})                    -> null        (no `song.path`: no request is made)
```

Both real files matched the byte counts the route's own `index.json` reports, so the client is asking
for exactly the file the route serves. A timed and an untimed track were both taken because `.txt` is
the normal case in this corpus (63 of 355).

### 11.4 The cache windows (his report: "tracks I opened before the corpus existed stayed blank")

`MISS_TTL_MS` 6 h → **5 min**, `HIT_TTL_MS` 30 days → **7 days**. Two consequences, both asserted:

- a track that had no lyrics when it was opened is asked again five minutes later, so the sidecars Navi
  is still writing appear without the user clearing anything;
- a miss written by the *previous* build is already expired when this one starts (an hour-old miss is
  treated as stale) — the upgrade path is covered by its own test, which is the case the owner hit;
- a hit still survives a day, and is re-asked after a week, so a `.txt` that is later upgraded to a
  timed `.lrc` can replace what is on the device. (§10.5 said the refresh story belongs to v1.3; this
  is it.)

### 11.5 The one thing the wrapped builds do differently, and why

The route sends **no** `Access-Control-Allow-Origin` — by design, it is meant to be fetched
same-origin. Measured, in Chrome, with the real route:

```
page origin http://127.0.0.1:4631 → GET https://…:9443/lyrics?path=AKASAKI%2F…
  → TypeError: Failed to fetch          (refused before any text arrived)
curl -D- -H 'Origin: https://localhost' https://…:9443/rest/ping.view → access-control-allow-origin: *
```

So the API is fetchable cross-origin by Navidrome's own header, and this route is not. Inside the
APK/IPA the page's origin is the webview's own (`https://localhost`), i.e. cross-origin, so there the
route is fetched with **`CapacitorHttp`** — the platform's HTTP client, which is not a browser request
and has no origin to check. Verified as far as this machine allows: `CapacitorHttp` is registered by
default in both bridges (`capacitor-swift-pm` `CapacitorBridge.swift`: `pluginList = [CAPHttpPlugin…]`;
Android `Bridge.java`: `registerPlugin(CapacitorHttp.class)`), and the call this app makes is pinned
by unit test (url, method, `responseType`, timeouts, response handling, failure handling) — see §11.6
for what that does *not* prove.

### 11.6 Still unverified

- **The native fetch on a real device.** The `CapacitorHttp` path is exercised at its seam in unit
  tests and reasoned from the registered plugin list, but no build in this session ran it against the
  real route: an unsigned simulator build cannot write the Keychain, so the app cannot connect there
  without hiding the native bridge — and hiding it would also disable the native HTTP path being
  tested. His phone is where this gets its real answer.
- **His browser on the door origin.** The same-origin path is what the browser case exercises in
  §11.2, but against the mock, not against the real app served from `:9443` (deploying a new `dist/`
  to the door is Nova's card, not this one).
- Native playback, lock-screen controls, Keystore/Keychain and the sideload install: unchanged from
  §9.7 — still no device, still unverified.

### 11.7 Artifacts

```
artifacts/Navilite-1.3.0-debug.apk      8,781,723 bytes   (v1.2: 8,780,787 — +936)
artifacts/Navilite-1.3.0-unsigned.ipa     864,867 bytes   (v1.2:   864,067 — +800)
```

Both embed the same `dist/` the tests ran against — `shasum -a 256` of
`dist/assets/index-B6xoPdyW.js` (`d641a31759a00e37fb24baa80225fc0980c773a668ef0e2ab8d5f5c024ebbb90`)
compared against `assets/public/assets/index-B6xoPdyW.js` inside the APK and
`Payload/App.app/public/assets/index-B6xoPdyW.js` inside the IPA: identical in all three. Neither
carries any lyric text: grepping the shipped chunk for the mock's lines and for real lines returns
nothing; the words stay on his server and in the device cache. The iOS build reports
`app version 1.3.0 (4), UIBackgroundModes[0]=audio`.
