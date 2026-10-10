# Navilite

A deliberately **lightweight** music player for a self-hosted **Navidrome** library, with a
**real** audio spectrum — built for one person's library, not for streaming services.

One TypeScript codebase, three artifacts: **PWA**, **Android APK**, **iOS IPA** (sideloaded,
free Apple ID). No framework, no UI kit: the whole app is ~61 kB of JavaScript (20 kB gzipped)
plus a 8 kB stylesheet, and the native plugins are code-split so a browser never downloads them.

```
npm install
npm run mock        # serves the built app + a synthetic Subsonic library on :4533
npm run build       # dist/ — the PWA, and the payload for both native shells
npm test            # 19 unit tests: deployment copy, md5 vectors, token auth, parsing, play rules
npm run apk          # artifacts/Navilite-<version>-debug.apk
npm run ipa:unsigned # artifacts/Navilite-<version>-unsigned.ipa
```

## Built artifacts

Both are produced by the scripts in `tools/`, land in `artifacts/` (gitignored — the repo carries
source, not binaries), and stay far under the ~50 MB a Telegram bot can deliver:

| Artifact | Bytes | Why that size |
|---|---|---|
| `artifacts/Navilite-1.1.0-debug.apk` | 8,780,443 (8.4 MiB) | AndroidX + Capacitor core + ExoPlayer (the native audio plugin), plus 17 web payload files. Debug-signed, so it sideloads without any signing setup. |
| `artifacts/Navilite-1.1.0-unsigned.ipa` | 863,802 (0.8 MiB) | No engine is bundled: WKWebView and AVFoundation are the OS's. Just the arm64 binary and the web payload. Unsigned on purpose (`docs/ios-sideload.md`). |

v1.1 adds 8,164 bytes to the APK (+0.09%) and 6,980 to the IPA (+0.81%) over v1.0's
8,772,279 / 856,822: the lyrics panel, the changelog and the now-playing rebuild — no new
dependency, and no lyrics text in either file (checked by hash and by grep; `docs/verification.md`
§9).

## What it does

- **Browse** — artists, albums, playlists, favourites and search over the **Subsonic API**
  (`/rest`, API 1.16.1) on Navidrome. Not Navidrome's undocumented `/api` + `/auth` internals.
