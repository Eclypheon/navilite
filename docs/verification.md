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
