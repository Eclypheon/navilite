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

At v1.2 that criterion was true of the build as designed — and it still holds: re-run on 2026-10-15
from a worktree of f9fd6e5, the same 1277 lit pixels appear at +160, +240, +700, +900 and +1200 ms,
all byte-identical. What it stopped being true of is **every build since v1.7.4**, which replaced the
snap with a release envelope; so the tool's window, not the player, was re-baselined — see §16.

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
artifacts/Navilite-1.3.0-debug.apk      8,783,060 bytes   (v1.2: 8,780,787 — +2,273, +0.03%)
artifacts/Navilite-1.3.0-unsigned.ipa     864,867 bytes   (v1.2:   864,067 —   +800, +0.09%)
```

Both embed the same `dist/` the tests ran against — `shasum -a 256` of
`dist/assets/index-B6xoPdyW.js` (`d641a31759a00e37fb24baa80225fc0980c773a668ef0e2ab8d5f5c024ebbb90`)
compared against `assets/public/assets/index-B6xoPdyW.js` inside the APK and
`Payload/App.app/public/assets/index-B6xoPdyW.js` inside the IPA: identical in all three. Neither
carries any lyric text: grepping the shipped chunk for the mock's lines and for real lines returns
nothing; the words stay on his server and in the device cache. The iOS build reports
`app version 1.3.0 (4), UIBackgroundModes[0]=audio`.

(An APK rebuilt from the *identical* `dist/` came out 1,337 bytes larger than the first one — zip
timestamps, not content; the web payload hash is the same in both. The numbers above are the shipped
second build, 08:02.)

### 11.8 Found while doing this, not fixed

- **The About line shows a placeholder.** `src/ui/app.ts` defines `const BUILD_ID = '__BUILD_ID__'`
  and nothing ever replaces it — `vite.config.ts` stamps only `public/sw.js` — so
  **Settings → About** reads literally `Navilite __BUILD_ID__ · Subsonic API 1.16.1` in every build,
  including both artifacts (grep the shipped chunk: one hit). Pre-existing since v1.0, cosmetic, and
  outside this card; a one-line `define` in `vite.config.ts` fixes it, but it re-hashes the bundle and
  both artifacts, so it wants its own change.

## 12. v1.4 — scroll containment: what moves when he scrolls

Two reports, both about movement, and neither is a layout that can be asserted in the DOM:

> "if i'm in my playlist then i go to my spectrum view, when i scroll, it seems to scroll the playlist
> behind it."
> "next, i should not be able to scroll the top bar of the main app such that it takes up more space"

So v1.4 is proved with real gestures in real engines, and the before/after is **one measurement run
twice**: the v1.3 payload extracted out of `artifacts/Navilite-1.3.0-debug.apk`, served by the same
mock on the same port numbers, measured by the same probe as the v1.4 build.

### 12.1 The harness, and what it is not

| where | tool | what it does |
| --- | --- | --- |
| Chrome 393×852, dpr 3, iPhone 15 Pro metrics + `setSafeAreaInsetsOverride` (59/34) | `tools/scroll-check.mjs` | real touch and wheel gestures (`Input.dispatchTouchEvent`, `Input.dispatchMouseEvent`), 19 named checks, records the header rect, the document offsets and the scroll container's offset at every step |
| iPhone 15 Pro simulator, Safari | `tools/device-probe.mjs --scenario scroll` | the same scenario in-page via `layout-probe-browser.js`'s `scrollContainment()`, for WebKit, where no finger can be synthesised: hit-testing the screen and asking each scrollable box to scroll |
| `npm test` | `test/scroll-containment.test.ts` | runs the first line under the suite (the check is a test, so it cannot rot) |

The suite also keeps the v1.2 rule: `test/layout-393.test.ts` still walks every route and both modes
at 393×852 and fails on any horizontal overflow — it now reports which box it measured
(`scroll surface measured: div#app > div.view-scroll — since v1.4 the app's own scroll container, not
the document`).

### 12.2 v1.3, measured (RED)

Chrome, 393×852, 19 checks, **9 failed**. The whole document is the scroll container, and a gesture
over the now-playing screen drags it:

```
The list (html) put at scrollTop 400 of 1613 px scrollable.
  top bar: top 0 · height 107.75 (sticky)
  document: scrollTop 400 · scrollable 1613 px · window.scrollY 400
ok    a real touch + wheel gesture scrolls the list (the gesture mechanism works)
ok    the top bar does not move, grow or shrink when the list scrolls
FAIL  the document does not scroll while the list does
      document scrollTop 662 · window.scrollY 662 · document scrollable 1613 px
FAIL  scrolling the spectrum does not scroll the playlist behind it
      list scrollTop 700 -> 1613
FAIL  the covered list is frozen (overflow hidden) while the spectrum is up
      scroll container overflow-y visible, overscroll-behavior-y auto