- **Play** — queue, next/previous, seek, album/playlist/favourites playback.
- **Visualise** — `createMediaElementSource(<audio>) → AnalyserNode → destination`, read every
  frame with `getByteFrequencyData()`, drawn as log-spaced bands with peak caps, over a theme
  derived from the album art (kew's two ideas: spectrum, and colours from the cover).
- **Playlists and favourites** — create, add, remove, star/unstar (v1 scope, per `DECISIONS.md`).
- **Lyrics** — the playing track's lyrics, served by your own library from the lyrics file that sits
  next to the song (`getLyricsBySongId`), romanised on the device where needed, cached per device.
  Untimed text is fine and is the normal case; a timed `.lrc` file also gets a line-by-line
  highlight that follows playback. See *Lyrics* below.
- **Report plays properly** — `scrobble` with `submission=false` on start, `true` once the track
  passes half its length or four minutes. (Navidrome does *not* count a track played because it
  was streamed — only `scrobble` does.) The play queue is pushed with `savePlayQueue`, debounced.

## Lyrics (from your own music folder)

There is no lyrics service in this app and no lyrics in this repo. The words come from the library,
which reads the file sitting next to the audio:

```
Music/Alien Lab/Transmission/01 Track.flac
Music/Alien Lab/Transmission/01 Track.lrc      ← Navidrome reads this and serves it
```

Navidrome's `LyricsPriority` decides which sidecar wins
(`.ttml .yaml .yml .elrc .lrc .srt .txt embedded` — `.md` is **not** a supported extension), and the
app asks for one track at a time with `getLyricsBySongId`. What it does with each answer:

| The library answers | The app shows |
|---|---|
| Timed lines (a `.lrc` sidecar) | The lines, with the current one highlighted and scrolled into view as the song plays. |
| Untimed lines (a `.txt` sidecar) | The same list as plain, scrollable text. This is the normal case for this library and is **not** treated as a failure. |
| Nothing for this track | `no romaji lyrics for this track yet`. No spinner, no invented text. |
| Nothing at all before 15 s (slow network) | The same message; a late answer still paints when it arrives. |

Two details worth stating plainly. The kana→romaji converter (`src/lyrics/romanize.ts`) handles
**kana only** — kanji needs a dictionary the app does not carry, so a line that still contains
kanji is shown as it is with one line of small print saying so, rather than being passed off as
romaji; in practice the files are already romaji or English, so it mostly does nothing. And the
legacy `getLyrics` call (artist + title, no id) is used only when the server lacks the newer
endpoint, and its answer is discarded unless the artist/title it echoes back match the track that
is playing — that call cannot tell two songs with the same title apart, and another song's words
would be worse than none.

The cache is `localStorage` on the device that asked (`src/storage/lyrics.ts`), clearable from
Settings, with misses expiring in hours so a sidecar written later gets picked up.

## The honest part: which visualiser you get, and why

A spectrum only exists when the browser will hand over the samples. When it will not, the
analyser returns **zeroes with no error** — the classic silent flatline. Navilite watches for
that and never pretends:

| Situation | What the app does |
|---|---|
| Same origin as Navidrome (the design) | **Real spectrum.** |
| Cross-origin, server sends `Access-Control-Allow-Origin` on `/rest/stream` | **Real spectrum** (`crossorigin="anonymous"`). |
| Cross-origin, no ACAO on the stream | Plays anyway (the element's `crossOrigin` flag is dropped), reports *"the library sent no Access-Control-Allow-Origin for this stream … the spectrum cannot be real"*, and shows the album-art theme. |
| Native playback (APK/IPA background, lock screen) | Album-art theme. The audio plugin exposes no PCM to JavaScript, so there is nothing truthful to draw. The UI says so on screen. |
| Audio context suspended (iOS background) | Album-art theme, reason shown. |

The mode chip on the player bar and the now-playing screen always names the live mode
(`spectrum` / `theme` / `native audio`) and the reason underneath it. Two specific traps are
handled explicitly, because both were observed while building this:

- the analyser's destination buffer is **cleared before every read** — a tainted analyser can
  leave the previous track's frame in place, which would display a stale spectrum as if it
  were live;
- a frame that stays **byte-identical** for ~2.5 s is treated as not-a-measurement too.

## Platform behaviour

| | PWA (browser) | Android APK | iOS IPA (sideloaded) |
|---|---|---|---|
| Real spectrum | Yes (foreground) | Yes in the foreground; theme in the background | Yes in the **foreground only** — Web Audio does not survive iOS backgrounding |
| Background playback | Android: yes (media element). iOS: unreliable | Yes — native ExoPlayer + a foreground service | Yes — AVFoundation, `UIBackgroundModes: audio` |
| Lock-screen controls | Media Session (Android, iOS 15+) | Plugin's Now Playing notification | `MPNowPlayingInfoCenter` |
| Credential storage | Web storage (exfiltrable) — the UI says so | Android Keystore / EncryptedSharedPreferences | iOS Keychain |

The wrapped builds hand playback between Web Audio and the native engine at the same position
when the app goes to the background and back (`src/player/engine.ts`), so the spectrum is real
while you are looking at it and the music keeps playing when you are not. `Settings → Playback`
can pin either engine if you prefer.

## Networking (the part that is not this repo)

The phone reaches the library over **Tailscale**; nothing here needs Navidrome exposed to the
public internet. The deployment is **one origin**: a reverse proxy serves this app's `dist/` and
proxies the Subsonic paths to Navidrome, which removes the CORS question entirely and gives the
PWA the secure context it needs.

**The server URL is `https://alienlab.tailbed832.ts.net:9443`** — tailnet-only, HTTPS on the
node's publicly trusted Let's Encrypt certificate, so the PWA installs from it with nothing to
install on the phone (Android's user-CA restriction does not apply to a publicly trusted cert).
It serves `dist/` at `/` and proxies `/rest`, `/api`, `/auth` and `/share` to Navidrome.

Keep the **`:9443`**. The bare name `https://alienlab.tailbed832.ts.net` is port **443** — a
**public Tailscale Funnel to a different service (wizarr)**, not Navidrome and not this door. With
no port you get wizarr's page (or a confusing failure), not your library. On the door origin the
honest answer in the app's connect form is to leave the URL blank (same origin); in the wrapped
Android/iOS builds, which are not served from that origin, type the full URL **including the port**.

Host-level work (Caddy, quadlets, ufw, Uptime Kuma) belongs to **Nova** and is done: the door is
`tailscale serve --bg --https=9443 http://127.0.0.1:5702`, with a watchdog that checks the serve
mapping, the certificate and the app/API every 15 minutes, and no Funnel. `Access-Control-Allow-Origin`
on `/rest/stream` was confirmed through the proxy afterwards.

Measured on this Navidrome (0.64.2, `Origin` set): `/rest/stream` **does** send
`Access-Control-Allow-Origin: *` — see `DECISIONS.md`. That is version- and config-dependent, so
re-measure after an upgrade; the same-origin deployment is what makes it moot.

## Running it locally

```bash
npm install
npm run mock            # mock Subsonic library + the built app, one origin, :4533
# then open http://127.0.0.1:4533/ and connect with navidrome / navidrome
```

Or against a real server, with Vite's dev server proxying `/rest` for you:

```bash
NAVILITE_DEV_SERVER=https://alienlab.tailbed832.ts.net:9443 npm run dev
```

`tools/mock-subsonic.mjs` is a development tool, not part of the app: it implements the subset of
the Subsonic API this client uses, checks tokens for real (`md5(password + salt)`), and streams
generated PCM whose spectrum is known exactly. That is what makes the visualiser testable — the
end-to-end check reads the analyser and matches peaks against the frequencies the mock declared.

Its lyrics behaviour stands in for a Navidrome with sidecar files, and its lines are invented for
the harness (they are not anyone's lyrics, and they ship nowhere):

```bash
npm run mock -- --lyrics-plain   # every lyric file is untimed (.txt), the normal case here
npm run mock -- --no-lyrics      # a library with no lyrics at all → the honest empty state
# default: the first album has a timed .lrc-style sidecar, every other album has none
```

## Tests

```bash
npm test
```

- `test/md5.test.ts` — RFC 1321 vectors, plus agreement with `node:crypto` over random inputs.
- `test/subsonic.test.ts` — URL/token construction, `star`/`unstar` parameter mapping for songs
  vs albums vs artists, error mapping, scrobble semantics — with `fetch` stubbed.
- `test/queue.test.ts` — the play-reporting threshold.
- `test/queue-order.test.ts` — shuffle/repeat order and what happens at the end of a queue.
- `test/connect-copy.test.ts` — the canonical origin keeps its **`:9443`**, the connect form's
  placeholder never names the bare host, and the door URL round-trips through the normaliser.
- `test/romanize.test.ts` — the kana→romaji table, digraphs, the sokuon, ん before a vowel, and the
  rule that kanji is reported as incomplete rather than romanised.
- `test/lyrics.test.ts` — LRC and plain parsing, the structured/legacy answers, the empty and
  untimed cases, the wrong-song guard, the per-device cache, and a check that the lyrics client
  names **no outside service** at all (the owner's rule, enforced by the test).
- `test/changelog.test.ts` — `src/ui/changelog.ts` and `CHANGELOG.md` are the same document; the
  in-app page and the file cannot drift apart.

What the tests do *not* cover: anything that needs a device (native playback, the hand-off, the
Keychain/Keystore path), and live lyrics from the real Navidrome — the pilot sidecar lives on his
box, so the end-to-end path was exercised against the mock's implementation of the same endpoint.
See `docs/verification.md` for exactly what was verified where, with the commands and the observed
output.

## Building the Android APK

Requirements: **JDK 21** (`brew install openjdk@21` — keg-only, `tools/build-apk.sh` finds it),
Android SDK with platform 36 (`local.properties` points at it; `android/local.properties` is
gitignored).

```bash
npm run apk             # → artifacts/Navilite-<version>-debug.apk   (debug-signed: installs anywhere)
adb install -r artifacts/Navilite-<version>-debug.apk
```

`npm run apk:release` builds an **unsigned** release APK; add your own `signingConfig` if you want
one, and keep the keystore out of the repo.

Background playback on Android is a foreground service this repo provides
(`android/app/src/main/java/app/navilite/BackgroundAudioService.java`): the native audio plugin
plays in-process and declares no service of its own, and without one Android may freeze the app
when the screen goes off.

## Building the iOS IPA (free path, no paid account)

Requirements: Xcode. No Apple Developer Program membership, no TestFlight, no App Store.

```bash
npm run ipa:unsigned    # → artifacts/Navilite-<version>-unsigned.ipa
```

The output is deliberately **unsigned**: that is the input AltStore / SideStore / Sideloadly /
Xcode want, and they attach your free personal-team signature on the way in. Re-signing is a
7-day cycle on a free Apple ID; **docs/ios-sideload.md** walks the whole path, including the
signed-and-archived variant if you ever add a team.

## Deploying the PWA

```bash
npm run build           # dist/
```

Serve `dist/` from the same origin as Navidrome (above). The build includes
`manifest.webmanifest`, the icons, and a service worker that caches **only** app-shell assets —
never `/rest/` (byte ranges) and never API-shaped responses — so the app installs and updates
cleanly without ever serving stale library data. Offline caching of the library is explicitly out
of v1 scope.

## Layout

```
src/api/        Subsonic client, MD5, types          src/player/   engine (Web Audio + native), visualiser, palette, Media Session
src/state/      library cache, playback queue        src/storage/  settings, credential storage (Keychain/Keystore/web)
src/ui/         shell, router, views, player bar     tools/        mock library, icon generator, APK/IPA build scripts
```
