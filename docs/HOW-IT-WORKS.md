# How Navilite works

One page. It exists so the next card does not have to re-derive all of this by reading 6,000 lines:
where things live, which element is audible, where the queue lives, and the exact commands that
produce each artifact. If you change something here, change this file in the same commit.

Version: **v1.9.0**.

## Build, test, run

```bash
npm install
npm run dev                      # vite dev server, browser only
npm run mock                     # tools/mock-subsonic.mjs — a fake Subsonic library AND the built app
npm run build                    # tsc --noEmit && vite build  → dist/
npm test                         # node --test test/*.test.ts (the browser checks skip without Chrome)
npm run test:layout              # just the 393 px overflow regression
npm run apk                      # build + cap sync android + tools/build-apk.sh debug
npm run ipa:unsigned             # build + cap sync ios     + tools/build-ios-ipa.sh
```

Artifacts land in `artifacts/` as `Navilite-<version>-debug.apk` and `Navilite-<version>-unsigned.ipa`
(the version comes from `package.json`; bump `package.json`, `android/app/build.gradle`
`versionCode`/`versionName` and both `CURRENT_PROJECT_VERSION`/`MARKETING_VERSION` in
`ios/App/App.xcodeproj/project.pbxproj` together, or the builds lie about what they are).

A browser check needs Chrome and a built `dist/`; without either it **skips** with the reason, so a
green `npm test` on a machine with no Chrome is not evidence about the browser at all.

## Module map (`src/`)

| Path | Owns |
| --- | --- |
| `main.ts` | entry point: mounts the shell, boots `ui/app.ts` |
| `ui/app.ts` | the whole shell: routes, screens, song rows, the player bar, the seek bars, the tap gesture, palette, theme |
| `ui/pager.ts` | the horizontal pager behind the now screen (playlist \| spectrum \| lyrics): pull, projection, commit |
| `ui/lyrics.ts` | the lyrics panel: follow, hand-scroll grace, empty states |
| `ui/changelog.ts` | the in-app changelog data (mirrors `CHANGELOG.md`) |
| `ui/dom.ts` | `h()`, `replace()`, `icon()`, `cover()` — no framework, no virtual DOM |
| `state/queue.ts` | **the queue**: the play order, the cursor, repeat/shuffle, advance, play reporting, queue-ahead, the loading flag |
| `state/library.ts` | cached library reads (artists/albums/playlists/starred/search), `streamUrl`, the prefetch |
| `state/bitrate.ts` | the measured link and the `maxBitRate` decision (`ByteRate`, `chooseMaxBitRate`) |
| `api/subsonic.ts` | the Subsonic client: URL building, salt+md5 token auth, error mapping |
| `api/sidecar.ts`, `api/lyrics.ts` | the deployment's own `/lyrics` route, and the server's lyrics fallback |
| `player/engine.ts` | **the one transport**: a pure reducer (`reduce`) + a class that drives one of the two engines |
| `player/native.ts` | the Capacitor bridge: the app's one player (`NaviliteRemote`) — load/play/pause/seek/sync and the published queue — plus `NaviliteSpectrum`'s frames and `NaviliteDownloads` |
| `player/visualizer.ts` | the canvas bars: attack/release envelope, palette, no-samples theme mode |
| `player/palette.ts` | palette extraction from the cover art, and the default palette |
| `player/mediasession.ts` | the lock screen / media keys |
| `storage/*` | settings (localStorage), the credential store (Keychain/Keystore/localStorage), the resume snapshot, the lyrics cache |
| `lyrics/*` | the lyrics service (sidecar → server) and romanisation |
| `platform.ts`, `config.ts` | `platformInfo()` (which engine), the canonical origin and defaults |

## Audio architecture, in one paragraph

There is exactly **one audible engine**, and `src/player/engine.ts` is the only thing that decides
which: inside the Capacitor wrapper the audio comes from the app's own queue player
(`NaviliteRemote`) driven through `src/player/native.ts`, and in a browser it comes from the page's
own `<audio>` element through a Web Audio graph (`ensureGraph`) whose analyser feeds the speakers.
The engine is a state machine (`idle | loading | playing | paused | interrupted | error`) driven by `reduce()`;
nothing else in the codebase writes playback state. The **FFT tap** is the spectrum source and lives
on the *audible item*: on the native path every item is built with its own tap (`makeItem`) as the
player creates it and it is never re-attached on a pause or a return to the foreground, and in
the browser it is the analyser node on the element. The **queue** (`src/state/queue.ts`) is the only
owner of what "next" means — the order, the cursor, repeat and shuffle — and the only caller of
`engine.play`; the engine's job when a track finishes is to say so exactly once (`reportEnded`), and
the queue's job is to act on it. Since v1.9.0 the queue also (a) paints a selection synchronously
before it contacts anything, (b) pulls the next track's head while the current one plays
(`prefetchNext` → `library.prefetch`, one in flight, cancelled on a change), and (c) passes the
`maxBitRate` the measured link has earned into every stream URL (`state/bitrate.ts`).

## Where the two paths that matter are implemented

- **Play / pause / next / previous.** `ui/app.ts` `togglePlayback()` (the bar and the now screen, the
  lock screen through `player/mediasession.ts`) → `PlaybackQueue.toggle()` → `AudioEngine.toggle()`
  → `resume()`/`pause()`. A row tap is `songRow()`'s handler: `queue.select(...)` (synchronous paint:
  highlight, title, artist, artwork, loading) → `openNow()` → `queue.start()` (the engine and the
  network). `startCurrent` is the one place a track is loaded.
- **Seek.** `ui/app.ts` `bindSeek(input, ...)` — bound twice, to the player bar's slider and the now
  screen's. The bar takes the touch in the capture phase (`touchstart` claims and writes, so the
  pager never sees it), writes the *destination* into the labels while the finger is down, and
  commits on release → `PlaybackQueue.seek()` → `AudioEngine.seek()`; `refreshSeekLabels` puts the
  number back in the player's hands on the same frame.
- **The tap gesture** (a tap plays, a drag scrolls): `bindTap()` + `bindTapSurface()` in `ui/app.ts`.
  One press state for the whole list, an 8 px slop, and a one-shot click refusal with a TTL.

## Checks worth knowing before you write your own

`test/pager.test.ts` (runs `tools/pager-check.mjs`), `test/scroll-containment.test.ts`
(`tools/scroll-check.mjs`), `test/layout-393.test.ts` and `test/slow-link-browser.test.ts` (both
drive Chrome directly through `tools/layout-audit.mjs`'s `withChromePage`), the engine and queue
tests (`test/engine-native.test.ts`, `test/queue-ahead.test.ts`) which need no browser, and
`test/press-state.test.ts` which reads the stylesheet. Gestures whose verdict is a *release velocity*
are dispatched inside the page at a cadence the check sets — a CDP-driven drag hands the pager
round-trip-length gaps, and a check that measures a timer proves nothing about the app.