FAIL  closing the spectrum puts the list back at exactly the offset it was left at
      scrollTop 700 -> 1613 (route #/playlist/pl-stress-long, .row.song rows back: 1613 px scrollable)
FAIL  a deliberately 600 px-wide element is still reported by the 393 px layout audit
      overflow +221 px on html (document 221 px) · named as nothing
```

That last one is report #2's mechanism, measured: in v1.3 a row that is wider than the screen widens
**the document itself** — 221 px past the 393 px viewport — and a phone's answer to a page wider than
the screen is to shrink-to-fit and pan it, which is exactly "the top bar takes up more space".

WebKit, iPhone 15 Pro simulator, Safari (`--scenario scroll`, 8 checks, **4 failed**): the same story
with the numbers WebKit gives, `innerHeight 695` because Safari's URL bar takes the rest:

```
scroll surface: html (overflow-y visible, overscroll-behavior-y auto)
the list: scrollTop 400 of 1660 px scrollable
the document: scrollTop 400, scrollable 1660 px, window.scrollY 400
the top bar: top 0 · height 58 · position sticky
after the spectrum was opened, everything scrolled and closed again:
  the list: scrollTop 1200 (was 400) — NOT restored
FAIL  documentFrozen · documentNeverScrolled · listNeverMoved · listRestored
```

### 12.3 What changed

- **One shell, one scroll container.** `#app` is a fixed column (`height: 100%`, `overflow: hidden`)
  whose only moving part is `div.view-scroll` between the header and the player bar. `html, body` no
  longer scroll at all. Both boxes carry `overscroll-behavior: contain`/`none`, so a gesture cannot
  chain out of one view into another in either direction.
- **The covered view is frozen, not unmounted.** Opening the now screen adds `.scroll-locked`
  (`overflow: hidden`) to that one box and records its offset; the offset is re-applied *after* the
  view has been drawn again (re-applying it while the list is still "Loading…" would be undone by the
  render). That is why closing lands on the same row.
- **The header is a flex row of the shell** (`flex: none`), outside the scroller, so there is no
  gesture in the app that can reach it.
- **iOS: the web view's own elastic scrolling is off.** `ios/App/App/ViewController.swift` is now a
  `CAPBridgeViewController` subclass that turns off `bounces`, `alwaysBounceVertical`,
  `alwaysBounceHorizontal` and `contentInsetAdjustmentBehavior` on the web view's scroll view — the
  rubber-band drag that pulls a header around on a phone is native, so CSS cannot reach it. The
  storyboard and the scene delegate both instantiate it (`Main.storyboard` customClass
  `ViewController` in module `App`).

### 12.4 v1.4, measured (GREEN)

Chrome, 393×852, **19 checks, 0 failed**:

```
The list (div#app > div.view-scroll:nth-of-type(1)) put at scrollTop 400 of 1613 px scrollable.
  document: scrollTop 0 · scrollable 0 px · window.scrollY 0
ok    a real touch + wheel gesture scrolls the list           scrollTop 400 -> 664 on div.view-scroll
ok    the top bar does not move, grow or shrink               top 0 height 107.75 -> top 0 height 107.75
ok    the document does not scroll while the list does        document scrollTop 0 · scrollable 0 px
ok    every point of the screen hit-tests into the now-playing view, not the list behind it
                                                              25 of 25 points land inside .now
ok    scrolling the spectrum does not scroll the playlist behind it
                                                              list scrollTop 700 -> 700
ok    the covered list is frozen (overflow hidden) while the spectrum is up
                                                              overflow-y hidden, overscroll-behavior-y none
ok    the lyrics panel itself takes the gesture               scrollTop 321 with 471 px of scrollable filler
ok    a gesture in lyrics mode does not scroll the playlist behind it either
                                                              list scrollTop 700 -> 700
ok    closing the spectrum puts the list back at exactly the offset it was left at
                                                              scrollTop 700 -> 700
ok    the list is scrollable again once the spectrum is closed
                                                              overflow-y auto · 1613 px scrollable
ok    the swipe from the spectrum to the playlists is still a swipe, not a scroll
                                                              route after a leftward touch drag: #/playlists
ok    a deliberately 600 px-wide element is still reported by the 393 px layout audit
                                                              overflow +221 px on div.view-scroll (document 0 px)
                                                              · named as div#v14-wide-probe
RESULT: nothing moved that should not have.
```

WebKit, iPhone 15 Pro simulator, Safari, **8 of 8**:

```
scroll surface: div#app > div.view-scroll:nth-of-type(1) (overflow-y auto, overscroll-behavior-y contain)
the list: scrollTop 400 of 1660 px scrollable
the document: scrollTop 0, scrollable 0 px, window.scrollY 0
the top bar: top 0 · height 58 · position sticky
after the spectrum was opened, everything scrolled and closed again:
  the list: scrollTop 400 (was 400) — restored exactly
  the top bar: top 0 · height 58 — identical
scrolling the frozen container programmatically moved it by 600 px (browser behaviour for
overflow: hidden) — the offset was still restored exactly
ok documentFrozen · documentNeverScrolled · headerNeverMoved · listNeverMoved · listRestored
ok overlayIsTheOnlyHitTarget · swipeStillWorks · controlsStillWork
```

Raw readings: `docs/layout-393-report.json` (the 393 walk: `RESULT: no horizontal overflow
anywhere`), `docs/layout-393-scroll-device-report.json` (the WebKit scroll scenario). The v1.3
counterparts are quoted above and were produced by the same tools pointed at the extracted v1.3
payload (`tools/device-probe.mjs --dist <v1.3 assets>`).

### 12.5 The header re-report, and where the claim actually rests

He re-reported the top bar while testing **v1.3** — so it is not evidence that this fix failed, and
it is treated as the same MUST-FIX, measured. What the numbers now say, honestly:

- the header rect is identical before and after every gesture in both engines (`top 0`, `58 px` in
  WebKit; `top 0`, `107.75 px` in Chrome's emulation — constant in both), and that assertion is in the
  suite at 393×852;
- but that assertion also passed on v1.3 under a *synthetic* gesture, because `position: sticky` does
  hold during a programmatic scroll. It is a guard against regression, not the proof. The proof is
  what changed around it: the document now has **0 px of scroll range in either axis** (v1.3: 1,660 px
  down and, with a wide row, 221 px across), the header is not inside anything a gesture can reach,
  and the wide row that used to widen the page is contained in the scroller instead;
- the elastic drag itself is native and can only be reached in `ViewController.swift` (§12.3).

### 12.6 Still unverified

- **A finger with momentum.** iOS rubber-band needs a real drag on real hardware: `simctl` cannot
  synthesise one, and Safari-for-simulator cannot be driven by CDP. The CSS half removes the drag's
  *effect* (nothing above or below the content is scrollable, and nothing chains), the native half
  removes the drag itself — but neither is proven by a synthetic gesture. His phone is the answer.
- **The native shell.** The simulator run above is Safari loading the served `dist/`, not the built
  `.app` (an unsigned simulator build cannot write the Keychain, so the probe hides the native bridge
  and the app signs in through its web-storage fallback). `tools/device-probe.mjs --app <App.app>`
  is the path for a device run; `ViewController.swift` is compiled and linked by the iOS build
  (`tools/build-ios-ipa.sh`), which is the only thing this session proves about it.
- **Android's overscroll.** Android's web view does not drag its own content the way WKWebView does,
  and the document now has no scroll range there either, so the CSS half covers it; no Android device
  run was made.

### 12.7 Artifacts

```
artifacts/Navilite-1.4.0-debug.apk      8,782,355 bytes   (v1.3: 8,783,060 —   −705, −0.01%)
artifacts/Navilite-1.4.0-unsigned.ipa     866,719 bytes   (v1.3:   864,867 — +1,852, +0.21%)
```

Both embed the exact `dist/` the tests ran against: `shasum -a 256` of `dist/assets/index-DD3_tz8t.js`
(`78b4902a23606c7b120485c0649025658e89a483fce11bb1dd05d7b91c7ce6c5`) against
`assets/public/assets/index-DD3_tz8t.js` in the APK and `Payload/App.app/public/assets/index-DD3_tz8t.js`
in the IPA — identical in all three, and the stylesheet too
(`…/index-GuqClR0T.css`, `725d33dca7b942b23722678d8f72766824242a4b8d2db0463eef2451a30e3da5`), which is
where `.view-scroll{…overflow-y:auto}`, `.view-scroll.scroll-locked{overflow:hidden}` and the
`overscroll-behavior` values live. The iOS build reports `app version 1.4.0 (5),
UIBackgroundModes[0]=audio`, and the shipped arm64 binary carries the v1.4 override —
`nm -a Payload/App.app/App` shows
`_$s3App14ViewControllerC03webB04with13configurationSo05WKWebB0CSo6CGRectV_So0gB13ConfigurationCtF`
(`App.ViewController.webView(with:configuration:)`), i.e. the class that turns the web view's bounce
off is compiled into what he installs, not just on disk.

### 12.8 Found while doing this, not fixed

- **The album-art palette never applies on a cold start.** `boot()` calls
  `restoreSession(ctx, shell, applyPalette)` with a *function* where `PaletteHooks` (`{ apply }`) is
  expected, so `syncPalette()`'s `hooks.apply(DEFAULT_PALETTE)` becomes `Function.prototype.apply` —
  `applyPalette(undefined)` — and `applyPaletteVars` throws on `palette.primary`. Seen in the Chrome
  probe's console while running the scroll scenario (`TypeError: Cannot read properties of undefined
  (reading 'primary')` at the `queue.onChanged` → `syncPalette` frame, reached from a row's play
  button), and it is the *stored-session* path, i.e. every normal launch. Visible effect: the theme
  colours stay on the defaults for the whole session; a one-line
  `{ apply: (palette) => applyPalette(palette) }` fixes it. Pre-existing since v1.1, untouched by this
  card, and it changes colours, so it wants its own change rather than a ride-along here.
  **Fixed in §13 (v1.4.1)** — the fix went further than the one-liner, and §13 is where the proof is.

## 13. v1.4.1 — the album-art palette on a cold start (2026-10-11)

§12.8 recorded the defect; this section is the fix, the proof it was broken, and the proof it is not.
The diff is two lines in `src/ui/app.ts`, and the interesting part is not the diff: the wrong code
type-checked, so *why* the type checker was silent had to be shown rather than asserted, and the
symptom is a theme that never changes rather than an element with the wrong class, so it had to be
measured in a real browser.

### 13.1 Why the type checker was silent — shown, not asserted

`restoreSession(ctx, shell, hooks: PaletteHooks)` took `{ apply(palette: Palette): void }`, and a
**function satisfies that structurally**: every function already has an `apply`, namely
`Function.prototype.apply`. So `restoreSession(ctx, shell, applyPalette)` — the cold-start path, i.e.
every normal launch — compiled, and at runtime `hooks.apply(DEFAULT_PALETTE)` called
`applyPalette(undefined)`.

Copied the pre-fix file in beside the fixed one (the timestamped backup taken before editing), and
compiled it:

    $ cp src/ui/app.ts.bak-<stamp> src/ui/zz-probe-old-palettehooks.ts && npm run typecheck
    > tsc --noEmit
    (exit 0 — the pre-fix file, function passed where PaletteHooks was expected, is clean)

Then put that same call shape back into the fixed file:

    $ npm run typecheck
    src/ui/app.ts(144,42): error TS2353: Object literal may only specify known properties, and
    'apply' does not exist in type 'ApplyPalette'.

The hook is now a plain callback — `type ApplyPalette = (palette: Palette) => void`, passed directly
at both call sites (`restoreSession` from `boot()`, and the connect form) — so neither the mistake
nor its mirror image can be typed any more. This is the part the card's suggested one-liner
(`{ apply: (palette) => applyPalette(palette) }`) would have left in place: the next `restoreSession`
call could make the same mistake again.

### 13.2 RED: the defect, reproduced on the build the card was written against

`tools/palette-check.mjs` (new) drives the real app in real Chrome at 393x852 with the safe-area
insets, through the **stored session** — the path a relaunch takes — and then taps a row's play
button. It reads two things the app cannot fake:

- the palette the app is holding, via `window.__navilite.palette()` (one new read-only line in the
  `__navilite` seam that already reports the engine, the route and the lyrics);
- the colour the document is carrying (`--accent-primary`), which is only set if the apply hook ran;
- plus every uncaught error and unhandled rejection the page saw, collected from *before* the app's
  bundle runs, because `queue.onChanged` calls `void syncPalette(...)`: the failure was a rejected
  promise nobody was holding.

Against the v1.4 app with the new read-only seam added and nothing else (the first build of this card,
`dist/assets/index-BKF5Cb2p.js`), mock library on :4633:

    $ node tools/mock-subsonic.mjs --port 4633 --stress --dist dist
    $ node tools/palette-check.mjs --url http://127.0.0.1:4633 --json red-report.json

    cold start through the stored session: route #/artists · palette {...fromArt:false}
    ok    a normal launch lands in the app without throwing
    Track change with cover art reachable: played album-ja-1-track-1 of 3 rows
      palette {...fromArt:false} -> null
      document --accent-primary #7cd2ff -> #7cd2ff
    FAIL  a track change does not throw from queue.onChanged
          the page threw: TypeError: Cannot read properties of undefined (reading 'primary')
        at Jt (index-BKF5Cb2p.js:1:62704)                 ← applyPaletteVars
        at Object.l (…)                                   ← the apply hook
        at $t (…)                                         ← syncPalette
        at Qt.s.onChanged (…)                             ← queue.onChanged
        at ht.play (…) · at HTMLButtonElement.onclick (…)  ← a row's play button
    FAIL  the palette applied is the artwork one (fromArt: true) — palette null
    FAIL  the document is actually carrying the artwork colours
          --accent-primary is "#7cd2ff", the palette says "(no palette)", the default is "#7cd2ff"
    FAIL  a track change with no reachable cover art does not throw either
    FAIL  with no cover art the app falls back to the defaults, and applies them
    FAIL  nothing thrown anywhere in the session
    RESULT: 6 palette check(s) failed.

Raw measurements: `docs/palette-v1.4.1-red-report.json`. Two details worth keeping: the stack is the
one §12.8 recorded, frame for frame; and after the first track change the app is holding *no* palette
at all (`null`), not the defaults — `applyPalette` assigns `ctx.palette` before `applyPaletteVars`
throws on the argument it was handed. The old colours are what the screen still shows only because
nothing re-sets the CSS variables afterwards.

### 13.3 GREEN: the same check, on the fixed build

    $ npm run build && node tools/palette-check.mjs --url http://127.0.0.1:4633

    Track change with cover art reachable: played album-ja-1-track-1 of 3 rows
      palette {...fromArt:false} -> {"primary":"hsl(22 85% 66%)","secondary":"hsl(337 60% 60%)","accent":"hsl(352 70% 72%)","fromArt":true}
      document --accent-primary #7cd2ff -> hsl(22 85% 66%)
    ok    a track change does not throw from queue.onChanged
    ok    the palette applied is the artwork one (fromArt: true)
    ok    the document is actually carrying the artwork colours
    ok    the artwork palette is not the default palette wearing a different name
    Track change with cover art unreachable: played album-ja-1-track-2
      palette {...fromArt:true} -> {"primary":"#7cd2ff","secondary":"#a88cff","accent":"#ff80b4","fromArt":false}
    ok    the second track change is a different track (so the check is not vacuous)
    ok    a track change with no reachable cover art does not throw either
    ok    with no cover art the app falls back to the defaults, and applies them
    ok    nothing thrown anywhere in the session
    RESULT: the theme follows the track, and nothing threw.

Raw measurements: `docs/palette-v1.4.1-green-report.json`. The second half shuts the library's
cover-art door (the page's own `fetch` made to reject for `getCoverArt`) so the fallback path is
exercised in the same session rather than assumed, and the two halves deliberately play different
tracks so neither result can come from the first one.

### 13.4 Tests

    $ npm test          → 75 tests, 75 pass, 0 fail, 0 skipped   (v1.4: 73)
    $ npm run typecheck → clean

`test/palette-apply.test.ts` (new) runs the driver and asserts on the numbers it reported, not on its
exit code, so a driver that quietly stopped driving anything would fail here: the stored-session
launch throws nothing, the artwork palette arrives *and* is not the default, the document carries it,
the no-art case falls back to the defaults, and the two halves played different tracks. It skips with
its reason when Chrome or a built `dist/` is missing, like the other two browser tests.

`test/changelog.test.ts` gained the v1.4.1 entry's own assertions (his terms only — no hook, type or
promise words), and the version list it pins now ends at `1.4.1`.

### 13.5 Still unverified

- **Not on a device, and not in the wrapped builds.** This is Chrome at 393x852 with the safe-area
  insets emulated — the same harness the v1.4 numbers come from — not WebKit, not a phone.
- `artifacts/` was **not** rebuilt: the APK and the IPA in there are the v1.4.0 builds, which still
  carry this defect. The fix is web-payload-only, so a rebuild is all it needs, but nothing in this
  card built or installed one.
- The check reads *the palette the app applied* and the CSS variables it set. It does not read the
  rendered pixels, so "the screen looks like the cover" is still an eye test.

## 13. v1.5 — the swipe pager, the settings box, and the first lyric line (2026-10-11)

What he asked for: the settings screen must stop moving under his finger, the first lyric line must
stop hiding behind the top of the panel, and the now-playing screen should be three screens he can
swipe between — playlist, spectrum, lyrics — with the next one *pulled* in rather than cut to.

Two engines, and they answer different questions:

- **Chrome at 393 x 852** (`tools/layout-audit.mjs`, every route, both now-playing modes) — where the
  *cause* lives. It reports the computed `font-size` of every control it focuses, and it now reports
  the focused state's own horizontal overflow.
- **Safari, iPhone 15 Pro, iOS 18.7** (`tools/device-probe.mjs --scenario focus`, real WebKit, 393 x
  852, dpr 3) — where the *effect* lives. Chrome never performs an iOS focus-zoom, so a Chrome run
  can name the offending size but cannot show the zoom; that needs this engine.
- **`tools/pager-check.mjs`** — the gestures, driven as real CDP touch events against the built app,
  and the app's own state read back (never by calling an internal function to fake a result).

### 13.1 The settings box that moved the screen

| | v1.4 (before) | v1.5 (after) |
| --- | --- | --- |
| the playback dropdown's focus size (Chrome, 393) | `15px` | `16px` |
| the (URL) box, the same | `15px` | `16px` |
| visual viewport while focused (Safari, real device engine) | not run — see 13.5 | `393x695` scale `1` -> `393x695` scale `1`, **zoom x1** |

iOS zooms a page in when a focused form control's text is under 16 px, and the zoom is the panning
he reported: the page stays 393 px wide the whole time (`documentElement.scrollWidth` = 393 before
and after focusing), which is why a width-only audit had been calling this screen clean. The fix is
the size, and the measurement that proves it is the *computed size* plus the visual viewport in
WebKit — a ratio of 1 is not a zoom, 1.07 would be.

Found while doing this, **not fixed**: with the box focused, the settings *scroll surface* still
carries `301 px` of horizontally scrollable content in WebKit (surface `393 -> 694 px`) while the
page stays 393 px and no element's rectangle leaves the screen. The probe extension that names the
element inside the scroller (`widestWhileFocused`) landed after this run, so the culprit is
unidentified rather than exonerated. Follow-up card: `t_16a5dbe5`. **It was named, measured and
fixed in §14.1** — it is the playback dropdown's own content, and the fix is one line of CSS.

### 13.2 The first lyric line

| | v1.4 (before) | v1.5 (after) |
| --- | --- | --- |
| first line's top vs the panel's top (Chrome, 393) | `+0.00 px` — in the 16 px faded band | `+18.00 px` — past it |
| first line, Safari (real engine, 393) | not run — see 13.5 | panel top `56 px`, line top `74 px`, `firstLineInFade: false`, `firstLineFullyInside: true` |

The fade at the top of the panel is where the words disappear; a line at `+0 px` is inside it, which
is the "clipped" he saw. The panel's own scroll now opens with the first line clear of it.

### 13.3 The pager — one run, 27 checks, nothing failed

`node tools/pager-check.mjs --url http://127.0.0.1:4641 --json /tmp/v15-pager6.json` (393 x 852,
dpr 3, real touch events). The two behaviours that carried the risk:

- **The axis lock.** A mostly-vertical drag on the playlist, measured with 200 px of sideways travel
  in it: the list scrolled and the pager stayed at `position 0, offset 0`, with **no transform
  written at all** (`translate.list 0, overlay 0, strip 0`). Half a screen of sideways travel turns
  no page.
- **The pane follows the finger.** Over the drag's five samples the panes moved `1.09, 1.18, 1.27,
  1.36, 1.45` pane-widths — the finger's own travel, monotonic — and the strip's transform matched
  that travel to **0.00 px** (worst pane error `0.15 px`). The two panes always met edge to edge
  while the finger was down (no gap, no overlap, the window still covering the screen).
- **The swipe map.** From the spectrum, left is the lyrics (`#/now/lyrics`), left again is the
  playlist he came from (`#/playlist/pl-stress-long`), right from the spectrum is the playlist,
  right from the playlist is the lyrics — the ring turns both ways. The route follows the pane.
- **Commit on velocity, not distance.** 0.2 pane-widths released slowly snaps back to the pane it
  started on; the same 0.2 pane-widths released fast (34 ms, offsets `2.07 -> 2.13 -> 2.20`) turns
  the page.
- Also checked in the same run: the (x/y) line, the transport, the pill and the progress bar are all
  hit-testable **mid-drag** (each lands on itself, not on the strip); the pill slides the strip
  through the same pager instead of cutting; back from the lyrics is the spectrum and forward
  returns to it; the lyric highlight keeps advancing while the finger is down (advanced by seeking
  the real media element, not by calling a function in the app).

### 13.4 The lyrics themselves — look and say

From the same run, on a 36-line sidecar (16 lines fit the panel):

- the highlight followed the song for all **36 of 36** lines, and the panel never scrolled past its
  own end (worst `scrollTop - maxScroll` = `-38 px`, i.e. never overscrolled);
- it **leads by one line**: for every lit line the upcoming one was already fully on screen, so the
  line he is about to hear is visible when the current one lights up;
- a hand scroll of `-49 px` was **left alone** — the auto-scroll did not pull it back while the
  song played on — and the follow resumed once the grace ran out.

### 13.5 Not verified — read this before trusting the numbers above

- **The v1.4 side of the device pair was never run.** The before/after WebKit pair was abandoned
  when the card was timeboxed, so the *device* readings above are v1.5-only; the v1.4 numbers in
  13.1 and 13.2 are Chrome's, which is enough to name the cause but not to show the zoom.
- **No device run of the pager at all.** Every gesture number above is Chrome-driven CDP touch
  events at 393 x 852. Real-finger behaviour on iOS — particularly the axis lock against Safari's
  own back-swipe — is reasoned about, not measured. Follow-up card: `t_16a5dbe5`.
- **Landscape and the iPad are out of scope** of every run here.
- One more honest note: the v1.4 device log on disk still shows the old failure
  (`the layout probe did not load`), including one attempt that died on a backtick inside a comment
  in the probe's own bootstrap. That is fixed (`--scenario focus` runs), but its re-run did not fit
  this card.

### 13.6 A note on the cost of proving this

Most of this card's wall clock went into verification scaffolding rather than the release: a new
409-line harness, a probe extension, and a device pair that was designed, debugged and then dropped.
The lesson to carry: for a card of this shape the check budget is about **ten minutes using the
harnesses that already exist** — `pager-check.mjs` already covered the axis lock and the swipe map,
and its one run is what §13.3 quotes. New scaffolding is only worth it when an existing harness
*cannot* express the risk.

## 14. v1.5 follow-up — the 301 px named, and the gestures on a device (2026-10-11)

The v1.5 card left three things: a measured 301 px with no element named, gestures that had never
run in the shipping engine, and the v1.4 half of the WebKit pair dropped. All three are below, each
with the command that produced it.

### 14.1 The settings screen's 301 px — the element, and the fix

The culprit is the playback dropdown itself:

| | measured (Safari, iPhone 15 Pro simulator, real WebKit) |
| --- | --- |
| `select.field.inline` (the playback preference) | box `363 px`, content `679 px` — **the box fits, the content does not** |
| its widest option | `669 px` of text — "Web Audio only — always the real spectrum (background playback depends on the platform)" |
| the app's scroll container `div#app > .view-scroll` | `393 -> 694 px`, i.e. `301 px` of sideways content |
| what a push actually does | `scrollLeft` reaches **`301 px`** — the settings screen really is draggable sideways |

Mechanism: `select.field` clamps the *box* (`max-width: 100%`) but WebKit does not clip the control's
*content*, and an unclipped overflow inside the scroll container is scrollable overflow. So the
screen the owner said he could still drag sideways was draggable, at 301 px, by a `<select>` whose
text is a sentence long.

`tools/device-probe.mjs --scenario settings-overflow` now answers this by *testing rules on the live
page in one run* (apply, re-measure, push, remove) instead of asking anyone to guess what WebKit
does. Measured candidates, all in the same run:

| rule applied to the live page | surface | push | verdict |
| --- | --- | --- | --- |
| **baseline, the shipping CSS before the fix** | `301 px` | `301 px` | the defect |
| `select.field { overflow: hidden }` | `0 px` | `0 px` | **the fix** (`src/styles.css`) |
| `select.field { overflow-x: hidden }` | `0 px` | `0 px` | also works; the one-directional form of the same rule |
| `select.field { contain: inline-size }` | `301 px` | `301 px` | no effect |
| `select.field { appearance: none }` | `301 px` | `301 px` | no effect — it is not the appearance |
| `.field.inline { width: 100% }` | `301 px` | `301 px` | no effect — the box was never the problem |
| `.view-scroll { overflow-x: hidden }` | `301 px` (geometry unchanged) | `301 px` by script | hides it from a finger, leaves the content overflowing. Not used: it fixes the symptom |
| `select.field { overflow: visible }` (the pre-fix control) | `301 px` | `301 px` | the control, below |

After the fix, the same run reports: surface `393 -> 393 px`, a push moves it **`0 px`**, and the
pre-fix control in the same run still measures **`301 px`** — so the zero is a measurement of the
settings screen, not a probe that has gone blind. `RESULT: the settings screen has nothing to drag
sideways.` (exit 0).

**Chrome cannot see this one.** The same `<select>` in Chrome reports `scrollWidth === clientWidth`
(`363 px`), the surface stays `393/393`, and a push moves it 0 — measured with a scratch probe
(`HeadlessChrome/154`, 393 x 852, dpr 3, safe-area insets). That is why the 393 px audit has been
green throughout while the phone was not, and why the guard for this lives in the device run: the
command above **fails** (exit 1, printout naming the element) while the surface carries sideways
content.

### 14.2 The gestures, in the engine that ships

`node tools/pager-check.mjs --device A0DAA171-263B-48EC-99B6-FCA0BCD299EC` — one run, in Safari on
the iPhone 15 Pro simulator, **9 checks, 0 failed** (`docs/layout-393-gesture-device-report.json`).

There is no CDP against a simulator's Safari and no WebDriver for it either, so the harness drives
the app's own listeners in the page: `TouchEvent`s dispatched at a finger's cadence
(`device-probe.mjs --scenario gesture` → `deviceGestureSweep()`), geometry read between moves with
the finger still down. `pager-check.mjs` judges the same readings with the same labels it uses for
Chrome (`judgeDeviceGestures`), so the two drivers answer the same questions.

| what was asked | measured on the device |
| --- | --- |
| a mostly-vertical drag turns no page | a **200 x 240 px** drag over the playlist: pager `position 0, offset 0`, the list transform **never written**, and `preventDefault` called on **0 of 4** moves — handed back untouched |
| the same over the lyrics | pane `2 -> 2`, finger travel `0` panes, `0 of 4` moves prevented |
| the pane follows the finger | offsets `1.089 -> 1.181 -> 1.270 -> 1.361 -> 1.450` (monotonic), worst error vs the finger's own travel **`0.2 px`** |
| the strip is transformed by that travel | strip x vs expected: worst **`0.0 px`**; spectrum.right vs lyrics.left and the window edges: worst **`0.00 px`** |
| the drag commits, route follows | rest pane `2` on `#/now/lyrics`, strip `-393 px` (one whole pane) |
| a short drag snaps back | a slow `0.12` panes over `375 ms` moved the pane and returned to pane `2` |
| a flick commits on velocity | the same `0.2` panes in `29 ms`, never past the 0.32 commit point, turned the page to pane `0` |
| the swipe map is the ring | `340→40`: pane `1` on `#/now` → pane `2` on `#/now/lyrics` → pane `0` on `#/playlist/pl-stress-long`; `40→340` right from the playlist: pane `2` on `#/now/lyrics` |
| the two screens tile while trading places | list.right vs now.left over all four ring drags: worst **`0.00 px`** |

What this path cannot show, stated plainly: the events go straight to the listeners, so an untrusted
gesture has **no default action**. The native scroll a real vertical drag produces is therefore not
reproduced here (Chrome's `Input.dispatchTouchEvent` run in §13.3 is where that half is measured),
and neither is Safari's own edge-swipe. `defaultPrevented: false` on every vertical move is the part
of the axis-lock claim this path *can* prove: the gesture is handed back untouched.

One measured difference between the two drivers, worth knowing before comparing numbers: the in-page
path runs at a finger's real cadence, so the shallow `0.12`-pane drag that Chrome's round-trip-bound
gesture releases slowly is here fast enough to commit on velocity. It is slowed down in the sweep
(`steps: 6, gapMs: 60`) so the check is about distance, which is what that check is for.

### 14.3 The v1.4 half of the WebKit pair, re-run (RED), and v1.5 beside it (GREEN)

`--scenario focus` against the v1.4 dist (`670502c`, built separately) and against this build:

| reading | v1.4 | v1.5 + this fix |
| --- | --- | --- |
| the playback dropdown's focus size | `15px` | `16px` |
| visual viewport while focused | `393x695` scale `1` -> scale `1`, **zoom x1** | the same, **zoom x1** |
| the settings scroll surface | `393 -> 657 px` (**264 px**) | `393 -> 393 px` (**0 px**) |
| its widest content | `select.field.inline`, `+279 px` | `select.field.inline`, `0 px` of surface overflow |
| the first lyric line | **`+0.0 px`** — in the faded band | **`+18.0 px`** — past it |

Two honest notes. First, the v1.4 run is RED for the reasons the v1.5 card fixed (the first lyric
line) and for the reason this card fixed (the surface), which is what a before/after pair is for.
Second, **the focus-zoom itself did not reproduce in this runtime**: the simulator now runs iOS 26.1,
where focusing a 15 px control left `visualViewport.scale` at 1 — so what is reproduced here is the
*size* (`15px`, the documented cause) and not the zoom the v1.5 card measured at x1.07 on iOS 18.7.
The 16 px change is unchanged by that; the zoom ratio is not re-confirmed on this runtime.

### 14.4 Still unverified

- **Safari's own edge-swipe on a real finger.** The in-page path cannot produce a default action, so
  whether a horizontal drag that starts at the very left edge is taken by the browser's back gesture
  before the pager sees it is still unmeasured. (§14.2 measures the app's half of the axis lock.)
- **The native scroll a vertical drag produces** — Chrome-measured (§13.3), not device-measured.
- **Landscape and the iPad**, as before.

### 14.5 Two harness bugs found on the way

Both in `tools/device-probe.mjs`, and both of the kind that make a measurement look absent rather
than wrong:

- The mock stores each post as `{ receivedAt, report }`; the driver read the wrapper as if it were
  the report. Every device run ended in **"no report arrived"** *after* the page had posted a full
  report — which is why §13.1's 301 px came with no element named: the field that names it was in a
  report nothing printed.
- Once that was fixed, the driver still read only the *newest* entry each time the count moved. The
  page posts its report and its next progress beat in the same millisecond, so the driver read the
  beat, stepped `seen` past the report, and waited out its whole timeout. It now walks every entry
  posted since the last look, in order.

## 15. v1.5.1 — the settings screen he could still drag sideways (2026-10-11)

The release for §14.1. v1.5 fixed the focus size but the settings screen was still draggable
sideways — 301 px of the playback dropdown's own content, which WebKit does not clip — so the owner
was still running a build that moved under his finger. This section is the release: the version
bump, the changelog entry, the two artifacts and the tag. It adds no measurement of its own; the one
it stands on is §14.1, and the source it ships was already committed as `11b6bcf`.

### 15.1 Tests, build, and the release payload measured in the engine that ships

```
$ npm run build      → dist/assets/index-UMqln3si.js   89.54 kB │ gzip: 31.08 kB
                       dist/assets/index-9geUir_A.css   12.10 kB │ gzip:  3.18 kB
$ npm run typecheck  (tsc --noEmit, clean)
$ npm test           ℹ tests 76  ℹ pass 76  ℹ fail 0   (75 → 76: the new v1.5.1 changelog assertion)
$ npm run test:layout ✔ the app has no horizontal overflow at 393 x 852 on any route, either mode
```

The pager flake was met twice and re-run three times: the first full run failed `test/pager.test.ts`
on `and it leads by one line` (34 of 35 lit lines), the second full run on that same check (24 of 35)
plus `a hand scroll is left alone`, and the isolated run **and** the third full run both passed — the
third one being the 76/76 above. Nothing in this diff touches the lyrics scroll (changelog text, four
version strings, and the CSS rule §14.1 had already fixed), and the same flake is recorded on v1.5's
own card, before any of this existed.

The release payload itself, in real WebKit — `node tools/device-probe.mjs --device A0DAA171-… 
--scenario settings-overflow` against this build's `dist/` (iPhone 15 Pro simulator):

```
the shipping rule set: surface 393 -> 393 px, overflow-x auto, a push moves it 0 px
the control (pre-fix rule, same run, same element): 301 px
RESULT: the settings screen has nothing to drag sideways.            (exit 0)
```

That is §14.1's reading, taken again on the release build. The re-run wrote
`docs/layout-393-settings-overflow-device-report.json` identically apart from the probe port and the
timestamp, so the committed copy of that report is left as it was.

### 15.2 What ships

- `CHANGELOG.md` and `src/ui/changelog.ts`: one `## 1.5.1 — 2026-10-11` bullet, in his terms ("The
  settings screen can no longer be dragged sideways … 301 px before, 0 px after"), free of the
  internal vocabulary the other sections are checked against.
- `test/changelog.test.ts`: the version list is now `['1.0' … '1.5.1']`, and a new test pins the 1.5.1
  section — its sentence, its numbers, and a ban list — the way the v1.4 and v1.5 sections are
  pinned. That is the +1 test.
- `package.json` 1.5.0 → 1.5.1; `android/app/build.gradle` `versionName "1.5.1"` / `versionCode 7`;
  `ios/App/App.xcodeproj/project.pbxproj` `MARKETING_VERSION = 1.5.1` / `CURRENT_PROJECT_VERSION = 7`
  (Debug and Release), the same way v1.5 did it.
- Branch `release/v1.5.1` off `release/v1.5`'s tip (fast-forwarded onto the fix, so the built commit
  is `11b6bcf` plus this card's release commit), pushed, with the annotated tag `v1.5.1` on the built
  commit. No existing tag was moved or force-pushed.

### 15.3 Artifacts

```
artifacts/Navilite-1.5.1-debug.apk      8,785,271 bytes   (v1.4: 8,782,355 — +2,916, +0.03%)
artifacts/Navilite-1.5.1-unsigned.ipa     869,342 bytes   (v1.4:   866,719 — +2,623, +0.30%)
$ aapt2 dump badging …Navilite-1.5.1-debug.apk  →  versionCode='7' versionName='1.5.1'
$ tools/build-ios-ipa.sh                        →  app version 1.5.1 (7), UIBackgroundModes[0]=audio
```

Every hashed asset in `dist/assets/` is byte-identical to its copy inside **both** archives (sha256 of
each member read straight out of the zip, so nothing was extracted to disk):

| asset | sha256 — the same in `dist/`, the APK and the IPA |
| --- | --- |
| `index-UMqln3si.js` (89,546 B) | `524ae08be2489d4131aac27b26f7d9f8969a6fb7c5d4602c970d7ba55e1e8534` |
| `index-9geUir_A.css` (12,103 B) | `02f4872c03d9471184863f8d0650efffd82eab439d086567fe9881741ffdc4a3` |
| `base-Ilm-LlNj.js`, `esm-B7L2JGfO.js`, `esm-vQC5DiGm.js`, `native-3kB3u6fK.js`, `web-CdZqwKzK.js`, `web-DFsRYH62.js` | `acf4a23f…`, `f6f45b77…`, `743acba7…`, `1aae361a…`, `10abf09e…`, `01f9c175…` |

The fix is in the shipped stylesheet, not only on disk —
`select.field{text-overflow:ellipsis;width:100%;max-width:100%;overflow:hidden}` is in
`index-9geUir_A.css` inside both artifacts — and the shipped chunk carries the new changelog text
(`can no longer be dragged sideways` is in `index-UMqln3si.js`), so the "What's new" page he opens
under Settings says 1.5.1 rather than 1.5.

Neither binary is in the repo (`artifacts/` is gitignored). Both were attached to the release card
`t_0caf0353`.

### 15.4 Still unverified

- **The APK on an Android device.** There is no Android device run for this release, and none for the
  ones before it: the Android half of this fix is the same stylesheet the simulator measured, and
  §12.6's note holds — Android's web view does not drag its own content the way WKWebView does.
- **The installed `.ipa` on the simulator.** The device run above loads the release `dist/` in
  Safari, not the app bundle: `--app` needs a build with `server.url` pointing at the probe port, and
  the release build deliberately has none. What ties the two together is §15.3's byte-identical
  payload, not a run of the installed binary.
- Everything else carries over from §14.4 unchanged: Safari's own edge-swipe on a real finger, the
  native scroll a real vertical drag produces, landscape, and the iPad.

## 16. `tools/spectrum-proof.mjs`, re-baselined — the tool, not the player (2026-10-15, v1.9.19)

Found while verifying v1.9.19 (card `t_e62d2b6b`, filed from the review of the offline fixes, which
are untouched by this). §10.4's pixel criterion had stopped being true of every build since v1.7.4,
while the repository still documented the check as green. What follows is the reproduction, the
bisect, and the re-baselined criterion; the decision itself is in `DECISIONS.md`.

**Reproduced here first** — `node tools/mock-subsonic.mjs --port 4599 --stress`, then
`node tools/spectrum-proof.mjs --url http://127.0.0.1:4599` against the shipped `dist/` (built from
ac12206):

```
playing:  30575 lit pixels
+50 ms:   32603 lit pixels — 106.6% of the loud frame (informational: pipeline latency)
+160 ms:  10212 lit pixels
+240 ms:   5278 lit pixels · DIFFERENT from +160 ms
RESULT: FAIL — something of an earlier frame is still on screen.
```

The same shape on the pre-fix v1.9.18 (17995e4, its own worktree on its own port): 29939 lit while
playing, 6763 at +160, 3067 at +240, and a tail still moving at +320 / +400. So this is not the
v1.9.19 change and not a loaded machine — it is what the tool asks of the bars.

**The window was right and the bars moved under it.** A fourteen-sample curve out to +2 s
(`tools/spectrum-tail.mjs` — the curve tool added with this, which reports the whole tail rather than
judging a window; same mock, same mock library), on the shipped build:

```
+ 160 ms:   7184 lit px   23%    prev-ratio 2.65  DIFFERENT
+ 240 ms:   2501 lit px    8%    prev-ratio 2.87  DIFFERENT
+ 320 ms:   1337 lit px  4.3%    prev-ratio 1.87  DIFFERENT
+ 400 ms:    668 lit px  2.1%    prev-ratio 2      DIFFERENT
+ 480 ms:    668 lit px  2.1%    prev-ratio 1      identical to previous
+2000 ms:    668 lit px  2.1%    prev-ratio 1      identical to previous
```

A constant ratio of ~2.5 per 80 ms reading is an exponential with a ~0.1 s time constant —
`RELEASE_S = 0.1` in `src/player/visualizer.ts`, the v1.7.4 release envelope the owner asked for
(*"Pausing should cause the spectrum to gracefully all drop to zero"*). Its endpoint is 668 px, which
is 64 bands × the 1 px minimum rectangle: the analyser is at digital silence and what is left on
screen is exactly the "no bar" rectangle per band. Nothing is being carried over from the loud frame
— the *tail* is the envelope, and the envelope is deliberate. The last pixel change after a mute is
the last bar leaving the floor, so it moves between runs: +480 ms in one, +560 ms in the next, both
on v1.9.19 — which is where the judgement window comes from, not from the +160/+240 readings.

**Bisect, with the tool as the test.** `git bisect run` between v1.2 (f9fd6e5, good) and ac12206
(bad), each commit built in a scratch worktree and served on its own mock port; the harness maps the
tool's exit 0 to good, exit 1 to bad, anything else (a commit that cannot build or run) to `skip`:

```
Bisecting: 29 revisions left to test after this (roughly 5 steps)
---- d0b5c9e exit=1   ---- ce92d3a exit=0   ---- 65f7046 exit=1
---- a22e6ff exit=1   ---- 4b6b7db exit=1   ---- 4bee9f9 exit=1
bisect found first bad commit
```

`4bee9f9` is **v1.7.4** — "the spectrum wears the album palette and stops shimmering; a pause settles
to zero instead of the placeholder" — the one commit in the range that adds the attack/release
envelope. v1.2 and v1.7.3 pass the old criterion; v1.7.4 and every later commit fail it.

**The re-baselined criterion**, and the controls that show it was not weakened. The judgement moved
to +900 ms and later (the envelope needs ~460 ms to reach its floor and the media pipeline can hold
the silence back by ~100 ms; the last pixel change observed after a mute was at +560 ms), compares
three readings half a second apart as PNGs rather than as lit counts, and adds a shape check on the
settled frame — one separated run of lit pixels per canvas column, nothing lit below the bars'
baseline. Every build below was built in its own scratch worktree and served on its own port; the
existing harnesses do the work (`tools/spectrum-proof.mjs`, `tools/mock-subsonic.mjs`), with the
shape facts added to the probe's `spectrumSnapshot(true)`.

| build | verdict | playing | +160 | +240 | +900 | +1200 | +1500 | settled frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1.9.19 (dist of ac12206), twice | **pass** | 30894 | 6054 | 2540 | 668 | 668 | 668 | 0 second runs, 0 below baseline |
| v1.9.18 (17995e4) | **pass** | 29939 | 6763 | 3067 | 668 | 668 | 668 | 0 / 0 |
| v1.7.4 (4bee9f9 — first bad commit) | **pass** | 22035 | 8922 | 4120 | 1233 | 1233 | 1233 | 0 / 0 |
| v1.2 (f9fd6e5) | **pass** | 21665 | 1277 | 1277 | 1277 | 1277 | 1277 | 0 / 0 |
| v1.1 (its `visualizer`+`engine` over v1.2) | **fail** | 20631 | 5713 | 2360 | 1246 | 979 | 922 | 118 second runs, loud frame 84 below baseline |

The v1.1 row is the control that matters: the tool still fails the build whose report it was written
for, on two independent counts (its bars never stop drifting, and what it leaves behind is bars with
a cap/reflection above them). Its failure reason in one line: *"FAIL — the bars were still moving a
second and a half after the audio went quiet; the frame left behind is not flat bars (118 columns
with a second run, 0 lit pixels below the baseline)."* What is **not** covered at pixel level is the
playing frame's own shape — that is asserted per frame in `test/visualizer.test.ts` (64 flat
rectangles, no caps, no reflections), and the pixel check would only re-derive it.

One correction found by the controls: distinct lit *colours* per column are not a usable shape fact.
The bars' bottom edge lands on `0.98 × height`, which is fractional on most canvas heights, so a
perfectly ordinary frame has one antialiased row blending the bar with the backdrop at two different
alphas — 629 such columns on the v1.2 build. Separated *runs* have no such ambiguity, which is why
the probe reports runs.

**Still not covered.** This reads the **streaming** spectrum — the mock's WAV through the web engine.
The local-file path (`playlistPath`/`localFile`, the v1.9.16/17 ground) is a different engine and was
not exercised by this check. Nothing here touched the v1.9.19 offline fixes: no `src/` file changed
in this work (`tools/` and this document only).


## 17. v1.9.20 — the downloaded-content surfaces (2026-10-16)

The design is `docs/design-downloaded-surfaces.md`; the decisions are in `DECISIONS.md` under 1.9.20.
This section is what was **run** here, and what was not.

**The harness, once, with the real assertions added to it.** `tools/offline-check.mjs` (the existing
1.9.18 harness) gained the design's §8.3 acceptance and was run against a built `dist/` with the mock
answering as a real Navidrome would:

```
$ node tools/mock-subsonic.mjs --port 4641 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4641 --online-playlist pl-stress-ja
```

25 checks, all green. The ones this release added, with what they reported:

| check | reading |
| --- | --- |
| no playlist name twice, server **up** | 4 rows, every name once (the failing baseline drew the playlist twice and tapped to the same id from both rows) |
| the downloaded playlist is marked on the server's one row | 1 marked row of 4 — `complete`, sub `3 tracks · 1:15 · 23.2 MB on this phone` |
| no playlist name twice, server **refused** | 2 rows: `Late night driving`, `Half downloaded` |
| a fully downloaded playlist reads downloaded | `complete`, `3 tracks · 10:42 · 23.2 MB on this phone` |
| a partially downloaded playlist does **not** read complete | `partial`, `3 tracks · 1 of 3 on this phone` |
| every downloaded track carries its mark, server refused | 3 of 3 rows marked, each with `, downloaded` on its accessible name |
| the covers come from the device copy, API refused | `http://127.0.0.1:4641/offline-art/cover-album-1-1.art` |
| `#/downloads` lists the downloaded tracks by title | `4 rows`, h1 `On this phone`, no playlist-shaped row |
| the cover drives the shell's palette, API refused | `--accent-primary` `#7cd2ff` → `hsl(262 85% 66%)` |
| neither view waits for a server that never answers | 3 rows in 32 ms; 4 rows in 2 ms (the app's own request timeout is 20 s) |

`npm test` (240 tests, including this harness run under `test/offline-views.test.ts`), `npm run
typecheck`, `node tools/spectrum-proof.mjs` (the +700 reading is now in the monotonicity chain) and
`xcodebuild` are all green. The IPA carries 1.9.20 (41) in its own `Info.plist`.

**The race this release found and fixed.** The new "one row per playlist" check waits for the
playlists screen to draw its rows — and was, intermittently, shown the *playlist page it had just
left*: a view that awaits the library paints after the await, so a slow answer wrote the old screen
over the new one (the list's subtitle inside the playlist page's header). `overtaken()` in
`src/ui/app.ts` guards the paint in the three views this acceptance depends on (the playlist page,
the playlists screen, the Library) and leaves the data work alone. The same class exists in the other
awaited views (`renderAlbum`, `renderArtist`, `renderFavourites`, `renderSearch`) and was **not**
touched here; it is the next card, not a claim of this one.

**Not verified here, and not claimed.**

1. **Art in the WebView.** That `Capacitor.convertFileSrc` renders a downloaded cover and yields an
   **untainted** canvas (`getImageData` succeeding) is a platform claim. The harness proves the app
   *asks for and samples the local copy* rather than the API's; the device path itself is the owner's
   to confirm, and it is the one thing that decides whether item 4's theming works offline.
2. **The native art lane end to end** — `URLSession` → staging → `<coverId>.art` → the index row →
   `list()`. Everything above `list()` is exercised against a bridge double in
   `test/offline-store.test.ts`; nothing below it can be run here. The Swift **compiles** (a green
   grep is not a compiler: this pass shipped one Swift error — `ArtRow(state:)` missing — that the
   source assertions could not see, and `xcodebuild` caught it).
3. **The migration on his phone**: that his 1.9.19 `index.json` and jobs still decode against the new
   optional fields, and that his existing downloads still play. Source-level claims only.
4. **What `getCoverArt?size=512` returns on his instance** (bytes, format, whether an original is
   passed through whole). `ART_ASSUMED_BYTES` is a bound asserted from the request.
5. **Background transfers of art** (the lane's own background behaviour, unchanged since 1.8.x).
6. **The 393 px layout with badged rows on the phone.** The harness measures overflow at 393 × 852 on
   every screen it visits, including the badged lists (0 px), but the device is the owner's.

## 18. v1.9.21 — a view he left does not paint over the one he is on (2026-10-16)

The defect, as filed by v1.9.20's own acceptance check: every view that awaits the library paints when
the answer arrives, and by then the router may already have drawn whatever the owner navigated to — so
a slow answer writes the old screen over the new one. v1.9.20 guarded the three views its acceptance
depended on (`renderPlaylist`, `renderPlaylists`, `renderArtists`) and left this card for the rest of
the class. **This change is unreleased**: no version, changelog or native version field is touched, so
no IPA/APK carries it yet — the release that does is a separate step, and it is what puts it on his
phone.

**What changed in `src/ui/app.ts`.** `overtaken(shell, route)` now guards the paint in `renderAlbum`,
`renderArtist`, `renderFavourites` and `renderSearch`. Each captures its route once, at the top of the
*render* — never per request, so a second Enter while the first search is in flight is still the same
render and its answer is a current one and lands. The same guard went into the router's own failure
fallback (`fail`): a *rejection* is a paint too, and one that lands after the owner has moved on used
to replace his screen with an error box about the one he left. Data work stays unguarded.

**The driver.** `tools/mock-subsonic.mjs` gained `GET /__slow?ms=N` — every API answer is held for N
milliseconds and `/__state` reads the hold back (static files, `/offline-art/`, the lyrics sidecars and
the debug endpoints are *not* held; `/__reset` clears it). That is the one thing the check needed: a
slow answer that is slow on purpose, every time, rather than by luck. `tools/offline-check.mjs` gained
a fifth block that uses it, with five cases: the album page, the artist page, Favourites, Search, and
the router's failure fallback (an album id the library does not know, i.e. an error that lands late).
Each case is run twice:

- a **control** that visits the route and stays — the held answer must draw that page, because a view
  that never paints cannot paint over another one;
- and the case itself: ask for the view, walk to `#/downloads` **250 ms** later (the answer is held for
  1800 ms), then read the screen once the answer has certainly landed.

A sixth check drives the caution the card raised: a search that is *still* the screen is left alone
until its answer lands, and a second Enter is sent while the first is in flight — the guard is keyed to
the render, not to the request, so both answers are allowed to land. (That one passes on **both**
builds by construction: it protects the current search, it does not detect the defect.)

`#/downloads` is the destination on purpose: it is drawn from the store alone, so it is on screen
immediately and stays put while the library is slow, and a reading of it is unambiguous. Every case
boots cold before it is raced — `state/library.ts` caches an album, an artist and the starred set for
the session, so a second visit inside one page load answers from memory and lands before anyone could
leave (that is what would make this check pass on nothing).

```
$ node tools/mock-subsonic.mjs --port 4673 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4673 --online-playlist pl-stress-long
```

**RED — the same check against the build the card was written on** (`dist/` built from aa8874f, before
any of this change): **30 ok, 4 FAIL**. What the screen read, 2.5 s after the route was left, while the
address said `#/downloads`:

| case | the reading |
| --- | --- |
| album page | heading **“Alien Lab — Quiet Hours”**, 4 song rows, an album header and cover drawn |
| artist page | heading **“Alien Lab”**, 2 album cards, 0 song rows |
| Favourites | heading **“Favourites”**, “0 tracks · 0 albums · 0 artists”, “Nothing starred yet…” |
| router's failure fallback | an error box: “the requested data was not found: Album not found” |
| Search | **passed** — see finding 1 below |

**GREEN — the same run on the fix**: **34 checks, 0 failures**. Every one of the five reads `#/downloads`
intact — h1 “On this phone”, the four downloaded rows, and none of the old view's parts on it. The
controls drew the held answer at 1856 / 1815 / 1812 / 1808 / 1809 ms, i.e. the same answer this block
then holds open is one that does paint when it *is* the view.

`npm test` (240 tests, 0 skipped — including this harness run under `test/offline-views.test.ts`, which
asserts every check the harness reports) and `npm run typecheck` are both green. No test file and no
store-level suite was touched: the whole change is the four paints, the router's fallback, and the two
tools.

**Two findings the check made, left in this record rather than papered over.**

1. **Search cannot corrupt the screen, with or without the guard.** The guard is applied to it (as the
   card asked — one rule, uniformly), but `renderSearch` paints into the results host its *own* render
   created, and the next render's `pageTitle`/`replace` has already detached that node, so a stale
   answer lands somewhere nothing shows. The RED run above is the evidence: Search passed there too.
   The guard stays, and the check states that it cannot fail rather than implying that it can.
   `renderAlbums`' `load()` is the same shape (its paint target is its own `listHost`) and is left
   alone for the same reason: there is no defect to fix there.
2. **The router's failure fallback was broken in the same way, and the card did not name it.** Case 5
   of the RED run is a *rejection* that arrives late, and it replaced the destination with its error
   box. Same class, one caller further out, so it is guarded now — and the check covers it.

**Found while doing this, and not fixed here** — the suite's own reliability, because this block added
browser work to it:

- `test/pager.test.ts` failed on **4 of the 17 full `npm test` runs** made here, always with the *same*
  single symptom: `page threw: Error: timed out waiting for the stress album`. That is its step 9
  waiting `PATIENCE_MS` = 20 s (`tools/layout-probe-browser.js:31`) for the stress album's rows, and
  the flake is already documented in this repository twice — §14.5 ("the pager flake was met twice and
  re-run three times") and `tools/pager-check.mjs:798-807`, which names *the suite's parallel load* as
  its cause. The pre-change build (aa8874f, `dist/` rebuilt from it) was green **6 of 6** in the same
  session. What this release changed about that: the offline harness now runs ~20 s longer (12 boots,
  five held answers), so it overlaps the pager's step 9 where it did not before; the *peak* load is
  unchanged. The 34 checks of this harness never failed in any of those runs, and none of the failures
  reproduces standalone (`node --test test/pager.test.ts` passes on this build).
- One **300 s hang** of this harness was seen once under that load (no report written — the output is
  buffered until the end, so a hang prints nothing). Every call this harness makes to the *mock* is now
  bounded (`mockFetch`, 10 s), which covers a stalled connection and turns it into a named error. A
  wedged *renderer* is still uncovered: `Cdp.send` (`tools/layout-audit.mjs:70`) has no timeout.
- Related: four headless Chrome instances from earlier runs were still alive on this machine, one of
  them 17 hours old and holding remote-debugging port 9725 — inside the range `withChromePage` picks
  from (`9500 + random(400)`), so an orphan can collide with a fresh harness. Nothing here was changed
  to prevent that.

Neither the pager's patience nor the shared browser plumbing is this card's to change: both are filed
as follow-up rather than edited under a race fix.

**Not verified here, and not claimed.**

1. **His phone, and his link.** Everything above is Chrome at 393 × 852 on this Mac against the mock;
   the slow answer is the mock's own hold, not his relay. What is reproduced is the shape of his
   situation — a library answer that takes longer than his patience — not his network, and not the
   WebView.
2. **The parts of the class this card did not touch**: `renderAlbums`' `load()` (finding 1) and the
   per-track download marks' in-place repaints are unchanged.
3. **No artifact.** See the note at the top of this section: unreleased.

Raw runs behind the two tables: `offline-check-RED-v1.9.20-build.txt` and `offline-check-GREEN-fix.txt`,
attached to this card (t_8de0bddf).

## 19. v1.9.21 — the two gaps v1.9.20's acceptance review left (2026-10-16)

Filed by that review (card t_4009b23a, from t_5581b678) as the two places where v1.9.20's item 2
("honest for a partial") and item 3 ("there whether or not the server answers") were not fully met.
Both are in `src/ui/app.ts`; both land **unreleased**, on the branch §18 is on — no version bump,
changelog entry, tag or IPA is part of this, so nothing carries it to his phone yet.

**Fix 1 — a grown playlist's row prints the playlist's own length as its denominator.** `badge.total`
is the manifest's length (what was *asked for* when the playlist was downloaded); the row is drawn
beside the playlist the server has just described, which may be longer. `downloadedFigures()` is now
the one place that pair comes from (`{ done: badge.done, total: Math.max(badge.total, songCount) }`),
and **both** the sub-line (`playlistSubLine`) and the accessible name (`playlistRowLabel`) read it, so
the row and VoiceOver say the same numbers. The playlist page's own control's grown label moved into
`grownControlLabel()` (same string, one function) so the two screens can be asserted against each
other rather than against two spellings of the same arithmetic. The numerator is untouched: complete
files among the manifest's songs.

**Fix 2 — the Library's "On this phone" entry row survives the offline page.** `renderOffline` now
appends `downloadsEntryRow(ctx)` above the store's playlist rows when `head === 'artists'`: one list,
no second rows list, and the transport's text is still not rendered. The card's second option (let
the Library keep its own header + entry row on the unreachable path) was not taken — see the
`DECISIONS.md` entry for 1.9.21.

**Fix 1, measured on the built app, before and after.** A throwaway probe (agent scratch, not added to
the repository — the card said no new harness) seeded the app's own offline mirror with a manifest of
**34** tracks for the server's own 35-track playlist, with the server answering — the owner's shape,
one track added to a playlist he had downloaded. It read the Playlists row and then the playlist's own
page, in the same session, on `dist/` built from the same source with only this fix missing:

| | playlists row (`sub` / `aria-label` / mark) | the same playlist's own page |
| --- | --- | --- |
| **before** (build of a0d296e) | `35 tracks · 34 of 34 on this phone` / `…, 34 of 34 downloaded` / `partial` | `34 of 35 · retry` |
| **after** (this change) | `35 tracks · 34 of 35 on this phone` / `…, 34 of 35 downloaded` / `partial` | `34 of 35 · retry` |

One playlist, one pair of numbers after the fix; the reviewer's reproduction (`3 tracks · 1 of 1 on
this phone` against `1 of 3 · retry`) is the same defect at a smaller size.

**The same figures, asserted in `test/offline-browse.test.ts`** (the card's test, extended): the grown
case's sub-line and accessible name are asserted as strings, and the pair the row prints is asserted
against the pair `grownControlLabel` prints for that playlist (`2 of 3 on this phone` vs `2 of 3 · retry`
on a 2-of-3 store). The test now imports the row's own formatters from `src/ui/app.ts` — which has no
module-scope DOM access (`boot()` is what draws), so a node test can read the real format strings
instead of restating them. A second test covers the transient cousin the card named: a playlist whose
audio has all landed while a lyric is in flight (`done === total`, state `downloading`/`partial`), grown
to four tracks, prints `4 tracks · 2 of 4 on this phone`. **RED** for those two assertions, with the old
denominator restored in `downloadedFigures` (then reverted), was exact:

```
✖ the badge is read from complete files, and a grown playlist is never called complete
  actual: '3 tracks · 2 of 2 on this phone'   expected: '3 tracks · 2 of 3 on this phone'
✖ a grown playlist with a lyric still in flight prints the playlist’s own length as well
  actual: '4 tracks · 2 of 2 on this phone'   expected: '4 tracks · 2 of 4 on this phone'
```

**Fix 2, measured in the harness, before and after.** Two checks were added to the v1.9.18/1.9.20
harness's library-offline reading — the entry row is on that screen (title, sub-line, accessible name,
and the list it shares with the downloads), and tapping it opens `#/downloads`. Both are *answered*
rather than thrown when the row is missing, so a RED run reports two failures instead of dying in a
`waitFor` and hiding the rest of the run.

```
$ node tools/mock-subsonic.mjs --port 4683 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4683 --online-playlist pl-stress-long
```

| | `#/artists` with the API refused | harness result |
| --- | --- | --- |
| **RED** (build of a0d296e, checks present) | h1 `Library`, "no connection to your library", **2** rows — `Late night driving`, `Half downloaded`; `its entry row: NOT DRAWN` | 34 ok, **2 FAIL** ("the offline page carries no entry row at all"; "no row to tap") |
| **GREEN** (this change) | 3 rows, the entry row first: `“On this phone” — “4 tracks · 31 MB” (Open On this phone)`, in the same list as the downloads | **36 checks, 0 failures**, exit 0 |

`npm test` **241/241** (0 skipped, exit 0 — the new store test, and `test/offline-views.test.ts` drives
the harness and asserts every check it reports plus the new readings: the entry row on the offline
page, the list it is in, the address it opens and the tracks on that view), `npm run typecheck` clean,
and `npm run build` clean (a `dist/` rebuilt from the fixed source is what every GREEN reading above
ran against).

**Not verified here, and not claimed.**

1. **His phone.** All of the above is Chrome at 393 × 852 on this Mac against the mock, with the app's
   own offline mirror seeded the way the suite seeds it; the refused port is a refused port, not his
   radio.
2. **The grown case in the browser, as a *committed* check.** The harness's own fixtures cannot carry
   it without dismantling v1.9.20's item-1 acceptance (the server's playlist row must stay `complete`
   for "the downloaded playlist is marked on the one row the server draws for it", and an extra store
   playlist would change the offline row counts those checks assert). So the browser reading above came
   from a throwaway probe and the durable assertion is the node test — stated rather than implied.
3. **No artifact.** See the note at the top of this section: unreleased, so no IPA/APK carries this.

Raw runs: `offline-check-RED-v1.9.21-leftovers.txt`, `offline-check-GREEN-fix.txt`, `npm-test.txt` and
`grown-row-probe.txt` (both probe readings), attached to this card (t_4009b23a).

## 20. v1.9.21 — the release that carries the race guard and the two review leftovers (2026-10-16)

§18 (`a0d296e`) and §19 (`7453ebd`) are the fixes; both were on `main` and **unreleased** when they were
written, and both said so. This is the cut that stamps and ships them, and it is one release carrying
those two commits and nothing else. What is new here is only what a release adds: the version, the
evidence for the release as a whole, and the artifact.

**What was run, once each, against a `dist/` built from the fixed source.**

```
$ npm run build                 # tsc --noEmit && vite build — 43 modules, dist/ in 57 ms
$ npm run typecheck             # clean
$ npm test                      # 241 tests, 241 pass, 0 fail, 0 cancelled, 0 skipped, 39.3 s
$ node tools/mock-subsonic.mjs --port 4683 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4683 --online-playlist pl-stress-long
                                # 36 checks, 0 failures, exit 0
$ node tools/spectrum-proof.mjs --url http://127.0.0.1:4683
                                # exit 0
```

`npm test` is the release check as well as the suite: `test/changelog.test.ts` compares `CHANGELOG.md`
with `src/ui/changelog.ts` item for item and asserts the version list ends at 1.9.21, so a bump that
touched only part of `docs/VERSIONING.md` §3's list fails there. Nothing was skipped (0 skipped, so no
browser fixture opted out), and `test/pager.test.ts` — the file that carries the flake the neighbouring
card filed — passed inside the run (38.9 s of the 39.3 s).

**The harness's 36 checks, on this release's build.** The block is §18's five race cases with their
controls and the second-Enter check, plus §19's two Library-offline checks. What the screen read, 2.5 s
after the route was left, on the five cases this release exists for — every one of them drawn from the
answer the block then holds open, which is the control that makes the readings mean anything:

| case (answer held 1800 ms, left 250 ms in) | the reading |
| --- | --- |
| album page | still `#/downloads` — h1 “On this phone”, 4 rows, no album header, cover or song rows |
| artist page | still `#/downloads` — 4 rows, no artist header and album cards |
| Favourites | still `#/downloads` — 4 rows, no Favourites header and sections |
| Search | still `#/downloads` — 4 rows, no Search header and result sections |
| the router's failure fallback (an album id the library does not know) | still `#/downloads` — 4 rows, **no error box** |
| a second Enter while the first search is still held | h1 “Search”, 2 cards, 0 song rows — the guard is keyed to the render, not the request |
| the Library's “On this phone” row, API refused | on the offline page too, in the same list as the downloads, tapping through to `#/downloads` |

**The spectrum proof** — this cut changes no player code, and it was run anyway so that the release's
own evidence is whole: 29804 lit pixels while playing, then **668** at +700 / +900 / +1200 / +1500 ms,
the last three byte-identical, 0 columns with a second run of lit pixels, 0 lit below the baseline.

**The artifact.**

```
$ bash tools/build-ios-ipa.sh
built  artifacts/Navilite-1.9.21-unsigned.ipa
bytes: 1,026,541          (v1.9.20: 1,026,082 — +459, +0.04 %)
app version 1.9.21 (42), UIBackgroundModes[0]=audio
```

Read out of the archive itself, not out of a source file:

```
$ unzip -p artifacts/Navilite-1.9.21-unsigned.ipa Payload/App.app/Info.plist \
    | plutil -p - | grep -E 'CFBundleShortVersionString|CFBundleVersion'
  "CFBundleShortVersionString" => "1.9.21"
  "CFBundleVersion" => "42"
```

Every hashed asset in `dist/assets/` is byte-identical to its own member inside the IPA (sha256 of each
member read straight out of the archive), so the shipped bundle is a fresh build of the released tree:

| asset | sha256 — the same in `dist/` and in the IPA |
| --- | --- |
| `index-BeHJDgul.js` (192,463 B) | `e65b2a944e1e404a6af6ebe10301c3e0eae0783fab9de5e32f3a576e434c37cf` |
| `index-F6_Re_h1.css` (14,005 B) | `9316db8712117f190a34005bf1ba3f0221eab5aeb3ee32c61056932c35b522ef` |
| `base-DHtd_KoX.js`, `esm-Bhol3Z4j.js`, `esm-CB2XQsFD.js`, `native-ByBeX_iW.js`, `web-BN6ndMGc.js`, `web-Dsf-jfFA.js` | `e5208356…`, `779d5e9c…`, `2baeee1d…`, `4ad2c4b0…`, `efea2507…`, `308e8bc1…` |
| `sw.js` | `9ee133a51619bb69299c434daaf54e4b8f611a36dfeba61730c5faba3e9fdf59` (stamped `a5bb600`, the commit it was built from) |

The previous release's chunk was `index-jr7GwDk1.js` (190,985 B, sha256 `62b3ff94…`), so this is not
v1.9.20's bundle — and the new code is *in* it: `index-BeHJDgul.js` carries the guard itself,
`function Q(e,t){return e.viewRoute!==t}`, at **10 call sites** (counted in the minified file: the
definition plus ten calls), which are the ten `overtaken()` sites in `src/ui/app.ts` — and the
harness's five race cases above pass against that same `dist/`. The changelog's own sentences
(`A slow answer can no longer draw itself over the screen you are looking at.`, and `34 of 35`) are in
there too, but they say only that the *changelog* shipped: they are written once and grow with every
release. The call sites are the guard.

**Order of operations, and what was built.** The release body was committed first (`a5bb600`), then
`dist/` was rebuilt from that commit and the IPA made from it — `docs/VERSIONING.md` §6's order, and one
deviation from the sequence v1.9.20 used, where the artifact preceded the commit and so carried the
*parent's* short SHA inside `sw.js` (`648b3e4`, checked in that IPA). The evidence build (before the
commit) and the shipped build (after it) are byte-identical in every asset in the table above; only
`dist/sw.js` differs between them, which is exactly what that file is for. Counts for the whole cut:
**two `vite build`s** (one for the evidence, one after the commit for the artifact) and **one
`xcodebuild`**; one `npm test` run, one harness run, one spectrum-proof run. The tag `v1.9.21` sits on
`a5bb600`, the commit the IPA was built from; this section is the one commit after it, written from that
build's readings.

**Not verified here, and not claimed.**

1. **His phone.** Everything above is Chrome at 393 × 852 on this Mac against the mock: the slow answer
   is the mock's own hold, the refused port is a refused port, and the WebView is untouched by all of it.
2. **The installed IPA.** It is unsigned on purpose (§15.4, `docs/ios-sideload.md`); the sideload and the
   7-day re-sign are the owner's own steps, and nothing here runs the app on a device or a simulator.
3. **The suite's determinism.** Not in this cut: `t_744cba0b` (the pager check's 20 s patience under
   `npm test`'s parallel load) is parked at the owner's request and its fix is uncommitted in that card's
   workspace. One green `npm test` is **one** run — §18's 4-in-17 reading still stands as the size of
   that flake, and nothing here says it is gone. `npm test` itself is unchanged.
4. **Android.** No APK was built for 1.9.21 (`versionCode` is bumped to 41 so that the next one carries
   it), so nothing here is evidence about the APK, and the guard's behaviour in Android's WebView is the
   same unmeasured class as §18's note 1.
5. **The one awaited paint §18 left alone** (`renderAlbums`' lazy `load()`) — unchanged, and named in
   `DECISIONS.md` for 1.9.21 rather than left to look like an oversight.

Raw runs behind the tables and the counts (agent scratch, attached to the release card `t_15b0a5c5`):
`npm-test.txt`, `offline-check-1921.txt`, `spectrum-proof-1921.txt`, `assets-build1.txt`,
`assets-build2.txt`.

## 21. the suite's own determinism — the port two test files shared, and the harness plumbing (2026-10-16, unreleased)

Card `t_744cba0b`, filed by §18's verification. The symptom was `test/pager.test.ts` failing inside `npm test`,
always with one reason — `the run reached the end of its checks — page threw: Error: timed out waiting for the
stress album` — while the same file passed standalone and the pre-change build had been green 6 runs out of 6.
This section is the fix. It is also a **correction of this record**: §14.5 and §18 both filed that flake as a
*load* phenomenon — "a starved renderer under parallel load can miss 20 s" — and it was not one. The library the
pager check was driving was not the pager test's own, and the test that owned it killed it a few seconds in.

### 21.1 The finding: one port, two test files, and a probe that cannot tell their mocks apart

```
$ grep -n "const PORT" test/pager.test.ts test/palette-apply.test.ts
test/pager.test.ts:38:const PORT = 4615;
test/palette-apply.test.ts:33:const PORT = 4615;
```

Both files spawn `tools/mock-subsonic.mjs --port 4615 --stress` with `stdio: 'ignore'`, and both then wait for
`/rest/ping.view?u=navidrome&p=navidrome&…` to answer — the *same* request, answered identically by either mock,
because both are `--stress` mocks of the same library. So when one `npm test` starts both:

- the file whose mock loses the bind dies of `EADDRINUSE` before it can listen, into a stdio nobody reads: there
  is no line anywhere in the run that says so;
- the winner's mock answers the loser's readiness probe, so the loser's check drives a library that belongs to
  another test file;
- and when that file finishes, its `finally` SIGKILLs the library the *other* check is still using.

That is asymmetric, which is why the flake was always the pager's and always the same message.
`test/palette-apply.test.ts` runs for **3.0 s** (its check is short) and `test/pager.test.ts` for **35.9 s**, so
whichever mock lost the bind, the *pager* is the run that outlives the library. §18's 4-failures-in-17 reading is
the fraction of runs in which palette-apply's mock won the bind.

### 21.2 The reproduction, on the pre-change tree (`9a2490b`, the `dist/` this suite's browser tests use)

Each row is `node --test test/pager.test.ts` alone, with a mock this section started itself on 4615 — which is
exactly what the neighbouring test's mock is to the pager test:

| the squatter on 4615 | what the pager test did |
| --- | --- |
| left alive for the whole run | **passed**, 35.9 s — and the whole API session was served *by it*: its own `/__state` logged 29 REST calls, from the boot through the album, the stream, the scrobbles and the saved play queue. That is the proof that the check was not talking to its own mock. |
| SIGKILLed ~3 s in | **failed**, 43.8 s — the card's own message, with two checks above it: |

```
✖ the swipe pager pulls its panes, and never takes a scroll
  AssertionError: the pager check failed:
  FAIL  and the drag seeks the track to the proportion it was dragged to
  FAIL  the lyric highlight still advances while the finger is down
  FAIL  the run reached the end of its checks
    - the run reached the end of its checks — page threw: Error: timed out waiting for the stress album
```

The two checks above the fatal one are the "one FAIL or several" the card could not account for: they read the
audio's own numbers, so a library that has gone takes their readings with it. Step 9
(`tools/pager-check.mjs:759-763`) is where the run finally dies, because it is the first *wait* in that run that
needs a fresh answer for a page that is not already drawn.

The 20 s patience was therefore never the mechanism, and could not have been: a longer one fails just as
completely, because the library is gone — and the page-state that the wait now reports is what would have said so.

### 21.3 What changed

1. **`test/support/mock-fixture.ts` (new) — a port the OS picks, tied to the child that reports it.** The mock is
   started with `--port 0` and prints a machine-readable `navilite-mock-port <n>` line **from its own listen
   callback**, so the number a test uses belongs to the process that test spawned and cannot be a number another
   file took. The fixture then reads `/__state` on that port, so "the child is answering" is a fact rather than an
   assumption, and a child that dies before listening (or reports a port nothing answers on) fails in
   milliseconds with the child's own output. All six browser-driven files use it — `layout-393`, `offline-views`,
   `pager`, `palette-apply`, `scroll-containment`, `slow-link-browser` — and **no test file names a port any
   more**. Sampled during a suite run, the mocks listen on OS-chosen ephemeral ports (`52272`, `52279`, `52422`,
   `52466`, `52505` in one run), none of them in the old `4611`–`4657` range.
2. **`tools/mock-subsonic.mjs` — `--port 0` is honoured, and a failed bind is a named line.**
   `mock-subsonic could not bind 127.0.0.1:4611 — EADDRINUSE listen EADDRINUSE: address already in use
   127.0.0.1:4611`, exit 1 — printed, rather than an unhandled `'error'` event lost in a captured stdio.
3. **`tools/layout-audit.mjs` — the plumbing the card's third point named.** `Cdp.send` has a deadline (60 s,
   `NAVILITE_CDP_TIMEOUT_MS`); a socket that closes or errors rejects every call it is holding, so a browser that
   dies mid-call is one named failure instead of a silent wait; the debug port is read from Chrome's own
   `DevToolsActivePort` with `--remote-debugging-port=0`, so there is nothing to collide with and nothing to
   adopt; and Chrome is launched `detached` so its **whole process group** is killed — Chrome is not one process,
   and killing only the launcher is what leaves the orphans the card counted.
4. **`tools/layout-probe-browser.js` — a wait that runs out of patience reports the page.** `timed out after
   20000 ms waiting for the stress album — the page is on #/album/album-ja-1, h1 "…", 0 rows, showing: "…"`.
   **No assertion was touched, and `PATIENCE_MS` is still 20 s**: this is a diagnostic on a wait, not a longer
   wait.
5. **`package.json` is unchanged.** The suite still runs `node --test "test/*.test.ts"` at node's own default
   concurrency (one file per core). The `--test-concurrency=4` shape the card offered as the blunt lever was
   tried in the earlier uncommitted attempt on this card — and is what pegged this Mac for 20+ minutes in the
   owner's own report — and with the cause gone it buys nothing. §21.4's numbers are what says so rather than a
   preference.

### 21.4 What was run, against the change

`npm run typecheck` — clean. Ten consecutive `npm test`, default concurrency, pre-change `dist/` (runs 9–10
after the last edit, which is the debug-port readiness wait in §21.3.3):

| run | tests | pass | fail | skipped | `test/pager.test.ts` | wall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 249 | 249 | 0 | 0 | ✔ 38.4 s | 39.1 s |
| 2 | 249 | 249 | 0 | 0 | ✔ 37.9 s | 38.5 s |
| 3 | 249 | 249 | 0 | 0 | ✔ 36.2 s | 36.8 s |
| 4 | 249 | 249 | 0 | 0 | ✔ 36.5 s | 37.1 s |
| 5 | 249 | 249 | 0 | 0 | ✔ 36.1 s | 36.7 s |
| 6 | 249 | 249 | 0 | 0 | ✔ 36.7 s | 37.3 s |
| 7 | 249 | 249 | 0 | 0 | ✔ 37.2 s | 37.7 s |
| 8 | 249 | 249 | 0 | 0 | ✔ 36.0 s | 36.6 s |
| 9 | 249 | 249 | 0 | 0 | ✔ 38.5 s | 39.1 s |
| 10 | 249 | 249 | 0 | 0 | ✔ 38.8 s | 39.4 s |

0 skipped in every run, so no browser fixture opted out and every reading above is a real one; the suite is
~37–39 s of wall time, of which the pager test is ~36–38 s (everything else overlaps it). Runs 9–10 were taken
while this working tree also carried another card's in-flight, uncommitted `src/` edits (a lane running in the
same checkout); runs 1–8 are the ones that correspond exactly to this commit's tree, and both readings agree
because this change touches no `src/` file. Then, with the change in place:

| check | reading |
| --- | --- |
| the same squatter on 4615, left alive | **served 0 API requests** — the pager test never touched it |
| that squatter SIGKILLed 4 s into the pager test | the pager test **passed**, 33.7 s |
| Chrome's own debug port | `51806`, read out of `DevToolsActivePort` — no port this repo guessed |
| a renderer wedged in an infinite loop, `NAVILITE_CDP_TIMEOUT_MS=2000` | `Runtime.evaluate went unanswered for 2000 ms — the renderer is wedged or gone` (the deadline the card's 300 s no-report hang had no cause for) |
| a second mock asked for the same port | `mock-subsonic could not bind 127.0.0.1:4611 — EADDRINUSE …`, exit 1 |
| `Chrome` processes holding a `navilite-chrome-` profile after all of it | 0 |

### 21.5 Not verified here, and not claimed

1. **No app code was touched.** The diff is `tools/`, `test/` and these docs: `src/`, `ios/`, `android/` and
   `dist/` are untouched, and nothing here changes what the app does.
2. **The pager check's assertions are untouched**, and so is its 20 s patience. The flake was in the driving.
3. **`Cdp.send`'s deadline is not covered by a committed test.** It is exercised by the throwaway probe in the
   table above (a renderer wedged in a loop, so no reply can arrive) — agent scratch, not part of the suite.
4. **Ten green runs are ten runs, not a proof about a busy machine.** The cause is gone *by construction* —
   no test file can drive a library it did not start, and a mock that cannot bind now fails loudly in the file
   that owns it — but the suite has not been run with other work on this Mac, and nothing here says a starved
   renderer cannot still miss a patience (§14.5's observation stands for that case).
5. **Unreleased.** No version bump, no changelog entry, no tag, no artifact: this is `main` plus this commit, and
   the next release carries it. `DECISIONS.md` records the two rules it establishes (no test file names a port;
   the suite keeps node's default concurrency), and supersedes the v1.9.21 note that said nothing about the
   suite's plumbing would change.

Raw runs behind the tables and the two probes, in one file attached to `t_744cba0b` as
`t_744cba0b-evidence.txt`: both pre-change pager logs in full (`pager-holding-pre.log`, the pass that drove a
foreign library, and `pager-kill-pre.log`, the failure), the post-change squat probe's output,
`plumbing-probe.mjs`'s output, and the ports the suite's own mocks listened on. The ten `npm test` logs
themselves and the three throwaway scripts are agent scratch and are not attached; every number this section
quotes is above, and the ten runs' own summary blocks are reproducible in 7 minutes with `npm test`.

## 22. v1.9.23 — the repaired row reaches the screen he photographed, and the queue with it (2026-10-16)

The release the owner installs: it carries bug A (the spectrum after a rapid skip, verified on v1.9.22's code
and unchanged here — no `src/player/engine.ts`, no Swift file is touched) and bug B, which v1.9.22 fixed in the
*store* and nowhere else. This section is the record of bug B's second half.

### 22.1 The finding this release answers

`repairMetadata` filled the store, and nothing that draws from it: the row's title/sub-line/time were written
once, at build (`songRow`), and the only store-driven row repaint was the download glyph — so opening
**On this phone** drew exactly the owner's screenshot (blank titles, `--:--`) and kept drawing it until he left
the screen and came back. The queue held the same stale objects (`items` is built from that paint and handed to
`queue.select`), and the bar prints them: its title is `currentSong`, and its total is
`status.durationMs || (song.duration ?? 0) * 1000` = `0:00` for a request that carried no duration.

### 22.2 What changed

| file | change |
| --- | --- |
| `src/ui/app.ts` (`songRow`) | the row's title/sub-line/time are **nodes**, and `paintText` re-reads them from `ctx.offline.songFor(id)`; registered through the same store-repaint list the download mark always used (the list is renamed `storeRepaints`, since it no longer paints only marks) |
| `src/ui/app.ts` (`renderRoute`) | the store listener also calls `ctx.queue?.applyMetadata((id) => ctx.offline?.songFor(id) ?? null)` — on **every** route, because the repair's second pass lands after the list it started on may be gone |
| `src/state/queue.ts` (`applyMetadata`) | fills the queue's own copies of its songs in place (the objects the rows were drawn from are the objects it holds), and redraws through `onChanged` — a paused queue emits no status events |
| `src/state/offline.ts` (`songFor`) | the store's answer for one id, in the shape `downloadedSongs()` draws from (`rowAsSong` is now that one mapping, used by both) |
| `src/state/song-metadata.ts` (new) | `fillSong(target, from)` — **the one rule both callers fill through**: empty fields only, so a song the library answered with is never overwritten and a row nobody can name yet keeps `--:--` and an empty title instead of its id or a zero |
| `src/state/offline.ts` (`repairMetadata`) | B4's two loose ends: a lookup that **failed** is forgotten again (`askedServer.delete`) so the next pass in the session retries it — which is what the v1.9.22 comment already claimed — and the sweep is capped at `SERVER_ASKS_PER_PASS` = 20 rows a pass, in row order, so one visit with the manifests gone is 20 round trips rather than 497, and the next pass names the next batch |

### 22.3 The fail-before, on the screen path (the reading the SEND BACK asked for)

The four new browser checks were run against a **pre-fix build** of the same tree — the same harness, the same
fixture, the same assertions:

```
$ git checkout 51c7d82 -- src/ui/app.ts src/state/offline.ts src/state/queue.ts
$ npx vite build            # tsc is skipped on purpose: the new test file names APIs this tree does not have
$ node --test test/offline-views.test.ts
```

| check | pre-fix reading (`dist/assets/index-CYvYhKJ2.js`) | post-fix reading (`dist/assets/index-Bnzfna-r.js`) |
| --- | --- | --- |
| the rows a 1.9.19 build wrote, on `#/downloads`, no navigation | `4 rows · [["","--:--"],["","--:--"],["","--:--"],["","--:--"]]` after 5 s of waiting | `3 rows named by the record · [["海底、月明かり","ヨルシカ · 盗作","3:34"], …]` in 2 ms |
| a row nobody can name | 4 unnamed rows (nothing is named at all) | 1 unnamed row: `["", "--:--", "Play , downloaded"]` — no id, no invented length |
| the bar of the track tapped while its row was blank, list since left | `"" → ""` | `"" → "Track 1 · 110/330/1320 Hz"` (the library's own name for it) |
| …and its total | `0:00 → 0:00` | `0:00 → 0:20` (its real 20 s) |

So the owner's symptom is reproduced on the screen path *and* fails there before the fix — not merely an absent
method (the v1.9.22 evidence's weakness). After the fix the same command exits 0, with the four checks green.

### 22.4 The suite, the type check and the artifact

| check | reading |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` (full suite, once, on this build) | **255 tests, 255 pass, 0 fail, 0 skipped** in 38.7 s — 6 more tests than 1.9.22's 249 (4 new in `test/offline-repair-visible.test.ts`, 2 in `test/offline-browse.test.ts`); `test/pager.test.ts` green in 38.2 s (t_744cba0b's port collision is fixed and this run is the first where a pager failure would have been a real signal) |
| `test/offline-views.test.ts` | green in 31.0 s: the harness's own `checks` all ok, including the four above |
| `artifacts/Navilite-1.9.23-unsigned.ipa` | `CFBundleShortVersionString` **1.9.23**, `CFBundleVersion` **44**, `UIBackgroundModes[0]` audio |
| the bytes in the IPA | `Payload/App.app/public/assets/index-Bnzfna-r.js` is **byte-identical** to `dist/assets/index-Bnzfna-r.js` (sha256 `bb57b25b…0d88`), and it carries `applyMetadata`, `songFor` and the 1.9.23 changelog sentences; the version list in `test/changelog.test.ts` and both changelog copies carry 1.9.23 |

Version files touched, per `docs/VERSIONING.md` §3: `package.json` + `package-lock.json`, `build.gradle`
(`versionCode 43`, `versionName 1.9.23`), `project.pbxproj` (`MARKETING_VERSION = 1.9.23` and
`CURRENT_PROJECT_VERSION = 44`, both in two places), `src/ui/changelog.ts`, `CHANGELOG.md`,
`test/changelog.test.ts`.

### 22.5 Not verified here, and not claimed

1. **No device and no simulator.** Both new readings are browser readings of the app's real code path (Chrome
   at 393 × 852, the shipped `dist/`), and the *queue* reading is driven so that only the queue's own copy can
   fill the bar (a row only the server can name, every API answer held, the list left before the answer lands).
   The owner's install is the acceptance for the real thing — see the card's summary for what to do on the
   phone.
2. **The bar's artwork and the shell's palette are not repainted by a repair.** `updatePlayerBar` rebuilds the
   bar's cover only when the *song* changes, and `syncPalette` keys on the song id, so a `coverArt` that
   arrives with the repair does not re-draw the cover or re-theme the shell for the track already playing; the
   title, the sub-line and the total do. This release claims the title and the total (the card's acceptance)
   and nothing about the artwork.
3. **The 2 s hold in the bar case is a harness lever, not the phone's timing.** On the phone the window is the
   round trip the repair's server pass is waiting on; the harness makes it deterministic with `/__slow`.
4. **The store's row fill (`fillFrom`) and the shared `fillSong` are two shapes of one rule**, not one
   function: the row's fields are `durationSec`/`coverArt` against a `Song`'s `duration`/`coverArt`. Both are
   documented as "empty fields only", and `test/offline-repair-visible.test.ts` pins the `Song` one.
5. **The cap's number is a judgement, not a measurement.** 20 rows a pass (~2 s on a tailnet) was chosen so one
   visit cannot fire hundreds of round trips while the work still finishes; 497 rows in the owner's case are
   named twenty at a time, over passes.

## 23. the v1.9.23 follow-up — the row's accessible name is written after the text it carries (2026-10-16, unreleased)

Sage's SHIP review of v1.9.23 left one minor, non-blocking finding (A11Y-1), filed twice — as the review
leftover on that card (`t_1ba6144e`, worked here) and as a card of its own (`t_861821f3`); both are the
same defect and the same acceptance. Nothing owner-visible promised it, no version bump is taken: it rides
along with the next release that touches this area, per `docs/VERSIONING.md`.

### 23.1 The finding

A row's accessible name is the row's only voice — the row is one tap target (v1.5) and the download glyph
is `aria-hidden`, so nothing else on it is announced. That name carries the title
(`` `Play ${song.title}${downloaded ? ', downloaded' : ''}` ``), and it was written by the **mark** pass —
registered before the **text** pass that fills `song.title` out of the store (`songRow`, `src/ui/app.ts`).
Inside one store notify the name therefore preceded the title it carries, and a row the *server* names gets
exactly one notify (no manifest ⇒ `repairFromRecords` has nothing to say ⇒ `repairMetadata`'s only notify
is the one at the end of the server pass, `src/state/offline.ts:618`) — so the pass that filled the title
was the last pass, and the name stayed stale. The legacy/manifest path self-heals only because the record
pass notifies **twice** (`:591`, then `:618`). Sage's probe on the shipped `dist/`: a row whose title
`Track 1 · 110/330/1320 Hz` and `0:20` were legibly on the screen read
`"Play , downloaded"` 2 ms after the route drew and 2 s later, unchanged.

Symptom as the owner would hit it: with VoiceOver the row is announced as "Play, downloaded" — no name at
all — while its title is on the screen, and it heals only on the next unrelated store change.

### 23.2 What changed

| file | change |
| --- | --- |
| `src/ui/app.ts` (`songRow`) | the two store-repaint registrations are swapped: `paintText` **before** `paintMark`, so the pass that writes the name runs after the pass that fills the title it carries. Both stay registered and the name is still written on **every** pass (the title can arrive later than the glyph); neither writes the other's node. The comment above the pair says why the order is load-bearing |
| `tools/offline-check.mjs` | a third v1.9.23 reading (§2e): the one-row, server-named store of §2d, on `#/downloads`, held open (`/__slow`) so the route draws it blank, read **once** as it drew and **once** when the store could name it, **with no navigation between them** — the row's rendered title and its `aria-label` in the same reading |
| `test/offline-views.test.ts` | the acceptance, asserted on the readings the harness reported (not on its exit code, not on "a repaint was called"): the reading is on `#/downloads`, the row was blank when the route drew, and then `title` is the library's own name and `label` is `` `Play ${title}, downloaded` `` |

### 23.3 The fail-before, and the same check after

The new reading first ran against the **shipped v1.9.23 bundle** (`dist/assets/index-Bnzfna-r.js`, the bytes
in `artifacts/Navilite-1.9.23-unsigned.ipa`), on the tree before the swap:

```
$ node --test test/offline-views.test.ts          # exit 1
FAIL  the row the server named reads as its title and its accessible name in the same reading, on the route (v1.9.23)
      route #/downloads · as drawn ["","Play , downloaded"] · named ["Track 1 · 110/330/1320 Hz","Play , downloaded"] (the library calls it "Track 1 · 110/330/1320 Hz")
```

The visible text is right and the name is not — the owner's symptom, reproduced on the screen path, and the
same command exits 0 after the swap:

```
$ npm run build                                    # tsc --noEmit, then vite build → dist/assets/index-y2t2BS14.js (sha256 80150e59…f6b)
$ node tools/offline-check.mjs --app http://127.0.0.1:55768 --online-playlist pl-stress-long --json /tmp/a11y-report.json
The row the server named, read on the route it was drawn on, with no navigation:
    as the route drew it: ["","Play , downloaded"]
    once the store had named it: ["Track 1 · 110/330/1320 Hz","0:20","Play Track 1 · 110/330/1320 Hz, downloaded"]
ok    the row the server named reads as its title and its accessible name in the same reading, on the route (v1.9.23)
RESULT: … (exit 0)
$ node --test test/offline-views.test.ts           # exit 0, 1 pass 0 fail in 32.2 s
```

The legacy case §22 asserts is unchanged and still correct in the same run: the three rows the record names
read `3:34` with `ヨルシカ`, and the row nobody can name still draws `""` and `--:--` with no id in it.

### 23.4 The suite, and what this build is

| check | reading |
| --- | --- |
| `npm run build` | `tsc --noEmit` clean, `vite build` → `dist/assets/index-y2t2BS14.js` |
| `node --test test/offline-views.test.ts` | green in 32.2 s (all harness checks `ok`, including §2e) |
| `npm test` (full suite, once, on this build) | **255 tests, 255 pass, 0 fail, 0 skipped** in 36.4 s — the same count as v1.9.23: this adds assertions to an existing browser test, not a test case |

No version file is touched, so `dist/` is now the follow-up build and **not** the released bundle: the
1.9.23 IPA keeps `index-Bnzfna-r.js` (sha256 `bb57b25b…0d88`), and this change is source + tests only until
the next release rebuilds and re-stamps it.

### 23.5 Not verified here, and not claimed

1. **No device and no simulator**, and no screen reader: the reading is Chrome at 393 × 852 against the
   built `dist/`, and it reads the row's `aria-label` **attribute** — which is what VoiceOver reads out of
   a `button` — rather than any speech. The owner's phone is the acceptance for the announcement itself.
2. **The two cards are one defect.** This section records the work of `t_1ba6144e`; `t_861821f3` is the same
   finding from the same review and was in flight against the same three files at the same minute. Its
   harness block was removed from the working tree at 15:22:39 leaving this section's §2e reading as the
   single one; `src/ui/app.ts` was untouched by it. If that card re-applies the same swap, the anchor will
   no longer match — the order is already `paintText` then `paintMark`.


## 24. the spectrum falls back to native audio on a track change — the diagnosis (2026-10-16, unreleased, no code change)

Task `t_183f4708`, the look-before-you-leap gate for the owner's report on the installed build (v1.9.22/v1.9.23):

> *"the spectrum still doesn't work most of the time when i go to different tracks, it defaults to native audio and
> turns spectrum off. … it could be because songs are starting up really fast now that they are starting from my
> phone's local storage after being downloaded so the spectrum attaching can't keep up. sometimes it appears the
> attach then immediately detach."*

**No production code is changed by this section, and no version is bumped.** It is the diagnosis the implementing
card (`t_bec7b1bd`) is gated on. Everything below is either a line of this repo's own source or a reading from the
probe described in §24.5.

### 24.1 The finding, in one paragraph

The engine's answer to *"can this track have a spectrum?"* is not a fact about the track; it is a **verdict written
by a clock**. Five of the six places that turn the chip to *native audio* are reached by spending a budget of
milliseconds (396 ms, then 1000 ms per re-check, then a 5000 ms retry), and one of them asks whether the tap has
*"answered for this item"* by reading `frame.frames` — a counter the tap keeps for the **life of the app process**,
not for the item. On any track after the first one that ever produced a spectrum frame, a tap that has produced
**nothing at all** for the new item is therefore judged to have *"answered digital silence"* after 12 polls
(≈ 0.4 s) and the chip is switched off while the attach it is waiting for is still in flight. That is the owner's
*"defaults to native audio"*, and it is chosen *because* the attach has not landed yet — the exact inversion the
brief forbids. The tap itself is not broken and nothing is detached on purpose: the app's own re-attach is
*synchronous in intent and asynchronous in fact*, and every way it can be late or refused is charged to a budget
that ends the arming window.

**Why this is not the two earlier fixes.** `a0d296e` (the paint guard) and `9a2490b` (the rapid-skip race: the
`src/player/engine.ts` lifecycle plus the Swift install guard) both closed a **race about which item the tap ends
up on**: a stale install attaching to the item the player had left, and an install superseded mid-await. That is
one *cause* of the tap being off the item; both are genuinely closed (§24.4's guards are the ones that were added,
and they hold). Neither touched the rule that turns a *late* or *refused* attach into a stated capability. So the
earlier work is 8/8 → 0/8 on the reading it was aimed at while the symptom on his phone is unchanged: what he sees
is not the race, it is the verdict written while the race is being won slowly.

### 24.2 Every transition path, and where the analyser is attached

One attach site per start, one verify per transition, one decide-to-off rule reached from six places. The URL a
downloaded track resolves to is the local file (`src/state/library.ts:102`: `streamUrl()` asks the offline resolver
first, so the audible load, the warm pool **and** the queue published to the native side all carry that one string,
`src/state/queue.ts:779`, `:888`); nothing in the spectrum path treats it differently from a stream, which is the
point of the v1.9.16 patch below.

| path | why it starts | the analyser is attached at | the off-rule is reached from |
| --- | --- | --- | --- |
| skip next / previous | `queue.next()` `src/state/queue.ts:430` → `startCurrent()` `:603` → `engine.play` `:685` | `src/player/engine.ts:2397` (after `bridge.play()`, inside the start's `finally`-adjacent block) + verify at `:2429` | `pollSpectrum` `:2599` / `:2660` / `:2750` / `:2774`, and `attachSpectrum` `:2885`/`:2894` |
| play-all / queue jump | `queue.play()` `:245` → `start()` → `startCurrent()` `:603` | same as above | same |
| end-of-track auto-advance (zero gap) | `engine.onEnded` `:187` → `advance()` `:570` → `startCurrent()` `:603`; or the native boundary's own advance → `engine.adoptNativeAdvance` `:1779` | `:2397`, or `:1801` for the adopted track | same |
| native adopt (player took the boundary while away) | `onAdvanced` → `queue.adoptNativeAdvance` → `engine.adoptNativeAdvance` `:1779-1802` | `:1801` (`attachSpectrum(track)`), arming set `:1791` | same |
| resume / foreground | `resume()` `:1853` → `confirmPlaying` `:1874` → `startNative` `:1899`; `handleVisibility(false)` `:2084-2145` | `:2397` on a real restart, else **verify only**: `:2144` → `:2827` | same |
| **local-file start** (a downloaded track) | identical to the row above: `library.streamUrl` returns `file://…` (`:102`), so `bridge.load`/`adopt` and `startSpectrum` all carry the file URL | `:2397`, `:1801` | same |

The engine/native choice itself is not a per-path decision: it is `src/player/engine.ts:1520-1537` (`nativePlatform`
⇒ `backend = 'native'`, and no fallback that plays, `:1526-1534`), with `startWeb` at `:2153` for the browser only.
`startConsumers` `:2478-2529` is the only place that arms the poll, and it is reached from exactly one transition —
`applyState('playing')` `:895-907`. **That single-entry discipline is intact and is not the defect.**

### 24.3 The decision that turns the spectrum off

The chip's word is `src/ui/app.ts:3356`:
`status.spectrum ? 'spectrum' : status.spectrumArming ? 'spectrum…' : status.backend === 'native' ? 'native audio' : 'theme'`,
and `spectrumArming` is only reported while a native track is actually playing (`src/player/engine.ts:1183`). So
**"native audio" means exactly: `backend === 'native'`, `state === 'playing'`, `spectrumLive === false`, and the
engine has cleared `spectrumArming`.** Six writers clear it:

| # | file:line | what it is decided from | timing or capability? |
| --- | --- | --- | --- |
| 1 | `engine.ts:2495` | this build has no spectrum plugin at all | capability — **legitimate, keep** |
| 2 | `engine.ts:2650` | the tap reported `itemIsCurrent === false` on `MAX_SPECTRUM_RECHECKS` (3, `:422`) sightings, one per `SPECTRUM_ORPHAN_RECHECK_MS` (1000 ms, `:387`) | timing |
| 3 | `engine.ts:2704` | 12 zero-frames (`:360`) then `SPECTRUM_RECHECK_MS` (5000 ms, `:403`) × 3 re-checks | timing |
| 4 | `engine.ts:2752` | **12 zero-polls (≈ 0.4 s) and `answered`** | timing, on a false input — see below |
| 5 | `engine.ts:2778` | the tap returned the same non-silent frame 10 times (`FROZEN_FRAMES_BEFORE_THEME`, `:469`) | reading about *this item* — legitimate, keep |
| 6 | `engine.ts:2885`, `:2894`, `:2954` | `startSpectrum` answered `false`, or rejected, plus a 5 s timer retry | **timing presented as capability** |

**#4 is the one that fires on a fast start, and its input is not about this item.** `engine.ts:2749` is
`const answered = frame.frames > 0;` — and `frames` is the tap object's own lifetime counter:
`ios/App/App/NaviliteSpectrum.swift:605` (`frames += 1` inside `analyze()`, one `AudibleSpectrumTap` per plugin,
`:720`), and it is reset by **nothing** — `detach()` (`:378-391`) clears `bands` and `lastFrameLive` only, and
`unprepare()` (`:611-631`) clears the PCM ring only. `src/player/native.ts:144-145` documents the field for what it is
(*"FFT frames the tap has produced since it started"*). The engine reads it as *"the tap has answered for the item
playing now"*. After the first track of a session those two sentences differ by one item, and the difference is
taken as a decision 396 ms into every later track.

So the answer to the brief's question: **yes — the condition is true precisely because the attach has not landed
yet.** It is true whenever the tap is installed on the item being played and has not yet produced a frame *for that
item*: the window between the mix landing and the tap's first window of PCM (the tap needs a 1024-sample hop after
`prepare`, `:119-120`, `:548-556`), and the longer window when the item is not yet rendering because the player is
still filling (a remote stream — the *fast* local start actually shortens this one). What makes the fast local start
worse is elsewhere: the load is a few milliseconds, so the *whole* of the transition is the attach's own latency,
and the attach is asynchronous by construction (`begin`'s `Task`, `:798`; the `await` of the item's track list,
`:810`; the 100 ms retry loop, `:850-857`) while the engine's judgement of it is on three clocks.

And the two facts the plugin already sends about exactly this are **never read**: `attached` (`NaviliteSpectrum.swift:422`)
and `silentFrames` (`:417`) travel the bridge (`src/player/native.ts:137-166`) into a frame object the engine
destructures by hand (`engine.ts:2577`, `:2599`, `:2660`, `:2717`, `:2749`, `:2770`) and drops. The engine
therefore cannot tell *"no tap at all"* from *"a tap on an item the player has left"* — both read
`itemIsCurrent === false` (`:432`: `item != nil && item === player?.currentItem`) — and it describes both on screen
with the orphan branch's sentence, *"the tap is on the item the player has moved off"*, which is false in the first
case.

### 24.4 attach-then-immediately-detach, in order

**Who detaches.** Nothing in `src/` ever asks for it: `NativeBridge.stopSpectrum` (`src/player/native.ts:1447`,
which is the only caller of `NaviliteSpectrum.stop`, `:866-872`, whose body is `spectrum.detach()`) has **no caller
in the application** — the engine detaches the tap nowhere, and `disarmConsumers` (`engine.ts:2545-2557`) is
explicitly the place that does *not*. The detach the owner sees comes from three native places:

1. **`attach`'s own prologue** — `NaviliteSpectrum.swift:263`, the first statement after `carriesOurTap` returns
   false (`:348-352`). `attach` is reached from `install` (`:835`), and `detach()` takes the mix off `self.item`
   (`:379-381`), zeroes the published bands and forgets the item and the player. So *every* install on a different
   item is a detach first. With the v1.9.22 re-tests in place (`:833`, both the generation and
   `player.currentItem === item` re-read after the await) the item being stripped is no longer the playing one, so
   this is now the harmless half of what it was — but the *sequence* the owner describes is this sequence, and it
   is the mechanism by which a request that arrives at the wrong instant (see 3) leaves nothing attached.
2. **The vendor plugin's own slot lifecycle** — `fillSlot` unloads before it preloads
   (`src/player/native.ts:791-808`), and `RemoteAudioAsset.unload` (`node_modules/@capgo/capacitor-native-audio/ios/Sources/NativeAudioPlugin/RemoteAudioAsset.swift:261-275`)
   drops `players = []` and the items with them. The tap's item goes away with it. **No code in this app performs
   that detach and nothing in the app observes it** — the only trace is the next frame's `itemIsCurrent: false`,
   which is the same value as "there was never a tap".
3. **The plugin's refusal**, which is not a detach but is read as one: `NaviliteSpectrum.start` looks the playing
   slot up by the id the *bridge* passes (`src/player/native.ts:1436-1440`, `assetId: audibleId`), and a slot that
   has no loaded item at that instant is a **rejection** (`NaviliteSpectrum.swift:763-765`). `NativeBridge.startSpectrum`
   turns every rejection into `false` (`src/player/native.ts:1443-1445`). The load is exactly such a moment —
   `fillSlot` unloads, then preloads, `src/player/native.ts:791-808` — and the engine issues its requests *into*
   that window: one install at `engine.ts:2397` right after `bridge.play()`, one verify at the close of the load
   (`:2429`), and one more per orphan sighting (`:2656` → `:2849-2853`).

**Why the re-attach loses.** Because it is not superseded, it is refused and then *charged to a budget*:

- `verifySpectrum` ignores its own answer entirely (`engine.ts:2850-2853`: `.then(started => settleSpectrumInstall(serial, started === true))`
  — the boolean is used for nothing else), while the sighting that issued it has already spent a re-check
  (`:2646`). Three refusals in ~2 s are indistinguishable from three real failures, and the third writes
  *"the tap is on the item the player has moved off and would not re-attach"* (`:2650-2652`) — the word
  *"would not"* is a capability claim made out of two momentary refusals.
- `attachSpectrum`'s `false` / rejection is a **hard verdict**: `spectrumArming = false` and
  *"the native spectrum tap did not start"* (`:2885-2887`, `:2893-2897`), and the only recovery is a **fixed
  5 s timer** (`retrySpectrumOnce`, `:2948-2959`) — the shape the brief explicitly rejects.
- The next sighting after that (`:2643`) is rate-limited to one per second, and after the budget is reset
  (`:2648`) it can only slow down, never re-arm: `spectrumArming` is set true in exactly three places — the start
  (`:2246`), the adopted boundary (`:1791`) and the *first* orphan sighting of a track (`:2645`) — so once it is
  false for a track, only a new track can raise it again. From the owner's side that is *"it turns spectrum off"*,
  and it is why the state survives to the next song rather than flickering.

**What the native side does when a new item arrives while the previous attach is in flight** is now, correctly,
nothing: the new request carries a new generation (`begin`, `:780`), the older request re-tests it after its await
(`:833`) and either retries on the *new* current item or rejects (`:805-807`). That guard is the v1.9.22 fix and it
holds — in the source and in the probe (the install never lands on the stale item). It does not, however, make the
*engine* wait: the engine has already decided, and the guard's correctness is invisible to it.

### 24.5 The readings

Driving the **real** `AudioEngine` (`src/player/engine.ts`, unmodified) with a fake bridge that models the plugin's
own install semantics — `startSpectrum` reads the current item, awaits its track list, attaches to *that* item;
`frames` is a lifetime counter; `itemIsCurrent` is `item === player.currentItem` and is false when nothing is
tapped; the two re-tests of `NaviliteSpectrum.install:833` are honoured. The probe is not a repo artifact; it is
this file plus the numbers below. A first track plays so the lifetime frame counter is non-zero, which is the
state his phone is in after the first song.

**(a) A downloaded (`file://`) start whose tap IS on the playing item but has produced no frame yet.** Install
latency 5 ms (it lands), first frame for the new item at +800 ms:

```
change at t+737 ms
t+ 770  spectrum…    spectrum=false arming=true  playing  tap frames=20 (all 20 from the previous track)
t+1181  native audio spectrum=false arming=false playing  tap frames=20 — the native tap is reading digital silence — the audio itself is silent, so the bars are flat
t+1562  spectrum     spectrum=true  arming=false playing  tap frames=21 — real spectrum — an FFT of the stream this player is playing, read from the native audio tap
```

411 ms after the transition into `playing` — 12 polls × 33 ms — the engine states digital silence about a tap that
has produced **nothing** for this item, and the chip reads *native audio*. That number is the whole of finding #4,
and the sentence it writes is false.

**(b) The same for a streamed start, and the same 900 ms-late install on both** — identical behaviour (`file://` and
`http` produce the same timeline; the local case is not a separate defect). With the install 900 ms late the chip
shows `spectrum…` and heals at ~1.7 s, because while the tap is on the *previous* item the orphan branch returns
first (`engine.ts:2599`) and the zero-poll verdict is never reached. So the false verdict needs the tap **on** the
item without a frame; the orphan budget needs it **off** the item.

**(c) A local start, then a second change 250 ms later** (his *"moving through tracks"*): the same false verdict
appears at +1470 ms, and the tap is re-installed four times (`installs=4 verifies=3` for three tracks), i.e. the
transition can issue several requests per track — the install, the verify at the close of the load, and one per
orphan sighting.

**(d) A tap that never lands on the item**: `spectrum…` for ~3 s (three orphan sightings, one per second), then
*native audio* permanently — `engine.ts:2650`'s sentence. **(e) Every install refused** (the named slot has no
loaded item, which is a real state for the length of a `fillSlot`): the same permanent verdict at +2850 ms, with
*"would not re-attach"*.

**What the harness structurally cannot see.** It drives JavaScript with a *model* of the plugin: it cannot tell
whether the mix actually lands on a file-backed `AVPlayerItem`, whether `MTAudioProcessingTap.prepare/process` are
called for it, whether `player.timeControlStatus` is `.playing` at the instant `snapshot()` is built, or how long
`loadTracks` takes for a warm local file versus a replaced remote one. §24.8.

**In Chrome the symptom does not exist, and that is itself a reading.** On the web path the analyser is built once
and sits in front of the element that is making the sound (`ensureGraph` `engine.ts:2978-3018`); there is no tap to
attach, no `itemIsCurrent`, and no budget: the only ways to "off" are a suspended `AudioContext` (`:3003-3008`) and
the frozen-frame check (`:2774` web twin, `:3069`). A fast start cannot lose a race there, so a PWA run cannot
reproduce what he reports — which locates the defect in the native decision layer rather than in the transition
machinery.

### 24.6 The invariants the fix must hold

1. **Attached before or at the first frame, on every path.** When the engine says `playing` for a track, the tap is
   on the item the player is playing (or the request that will put it there is outstanding *and the engine knows
   it is*). No path may leave `playing` with the tap knowably elsewhere and the app silent about which of the two
   it is.
2. **A lost attach is retried for the current track only, on evidence, not on a clock.** The retry's trigger is the
   *player's* item (`itemIsCurrent`, and the tap's own `attached`), and its unit is the item, not a 1 s/5 s timer.
   A refusal that names a reason ("the slot has no loaded item") is a reason to ask again when that condition has
   ended, not a verdict.
3. **The spectrum is never turned off for a track whose audio can be analysed.** The only inputs that may state
   *native audio* are: this build has no tap (`:2495`); the tap is on the wrong item **and the engine has said so
   in those terms, with a remedy in flight**; the tap is genuinely frozen (`:2778`) or reading digital silence
   **of this item**; or a refusal that carries the plugin's own reason for *this* item. A budget expiring is none
   of those.
4. **The fallback is a capability decision, never a timing one.** No count of polls, no elapsed milliseconds and no
   timer may be a term in "there will be no spectrum here".
5. **Per-item facts must be per item.** Anything used as "the tap has answered for this track" counts frames (or
   time) *since this item was attached* — the `frames` counter as shipped is process-lifetime
   (`NaviliteSpectrum.swift:605`, never reset) and must not be read as this item's answer.
6. **`attach` is idempotent per item and the detach is not its prologue.** An item that already carries the tap is
   verified, never re-installed (`:348`), and the mix is taken off an item only when that item is genuinely no
   longer the player's current one. The two `attached`/`itemIsCurrent` facts must agree with what the engine
   believes; the engine must stop describing "no tap" as "the tap is on an item the player has moved off".
7. **The one-engine rule is untouched.** Nothing here may reintroduce a second player, a second clock, a second
   decode, or an `<audio>` element feeding an analyser in a wrapped build.

### 24.7 Fixes this diagnosis rejects

A timer-driven re-attach; a fixed retry delay; a synthetic or idle envelope drawn while the tap is dark; treating a
detached analyser as "just leave it"; re-arming `spectrumArming` on a clock instead of on an answer; and — the
tempting one — making the chip *lie* by keeping it on "spectrum…" indefinitely while nothing is attached. Each of
those makes the symptom invisible without making the tap land, which is the failure this repo has already shipped
twice.

### 24.8 Not verified here, and not claimed

1. **No phone, no simulator, no native mixer.** The Swift/ObjC half is read, not run: whether the mix lands on a
   `file://`-backed `AVPlayerItem`, whether the tap's `prepare`/`process` are reached for it, and what
   `timeControlStatus` is at the instant the frame is built are the phone's answers, not this machine's.
2. **The bridge in the probe is a model**, faithful to the plugin's ordering and to the two facts the engine reads,
   but not to its timings: the real install latency for a downloaded file is unmeasured here, and with it the
   frequency of the false 0.4 s verdict on his phone. What is measured is that the verdict is available at 411 ms
   and that it is written from a counter that does not describe the item.
3. **The v1.9.16 `file://` transport patch is verified present** in the tree this section was written against
   (`tools/patch-native-audio.mjs:194-226`; the marker `NAVILITE_BUFFER_PATCH:ios-file-transport` at
   `node_modules/@capgo/capacitor-native-audio/ios/Sources/NativeAudioPlugin/Plugin.swift:1399`, in the
   `preloadAsset(_:isComplex:)` the app's own `preload` call reaches, `Plugin.swift:551-553`), so "a downloaded
   track reaches a transport with no `players` array" is closed and is **not** offered here as a cause.
4. **The engine's own suite is green on this tree** (`npm test` → 255 tests, 255 pass, 0 fail in 36.4 s) — i.e. the
   defect above is not caught by any existing test: the two tests that guard this window use a *first* track, where
   the lifetime frame counter is still zero (`test/engine-native.test.ts:1691`, `:1736`).
5. **How the implementer can tell the fix worked.** With the same probe: a track change on which the tap's first
   frame for the new item arrives at +800 ms, at +2 s, and never-but-installed must **never** print *native audio*
   while `state === 'playing'`, and the reason line must not claim silence or a re-attach failure about an item the
   tap is on. On the phone: `NaviliteSpectrum`'s own `installs`/`verifies` counters (in `bands()`, `:435-436`) and
   the reason line stay readable at every change, and the chip's third word is the only one allowed between the
   transition and the tap's first frame.

## 25. the spectrum's word for "there will be no bars here" was spent by a clock — it is a fact about this item now (2026-10-16, unreleased)

Card `t_bec7b1bd`, implementing the diagnosis §24 (`t_183f4708`, commit `0af06b0`). The owner, on the installed
build (v1.9.22 / v1.9.23):

> *"the spectrum still doesn't work most of the time when i go to different tracks, it defaults to native audio and
> turns spectrum off. … it could be because songs are starting up really fast now that they are starting from my
> phone's local storage after being downloaded so the spectrum attaching can't keep up. sometimes it appears the
> attach then immediately detach."*

His "downloaded songs" hypothesis is the *trigger* and not a second cause: a `file://` start and a streamed one
reach the same engine, the same `bridge.load` and the same `startSpectrum` call with the same latency shape
(§24.2, §24.5). **No version is bumped, no IPA/APK is built, the `CHANGELOG.md` release heading is untouched** —
this is the fix, its check, and a commit; the release is its own card, after review.

### 25.1 The defect, in one paragraph

The engine's answer to *"can this track have a spectrum?"* was a verdict spent by a **clock**, and one of its six
inputs was not about the track. `pollSpectrum` asked whether the tap had *answered for this item* by reading
`frame.frames` (`src/player/engine.ts:2749`) — the tap's own counter for the life of the app **process**
(`NaviliteSpectrum.swift:605`; `detach()` and `unprepare()` reset nothing, `src/player/native.ts:144` documents it
as *"since it started"*) — so on every track after the first one that ever produced a frame, a tap that had
produced **nothing** for the item playing was judged to have answered *digital silence* twelve polls (≈ 0.4 s) in,
and the chip printed *native audio*. It was reached *because* the attach had not landed yet, which is the exact
inversion the brief forbids. Three further writers turned a **late or refused** attach into a capability claim out
of elapsed time (§24.3 rows 2, 3 and 6: three orphan sightings at 1 s apart, three dead-poll rounds at 5 s apart,
and one answered request plus a 5 s retry timer), and the engine described *"there is no tap at all"* with the
sentence for *"the tap is on an item the player has moved off"* — the plugin has always sent `attached`
(`NaviliteSpectrum.swift:422`) and the engine dropped it.

### 25.2 What changed

| file | why |
| --- | --- |
| `src/player/engine.ts` | the decision, once: **the chip's third word is only spent on a fact about the tap on the item playing now**. `tapFramesForItem` counts the tap's frames as deltas observed while the plugin says the tap is on the current item — the first such read is a baseline and a read that finds the tap elsewhere rewinds it, so it can only *under*-count and can never state another item's frames as this item's (`noteTapFrames`, `forgetTapFrames`, reset at `startNative` and `adoptNativeAdvance`); `answered` is `tapFramesForItem > 0`, so a tap that has produced nothing for this item keeps the third word; the orphan branch re-asks the plugin on the plugin's own evidence and *still keeps the third word*; the dead-poll branch re-checks rate-limited and keeps it; `attachSpectrum`'s `false`/rejection report the state on the reason line and no longer spend the word; `MAX_SPECTRUM_RECHECKS`, `SPECTRUM_SLOW_POLL_MS`, `slowSpectrumPoll` and `retrySpectrumOnce` (the 5 s timer) are deleted; `setSpectrumReason` writes the sentence once per distinct state; the invariant is stated where it is enforced (the `ZERO_POLLS_BEFORE_THEME` doc and `EngineStatus.spectrumArming`) |
| `src/player/native.ts` | `NativeSpectrumFrame.attached` declared — the fact the plugin has always sent and the engine has always discarded, which is what lets `"no tap at all"` stop being described as `"the tap is on an item the player has moved off"` |
| `test/engine-native.test.ts` | the fake models the owner's case in the two facts the plugin sends: `framesQuietUrls` is a tap **installed on the item that is playing and standing still** (the process counter non-zero from the previous track, `itemIsCurrent` true, `attached` true), and `attached` is now sent; one new test drives a downloaded (`file://`) start, the change onto a quiet tap, and then his burst of two changes 250 ms apart |

### 25.3 The fail-before, and the same check after

The new test first ran against the **engine as shipped in v1.9.23** (this tree's `src/player/engine.ts` before the
change, kept at `src/player/engine.ts.bak-20261016-185201`), with the harness and the test unchanged:

```
$ node --test --test-name-pattern 'while the new item’s tap is still to give its first frame' test/engine-native.test.ts
    1. a downloaded track: spectrum true, the tap's process-lifetime counter at 9
✖ a track change never turns the chip to "native audio" while the new item’s tap is still to give its first frame (v1.9.24)
  AssertionError: the chip's third word while the new item's tap has produced nothing
    (  417 ms · playing · spectrum false · arming false · tap frames 9 — the native tap is reading digital silence — the audio itself is silent, so the bars are flat)
ℹ tests 1 · pass 0 · fail 1 · duration_ms 1112.9
```

417 ms after a change onto a local file whose tap is on it and has produced nothing, the shipped engine states
*digital silence* about a tap with **zero frames for this item** — the counter it read (`9`) is the previous
track's, and the chip reads his *native audio*. The same command on the fix exits 0, and the whole file reports
the timeline:

```
$ node --test test/engine-native.test.ts        # after
    1. a downloaded track: spectrum true, the tap's process-lifetime counter at 9
    2. the change onto a quiet tap —   462 ms · playing · spectrum false · arming true · tap frames 9 — native playback …
       and 26 reads through the first second, every one of them "spectrum…"
    3. the new item's first frame: live 18 ms later, arming false
    4. the burst: 25 reads while playing, "native audio" on none of them
    5. no tap on this item: arming true — nothing is attached to the item that is playing — asking the plugin to put a tap on it; the bars follow the audio
ℹ tests 28 · pass 28 · fail 0 · duration_ms 24907.4
```

Read as the diagnosis reads it: the counter still stands at `9` (process-lifetime, unmoved for the new item), the
verdict is gone, the word is the third one, and the *only* thing that ends it is the tap's own first frame for that
item — 18 ms after the harness lets the tap produce one. His burst (two changes 250 ms apart, the second landing on
a quiet tap) is read at every poll for a second and never prints *native audio*, and the two states the engine used
to collapse into one false sentence are now two sentences.

### 25.4 The suite, the invariant in the code, and what the change is not

| check | reading |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` clean |
| `npm run build` | `tsc --noEmit` + `vite build` clean → `dist/assets/index-9CPLwmFN.js` (197.45 kB, sha256 `6f1fde81…cef4`) |
| `node --test test/engine-native.test.ts` | 28 tests, 28 pass, 0 fail in 24.9 s (27 before this card, +1) |
| `npm test` | **256 tests, 256 pass, 0 fail, 0 skipped** in 35.8 s (255 before this card, +1) |

The invariant §24.6 asks for is stated where it is enforced, in the engine:

> *What may end the chip's third word while a native track is playing is a fact about the tap that is on the item
> playing **now**: this item's own frames, or a build with no tap at all.* (`ZERO_POLLS_BEFORE_THEME`)

An audit of the final file holds it: the remaining writers of `spectrumArming = false` are the build with no tap
(`startConsumers`), a live frame for this item, this item's frames reading silent, and this item's frames frozen —
no poll count, no elapsed millisecond, no timer. Nothing is masked to get there: the timed re-attach is deleted
rather than retuned, no envelope or idle spectrum is synthesised, the chip's three words are unchanged (the fix is
not a UI change that hides the state), the one-engine rule is untouched, and nothing detaches the tap.

### 25.5 Not verified here, and not claimed

1. **No phone and no simulator.** The reading above is the real `AudioEngine` driven through a bridge that models
   the plugin's ordering and the two facts it sends; the native mixer is not exercised, so *whether the mix lands
   on a `file://`-backed `AVPlayerItem`* and how long `AudibleSpectrumTap`'s first frame really takes on his phone
   are still §24.8's answers, not this machine's. What is closed is the decision: a tap that has produced nothing
   for the item no longer *causes* the fallback.
2. **The Swift/ObjC half is untouched** (no file under `ios/` or `tools/` changed). §24.4's three detach sites —
   `attach`'s own `detach()` prologue, the vendor slot unload, and the plugin's refusal of a slot with no loaded
   item — are unchanged, and the v1.9.22 guards on them hold; a native change could not be verified here at all
   (no simulator, no device), which is why this card fixed the layer it could read and run.
3. **Two departures from §24, stated plainly.** (a) §24.7 rejects *"keeping it on 'spectrum…' indefinitely while
   nothing is attached"*. This fix does keep the third word in that state — the engine cannot tell *"will never
   attach"* from *"still attaching"* without a clock, and the alternative is the false capability claim the card
   exists to remove; so the state is *named* on the reason line, the remedy is the plugin's own item-keyed answer,
   and the only terminations left are the tap's answers about this item (silence, frozen, or no tap in the build).
   If Sage judges that a never-attaching tap must eventually say *native audio*, that is a new input (a refusal
   carrying the plugin's own reason for this item) and belongs on its own card, not in a timing budget.
   (b) The 5 s slow poll is deleted, so the reads stay at 30 Hz for as long as a native track plays; the poll
   already reads one frame at a time, and the trade is that a tap which recovers is drawn on the next frame
   instead of up to five seconds later.
4. **What the harness cannot see** is the same list as §24.5 plus one: the fake decides `frames` growth and
   `attached`; a phone's plugin decides them from a real item. The falsification Sage should run is §25.3's first
   command against a build that has the change — and on the owner's phone, one change of track with the reason
   line open: the chip's third word until the tap's first frame, and *never* the sentence *"reading digital
   silence"* about an item whose tap has produced nothing.

## 26. v1.9.24 — the release that carries the per-item spectrum fact and the row's accessible name (2026-10-16)

§25 (`b760253`, the spectrum fix) and §23 (`acd4822`, A11Y-1) were both on `main` and **unreleased** when they were
written, and both said so. This is the cut that stamps and ships them: one release carrying those two commits and
nothing else — the two docs-only commits since the `v1.9.23` tag (`0af06b0`, `c636ca5`) change no code and are in
the build only as history. What is new here is only what a release adds: the version, the evidence for the release
as a whole, and the artifact.

### 26.1 What was run, and the counts for this cut

```
$ npm run typecheck             # tsc --noEmit — clean
$ npm test                      # 256 tests, 256 pass, 0 fail, 0 cancelled, 0 skipped, 39.8 s
$ npm run build                 # build #1 — tsc --noEmit && vite build → dist/assets/index-it8C1qaH.js
$ node tools/mock-subsonic.mjs --port 4691 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4691 --online-playlist pl-stress-long
                                # 42 checks ok, 0 FAIL, exit 0
$ node tools/spectrum-proof.mjs --url http://127.0.0.1:4691
                                # exit 0
$ npm run ipa:unsigned          # build #2 + cap sync ios + one xcodebuild → the artifact in §26.5
$ npm run build                 # build #3 — the fresh build of the commit compared to the shipped bytes
```

**Three `vite build`s** (build #1 for the readings, build #2 inside `ipa:unsigned` for the artifact, build #3 for
the byte comparison), **one `xcodebuild`**, **one `npm test`**, **two `offline-check` runs**, **one
`spectrum-proof` run**. The harness ran twice because the first run's exit code was lost inside the pipeline it was
captured through: the identical command was run again to capture the code. Both runs report the same thing — 42
checks `ok`, 0 `FAIL` — and the tool exits non-zero on any check that fails or cannot be made, so the second run's
`exit 0` is the verdict and the first is the count.

### 26.2 `npm test` is the release check as well as the suite

`test/changelog.test.ts` compares `CHANGELOG.md` with `src/ui/changelog.ts` item for item and asserts the version
list ends at 1.9.24, so a bump that touched only part of `docs/VERSIONING.md` §3's list fails there. It ran **256
tests, 256 pass, 0 fail, 0 cancelled, 0 skipped, in 39.8 s** — §25's count, with no test added or removed by this
cut (the bump edits the release check's own list).

### 26.3 The harness's 42 checks, on this release's build

Every check is `ok` and none is `FAIL`. The one this cut exists for reads, in the harness's own words:

```
The row the server named, read on the route it was drawn on, with no navigation:
    as the route drew it: ["","Play , downloaded"]
    once the store had named it: ["Track 1 · 110/330/1320 Hz","0:20","Play Track 1 · 110/330/1320 Hz, downloaded"]
ok    the row the server named reads as its title and its accessible name in the same reading, on the route (v1.9.23)
```

That is A11Y-1's own check (§23.2's §2e reading) on the released bundle: the visible title and the accessible name
arrive in the same pass, which is the second item in this release's changelog. The rest of the 42 are the block
§18–§23 built, unchanged by this cut: the five race cases with their controls and the second-Enter check, the
Library's own door into the downloaded music with the API refused, the two failure paths and the bounded sweep, the
metadata repair read on the screen it was reported on and on the bar of the track that is playing, and the
one-row-per-playlist readings.

### 26.4 The spectrum proof

The spectrum is this cut's subject, so the proof was run against the same build. It changes no visualiser code, so
this is the release's own baseline rather than this fix's evidence — §25.3 is that:

- playing: **30,905** lit pixels (checksum 521414949) · 3 columns with a second run of lit pixels · 0 lit below the
  baseline;
- pause: **668** lit pixels at +700, +900, +1200 and +1500 ms, the last three **byte-identical**;
- settled frame: 0 columns with a second run of lit pixels, 0 lit below the baseline.

### 26.5 The artifact, and the bytes it carries

```
$ npm run ipa:unsigned
** BUILD SUCCEEDED **
built  artifacts/Navilite-1.9.24-unsigned.ipa
bytes: 1,028,192          (v1.9.23: 1,027,907 — +285, +0.03 %)
app version 1.9.24 (45), UIBackgroundModes[0]=audio
```

Read out of the archive itself, not out of a source file:

```
$ unzip -p artifacts/Navilite-1.9.24-unsigned.ipa Payload/App.app/Info.plist | plutil -p - \
    | grep -E 'CFBundleShortVersionString|CFBundleVersion'
  "CFBundleShortVersionString" => "1.9.24"
  "CFBundleVersion" => "45"
```

`artifacts/Navilite-1.9.24-unsigned.ipa` is 1,028,192 bytes, sha256
`d6d59c85957a6129f5114b00f59fc6c8b71c560c641ed37e550b854a1fe01d8d`, and `file` reads it as a real zip archive
carrying `Payload/App.app/`.

Every hashed asset is **byte-identical in all four places it exists** — the three builds of this commit and the
member inside the IPA:

| asset | sha256 — identical in build #1, build #2, build #3 and the IPA |
| --- | --- |
| `index-it8C1qaH.js` (198,307 B) | `cda60f8ea4eab157297bd810405aefdd7d0b752e0975e662f8377a2346848198` |
| `index-F6_Re_h1.css` (14,005 B) | `9316db8712117f190a34005bf1ba3f0221eab5aeb3ee32c61056932c35b522ef` |
| `base-jY13WPav.js`, `esm-CEnHiZDq.js`, `esm-xH0U1Vfy.js`, `native-Cu_lWe8Y.js`, `web-CfmDQGfG.js`, `web-DloB7lCe.js` | `73c25724…`, `09e96d30…`, `26a3903d…`, `a3c42f14…`, `b2209008…`, `6fd514dd…` |
| `sw.js` | `138447434e0061da16bd832493b9b3c6cad8ad4b78d2b19384f6bc767c61f20d` (stamped `08e7681`, the commit it was built from) |

The previous release's chunk was `index-Bnzfna-r.js` (198,054 B, sha256 `bb57b25b…0d88`), so this is not v1.9.23's
bundle — and this fix is *in* it, read against that chunk as the control. The identifiers are the minified ones the
bundle keeps (private fields and methods), so the reading is of the shipped bytes, not of the source:

| in the bundle | v1.9.23's chunk | v1.9.24's chunk |
| --- | --- | --- |
| `spectrumRechecks` (the three-re-check budget) | 1 | **0** |
| `retrySpectrumOnce` (the 5 s retry) | 1 | **0** |
| `slowSpectrumPoll` (the timed slow read) | 1 | **0** |
| `tapFramesForItem` (the per-item counter) | 0 | **1** |
| `forgetTapFrames` (the rewind when the tap leaves the item) | 0 | **1** |
| `the tap is on the item the player has moved off and would not re-attach` | 1 | **0** |
| `nothing is attached to the item that is playing — asking the plugin to put a tap on it` | 0 | **1** |
| the 1.9.24 changelog's two sentences | 0 | **1 and 1** |

The word that was spent by a clock is gone from the shipped bytes and the fact that replaces it is in them; the
changelog sentences are in there too, but they say only that the *changelog* shipped, since they are written once
and grow with every release. The identifiers are the fix.

**Order of operations, and what was built.** The release body was committed first (`08e7681`), `dist/` was rebuilt
from that commit for the readings above, and the IPA was made from the same build — `docs/VERSIONING.md` §6's
order. All three builds of this commit are byte-identical in every asset **including `sw.js`**, which is what three
builds of one commit should be (v1.9.20's artifact carried its parent's short SHA inside `sw.js`, the deviation
§20 records). The tag `v1.9.24` sits on `08e7681`, the commit the IPA was built from; this section is the one
commit after it, written from that build's readings, and the tree is clean at `origin/main`.

### 26.6 Not verified here, and not claimed

1. **His phone.** Everything above is a read of the shipped bytes and of Chrome at 393 × 852 on this Mac against
   the mock; no device, no simulator, no native mixer. The chip's third word across a real track change is
   §25.5 note 1's answer, still his to give.
2. **The state this release deliberately leaves open.** A tap that is attached to this item and producing nothing,
   or a request that never lands, keeps the chip on *"spectrum…"* for the whole track where v1.9.23 eventually said
   *native audio* — §25.5 note 3(a) and item 4 of `DECISIONS.md`'s 1.9.24 entry. It is a known open state, filed as
   `t_aedab91d` (the plugin's own refusal reason for this item, never a timer), and it is **not** written as fixed
   in the changelog. Nothing in this release changes it.
3. **The installed IPA.** Unsigned on purpose (§15.4, `docs/ios-sideload.md`); the sideload and the 7-day re-sign
   are the owner's own steps. The announcement VoiceOver actually makes (§23.5 note 1) and whether the mix lands on
   a `file://`-backed `AVPlayerItem` (§24.8, §25.5 note 1) are his install's answers.
4. **The review's two P3 notes** (`t_d7dd3e62`'s F2 and F3): the stale *"native audio"* flap when the plugin
   reports a not-playing player after this item's tap has answered live, and the plugin's PCM ring not being zeroed
   on a re-install. Both are pre-existing, neither is this cut's subject, and neither changed here — and the
   Swift/ObjC half is untouched by it (no file under `ios/` or `tools/` changed).
5. **Android.** No APK was built for 1.9.24 (`versionCode` is bumped to 44 so the next one carries it), so nothing
   here is evidence about the APK.

Raw runs behind the tables and the counts (agent scratch, attached to the release card `t_bd2d1dae`):
`npm-test-1924.txt`, `offline-check-1924.txt`, `offline-check-1924-run2.txt`, `offline-check-1924.json`,
`spectrum-proof-1924.txt`, `ipa-build-1924.txt`, `assets-ipa-vs-dist-1924.txt`,
`assets-fresh-build-vs-ipa-1924.txt`, `chunk-identifiers-1924.txt`, `chunk-strings-1924.txt`.

## 27. v1.9.25 — the release that carries the tap's own pace (2026-10-16)

`2e1eb9d` (`DECISIONS.md` §516 — an item's tap owns its own analysis) and `c234e58` (§516.1 as amended — the drawing
rule is the tap's own frame pace, not one frame per poll) were both on `main` and **unreleased** when they were
written, and both said so. This is the cut that stamps and ships them: one release carrying those two commits and
nothing else. The open state behind them (`t_aedab91d` — a tap refused for a whole track keeps *"spectrum…"*, owner's
call: leave it) is not this cut's subject and is deliberately **not** written as fixed.

### 27.1 What was run, and the counts for this cut

```
$ npm run typecheck             # tsc --noEmit — clean
$ npm test                      # 258 tests, 258 pass, 0 fail, 0 cancelled, 0 skipped, 36.6 s
$ node tools/mock-subsonic.mjs --port 4691 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4691 --online-playlist pl-stress-long
                                # 42 checks ok, 0 FAIL, exit 0
$ node tools/spectrum-proof.mjs --url http://127.0.0.1:4691
                                # exit 0
$ npm run ipa:unsigned          # one vite build + cap sync ios + one xcodebuild → the artifact in §27.4
```

**One `npm test`**, **one `offline-check` run**, **one `spectrum-proof` run**, **one `typecheck`**, **one `vite
build`** (inside `ipa:unsigned`) and **one `xcodebuild`**. Each ran once for this cut: the runs are the release
record, not a loop.

### 27.2 The suite, and the release check

`npm test` — **258 tests, 258 pass, 0 fail, 0 cancelled, 0 skipped, 36.6 s**, the same count `c234e58` was verified
at (this cut adds no test). The one test file it edits is the release check itself: `test/changelog.test.ts` compares
`CHANGELOG.md` with `src/ui/changelog.ts` item for item and asserts the version list ends at 1.9.25, so a bump that
touched only part of `docs/VERSIONING.md` §3's list fails there. `tsc --noEmit` prints nothing.

### 27.3 The harness's 42 checks, and the spectrum proof

The harness's 42 checks are the block §18–§23 built, unchanged by this cut: every one `ok`, none `FAIL`, exit 0 (a
downloaded playlist is browsable with no connection, one row per playlist, the Library's own door into the
downloaded music with the API refused, nothing printing a URL at him, a view left mid-answer not painting over the
screen he moved to). The spectrum proof is this cut's subject, so it was run against this build as the release's own
baseline:

- playing: **30,663** lit pixels (checksum 999837626) · 3 columns with a second run of lit pixels · 0 lit below the baseline;
- pause: **668** lit pixels at +700, +900, +1200 and +1500 ms, the last three **byte-identical**;
- settled frame: 0 columns with a second run of lit pixels, 0 lit below the baseline.

It drives the mock's own audio in Chrome on this Mac; it says nothing about the native tap (§27.5 note 1).

### 27.4 The artifact, and the bytes it carries

```
$ npm run ipa:unsigned
** BUILD SUCCEEDED **
built  artifacts/Navilite-1.9.25-unsigned.ipa
bytes: 1,030,943          (v1.9.24: 1,028,192 — +2,751, +0.27 %)
app version 1.9.25 (46), UIBackgroundModes[0]=audio
```

Read out of the archive itself, not out of a source file:

```
$ unzip -p artifacts/Navilite-1.9.25-unsigned.ipa Payload/App.app/Info.plist \
    | plutil -p - | grep -E 'CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion'
  "CFBundleIdentifier" => "app.navilite"
  "CFBundleShortVersionString" => "1.9.25"
  "CFBundleVersion" => "46"
```

`artifacts/Navilite-1.9.25-unsigned.ipa` is 1,030,943 bytes, sha256
`2db878633ff85e2e1c8051515c875e2c6ea10ecd5b044402528ded53d4ae750b`, and `file` reads it as `Zip archive data, at
least v1.0 to extract`, carrying `Payload/App.app/` — 47 files, `Payload/App.app/App` among them. Every hashed asset
in `dist/` is **byte-identical to the same member inside the IPA** (`index-C3B39aWG.js`, `index-F6_Re_h1.css`,
`base-BUcoc2DZ.js`, `esm-BBR6i2z5.js`, `esm-ImJRG9Mc.js`, `native-CGnyy8ei.js`, `web-C36wsTzt.js`,
`web-yw7QHmtH.js`), and `sw.js` is stamped `ead25fb` — the commit the IPA was built from and the commit the tag
`v1.9.25` sits on.

The fix is *in* the shipped bytes, read against the previous release's chunk as the control:

| in the bundle | v1.9.24's `index-it8C1qaH.js` (198,307 B) | v1.9.25's `index-C3B39aWG.js` (201,127 B) |
| --- | --- | --- |
| `framePeriodMs` / `frameAgeMs` / `itemFramePeriodMs` (the tap's own pace, published) | 0 / 0 / 0 | **2 / 2 / 2** |
| `tapFramesForItem` (the per-item counter) | 4 | **8** |
| `itemFrames` (the frames this analysis produced for this item) | 0 | **6** |
| `spectrumRechecks`, `retrySpectrumOnce`, `slowSpectrumPoll` (the three shapes v1.9.24 deleted) | 0 | 0 |

The old chunk hashes to `cda60f8ea4eab157297bd810405aefdd7d0b752e0975e662f8377a2346848198` — §26.5's own value, so
the v1.9.24 artifact is the one that record was written about and this cut changed nothing inside it. The new chunk
is `2d2761601e76cef19465ec0afd6fbda970fa29d9f5283ed734693ba4dbaa859f`.

**Order of operations.** The release body was committed first (`ead25fb`) with a clean tree, then tagged, then the
IPA was built from that commit — `docs/VERSIONING.md` §6's order. The tag `v1.9.25` is on `ead25fb`, the commit the
IPA was built from; this section is the one commit after it, written from that build's readings.

### 27.5 Not verified here, and not claimed

1. **His phone.** Everything above is a read of the shipped bytes and of Chrome at 393 × 852 on this Mac against the
   mock; no device, no simulator, no native mixer. The native `prepare`/`unprepare` ordering, the tap's real
   `maxFrames` / frame period, and the bars being live on his phone after a skip out of a loud passage are
   **unverified on device** — the two numbers the banner prints beside the tap line (`framePeriodMs`, `frameAgeMs`)
   are how one skip settles them, and that reading is his to give.
2. **The residual §516.1 names.** The frame is stamped on the 10 ms drain timer, so a real inter-frame interval about
   10 ms long can still leave a single poll whose age is past the declared period — one dark canvas window, one poll
   of *"spectrum…"*, recovering on the next frame. This cut does not change it and does not claim it.
3. **The state this release deliberately leaves open.** A tap refused for a whole track keeps *"spectrum…"*
   (`t_aedab91d`; the owner's call was to leave it). It is **not** written as fixed in the changelog, and nothing in
   this release touches it.
4. **The installed IPA.** Unsigned on purpose (§15.4, `docs/ios-sideload.md`); the sideload and the 7-day re-sign are
   the owner's own steps.
5. **Android.** No APK was built for 1.9.25. `versionCode` is bumped to 45 and `versionName` to 1.9.25 so the next
   APK carries them (`docs/VERSIONING.md` §3 does not require an APK for the parity), and nothing here is evidence
   about the APK.
6. **The two P3 notes §516's review left** — the unmeasured *"two reads in three"* figure in `c234e58`'s message and
   in §516.1, and the abnormal banner printing `0` / `-1` rather than *"—"* for a publishing-but-unprepared
   analysis — are pre-existing, neither is this cut's subject, and neither changed here.

Raw runs (agent scratch, attached to the release card `t_90ebc65f`): `typecheck-1925.txt`, `npm-test-1925.txt`,
`offline-check-1925.txt`, `spectrum-proof-1925.txt`.

## 28. the chip said *native audio* for a paused track on a playlist page — the word was a capability claim reached by elimination (2026-10-16, unreleased)

Card `t_9329e3b0`. The owner, on the v1.9.24 build he had just installed, with a track loaded and **paused** at
1:28 / 4:55 on the playlist page for `Jap` — his screenshot reading `NATIVE AUDIO` on the mini-player over
`paused · native · spectrum off · player: paused · pause`:

> *"the spectrum always works but on the playlist pages, the bottom bar seems to keep flashing to native audio
> spectrum off even though the spectrum is working fine"*

**No version is bumped, no IPA/APK is built, the `CHANGELOG.md` release heading is untouched** — this is the fix,
its two harnesses and a commit; the release is its own card, after review.

### 28.1 The defect, in one paragraph

The chip's word was built in the UI out of three fields — `src/ui/app.ts:3356`:

```
status.spectrum ? 'spectrum' : status.spectrumArming ? 'spectrum…' : status.backend === 'native' ? 'native audio' : 'theme'
```

`spectrumArming` is only ever reported while a native track is *playing* (`spectrumArming: this.spectrumArming &&
this.backend === 'native' && this.state === 'playing'`), so the expression's third branch was reached **by
elimination** by every state that is not playing: `paused`, `ended`, `interrupted`, `loading`, and "a track is
loaded but nothing has been played". `native audio` is the word for *"the spectrum cannot run on the item playing
now"*, so a stopped transport was announcing a capability the app has not lost — and on a playlist page, which is
where his rows are, that word came and went at every pause and every change (`ended` while the next track loads,
`paused` with the transport sitting still). It is the same class as v1.9.24's defect, one layer up: a word about a
capability, decided by something that is not evidence about it.

### 28.2 What changed

| file | why |
| --- | --- |
| `src/player/engine.ts` | **the word is one fact, on the status** (`EngineStatus.visualiser: { word, tone }`, `VisualiserWord`, `VisualiserTone`), computed in one place (`visualiser` / `visualiserWord`) from facts only the engine has: the state, the backend, whether the bars are being fed, whether the tap is being asked, and — the fact the UI could not read at all — **whether this build can measure the item in hand**. `measuringPathForTheItem()` is that fact and it is deliberately **three-valued**: `tap`/`analyser` (the path exists), `none` (an *evidenced* absence: a bridge that is built and reports `hasNativeSpectrum: false`, a browser whose Web Audio graph could not be built) and `unknown` (nothing has answered yet — a bridge still being built is a load in progress, and a build that fails reports `error`). Only `none` spends a capability word. Every transport state's word is a total `Record` (`STOPPED_WORD`), so a state added to `EngineState` does not compile until its word is written. `hasSpectrumTap()` is now the one place both `startConsumers` and the word ask the tap question |
| `src/ui/app.ts` | the chip **prints** `status.visualiser.word` and wears `status.visualiser.tone` — the three-field expression is deleted, with the reason it was wrong written where it stood; the app's own `loading…` (the tap's synchronous paint, v1.9.0, whose input `queue.isLoading` is the queue's) is kept, and the comment that said *"`native audio` is what this chip says for every state that is not playing"* is corrected |
| `src/styles.css` | `.mode-chip.stopped` — the fourth tone, dim: a pause is neither a measurement (green) nor a fallback (amber). v1.9.6 made the same argument for `arming` |
| `README.md` | the sentence claiming *"the mode chip on the player bar and the now-playing screen"* is corrected: the bar's chip is the app's **only** one (the now-playing screen lost its own in v1.1, `2ed9ed7`), which is why "two surfaces cannot disagree" reduces to one field and one node |
| `test/engine-native.test.ts` | the v1.9.26 case: `chipWord()` reads `EngineStatus.visualiser.word` and, on a tree that predates the field, **the chip's own pre-fix expression** — so the fail-before is the *word* and not a missing property; the fake can now state a build with no tap at all (`hasSpectrum: false`) |
| `test/chip-word-browser.test.ts` | **new**: the real app in Chrome at 393 x 852 over the mock library, reading `.mode-chip`'s own text at each state on a playlist page — plus every distinct word the chip wears during the run, with the millisecond it changed at |

### 28.3 The fail-before, and the same check after

Both harnesses first ran against the tree as it stood at `8689a2e` (the fix not applied). **The native word** — the
one in his screenshot — needs the native backend, so it is the engine harness:

```
$ node --test --test-name-pattern 'never a capability it still has' test/engine-native.test.ts   # before
    1. a cold start: state loading — the chip reads "native audio"
    2. playing: spectrum true — the chip reads "spectrum"
    3. paused: state paused, spectrum false, arming false — the chip reads "native audio" (paused — the spectrum is a picture of what is being heard)
✖ the chip’s word is the transport’s when the transport is the reason — never a capability it still has (v1.9.26)
  AssertionError: the chip says what the transport is doing — not his "native audio", which is a claim about a capability this build still has
  + 'native audio'
  - 'paused'
ℹ tests 1 · pass 0 · fail 1 · duration_ms 754.2
```

The word the whole card is about, on a paused track, from the shipped expression. The same over the whole suite —
the browser harness, whose backend is `web` and therefore reaches the *other* branch of the same expression
(`theme`), on the screen he photographed:

```
$ node --test --test-name-pattern 'the chip’s word on the screen he photographed' test/chip-word-browser.test.ts   # before
      4. PAUSED (his screenshot): chip "theme" · state paused · spectrum false
      5. still paused, on the playlists screen: chip "theme" · state paused
      6. still paused, back on a playlist page: chip "theme" · state paused
      7. the now-playing screen: chip "theme" · state paused
           429 ms  "theme"   (the chip changed, state playing)
          1402 ms  "theme"   (the chip changed, state paused)
          2104 ms  "theme"   (paused, on the playlist page (his screenshot), state paused)
          2476 ms  "theme"   (still paused, on the playlists screen, state paused)
          2848 ms  "theme"   (still paused, back on a playlist page, state paused)
          3267 ms  "theme"   (the now-playing screen, state paused)
✖ AssertionError: paused on a playlist page reads the transport's own word, not a capability (was "theme")
  'theme' !== 'paused'
```

Each paused reading, and the run of changes with the transport standing still, all wearing the capability word.
After the change, both harnesses, one command:

```
$ node --test --test-name-pattern 'chip’s word' test/engine-native.test.ts test/chip-word-browser.test.ts   # after
      1. the tap: chip "loading…" ... engine word "loading" · tone "stopped"
      2. playing: chip "spectrum" ... engine word "spectrum" · tone "live"
      3. playing, browsing the playlist page: chip "spectrum" · state playing
      4. PAUSED (his screenshot): chip "paused" · state paused · spectrum false · engine word "paused" · tone "stopped"
      5. still paused, on the playlists screen: chip "paused" · state paused
      6. still paused, back on a playlist page: chip "paused" · state paused
      7. the now-playing screen: chip "paused" · state paused · 1 chip node ["paused"]
      8. resumed: chip "spectrum" · state playing · spectrum true
      9. mid track change: chip "spectrum" · state playing
     10. the new track playing: chip "spectrum" · state playing
      every distinct word the chip wore (18): loading… (310 ms) · theme (330 ms) · spectrum (428 ms) · paused (1279 ms) · … · spectrum (4485 ms)
      of those, worn while the transport was not playing: ["loading…","paused"] (8 changes)
✔ the chip’s word on the screen he photographed: a paused track on a playlist page is not a capability claim (5197.4ms)
    1. a cold start: state loading — the chip reads "loading"
    2. playing: spectrum true — the chip reads "spectrum"
    3. paused: state paused, spectrum false, arming false — the chip reads "paused" (paused — the spectrum is a picture of what is being heard)
    4. the new item’s tap has produced nothing: arming true — the chip reads "spectrum…"
    5. the track ended: state ended — the chip reads "ended"
    6. a build with no tap: spectrum false, spectrumArming false — playing, the chip reads "native audio"
    7. the same build, paused: the chip reads "native audio" — the truth about the build, not about the transport
✔ the chip’s word is the transport’s when the transport is the reason — never a capability it still has (v1.9.26) (3334.3ms)
ℹ tests 2 · pass 2 · fail 0 · duration_ms 5283.4
```

Read as the card reads it: **every transport state has its own word** (a load → `loading`, playing → `spectrum`,
an item whose tap has not answered → `spectrum…` (unchanged, §515.4), the end of a track → `ended`, paused →
`paused`), the capability word is reachable **only** where the capability is genuinely absent — a build with no tap
wears `native audio` playing *and* paused, because that is a fact about the build — and the engine's field is what
the DOM prints (asserted on `playing`, `paused` and `resumed`: `onScreen === status.visualiser.word`), with the one
chip node on the now-playing screen reading the same word.

### 28.4 The suite, the invariant in the code, and what the change is not

| check | reading |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` clean |
| `npm run build` | `tsc --noEmit` + `vite build` clean → `dist/assets/index-C41QBNo6.js` (201.79 kB, gzip 63.66 kB) |
| `node --test "test/*.test.ts"` | **260 tests, 260 pass, 0 fail, 0 skipped** in 37.1 s (258 before this card, +2: the engine case and the new browser probe) |

The invariant is stated where it is enforced, in the engine:

> *Nothing is being measured, and there are two different reasons … First the question the UI could not ask: **can
> this build measure this item at all?** An evidenced `none` is the only thing the capability words are allowed to
> mean.* (`visualiserWord`, `src/player/engine.ts`)

An audit of the final file holds it: the only two writers of `native audio` / `theme` in the word are the evidenced
`none` and the *playing* line whose words §515/§516 settled; every other state returns `STOPPED_WORD[state]`. No
transport state can reach a capability word, a state added to `EngineState` cannot compile without a word, and the
one field is what the UI prints — no second expression exists in the app. Nothing is masked: the word is recomputed
on every status event from current facts, the branch is replaced rather than frozen or deleted, the legitimate case
is *more* reachable (a no-tap build, in every transport state), `spectrumArming`/`spectrumLive` and every verdict
keep their meaning, and no file under `ios/`, `android/` or `tools/` changed.

### 28.5 Not verified here, and not claimed

1. **No phone and no simulator.** The native readings are the real `AudioEngine` through the fake bridge; the
   browser readings are the real app in Chrome, whose backend is `web` — so his screenshot's exact word
   (`NATIVE AUDIO`) is reproduced on the harness and the *same* defect on the screen is reproduced as `theme`, the
   other branch of the same expression. That the chip on his IPA now reads `paused` is a claim about the same code
   path, not a reading off his device.
2. **The ~90 ms web window is unchanged and is *not* claimed to be gone.** On the web path a *playing* item whose
   analyser has not yet produced its first frame wears `theme` (the meter samples every 100 ms), and a
   cross-origin stream with no ACAO wears it from the verdict on. That is the pre-existing web verdict timing — no
   transport state is involved, the native equivalent has been covered by `arming` since v1.9.6 — and the probe's
   sequence assertion is therefore filtered on the transport state rather than on the whole run. It is named here
   because it looks like the same defect and is not.
3. **The transport word for `ended` / `interrupted` is defined and only partly exercised.** `ended` is read on the
   harness (after `TRANSPORT_MUTE_MS`, which is the app's own rule about a completion arriving on the back of a
   transport); `interrupted` and `error` are exercised nowhere in this card — their words are in the total `Record`
   the compiler enforces, and no probe has read them off the screen.
4. **What the harness cannot see** is the phone's own transport: the fake decides `hasNativeSpectrum` and the
   bridge's build timing, and a real device decides them from the plugin. The falsification to run is §28.3's first
   command against a tree without the fix (it reads *native audio* while paused), and then on his build: pause a
   track on a playlist page and read the chip — `paused`, not `native audio`.

## 29. v1.9.26 — the release that carries the bar's word as a fact about the song in hand (2026-10-16)

`d769fd4` (`DECISIONS.md` §t_9329e3b0 — the chip's word is a fact about the item in hand, never a capability
reached by elimination) was on `main` and **unreleased** when it was written, and it said so. This is the cut that
stamps and ships it: one release carrying that one fix and nothing else. The other commit between it and the
v1.9.25 tag (`8689a2e`, the v1.9.25 verification record) is docs only and is in the build as history. **Nothing
else on `main` was unreleased and verified** — the sweep for this cut, run rather than assumed:

```
$ git log --oneline v1.9.25..HEAD
d769fd4 fix(unreleased): the chip's word is a fact about the item in hand, never a capability reached by elimination (v1.9.26)
8689a2e docs(v1.9.25): the release verification record — the counts, the harness's 42 checks, the artifact read back out of the IPA, and what is not claimed
```

Two non-code corrections the fix's verification required (`t_1c2d1c51`'s comment on this card) are in this cut's
release commit, because this is the card that writes these files: `README.md`'s sentence about the now-playing
screen — **false as written**, since the bar's chip is in the DOM there and the now overlay paints over it — and
`DECISIONS.md` §t_9329e3b0.5 with it, plus the browser harness's now-screen assertion (§29.2). No production code
changed in the cut; the diff is the seven version files, the two changelog copies, the release check, the two
docs, and one test file.

### 29.1 What was run, and the counts for this cut

```
$ npm run typecheck             # tsc --noEmit — clean
$ npm run build                 # tsc --noEmit + vite build — clean
$ npm test                      # 260 tests, 260 pass, 0 fail, 0 cancelled, 0 skipped, 36.2 s
$ node tools/mock-subsonic.mjs --port 4691 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4691 --online-playlist pl-stress-long
                                # 42 ok, 0 FAIL, exit 0
$ node tools/spectrum-proof.mjs --url http://127.0.0.1:4691
                                # exit 0
$ npm run ipa:unsigned          # one vite build + cap sync ios + one xcodebuild → the artifact in §29.4
$ npm run build                 # a second vite build, for §29.4's byte-for-byte
```

**Two `vite` builds** (one inside `ipa:unsigned`, one fresh for the reproducibility read), **one `xcodebuild`**,
**one `npm test`**, **one `offline-check`**, **one `spectrum-proof`**, **one `typecheck`**. Each harness ran once
for this cut: the runs are the release record, not a loop.

### 29.2 The suite, and the release check

`npm test` — **260 tests, 260 pass, 0 fail, 0 cancelled, 0 skipped, 36.2 s**, the same count `d769fd4` was verified
at (this cut adds no test; it rewrites one assertion). The release check is `test/changelog.test.ts`: it compares
`CHANGELOG.md` with `src/ui/changelog.ts` item for item and asserts the version list ends at 1.9.26, so a bump that
touched only part of `docs/VERSIONING.md` §3's list fails there. `tsc --noEmit` prints nothing.

**The assertion §28's verification would not let stand, and what it reads now.** `t_1c2d1c51` measured that the
now-playing screen paints an opaque overlay over the bar, so the old wording — *"the now-playing screen has the
chip on it"*, *"every one of them reads the same word"* — was a claim about a node the owner cannot see. It now
reads one node, one field, and **measures** the coverage (`elementFromPoint` at the chip's own centre) instead of
implying that both surfaces show the word. From this cut's own run:

```
      7. the now-playing screen: chip "paused" (whole text "paused") · state paused · spectrum false · arming false · engine word "paused" · tone "stopped"
      chip nodes on the now-playing screen: 1 ["paused"]
      on the now-playing screen the chip's own centre is painted by: SECTION.now — the chip itself: false
```

So the assertion is the invariant that survives the measurement — one node, one field, therefore nothing can
disagree — plus the coverage itself, and the two docs now say what is true of that screen (`README.md`,
§t_9329e3b0.5).

### 29.3 The chip harness on this build, and the harness's 42 checks

The browser harness drove the real app in Chrome at 393 x 852 over the mock library, on a playlist page, and read
the chip's own text at each state. This cut's run:

```
      1. the tap:                               chip "loading…"   (state loading)
      2. playing:                               chip "spectrum"   (state playing)
      3. playing, browsing the playlist page:   chip "spectrum"   (state playing)
      4. PAUSED (his screenshot):               chip "paused"     (state paused)
      5. still paused, on the playlists screen: chip "paused"     (state paused)
      6. still paused, back on a playlist page: chip "paused"     (state paused)
      8. resumed:                               chip "spectrum"   (state playing)
      17 word changes over the run; the words worn while the transport was NOT playing:
      ["loading…", "paused"]  (8 changes)
```

Read as the card reads it: **a stopped transport never wore a capability word** at any point in the run — the
flashing he reported is gone on the surface he photographed — and every reading's on-screen text is the engine's
own field (`onScreen === status.visualiser.word`, asserted on `playing`, `paused` and `resumed`). The one
capability word in the whole run, `theme`, was worn at 747 ms **while the transport was playing**: §28.5.2's
pre-existing ~100 ms web window, unchanged by this cut, named rather than filtered away. The word his own
screenshot shows (`native audio`) needs the native backend, so it is read by the fake-bridge harness
(`test/engine-native.test.ts`, the v1.9.26 case) — inside the same 260.

The other harness is §18–§23's block, unchanged by this cut: **42 ok, 0 FAIL, exit 0** (a downloaded playlist is
browsable with no connection, one row per playlist, a mark on what is on this phone, the Library's own door into
the downloaded music with the API refused, nothing printing a URL at him, a view left mid-answer not painting over
the screen he moved to). The spectrum proof, run against this build as the release's own baseline:

- playing: **30,898** lit pixels (checksum 787030170) · 3 columns with a second run of lit pixels · 0 lit below the baseline;
- pause: **668** lit pixels at +700, +900, +1200 and +1500 ms, the last three **byte-identical**;
- settled frame: 0 columns with a second run of lit pixels, 0 lit below the baseline.

It drives the mock's own audio in Chrome on this Mac; it says nothing about the native tap (§29.5 note 1).

### 29.4 The artifact, and the bytes it carries

```
$ npm run ipa:unsigned
** BUILD SUCCEEDED **
built  artifacts/Navilite-1.9.26-unsigned.ipa
bytes: 1,031,417          (v1.9.25: 1,030,943 — +474, +0.046 %)
app version 1.9.26 (47), UIBackgroundModes[0]=audio
```

Read out of the archive itself, not out of a source file:

```
$ unzip -p artifacts/Navilite-1.9.26-unsigned.ipa Payload/App.app/Info.plist \
    | plutil -p - | grep -E 'CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion'
  "CFBundleIdentifier" => "app.navilite"
  "CFBundleShortVersionString" => "1.9.26"
  "CFBundleVersion" => "47"
```

`artifacts/Navilite-1.9.26-unsigned.ipa` is 1,031,417 bytes, sha256
`de3cfa4e78cbd0f674a7bacef384f4092339f35d8513ee367ab6ff3a9a06d414`, and `file` reads it as `Zip archive data, at
least v1.0 to extract`, carrying `Payload/App.app/` — 47 files, `Payload/App.app/App` among them. Every hashed
asset in `dist/` is **byte-identical to the same member inside the IPA** (`cmp`, not size): `index-Wt45tSM6.js`
(202,669 B), `index-QjmzHs0A.css` (14,071 B), `base-CjCcC5hK.js`, `esm-BrM5_ez1.js`, `esm-s3qbZ84j.js`,
`native-BJv4x2PT.js`, `web-BHkpBgb_.js`, `web-DG_fXUwG.js`; `sw.js` is stamped `28e7e91` — the commit the IPA was
built from and the commit the tag `v1.9.26` sits on. The copy `cap sync` wrote into the project
(`ios/App/App/public/assets/index-Wt45tSM6.js`) is that same file byte for byte.

**A fresh build of the release commit reproduces the shipped chunk.** The tree was clean at `28e7e91` when the
second `npm run build` ran, and every asset hashed to the value the build inside the IPA has: the shipped chunk
`index-Wt45tSM6.js` is 202,669 bytes, sha256 `66d2ec61baeacbbff9cee98f139c9df96985abc19fce5497c7056f6c64158cd2`,
and `cmp` against the member read out of the IPA reports no difference. For the control below, v1.9.25's chunk is
`index-C3B39aWG.js`, 201,127 bytes, `2d2761601e76cef19465ec0afd6fbda970fa29d9f5283ed734693ba4dbaa859f` — §27.4's
own value, so the v1.9.25 artifact is the one that record was written about.

The fix is *in* the shipped bytes, read against the previous release's own chunk as the control — both read out of
their IPAs, not from source:

| in the bundle | v1.9.25's `index-C3B39aWG.js` | v1.9.26's `index-Wt45tSM6.js` |
| --- | --- | --- |
| the UI's elimination expression, verbatim | ``let p=n.spectrum?`spectrum`:n.spectrumArming?`spectrum…`:n.backend===`native`?`native audio`:`theme` `` | 0 — **gone** |
| what the chip is painted from | `t.barChip.textContent=a?`loading…`:`${p}…``, from that expression | `let p=n.visualiser; … ${p.word}…` — the engine's field |
| `visualiserWord(` | 0 | 2 (the declaration and its call) |
| `measuringPathForTheItem(` | 0 | 2 |
| `p.word` / `ot[this.state]` (the field, and the total `Record` of transport words) | 0 / 0 | 1 / 1 |
| `visualiser` / `spectrumArming` occurrences | 5 / 14 | 11 / 12 |
| `native audio` occurrences (the word in code *and* in the changelog text he reads) | 12 | 16 |

**Order of operations.** The release body was committed first (`28e7e91`) with a clean tree, then tagged, then the
IPA was built from that commit — `docs/VERSIONING.md` §6's order. The tag `v1.9.26` is on `28e7e91`, the commit the
IPA was built from; this section is the one commit after it, written from that build's readings.

### 29.5 Not verified here, and not claimed

1. **His phone.** Everything above is a read of the shipped bytes and of Chrome at 393 × 852 on this Mac against the
   mock; no device, no simulator, no native mixer. That the chip on his IPA now reads `paused` on a paused track is
   a claim about the same code path, not a reading off his device (§28.5.1). One pause on a playlist page on the
   installed build is what settles it.
2. **The ~90 ms web window is unchanged and is *not* claimed to be gone** (§28.5.2, §t_9329e3b0.6). On the web path
   a *playing* item whose analyser has not yet produced its first frame wears `theme`, and this cut's own harness
   run shows it exactly once, at 747 ms in the `playing` state. It is named here because it looks like the same
   defect and is not; it has its own card (`t_71dc787e`, gated on this release).
3. **The transport words `ended` / `interrupted` / `error` are still only defined**, not read off a screen
   (§28.5.3). This cut changes no word and no state.
4. **Android.** No APK was built for 1.9.26. `versionCode` is bumped to 46 and `versionName` to 1.9.26 so the next
   APK carries them (`docs/VERSIONING.md` §3 does not require an APK for the parity), and nothing here is evidence
   about the APK.
5. **The installed IPA.** Unsigned on purpose (§15.4, `docs/ios-sideload.md`); the sideload and the 7-day re-sign are
   the owner's own steps.
6. **No production code changed in this cut.** The diff is the seven version files, the two changelog copies, the
   release check, `README.md`, `DECISIONS.md`, and one test file's now-screen assertion. The two P3 notes §516's
   review left are untouched, and neither is claimed here.

Raw runs (this machine's agent scratch, `/Users/neokester/.hermes/profiles/nerd/cache/scratch/runs-1926/`):
`typecheck-1926.txt`, `npm-test-1926.txt`, `offline-check-1926.txt`, `spectrum-proof-1926.txt`,
`ipa-build-1926.txt`; the readings they hold are condensed into `release-1.9.26-evidence.txt`, attached to the
release card `t_77e69a9b`.

## 30. the browser's own first-frame window was wearing the capability word — the web half of §515's word (2026-10-16, card `t_71dc787e`, unreleased)

**No version is bumped, no IPA/APK is built, no tag is written and the `CHANGELOG.md` release heading is
untouched.** This is the fix, its two harnesses, `DECISIONS.md` §t_71dc787e and this record — an unreleased fix
like its predecessor (`d769fd4`), whose release was its own card.

### 30.1 The defect

Sage, verifying `t_9329e3b0`, read the real app in Chrome at 393 x 852 over the mock library (`d769fd4`) and
printed the probe's own word list — **every distinct word the chip wore, with the state it wore it in**:

```
384 ms  "theme"      (the chip changed, state playing)
512 ms  "spectrum"   (the chip changed, state playing)
```

`theme` is the amber `fallback` tone and it means *"this browser has no Web Audio, or this item's samples are not
real"*. The transport was **playing**, the graph was built, and the bars arrived 128 ms later — so the app was
announcing the loss of a capability it has. At `8689a2e` the same window is 99 ms, i.e. pre-existing, not a
regression from the v1.9.26 fix.

The licence it was reached by is the second one in `visualiserWord`:

```
if (this.state === 'playing') return this.backend === 'native' ? 'native audio' : 'theme';
```

— taken whenever the bars were not being fed. The native path has a word for "installed, not answered yet"
(`arming`, v1.9.6, which v1.9.26 made the chip's own); the web path had **no window at all** between
`createMediaElementSource` and the analyser's first real frame, so that window fell through to the capability
claim. The same window exists on the web path at a **resume** (the meter's first sample after `playing` returns),
which the card did not name and this record does: at `d769fd4` the pre-fix run wore `3139 ms "theme"` →
`3254 ms "spectrum"` at the resume, i.e. 115 ms of amber on a stream that was measuring fine.

### 30.2 What changed

| file | why |
| --- | --- |
| `src/player/engine.ts` | **the web path's arming window, from its own register** — `analyserArming()` is true when the backend is `web`, an analyser exists, `spectrumLive` is false and fewer than `ZERO_FRAMES_BEFORE_THEME` (18) frames have come back unusable; `status()` computes `spectrumArming` as *playing* AND (`spectrumArming` \|\| `analyserArming()`), the same question asked of the two ways of measuring, and never true while `spectrum` is true. `startWeb` clears `zeroFrames` / `identicalFrames` / `lastChecksum` for the item that is starting — the web half of `forgetTapFrames` (v1.9.24) — so a new item's window and verdict are its own. `visualiserWord`'s playing branch (the licence) is now reached on this path only by the item's own verdict, and the comment there says so. No word was added and no word was removed |
| `README.md` | one sentence: `spectrum…` is worn *"while the tap or the analyser is still answering for it"* — it said *native tap* only |
| `test/engine-native.test.ts` | the fake analyser can now answer **nothing** (`setSilent`), and the new case drives the window, that item's own verdict, the verdict surviving a pause and a resume, the bars and the word coming back on a real frame, and a track change onto an unmeasurable item wearing *its own* window |
| `test/chip-word-browser.test.ts` | the probe can be asked to **linger** on the last item, the word list now carries the reason at each change, the ordinary run asserts **no capability word while `state === 'playing'`**, and a **second run** over a library the app is cross-origin with (`--no-cors-stream`) asserts the other half: `spectrum…` first, then the item's own verdict as `theme`, with the sentence that names it |

### 30.3 The fail-before, and the same checks after

Both harnesses first ran against the tree as it stood before the fix (`HEAD`, `28e7e91`).

**The engine, on the fake analyser** — the window, with an analyser that has answered nothing:

```
$ node --test --test-name-pattern 'web path wears the spectrum' test/engine-native.test.ts   # before
    1. web, playing, the analyser has answered nothing: state playing, spectrum false, arming false — the chip reads "theme"
✖ the web path wears the spectrum’s own word until its analyser has answered for the item, and the capability word only when it has (t_71dc787e)
  AssertionError: the spectrum is coming — not the word for a browser that cannot measure this item
  + 'theme'
  - 'spectrum…'
ℹ tests 1 · pass 0 · fail 1
```

and after:

```
    1. web, playing, the analyser has answered nothing: state playing, spectrum false, arming true — the chip reads "spectrum…"
    2. 700 ms later, still answering nothing: arming true — the chip reads "spectrum…"
    3. the item’s own verdict: spectrum false, arming false — the chip reads "theme" (the analyser returned silence — a tainted cross-origin stream gives zeroes with no error)
    4. paused and resumed: the chip reads "theme"
    5. the analyser answers: spectrum true, arming false — the chip reads "spectrum"
    6. a change onto an item whose samples answer nothing: state playing, arming true — the chip reads "spectrum…"
✔ the web path wears the spectrum’s own word until its analyser has answered for the item, and the capability word only when it has (t_71dc787e)
ℹ tests 1 · pass 1 · fail 0
```

**The real app in Chrome, the ordinary run** (`dist/` rebuilt from each tree; the same probe, the same screen):

```
$ node --test --test-name-pattern 'the chip’s word on the screen he photographed' test/chip-word-browser.test.ts   # before
      every distinct word the chip wore (18):
           313 ms  "loading…"   (the chip changed, state loading)
           343 ms  "theme"      (the chip changed, state playing)      ← the defect, on the screen
           466 ms  "spectrum"   (the chip changed, state playing)
           ...
          3139 ms  "theme"      (the chip changed, state playing)      ← and again at the resume
          3254 ms  "spectrum"   (the chip changed, state playing)
      and worn while it WAS playing: ["theme","spectrum"]
✖ the chip’s word on the screen he photographed: a paused track on a playlist page is not a capability claim
  AssertionError: and no capability word is worn while the item playing can be measured — the window in front of the item’s first frame is the spectrum’s own word
```

```
# after
      every distinct word the chip wore (18):
           281 ms  "loading…"    (the chip changed, state loading)
           315 ms  "spectrum…"   (the chip changed, state playing)     ← the window, in the arming tone
           447 ms  "spectrum"    (the chip changed, state playing)
           ...
          3271 ms  "spectrum…"   (the chip changed, state playing)     ← the resume, same word
          3384 ms  "spectrum"   (the chip changed, state playing)
      distinct words across the run: ["loading…","spectrum…","spectrum","paused"]
      of those, worn while the transport was not playing: ["loading…","paused"] (8 changes)
      and worn while it WAS playing: ["spectrum…","spectrum"]
✔ the chip’s word on the screen he photographed: a paused track on a playlist page is not a capability claim
```

The window is 132 ms wide here and wears the word §515.4 gave it; before, those 123 ms were the amber
capability word. The readings at each named state (`paused` on a playlist page and on the playlists screen, the
now-playing screen's one node, `spectrum` after a resume and after a change) are unchanged by this card.

### 30.4 The second run: a stream the browser will not hand over

The card's second acceptance clause — *on a stream that genuinely cannot be measured, `theme` still appears and
still names the verdict* — cannot be produced by the ordinary run, because that mock serves the app **and** the
library from one origin, so `client.isCrossOrigin` is false and every stream is measurable. The file therefore
drives the same probe a second time, with two changes that are the app's own decision path rather than a fixture
invention:

- the page is fetched from `127.0.0.1` and the settings name `localhost` — different origins, so
  `isCrossOrigin` is true and the element asks for `crossOrigin="anonymous"`;
- the mock runs `--no-cors-stream`, so `/rest/stream` answers without `Access-Control-Allow-Origin` while the API
  keeps its CORS headers. That is §4's case, measured by hand on 2026-10-11, here on a harness.

Before, on this run, the app concluded from the first paint and never asked:

```
           344 ms  "error"     (the chip changed, state error) — the library refused cross-origin sample access for this stream, so the analyser ...
           373 ms  "theme"     (the chip changed, state playing) — the library refused cross-origin sample access ...
      while playing: ["theme","theme","theme","theme","theme","theme","theme","theme","theme"] — first "spectrum…" at never, first "theme" at 344 ms
✖ on a stream the browser will not hand over, the chip still reaches the capability word and names the verdict (t_71dc787e)
```

After — and this run is also what shows the register is **per item** (each change starts that item's own 1.8 s):

```
      while playing: ["spectrum…","spectrum…","spectrum…","spectrum…","spectrum…","spectrum…","spectrum…","spectrum…","theme","theme"] — first "spectrum…" at 348 ms, first "theme" at 5274 ms
      and the item watched on (7508 ms): chip "theme" · spectrum false · arming false — the analyser returned silence — a tainted cross-origin stream gives zeroes with no error
✔ on a stream the browser will not hand over, the chip still reaches the capability word and names the verdict (t_71dc787e)
```

So on the surface that can produce it, the capability word is still reachable, still names the verdict, and now
arrives **after** the window rather than instead of it. The reason line is the app's own `silenceReason`.

### 30.5 The suite, and what is not claimed

```
$ npm run typecheck                       # clean
$ npm test                                # 262 tests, 262 pass, 0 fail, 0 cancelled, 0 skipped, 36.3 s
$ npm run build                           # dist/ rebuilt from this tree before the browser runs
$ node --test test/chip-word-browser.test.ts   # 2 runs of the probe, both pass (5.3 s + 8.1 s)
```

Two more tests than v1.9.26's 260, and one more Chrome run: the two new cases are the engine's window/verdict
case and the tainted-stream run of the same probe.

1. **His phone is not touched and not claimed.** This card changes no native behaviour: the file's native half
   (`hasSpectrumTap`, `arming`, `ZERO_POLLS_BEFORE_THEME`, every verdict) is byte-for-byte what Sage verified on
   `t_1c2d1c51`. What he would see differently is on the web page / PWA only, and only as `spectrum…` where an
   amber `theme` used to flash — a claim about the code path, not a reading off his screen.
2. **The native path's resume window is found, measured, and NOT fixed here** — `state playing, spectrum false,
   arming false` the instant `resume()` is called on the fake bridge, i.e. the word is `native audio` for one
   bridge round trip on an item that was measuring a moment ago. It needs a third fact (this item's verdict) so
   that re-arming does not overwrite §515's silence verdict, and it needs his phone to verify; it is filed as this
   card's follow-up rather than folded in. `DECISIONS.md` §t_71dc787e.5.
3. **The ~1.8 s per item on a genuinely unmeasurable stream is a decision, and it is stated**: each item earns its
   own verdict (18 analyser frames of its own), which is what "per item" costs. Nothing here claims a faster
   verdict, and no clock was introduced to get one.
4. **`theme` is still reachable while playing** — by design, on an item whose own samples have answered. The
   ordinary browser run's word list is clean of it because that library's streams are measurable; that is a fact
   about the fixture, stated here rather than used as evidence about the word.
5. **No artifact, no version, no tag, nothing about the APK or the IPA.** §29's artifact is untouched and the
   `dist/` this card rebuilt is a build of the working tree, not a release.

Raw runs (this machine's agent scratch, `/Users/neokester/.hermes/profiles/nerd/cache/scratch/runs-t_71dc787e/`):
`engine-web-window-before.txt`, `engine-web-window-after.txt`, `chip-word-browser-before.txt`,
`chip-word-browser-after.txt`, `tainted-probe-first-pass.txt` (the tainted run's first pass, kept because it is
what showed the verdict needs the item's own 1.8 s), `npm-test-after.txt`, `typecheck.txt`.

## 31. the native path's resume was wearing the capability word — the other half of §515's window (2026-10-16, card `t_c8cc01c6`, unreleased)

**No version is bumped, no IPA/APK is built, no tag is written and the `CHANGELOG.md` release heading is
untouched.** This is the fix, its harness, `DECISIONS.md` §t_c8cc01c6 and this record — an unreleased fix like its
two predecessors (`d769fd4`, `48f9497`), whose releases were their own cards.

### 31.1 The defect, and where it was measured

`t_71dc787e` closed the web path's first-frame window and measured this one on the way past without touching it
(§30.5.2). It is the same licence line, reached by elimination on the **other** path: the instant a `resume()`
returns the transport to `playing`, `disarmConsumers` (the pause) has cleared `spectrumLive` and `spectrumArming`
was never set by a resume, so `visualiserWord`'s `if (this.state === 'playing')` branch paints the amber
capability word `native audio` on an item whose tap was measuring a moment ago. The status is one the app really
emits — the resume `dispatch` calls `applyState` and then `emit()` synchronously, before the bridge is asked
anything — so the bar paints it too; on his phone that is every resume and every return from the background,
until the poll's own round trip answers.

The probe is the card's, on the existing fake bridge in `test/engine-native.test.ts`
(`nativeEngine(recording())`, play → settle → pause → `resume()`), **run against the parent commit's engine
(`48f9497`, `git checkout 48f9497 -- src/player/engine.ts`) with the new test in place**:

```
probe A1 native playing:        "spectrum" (spectrum true, arming false)
probe A2 native paused:         "paused"   (spectrum false, arming false)
probe A3 the instant resume() is called: state playing, spectrum false, arming false — the chip reads "native audio" (emitted: "native audio")
✖ a native resume wears the spectrum’s own word, and a tap’s own verdict survives it (t_c8cc01c6)

AssertionError [ERR_ASSERTION]: the tap that was measuring this item a moment ago has not answered for it yet —
the spectrum is coming, not a capability the app has lost
  + actual - expected
  + 'native audio'
  - 'spectrum…'
ℹ tests 1, pass 0, fail 1
```

A4 (`"spectrum"`, once the poll answers) is what made this the *window* rather than a wrong word: the engine is
right about the item and wrong about the moment.

### 31.2 What changed

Three things in `src/player/engine.ts`, and the exact rule is item 3 of `DECISIONS.md` §t_c8cc01c6:

1. **`tapVerdictForItem`** — *this item's tap has answered with its own verdict* — set where the two verdicts are
   written (the digital-silence branch and the frozen-frame branch of `pollSpectrum`), cleared in
   `forgetTapFrames` (a load, an adoption, the orphan branch) and by this item's own live frame.
2. **`tapArming()`** — the native path's window, read from that register instead of from the writers: `native`,
   nothing live, the tap is on this item (`hasSpectrumTap`), and no verdict for it. Nothing here is a clock or a
   count (the shape v1.9.24 deleted); what ends the window is this item's tap producing its own frame or giving
   its own verdict.
3. **`status()`** — `spectrumArming` is now *the transport is playing* AND (`spectrumArming` || `analyserArming()`
   || `tapArming()`): the two derived reads (one per way of measuring) beside the flag the writers still own.
   `visualiserWord` is unchanged in shape; its playing branch is now reachable on this path only by an item's own
   verdict or by a build with no tap.

The trap this card names is the reason for the third fact rather than `spectrumArming = true` in `startConsumers`:
on this path `(spectrumLive, spectrumArming) = (false, false)` **while playing** is also how a *reached verdict*
looks, so re-arming would say *the spectrum is coming* over a track the tap has already ruled out — §515's
silence verdict. Section 31.3.3 and 31.3.4 are that behaviour, asserted.

### 31.3 The same probe after the change

```
probe A1 native playing:        "spectrum" (spectrum true, arming false)
probe A2 native paused:         "paused"   (spectrum false, arming false)
probe A3 the instant resume() is called: state playing, spectrum false, arming true — the chip reads "spectrum…" (emitted: "spectrum…")
     the window: the tap answers a read in 40 ms here, and its first frame ended the window 43 ms after this read; 1 emitted status(es) inside it, a capability word on 0 of them
probe A4 native resumed:        "spectrum" (spectrum true, arming false)
2. back from the background, the player saying it is playing: state playing, spectrum false, arming true — the chip reads "spectrum…"
   …the tap’s own frame ended that window too, 44 ms later
3. a tap reading digital silence: spectrum false, arming false — the chip reads "native audio" (the native tap is reading digital silence — the audio itself is silent, so the bars are flat)
   and at the resume: spectrum false, arming false — the chip reads "native audio"
   after the resume: "native audio" (the native tap is reading digital silence — the audio itself is silent, so the bars are flat)
4. a tap returning one frozen frame: spectrum false, arming false — the chip reads "native audio" (the native tap kept returning the same frame, which is not a measurement — showing the album-art theme)
   at the resume: spectrum false, arming false — the chip reads "native audio"
   and 300 ms after the resume the tap’s own verdict is back: "native audio" (the native tap kept returning the same frame, which is not a measurement — showing the album-art theme)
✔ a native resume wears the spectrum’s own word, and a tap’s own verdict survives it (t_c8cc01c6)
```

Read as the acceptance:

1. **A3 is `spectrum…`**, in the status the engine emits as well as the one read from it (`spectrum false,
   arming true`), and **the window that opens is ended by the tap's own frame** — 43 ms later in the fake, whose
   tap is stated as answering in one `ROUND_TRIP_MS` (40 ms) per read; on the phone that is the plugin's own
   round trip. Not one emitted status inside the window wore a capability word.
2. **A return from the background wears it too.** The app leaves the screen with the track paused and comes back
   to a player that is playing: the return path adopts that answer (`engine-state playing`) instead of calling a
   tap, so no writer arms anything there either — `spectrum…`, ended by the tap's own frame 44 ms later, no
   capability word on any reading taken on the way in.
3. **A tap that answered with silence keeps `native audio` across a pause and a resume** — at the instant the
   resume flips the transport, and at every reading afterwards, with no `spectrum…` anywhere in between: the
   verdict is about the item, not the moment. This is the behaviour the card exists to protect.
4. **A tap returning one frozen frame is the same statement** (and this harness can now state it at all: the fake
   gained `frozenUrls`, a tap whose own per-item counter moves while its bands never change — the v1.8.0 frozen
   buffer, which the v1.9.25 *register-rule* cases are deliberately not). Its verdict is `native audio`, its
   resume instant is `native audio`, and the verdict is reached again 300 ms after the resume because the resumed
   poll re-opens the per-item register `startConsumers` keeps — the frozen rule's own ~0.4 s latency, restarted by
   a transition. **That is named, not fixed, and it is not this card's**: the bars there are drawn from frames
   this item's tap really produced, and this card is about the capability word arriving early, not late.

### 31.4 The suite, and what is not claimed

```
$ npm run typecheck                             # clean
$ npm test                                      # 263 tests, 263 pass, 0 fail, 0 cancelled, 0 skipped, 37.6 s
$ node --test --test-name-pattern="t_c8cc01c6" test/engine-native.test.ts
                                                # 1 test, 1 pass, 0 fail, 3.2 s (before the fix: 0 pass, 1 fail)
```

263 is `48f9497`'s 262 plus this card's single case; the harness is the file that already existed
(`test/engine-native.test.ts`), extended with two facts it could not state before (`frozenUrls`, `frameDelayMs`)
rather than a new harness.

1. **His phone is not touched and not claimed.** Every reading above is off the fake bridge. What the change
   predicts on his phone: at a resume (and at a return from the background) the chip reads `spectrum…` instead of
   flashing the amber `native audio`, for the length of the plugin's own round trip, and a track the tap has
   ruled out still reads `native audio` across a pause and a resume. **Nothing in this record is a reading off
   his screen** — his phone is the only surface that can settle it, and that is what the verification card and
   the next installed build are for.
2. **The web path, the paused / ended / interrupted words and the no-tap build are not re-litigated** — they are
   covered by `t_71dc787e`'s and `t_1c2d1c51`'s cases, all still green in the 263. The no-tap build's
   `native audio` is preserved by construction (`tapArming` requires the tap to exist at all) and by that case.
3. **The frozen rule's ~0.4 s restart at a resume** is as described in 31.3.4: observed, explained, not changed.
4. **No artifact, no version, no tag, nothing about the APK or the IPA.** The release that carries this fix is its
   own card, after Sage's verification (`t_1c099158`), and it is not this one.

Raw runs (this machine's agent scratch, `/Users/neokester/.hermes/profiles/nerd/cache/scratch/runs-t_c8cc01c6/`):
`engine-native-window-before.txt` (the new test against `48f9497`'s engine: the failure above),
`engine-native-window-after.txt` (the run quoted in 31.3), `npm-test-after.txt` (263/263).

## 32. v1.9.27 — the release that carries both first-frame windows (2026-10-16)

`48f9497` (`DECISIONS.md` §t_71dc787e — the browser's own first-frame window is the spectrum's word, not a
capability verdict) and `36ddb14` (§t_c8cc01c6 — the other half, a native resume, and the per-item fact that
keeps it honest) were on `main` and **unreleased** when they were written, and both said so. This is the cut that
stamps and ships them: one version carrying those two fixes and nothing else. The sweep for this cut, run rather
than assumed:

```
$ git log --oneline v1.9.26..HEAD            # before the release commit
36ddb14 fix(unreleased): the native half of the first-frame window — a resume, and the per-item verdict that keeps it honest
48f9497 fix(unreleased): the browser's own first-frame window is the spectrum's word, not a capability verdict
9d5c6ae docs(v1.9.26): §29's closing line names where the raw runs actually live, and what is attached
edabdb6 docs(v1.9.26): the release verification record — the counts, the harness's 42 checks, the chip readings on the surface he photographed, the artifact read back out of the IPA, and what is not claimed
```

The two `docs(v1.9.26)` commits are docs only and are in the build as history. **Nothing else on `main` was
unreleased and verified.**

**Two halves, one version — a routing decision, recorded because it is one.** `t_7481b20f` verified the web half
at `48f9497` on its own and recommended shipping it alone, keeping the native follow-up out of the cut. This cut
carries both, on the orchestrator's reasoning in `t_55732fc5`'s comment thread: the native half never entered the
cut unverified (its own verification, `t_1c099158`, returned SHIP at `36ddb14` before this card started); the
resume window is the half the owner actually reported; and he has asked not to be sent version after version. The
isolation point behind Sage's caution is honoured as a *process* fact rather than a code fact — the cut was gated
behind both writers, and every reading below was taken with the tree at the release commit, not mid-edit.

**The version number, stated once because the commits around it disagreed with the files.** Both fix commits'
comments and §30/§31 name **v1.9.27** while every version file still said 1.9.26 (Sage's note on `t_1c099158`,
passed to this card). This cut lands as **1.9.27**: §32.2 lists the files it sets, the tag is `v1.9.27`, the
changelog heading is `1.9.27`, and the artifact self-reports 1.9.27 (48) (§32.4). The claim and the files agree;
no file is left claiming a version other than the one being shipped.

**No production code changed in this cut.** The diff is the version files of `docs/VERSIONING.md` §3 (two of them
the changelog copies), the release check, `DECISIONS.md` (both entries marked released as v1.9.27, plus the
invariant entry they add up to), and this section. `src/player/engine.ts` is byte-for-byte `36ddb14`.

### 32.1 What was run, and the counts for this cut

```
$ npm run typecheck             # tsc --noEmit — clean
$ npm test                      # 263 tests, 263 pass, 0 fail, 0 cancelled, 0 skipped, 37.3 s
$ npm run build                 # one vite build — the dist/ the three harnesses below ran against
$ node tools/mock-subsonic.mjs --port 4691 --stress --dist dist
$ node tools/offline-check.mjs --app http://127.0.0.1:4691 --online-playlist pl-stress-long
                                # 42 ok, 0 FAIL, exit 0
$ node tools/spectrum-proof.mjs --url http://127.0.0.1:4691
                                # exit 0 — the readings are quoted in §32.3
$ node --test test/chip-word-browser.test.ts
                                # 2 tests, 2 pass, 0 fail, 13.3 s — the probe drives itself twice
$ node --test --test-name-pattern="t_c8cc01c6" test/engine-native.test.ts
                                # 1 test, 1 pass, 0 fail, 3.4 s — the readings are quoted in §32.3
$ npm run ipa:unsigned          # one vite build + cap sync ios + one xcodebuild → the artifact in §32.4
$ npm run build                 # a third vite build, for §32.4's byte-for-byte
```

**Three `vite` builds** (one for the harness runs, one inside `ipa:unsigned`, one fresh for the reproducibility
read), **one `xcodebuild`**, **one `npm test`**, **one `offline-check`**, **one `spectrum-proof`**, **one browser
run** (two probes inside it), **one fake-bridge run**, **one `typecheck`**. Each harness ran once for this cut:
the runs are the release record, not a loop.

### 32.2 The suite, and the release check

`npm test` — **263 tests, 263 pass, 0 fail, 0 cancelled, 0 skipped, 37.3 s**, the same count `36ddb14` was
verified at (`t_1c099158`: 263/263 in 37.2 s). This cut adds no test; it rewrites the release check's own version
list and the two changelog copies. The release check is `test/changelog.test.ts`: it compares `CHANGELOG.md` with
`src/ui/changelog.ts` item for item and asserts the version list ends at 1.9.27, so a bump that touched only part
of `docs/VERSIONING.md` §3's list fails there. `tsc --noEmit` prints nothing.

Version, per `docs/VERSIONING.md` §3, all in the one release commit: `package.json` and the lockfile's two
`"version"` roots to 1.9.27; android `versionCode 47` / `versionName "1.9.27"`; iOS
`CURRENT_PROJECT_VERSION 48` / `MARKETING_VERSION 1.9.27`, both places; the changelog entry in
`src/ui/changelog.ts` and `CHANGELOG.md`, same words and same order; and the release check's version list. The
per-platform counters the file warns against aligning: Android 46 → 47, iOS 47 → 48.

The changelog entry leads with the owner's own report — the phone flashing `native audio` when he presses play
again, and again when he comes back to the app from the background — then the same window on the web page. It
says what he can see and nothing transparent to him; no build, no plumbing and no refactor entry is in it.

### 32.3 The harnesses on this build

**`tools/offline-check.mjs`** (§18–§23's block), the app in Chrome at 393 x 852 against a library that cannot be
reached at all: **42 ok, 0 FAIL, exit 0**, and its own closing line unchanged:

```
RESULT: a downloaded playlist is browsable with no connection, one row per playlist, a mark on what is on this
phone, the Library keeps its own door into the downloaded music with no server, nothing prints a URL at him, a
view left mid-answer does not paint over the screen he moved to, and a store a 1.9.19 build wrote is named on the
list he is looking at and on the bar of the track he is playing.
```

**`tools/spectrum-proof.mjs`**, exit 0:

```
  playing:            29775 lit pixels (checksum 1495355703) · 3 columns with a second run of lit pixels · 0 lit below the baseline
  +700 ms / +900 / +1200 / +1500:   668 lit pixels each, the last three byte-identical
  settled frame:      0 columns with a second run of lit pixels · 0 lit pixels below the baseline
```

v1.9.26's own run of the same tool read 30,898 lit pixels at checksum 787030170 (§29.3). The two readings are of
different builds sampling a live audio pipeline at different moments; **this record does not claim the difference
means anything**, and neither reading is used as evidence about the word the chip wears.

**`test/chip-word-browser.test.ts`**, run against this build's `dist/` — 2 tests, 2 pass, 0 fail, 13.3 s
(5.1 s + 8.1 s). Both probes:

```
# the ordinary run — a same-origin library, every stream measurable
      every distinct word the chip wore (17):
           359 ms  "loading…"    (the chip changed, state loading)
           389 ms  "spectrum…"   (the chip changed, state playing)   ← the window, in the arming tone (92 ms)
           481 ms  "spectrum"    (the chip changed, state playing)
           ...
          3054 ms  "spectrum"    (the chip changed, state playing)   ← the resume: no amber anywhere
          3576 ms  "spectrum"    (resumed, on the playlist page, state playing)
      distinct words across the run: ["loading…","spectrum…","spectrum","paused"]
      of those, worn while the transport was not playing: ["loading…","paused"] (8 changes)
      and worn while it WAS playing: ["spectrum…","spectrum"]

# the tainted run — the app on 127.0.0.1, the library named `localhost`, --no-cors-stream
           342 ms  "spectrum…"   — the window, on an item that turns out to be unmeasurable
           ...
          5380 ms  "theme"      — the item's own verdict, the reason line naming the case
      the item, watched on: chip "theme" · spectrum false · arming false — the analyser returned silence
```

Read as the release reads it: on the surface that can wear it, **no capability word is worn while the item is
playing** — the words are `spectrum…` then `spectrum`, at the start and at the resume alike — while the word is
still reachable, still names the verdict, and now arrives **after** the window rather than instead of it.

**`test/engine-native.test.ts`, the `t_c8cc01c6` case** — the half the owner reported, on the fake bridge:
1 test, 1 pass, 0 fail, 3.4 s:

```
probe A1 native playing:        "spectrum" (spectrum true, arming false)
probe A2 native paused:         "paused"   (spectrum false, arming false)
probe A3 the instant resume() is called: state playing, spectrum false, arming true — the chip reads "spectrum…"
     the window: the tap answers a read in 40 ms here, and its first frame ended the window 40 ms after this read;
     1 emitted status inside it, a capability word on 0 of them
probe A4 native resumed:        "spectrum" (spectrum true, arming false)
2. back from the background, the player saying it is playing: the chip reads "spectrum…", ended by the tap's own
   frame 41 ms later
3. a tap reading digital silence: "native audio" — and at the resume, and after it: "native audio"
4. a tap returning one frozen frame: "native audio" — and at the resume, and again 293 ms after it
```

`spectrumArming`'s derived reads are the fix; this run is the same case §31.3 records, re-read on the release
commit's tree so that the cut's own record is off the shipped code rather than quoted from the fix's card.

### 32.4 The artifact, and the bytes it carries

```
$ npm run ipa:unsigned
** BUILD SUCCEEDED **
built  artifacts/Navilite-1.9.27-unsigned.ipa
bytes: 1031737            (v1.9.26: 1031417 — +320, +0.031 %)
app version 1.9.27 (48), UIBackgroundModes[0]=audio
```

Read out of the archive itself, not out of a source file:

```
$ unzip -p artifacts/Navilite-1.9.27-unsigned.ipa Payload/App.app/Info.plist \
    | plutil -p - | grep -E 'CFBundleIdentifier|CFBundleShortVersionString|CFBundleVersion'
  "CFBundleIdentifier" => "app.navilite"
  "CFBundleShortVersionString" => "1.9.27"
  "CFBundleVersion" => "48"
```

`artifacts/Navilite-1.9.27-unsigned.ipa` is 1,031,737 bytes, sha256
`7676bd74675c6efe0c123053ee936d1f52931d27a80c8654bfb2d29d2d46ae67`, and `file` reads it as `Zip archive data, at
least v1.0 to extract, compression method=store`, carrying `Payload/App.app/` — 47 files, `Payload/App.app/App`
among them.

**The build stamp names the release commit.** `dist/sw.js` carries `const BUILD_ID = 'b40ec02';` — the commit the
IPA was built from — and the same line is inside the archive:

```
$ unzip -p artifacts/Navilite-1.9.27-unsigned.ipa Payload/App.app/public/sw.js | grep "BUILD_ID ="
const BUILD_ID = 'b40ec02';
```

That is the stamp the delivery guard reads (`~/.hermes/scripts/navilite_deliver.py`, whose build-order guard was
rewritten on `t_a09d1ba7` to read the artifact's own bytes rather than the file's mtime, precisely because a
release record always lands after the build it records). So the artifact the owner is offered names its own
build, and the commit it names is the commit the tag `v1.9.27` sits on.

**A fresh build of the release commit reproduces the shipped bundle.** The tree was clean at `b40ec02` when the
third `npm run build` ran, and every one of the eight hashed assets in `dist/` is **byte-identical to the same
member inside the IPA** (`cmp`, not size): `index-C2jLU_k3.js` (203,896 B), `index-QjmzHs0A.css` (14,071 B),
`base-BjmtzVdu.js`, `esm-B4zyz82m.js`, `esm-COzjbbfU.js`, `native-D0fucyVa.js`, `web-B84SncK4.js`,
`web-BKEosLDU.js`; `sw.js` likewise. The copy `cap sync` wrote into the project
(`ios/App/App/public/assets/index-C2jLU_k3.js`, gitignored) is that same file byte for byte. The shipped chunk's
sha256 is `95c7757f3d6052a60a312cd7d1343d850a48ffae3c44d167c12db94a6ea24b66`; the stylesheet's is
`ac4b85a50758aca6cdcbd95a3a701703a1c7822acb7a451c3ecf1313473c8ca0`.

The fixes are *in* the shipped bytes, read against the previous release's own chunk as the control — both read
out of their IPAs, and v1.9.26's chunk hash (`66d2ec61baeacbbff9cee98f139c9df96985abc19fce5497c7056f6c64158cd2`) is
§29.4's own recorded value, so the control is the file that record was written about:

| in the bundle | v1.9.26's `index-Wt45tSM6.js` | v1.9.27's `index-C2jLU_k3.js` |
| --- | --- | --- |
| `analyserArming` (the web path's window, `t_71dc787e`) | 0 | 2 |
| `tapArming` (the native path's window, `t_c8cc01c6`) | 0 | 2 |
| `tapVerdictForItem` (the third fact) | 0 | 6 |
| `zeroFrames` (the web register the window is read from) | 4 | 6 |
| `visualiserWord` (the licence line itself) | 2 | 2 |
| `native audio` (the word in code *and* in the changelog text he reads) | 16 | 18 |
| `spectrum…` | 6 | 7 |

**Order of operations.** The release body was committed first (`b40ec02`) with a clean tree, then tagged, then the
IPA was built from that commit — `docs/VERSIONING.md` §6's order. The tag `v1.9.27` is on `b40ec02`, the commit
the IPA was built from; commit and tag are pushed, and this section is the one commit after them, written from
that build's readings. Nothing in the delivery guard's `SHIPPED_PATHS` (`src`, `public`, `index.html`,
`vite.config.ts`, `capacitor.config.ts`, `ios/App/App`, `package.json`) moved after `b40ec02`, so the guard reads
this artifact as current rather than stale:

```
$ git log --oneline b40ec02..HEAD -- src public index.html vite.config.ts capacitor.config.ts ios/App/App package.json
                          # (no output — nothing he installs moved after the build)
```

### 32.5 Not verified here, and not claimed

1. **His phone.** Everything above is a read of the shipped bytes and of Chrome at 393 x 852 on this Mac against
   the mock; no device, no simulator, no native mixer. That the chip on his IPA reads `spectrum…` at a resume
   instead of flashing `native audio` is a claim about the same code path, not a reading off his device
   (§31.4.1). One pause and one resume on the installed build is what settles it — and that is the verification
   card's job, not this one's.
2. **The two named residuals are unchanged and are not claimed closed.** §30.5.3's ~1.8 s per item before a
   genuinely unmeasurable stream earns its own verdict (a decision, not an accident, and the price of "per
   item"), and §31.3.4's ~300 ms before a frozen tap's verdict is re-reached after a resume (observed,
   explained, left alone). Both are stated in `DECISIONS.md`'s invariant entry, item 6, with no card filed
   against either.
3. **The transport words `ended` / `interrupted` / `error` are still only defined**, not read off a screen. This
   cut changes no word and no state.
4. **Android.** No APK was built for 1.9.27. `versionCode` is bumped to 47 and `versionName` to 1.9.27 so the next
   APK carries them (`docs/VERSIONING.md` §3 does not require an APK for the parity), and nothing here is
   evidence about the APK.
5. **The installed IPA.** Unsigned on purpose (§15.4, `docs/ios-sideload.md`); the sideload and the 7-day re-sign
   are the owner's own steps.
6. **No production code changed in this cut.** The diff is the version files, the two changelog copies, the
   release check, `DECISIONS.md` and this section. The two P3 notes earlier reviews left are untouched and
   neither is claimed here.
7. **This record is not the delivery.** Writing it, and building the artifact, is not shipping it: the cut that
   wrote these bytes does not write the greenlight marker and does not deliver anything — a separate card reads
   the shipped bytes and greenlights them, and only then does the automatic delivery run.

Raw runs (this machine's agent scratch, `/Users/neokester/.hermes/profiles/nerd/cache/scratch/runs-1927/`):
`build-a.txt` (the vite build the harnesses ran against), `offline-check-1927.txt`, `spectrum-proof-1927.txt`,
`chip-word-browser-1927.txt`, `engine-native-1927.txt`, `ipa-build-1927.txt`, `build-c.txt` (the fresh build for
the byte-for-byte read), plus `commit-msg.txt` and the two chunks read out of the IPAs for the control table.
The `npm test` and `typecheck` counts are quoted from their own console output, which was not redirected to a
file in this directory.

