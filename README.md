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
| `artifacts/Navilite-0.1.0-debug.apk` | 8,772,279 (8.4 MiB) | AndroidX + Capacitor core + ExoPlayer (the native audio plugin), plus 17 web payload files. Debug-signed, so it sideloads without any signing setup. |
| `artifacts/Navilite-0.1.0-unsigned.ipa` | 856,822 (0.8 MiB) | No engine is bundled: WKWebView and AVFoundation are the OS's. Just the arm64 binary and the web payload. Unsigned on purpose (`docs/ios-sideload.md`). |

## What it does

- **Browse** — artists, albums, playlists, favourites and search over the **Subsonic API**
  (`/rest`, API 1.16.1) on Navidrome. Not Navidrome's undocumented `/api` + `/auth` internals.
- **Play** — queue, next/previous, seek, album/playlist/favourites playback.
- **Visualise** — `createMediaElementSource(<audio>) → AnalyserNode → destination`, read every
  frame with `getByteFrequencyData()`, drawn as log-spaced bands with peak caps, over a theme
  derived from the album art (kew's two ideas: spectrum, and colours from the cover).
- **Playlists and favourites** — create, add, remove, star/unstar (v1 scope, per `DECISIONS.md`).
- **Report plays properly** — `scrobble` with `submission=false` on start, `true` once the track
  passes half its length or four minutes. (Navidrome does *not* count a track played because it
  was streamed — only `scrobble` does.) The play queue is pushed with `savePlayQueue`, debounced.

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

## Tests

```bash
npm test
```

- `test/md5.test.ts` — RFC 1321 vectors, plus agreement with `node:crypto` over random inputs.
- `test/subsonic.test.ts` — URL/token construction, `star`/`unstar` parameter mapping for songs
  vs albums vs artists, error mapping, scrobble semantics — with `fetch` stubbed.
- `test/queue.test.ts` — the play-reporting threshold.
- `test/connect-copy.test.ts` — the canonical origin keeps its **`:9443`**, the connect form's
  placeholder never names the bare host, and the door URL round-trips through the normaliser.

What the tests do *not* cover: anything that needs a device (native playback, the hand-off, the
Keychain/Keystore path). See `docs/verification.md` for exactly what was verified where, with the
commands and the observed output.

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
