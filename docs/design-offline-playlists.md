# Design: offline playlist downloads (1.9.12)

Owner's requirements, the shape of the change, and the exact holes it must not open. Inputs:
`docs/research-offline-downloads.md` (Mugger, committed) and `docs/HOW-IT-WORKS.md`. Crossfade is
shelved; nothing here may assume it, and nothing here may add a second transport.
Version 1.9.11 is stable; this lands as **1.9.12**.

## 1. Invariants

Numbered, and each one is falsifiable — a test or a grep must be able to show it holds.

1. **The audible path is synchronous.** `startCurrent` (`src/state/queue.ts:544`) resolves a URL from
   memory only. No `await`, no filesystem call, no HTTP call, no duration probe on that path. Local
   resolution reads an in-memory map; the map is hydrated once at boot and updated by events.
2. **Nothing is asked of the player before it is ready.** Unchanged from 1.9.11 (`NaviliteSpectrum`
   `.readyToPlay` guard, `NaviliteRemote.refreshNowPlaying`, `src/player/engine.ts:1443`): a local
   `file://` asset is *not* an exception. No seek, no duration read and no now-playing write on a
   slot that has not reported readiness.
3. **One lane per job.** The audible load and the warm pool own the bridge lanes
   (`src/player/native.ts:481-492`). Downloads use a *different* lane: `URLSession` inside
   `nsurlsessiond`, not the audio bridge, not the `AssetLanes` queue. A download may never
   `prepareNext`, `warmedUrl`, `discardPrepared` or `yieldToAudible`.
4. **The track boundary is a handover.** `publishQueue` (`queue.ts:801`) and the native statement
   (`NaviliteRemote.swift:290`) are never emptied by a download, a completion or a failure. The queue
   is never cleared to "refresh" the offline state.
5. **A moved-on item is never touched.** Every async download callback carries `(playlistId, songId)`
   and a generation; on arrival it applies only to the index, never to playback. Seeks, prerolls and
   plays continue to be gated exactly as today (`queue.ts:544`, `engine.ts:1677`).
6. **Exactly one source of truth for what plays next, and one for what URL it plays.** Order is
   `state/queue.ts` alone. URL is `Library.streamUrl` (`src/state/library.ts:64`) alone — the four
   existing resolution sites (`queue.ts:704`, `:776`, `:813`, `:914`) must all go through that one
   function, and the offline store must never build a URL anywhere else. Offline forks neither.
7. **A download never mutates playback state.** The offline module may not import, hold, or call
   `PlaybackQueue`, `AudioEngine` or `NativeBridge`. The only edge from playback to offline is the
   read inside `Library.streamUrl`; the only edge from offline to the UI is its own change listener.
8. **A local copy is used for one reason only: it exists and it is verified complete.** Not "was
   requested", not "is in progress". Staging bytes are never audible.
9. **Nothing is written where the OS can delete it silently.** Files live under Application Support
   with `isExcludedFromBackupKey = true`; never `Caches`, never `Documents` (research §1.1, §4.3).
10. **A download is not a sync.** Viewing a playlist may compare metadata; it may never start, resume
    or top up a download without a user tap.

## 2. Seams, each named and covered

**S1 — The resolver (`src/state/library.ts:64`).** Becomes the single chokepoint:
`streamUrl(song, maxBitRate?)` returns `offline.pathFor(song.id)` when the in-memory index holds a
`complete` row for that `songId`, else the existing Subsonic URL. A local path ignores `maxBitRate` —
it is already a file, and asking for a transcode of a local file is meaningless. Synchronous, no
throw, `null`-safe: an unhydrated index returns the stream URL, never `undefined`. This one edit
serves the audible load, the warm pool **and the queue published to the native side**
(`queue.ts:813`), which is what makes offline playback survive the app being suspended or killed —
`NaviliteRemote` walks the published queue with no JS running (`NaviliteRemote.swift:115`, §v1.9.9
header) and would otherwise stream from the network with a local copy sitting on disk.

**S2 — Queue and warm slots (`queue.ts:741`, `:776`, `:787`, `:914`).** Warms inherit S1, so a warmed
URL is the same string `startCurrent` plays (`queue.ts:583` — the string equality the engine's
adoption depends on, `engine.ts:1584`). A download that completes *while a track is playing* does
**not** invalidate the warm pool and does **not** swap a sounding asset: the resolver memoizes its
answer per `songId` for the life of the app session, and a fresh answer is picked up at the next cold
load (`startCurrent`) — the next natural boundary. Deliberate: it never costs a gap and never forces
a re-load of something audible. The published statement is re-stated on every start, warm and
visibility change (`queue.ts:750`), so by the time the app is backgrounded it carries local paths.

**S3 — The native boundary.** What must be native: the transfer, the staging write, the atomic move,
the byte-count verification, `isExcludedFromBackupKey`, the free-space query and the session
re-attach. What must stay in JS: deciding *what* to download, the index, the estimator, the UI. A
background `URLSession` cannot be driven from JS (research §3, §4.1) and a JS-written file cannot
survive suspension. New plugin `NaviliteDownloads` (Swift, `CAPBridgedPlugin`), registered beside the
other two at `ios/App/App/ViewController.swift:43-44` and added to the Xcode target's file list
(`ios/App/App.xcodeproj/project.pbxproj:20,36,74,173` — three places per file, mirroring
`NaviliteSpectrum.swift`). API: `enqueue({songId, url, suffix, bytes})`, `cancel({songId})`,
`remove({songId})`, `list()` → rows, `freeBytes()`, `configure({allowsCellular, maxConcurrent})`,
`addListener('progress'|'done'|'failed')`. Android is *not* in this change (see §9).

**S4 — Background, foreground and suspension.** Downloads belong to `nsurlsessiond`; JS may be
suspended 3-5 s after backgrounding and the transfer continues (research §3). The JS side therefore
treats every progress event as advisory and `list()` as the truth: one reconcile call on
`visibilitychange` → visible and once at boot. A background completion wakes the app
(`AppDelegate` — `application(_:handleEventsForBackgroundURLSession:)`, to be added) and the plugin
moves staging → final *natively*, so the file is correct even if JS never runs again. No completion
handler may wait on JS: `completionHandler` is called by the plugin immediately after the move.

**S5 — Lock-screen metadata and duration.** `setupMediaSession` (`queue.ts:962`) and
`refreshNowPlaying` (`NaviliteRemote.swift:805`) keep working unchanged: a `file://` asset has a real
duration, so the v1.9.10 bug class (a duration published before the item had one) is *less* likely
offline, not more. `trackProgress` (`queue.ts:939`) and `updatePositionState` are untouched — no new
writer on the card, ever (this is the seam where two writers have killed the transport before).

**S6 — Spectrum and lyrics read the same bytes.** The FFT tap lives on the item the load put in place
and works on `file://` (research §1.3) — no change. Lyrics are **not** downloaded in 1.9.12: the
lyrics service (`src/lyrics/service.ts`, `src/api/sidecar.ts`) will simply fail offline and must fail
*quietly* — a lyrics miss shows the existing empty state, never a toast, and never blocks or retries
the audible path. Recorded as a known gap in §9.

**S7 — Seek and backtracking.** Seek stays `queue.ts:442` → `engine.ts:1867`. A complete local file
supports range seeking natively; a staging `.part` file is *not addressable* because the resolver
never returns it (invariant 8). Backtracking and the previous-track warm are unchanged (S2).

**S8 — Shuffle and repeat.** Zero interaction. Order lives in `queue.ts` (`shuffleOrder:74`,
`planAdvance:101`); resolution is per-item and happens at URL-build time. A shuffled playlist that is
downloaded plays shuffled from disk with no code path that knows about downloads.

**S9 — Playlist mutation while copies exist on disk.** Files are keyed by `songId` and deduplicated
across playlists (research §3, §4.6): removing a track from a playlist decrements its `refs` and
deletes the file only when `refs` is empty *and* the track has no explicit per-song download. Removing
the whole playlist download drops every ref. Reorder is a no-op — nothing on disk is ordered. A track
removed on the server is not deleted from disk until the playlist download is refreshed (a stale copy
is harmless; a deleted file that the index still claims is not — see edge case 3).

**S10 — Per-song vs per-playlist storage.** One file per `songId`. A playlist download is a
*manifest* (which songs, requested when), not a directory. Two playlists sharing 40 tracks store 40
files and one delete on one playlist does not break the other.

**S11 — Accounting and eviction.** No automatic eviction in 1.9.12: the owner asked to know how much
space it takes, not for the app to reclaim it. Total downloaded bytes are shown in Settings
(`Downloaded music: 1.2 GB · 147 tracks`) with a single "Remove all downloads" action. Eviction is
explicit, per playlist, or global.

**S12 — The playlist page's existing gestures.** The control is mounted into the header action row
via `pageTitle(..., actions)` (`src/ui/app.ts:1569`) from `renderPlaylist` (`app.ts:1871-1876`), as a
sibling of "Play playlist". That row is outside the scrollable list, above the rows
`bindTapSurface` (`app.ts:686`) owns and outside the pager's region, and it is a normal
`click`-driven `button` — so it cannot contend with the tap surface, the seek bars
(`bindSeek`, `app.ts:953`) or the pager, and it needs no change to any of them. The size label is
written by the download store's change listener, never by a poll; the button renders from the index
synchronously, so it never flashes a wrong number.

**S13 — Changelog and release machinery.** `CHANGELOG.md` gains a `## 1.9.12` section and
`src/ui/changelog.ts` is updated in the same commit (`test/changelog.test.ts` fails otherwise).
Version bump in three places per `HOW-IT-WORKS.md`: `package.json:3`,
`android/app/build.gradle:10-11`, and both `CURRENT_PROJECT_VERSION`/`MARKETING_VERSION` in
`ios/App/App.xcodeproj/project.pbxproj`. The tree must be clean when this is committed.

## 3. Data model and storage layout

Directory (native-owned, created in the plugin's `load()`):

```
iOS:     Library/Application Support/navilite-offline/
Android: files/navilite-offline/                       (not built in 1.9.12)
  <songId>.<suffix>            a complete, verified file      (suffix from Song.suffix, default mp3)
  staging/<songId>.<suffix>.part   in-progress bytes; never audible, never addressable
  index.json                   the native index — THE truth for what is on disk
```

`index.json` is written atomically (write `.tmp`, `replaceItemAt`) after every state change, and every
file it names carries `isExcludedFromBackupKey = true`. A row:

```json
{ "songId": "abc123", "suffix": "flac", "bytes": 31204321, "sha": null,
  "downloadedAt": 1792000000, "state": "complete",
  "refs": ["pl-9", "pl-14"], "title": "...", "artist": "...", "album": "...", "durationSec": 231 }
```

Keyed by `songId`. `bytes` is the *actual* bytes written, verified against `Content-Length`, never
`song.size` taken on faith. `refs` is the playlist ids that asked for it.

The **JS mirror** is `localStorage["navilite.offline"]`, the same shape as the resume snapshot
(`src/storage/session.ts:38-42`): `{ v: 1, hydratedAt, rows: { [songId]: { path, bytes, state } } }`.
It exists for one reason — invariant 1, a synchronous resolver — and it is a *cache*: the native
`index.json` wins, and the mirror is rewritten after boot reconcile, after every `done`/`failed`
event, and after any removal. A stale mirror is a performance bug, never a correctness bug (§6, E3).

Survives an app restart because both halves are on disk: the native index and the mirror are two
copies of the same facts, and boot runs `list()` → mirror. If the mirror is missing, empty or corrupt
it is rebuilt from `list()`; if `list()` returns rows whose files are gone, they are dropped there.

## 4. Size estimation

```
estimateBytes(songs):
  total = 0; exact = true
  for s of songs:
    if (s.size && s.size > 0) total += s.size
    else { exact = false; total += max(1_000_000, round((s.duration ?? 0) * 40000)) }
  return { total, exact }
```

`40_000` bytes/s is 320 kbit/s — an upper bound for the originals this server holds, so the fallback
is an over-estimate and the displayed number is never a promise the download breaks. Accuracy bound:
**exact** (byte-equal to the sum of `Content-Length`, because the files come from
`download?id=` — original, untranscoded, exact length, research §1.4, §5) when every entry has a
`size`; Navidrome's `getPlaylist` returns one for every entry, so this is the normal case and the
displayed figure is the *real* one. When any entry lacks a `size`, the figure is prefixed
`at least`, which is also how it is read aloud and how it is labelled in the accessible name.

Failure mode: a playlist with zero entries shows `Nothing to download` and disables the control; an
unknown length never blocks a download and never shows a bare number without `at least`.

What the UI shows, exactly one compact control in the header action row:

| State | Label | Tap |
| --- | --- | --- |
| idle | `↓ 312 MB` | start; over cellular without permission → confirm `Download over cellular?` |
| estimating | `…` (local arithmetic, only if it exceeded 200 ms) | nothing |
| downloading | `3 of 14 · 312 MB` | cancel → confirm; already-done tracks kept |
| partial | `12 of 14 · retry` | resume the missing 2 |
| complete | `✓ 312 MB` | opens the remove affordance (`Remove download`) |
| failed | `Retry` | re-enqueue, from zero or from `resumeData` |

## 5. Download state machine

Per song, in the index: `absent → staging → complete | failed`, plus `absent` again after removal.
Per playlist record: `idle → estimating → downloading → complete | partial | failed → removed`.

- `idle → estimating`: tap. Pure arithmetic over `playlist.entry` already in memory. No network.
- `estimating → downloading`: free-space guard `volumeAvailableCapacity > total + 250 MB`
  (research §7); otherwise a toast and back to `idle`, nothing enqueued.
- `downloading → complete`: every song `complete`.
- `downloading → partial`: ≥1 complete, ≥1 failed or cancelled. Persists; the button says `retry`.
- `downloading → failed`: zero complete. Same `retry` affordance, different copy.
- any → `removed`: explicit `Remove download`; files deleted, refs dropped, rows dropped.
- **What persists across an app kill:** everything. `index.json` (native, atomic) and the mirror.
  Plus the plugin's `UserDefaults` list of in-flight `songId`s, so a relaunch can reconcile
  `URLSession.getAllTasks` against them.
- **Resume rule:** on boot, every row still `staging` is re-checked. A staging file whose byte count
  equals the expected `Content-Length` **is promoted to `complete`** (the bytes arrived, only the
  callback was lost). Otherwise it is marked `partial` and re-enqueued *only if the playlist record
  is `downloading`* (i.e. the user had not cancelled) — `URLSession` resumption via `resumeData` is
  best-effort and never the rule: the rule is "correct or re-fetch", never "trust a partial".
  Concurrency capped at 3 (research §4.1), enforced natively.

## 6. Edge cases

1. **Partial file (wrong bytes, same name):** never promoted; the staging file is deleted and the
   track re-fetched. Comparison is byte-count *and*, when the server sent one, `Content-Length` of
   the response after redirects.
2. **Killed mid-download (app switcher force-quit):** iOS cancels background tasks (research §4.4).
   Nothing is lost but the bytes: rows stay `staging`, the playlist stays `downloading`, and the next
   foreground reconciles and re-enqueues. The control reads `Resume · 9 left`.
3. **File purged or user-deleted outside the app:** the mirror still claims a path. The file is
   missing → AVPlayer/ExoPlayer reports a load error → the existing error path runs
   (`engine.ts:1443` result → `queue.ts:544` failure branch), playback falls back to the stream, the
   row is marked `failed`/`absent`, and the fallback must be *silent* — no toast mid-song, no
   re-enqueue. Designed: **the stream is the substrate, the file is an optimisation.** Local-first
   must never be able to take playback away.
4. **Disk full mid-download:** the native side aborts the task, marks the song `failed`, keeps what
   is complete; one toast, once; the partial staging file is deleted (never left to fill the volume).
5. **Offline with no local copy while the queue advances:** unchanged and correct — the stream load
   fails, the existing native advance-failure path runs (`NaviliteRemote.swift:467`,
   `adoptNativeAdvance`, `queue.ts:869`). The queue is **not** skipped and not emptied; it stops where
   it is. Downloads never change how a failed load behaves.
6. **Song id reused or changed:** ids are the file names, so a reused id with different bytes would be
   served from the old file. Guarded by storing `durationSec` and `title`; if the server's current
   metadata for that id disagrees on duration by >2 s, the row is treated as `absent` and the file
   removed. A changed id is simply a new download; nothing migrates and nothing is orphaned (the
   orphan sweep in 7 covers the old file's refs).
7. **Orphan sweep:** on boot, after reconcile: any file with no index row, and any row with no
   `refs` and no explicit per-song download, is deleted. Staging files older than 24 h are deleted.
8. **Wi-Fi vs cellular:** default **Wi-Fi only**. `configure({allowsCellular:false})` sets
   `URLSessionConfiguration.allowsCellularAccess = false` natively (research §8) — so the default is
   enforced by the OS, not by JS politeness. If the user taps download on cellular, one confirmation
   (`Download 312 MB over cellular?`) then a per-playlist `allowsCellular: true` session. The choice
   is per-download, not a sticky setting; no cellular download ever starts without that tap.

## 7. File:line plan

**New files.**
1. `ios/App/App/NaviliteDownloads.swift` — `NaviliteDownloads: CAPPlugin, CAPBridgedPlugin`,
   `jsName = "NaviliteDownloads"`; background `URLSession` with a fixed identifier;
   `application(_:handleEventsForBackgroundURLSession:)` in `AppDelegate.swift`; staging write →
   byte verify → `moveItem`; `isExcludedFromBackupKey`; `index.json` read/write; `freeBytes()` via
   `volumeAvailableCapacityForImportantUsageKey`; max 3 concurrent.
2. `src/storage/offline.ts` — the mirror: `loadMirror()`, `saveMirror()`, `clearMirror()`, tolerant
   parse, modelled on `src/storage/session.ts:86-152`. No network, no plugin.
3. `src/state/offline.ts` — `OfflineStore`: the in-memory index, the playlist records, the state
   machine of §5, `estimateBytes()` (§4), `hydrate()` (boot + on-visible reconcile),
   `download(playlistId, songs)`, `remove(playlistId)`, `onChange`. Imports: `storage/offline.ts`
   and the downloads bridge only — **not** queue, engine or native bridge (invariant 7, testable by
   a dependency test).
4. `test/offline-resolver.test.ts`, `test/offline-store.test.ts`, `test/offline-estimate.test.ts`.

**Edits.**
5. `src/state/library.ts:64` — `streamUrl` consults `offline.pathFor(song.id)` first; constructor
   (`library.ts:32`) takes an optional resolver so the browser bundle and tests can pass a stub.
6. `src/player/native.ts` — `createDownloadsBridge()` alongside `createNativeBridge` (`native.ts:573`),
   same plugin-load/`BRIDGE_BUILD_TIMEOUT_MS` discipline; a separate `AssetLanes`-free path
   (invariant 3).
7. `src/ui/app.ts:1871-1876` — `renderPlaylist` builds the download control and passes it to
   `pageTitle`'s `actions` after `playAll`; subscribes to `OfflineStore.onChange` and re-renders the
   label only. `src/ui/app.ts:1569` needs no change unless the action row needs to wrap at 393 px
   (then the fix is in the stylesheet, not the gesture code — `test/layout-393.test.ts` guards it).
8. `src/ui/app.ts` settings screen — the `Downloaded music: … · Remove all downloads` row (S11).
9. `src/main.ts` / `src/ui/app.ts` boot — construct the store, `hydrate()` before the first render,
   subscribe to `visibilitychange` for the reconcile (reusing the existing visibility hook that
   already drives `engine.handleVisibility`, `engine.ts:1954`).
10. `src/ui/changelog.ts`, `CHANGELOG.md`, `package.json:3`, `android/app/build.gradle:10-11`,
    `ios/App/App.xcodeproj/project.pbxproj` (both versions) — S13.
11. `tools/mock-subsonic.mjs` — serve `download?id=` with an exact `Content-Length` and a `size` per
    song so the estimator and the byte check are testable without a device.

## 8. Tests Nerd must write

- `test/offline-resolver.test.ts` — **new:** with a `complete` row, `streamUrl` returns a `file://`
  path and ignores `maxBitRate`; with no row it returns the unchanged Subsonic URL (string equality
  against today's output). **Must not break:** the existing stream URL for every song that has no
  local copy, byte for byte. **Recovery:** a row whose file is gone still resolves to the path, and
  the failure branch returns to the stream without throwing (`S1`, `E3`).
- `test/offline-store.test.ts` — the transitions of §5 including `staging` → promoted on a matching
  byte count, `staging` → `partial` on a mismatch, cancel → `partial`, `remove` → refs decremented
  and file dropped only at zero. **Must not break:** two playlists sharing a track keep it after one
  is removed (`S10`). **Recovery:** a boot with a missing/corrupt mirror rebuilds from `list()` and
  plays local on the first start after.
- `test/offline-estimate.test.ts` — exact sum when `size` is present on every entry; `at least`
  prefix and the 320 kbit/s bound when one is missing; zero entries → the disabled label.
- `test/download-lane.test.ts` (or extend `test/native-boundary.test.ts`) — **must not break:** after
  a download completes, no `prepareNext`/`discardPrepared`/`unload` is issued for the sounding
  `songId`, and the published queue (`publishQueue`) is unchanged (`I3`, `I4`, `S2`).
- Dependency test (in `test/offline-store.test.ts`): read `src/state/offline.ts` and its imports and
  assert it names no queue/engine/native module — invariant 7 as an executable claim.
- `test/changelog.test.ts` already exists and must stay green with the new section.
- Manual, once, by the owner: airplane mode + play a downloaded playlist, seek inside a track, skip
  forward and back, lock the screen, and step a track with the phone locked.

## 9. Acceptance criteria (what the owner judges)

1. A playlist shows a compact download control with the **total size**, and tapping it makes the
   playlist play with the phone in airplane mode.
2. After a download, playing that playlist **does not touch the network**: the stream is not
   requested for songs that have a local copy (verifiable in the server's access log).
3. Track-to-track inside a downloaded playlist has no gap and no re-fetch, including when the app
   was backgrounded and the screen is locked.
4. Removing the download frees the space, and the size the app promised matches what it took
   (§4: it matches exactly when the server sent sizes).
5. Nothing that worked in 1.9.11 changed: playback that does not involve downloads, gestures on the
   playlist page, seek, shuffle, repeat, the lockscreen card, the spectrum.
6. The release build is clean — one commit, `docs/design-offline-playlists.md` and the code, no
   dirty tree, changelog and version bumped in all three places.

Known gaps, stated rather than hidden: **Android is not built** (this change is iOS-only; the
`offline.pathFor` seam and the index are platform-neutral so an Android plugin can follow);
**lyrics are not available offline** (§S6 — they fail quietly); **downloads do not survive a
force-quit mid-transfer** (§6 E2 — they resume on the next foreground, from zero if required);
**no automatic eviction** (§S11 — the owner removes downloads deliberately).

## 10. 1.9.12 changelog entry

```markdown
## 1.9.12 — 2026-10-16

- Download a playlist to your phone and it plays without a connection — the download button shows how
  much space it will take before you start.
- Songs you have downloaded play from your phone instead of over the network: faster to start, and
  it uses no data.
- Downloading keeps going while the app is in the background, and a playlist you have downloaded
  still plays from your phone on the lock screen.
```

## Offline lyrics

Appended 2026-10-15 on the owner's requirement: a downloaded playlist is the songs **and** their lyrics, the lines still highlight by timestamp with no connection, and the lyrics count in the size estimate. §1–§10 stand unchanged; this closes the §S6 gap ("lyrics are not available offline") and supersedes §4's label word. Mugger's `docs/research-offline-lyrics.md` had not landed when this was written — see *Open questions*; nothing below waits on it.

**Where lyrics come from today (the source of truth).** `LyricsService.lyricsFor` (`src/lyrics/service.ts:37`) is the UI's only entry point and `fetchLyrics` (`src/api/lyrics.ts:168`) is the only place a track's lyrics are decided. Sources, in order: the library's own route (`LyricsRoute.lyricsFor`, `src/api/sidecar.ts:91` — `GET <door>/lyrics?path=<song.path>`, `text/plain`, 8 s, path encoded at `sidecar.ts:85`), then `getLyricsBySongId`, then the legacy `getLyrics` blob behind the `sameSong` artist/title guard (`lyrics.ts:209`). Every body is parsed in one place (`fromSidecar`/`parseLrc`/`parsePlain`, `lyrics.ts:64-142`), romanised in `finalize` (`lyrics.ts:149`) and reduced to `LyricsDoc { lines: [{timeMs, text}], synced, source, fullRomaji }` (`lyrics.ts:38`). **Timing lives in the doc**: the highlight (`src/ui/lyrics.ts:131`) walks `doc.lines[].timeMs` against the position the panel is handed (`ui/lyrics.ts:207`), gated on `doc.synced`. The view does not know where a doc came from and must not learn.

The existing device cache (`LyricsCache`, `src/storage/lyrics.ts`, `localStorage "navilite.lyrics.v1"`) is a *view* cache: 200 entries (`:22`), hits expire in a week, misses in five minutes (`:28`, `:35`), and it holds a parsed doc, not the file — so a 300-track playlist evicts its own earlier lyrics silently. That is why the durable copy below exists.

**What is downloaded.** One extra transfer per track, in the audio's own lane: `enqueue({songId, url, suffix: 'lyrics'})` (no new write path in `NaviliteDownloads.swift`, §S3), URL from `LyricsRoute.urlFor(song)` (`sidecar.ts:85`), sent with the headers the shipped native path already uses (`accept: text/plain`, `sidecar.ts:126-134`) and with cookies enabled, so the route sees the same session it sees today on the device. Route `null` → fall back to `getLyrics` and store that raw value behind the same `sameSong` guard; both empty → `none`. `getLyricsBySongId` is deliberately **not** downloaded: it is Navidrome's parse of the very sidecar the route serves, and the one payload that cannot be stored raw.

**Where it is written.** Next to the audio, keyed like it (`<root>` is §3's directory): `<root>/<songId>.lyrics` (the verbatim body bytes) and `<root>/staging/<songId>.lyrics.part`. The native `index.json` row (§3) gains one object, `bytes` verified against `Content-Length` exactly as the audio row is; the JS mirror row gains `lyrics: { state, bytes }` and never the text:

```json
"lyrics": { "state": "present", "file": "abc123.lyrics", "bytes": 4213, "fetchedAt": 1792000000 }
```

**Raw, parsed on every read.** Nothing parsed is ever stored: the file *is* the sidecar's bytes and `fromSidecar` (`lyrics.ts:133`) runs at read time. That is the answer to "which survives an app version change" — the raw body does: a parser or romaji fix improves a copy downloaded months ago, and no stored doc can freeze an old parse bug into the offline set. The view cache keeps storing parsed docs, as today; it is a cache, this is the copy.

**A lyric-less track is a stored fact, not a silence.** `lyrics.state: "none"` records "asked, there is nothing", so nothing re-asks it on every visit or launch. A row with **no** `lyrics` key was never asked, and the next download or reconcile asks. `none` is not permanent — Navi is still writing sidecars (`storage/lyrics.ts:12-17`) — so a network-reachable reconcile re-asks a `none` older than five minutes, once; a failed request leaves the row alone.

### Offline rendering and highlighting

`LyricsService.lyricsFor` (`src/lyrics/service.ts:37`) gains one step between the view cache (`:38`) and the network (`:40`): ① the view cache, unchanged and first → ② **the durable copy**, `OfflineStore.lyricsDoc(songId)`: one `plugin.readLyrics({songId})` file read (no network) parsed by the same `fromSidecar` — `present` → the doc; `none` younger than five minutes → `null` with no request at all → ③ today's `fetchLyrics`, byte-identical, when ② has nothing to say → ④ whatever the network returned is written into the view cache exactly as today (`:63`). The constructor (`service.ts:26-34`) takes a fourth getter `() => OfflineStore | null` beside the existing `library`/`sidecar` getters, wired at `src/ui/app.ts:199`; the store never imports the service (invariant 7's one-way edge).

**`src/ui/lyrics.ts` is not edited at all, and any diff in it is a bug.** The highlight keeps reading `doc.lines[].timeMs` against the playback position (`ui/lyrics.ts:131-145`, `:207`); offline the doc is built from the same bytes the route serves online, so the same line lights at the same moment.

- **Timestamps absent** (a `.txt`, the normal case): `synced: false`, every `timeMs: null`, no highlight, lines shown — not a special case offline.
- **Lyrics missing** (a `none` row, or no row): `no romaji lyrics for this track yet` (`ui/lyrics.ts:36`) — immediately with a `none` row, after the request fails without one. Never a toast, never a spinner past `PATIENCE_MS` (15 s), never a gate on playback.

### The estimate includes the lyrics

```ts
const LYRICS_ASSUMED_BYTES = 12 * 1024;               // 12 KB per track, an upper bound
// §4's audio rule, unchanged  →  (audioBytes, audioExact)
lyrics = 0; lyricsExact = true;
for (s of songs) {
  const row = rows[s.id]?.lyrics;                     // in-memory index, no I/O
  if (row?.state === 'present') lyrics += row.bytes;              // the measured body
  else if (row?.state === 'none') lyrics += 0;                    // asked, nothing there
  else { lyrics += LYRICS_ASSUMED_BYTES; lyricsExact = false; }   // never resolved
}
return { total: audioBytes + lyrics, exact: audioExact && lyricsExact };
```

`estimateBytes` (`src/state/offline.ts:105`) becomes `estimateBytes(songs, rows)`: pure, no network, no disk, no new wait in the 200 ms estimating state. 12 KB is a bound because a timed `.lrc` line is ~30–60 bytes, so 200 lines (four minutes of dense singing) is ≈12 KB — the mock's `--stress` sidecar (12 long Japanese lines, `tools/mock-subsonic.mjs`) is under 2 KB. If his library ever exceeds it the constant moves and the rule does not.

**Wording:** `exact` → `↓ 312 MB`; otherwise `↓ up to 312 MB`, read aloud the same way. This **supersedes §4's label word**: `src/ui/app.ts:1900`, `const prefix = estimate.exact ? '' : 'at least '`, becomes `'up to '`. Both unknown cases are *ceilings* — a missing audio size is bounded above by 320 kbit/s, an unresolved lyric by 12 KB — so the figure is the most the download will ask for, while `at least` promised the opposite of what the arithmetic computes; that is exactly how §9's criterion 4 ("the size the app promised matches what it took") breaks. §4's arithmetic, guard and table are otherwise unchanged. The normal case: before a first download a playlist has no lyric rows and reads `up to …`; after it every row is `present` or `none` and the same playlist reads `↓ 312 MB` exact. Rows are keyed by `songId` and deduped across playlists (§S10), so a playlist sharing tracks is exact on its first open. Unknown or absent lyrics never block a download and never disable the control; only zero entries does (§4).

### Seams

- **State machine (§5) gains one independent axis.** Per song, `lyrics: pending → present | none | failed`, beside the unchanged audio axis. A playlist is `complete` only when every track's audio row is `complete` **and** every lyrics axis is `present` or `none`; any `failed` lyric leaves it `partial` (`retry` = one small transfer, never a re-download of the audio). **Invariant 8 wins**: a track whose audio is verified complete resolves to its local file from that moment, whatever its lyrics row says — a lyric failure never gates `pathFor` (`src/state/library.ts:64`), never marks the audio row `failed`, never delays a playable track. Otherwise one flaky route call makes a downloaded song unplayable offline, which is the worst outcome on this card.
- **Resume / kill.** `staging/<songId>.lyrics.part` is promoted on a matching `Content-Length` at the boot reconcile and deleted + re-enqueued otherwise, only while the playlist record is still `downloading` — §5's audio rule exactly. Audio is enqueued first (the long pole), lyrics second, in the same session.
- **Playlist changed after download.** A track added (or a refreshed playlist download) enqueues **both** rows for it; a track removed decrements `refs` and drops its `.lyrics` file and `lyrics` key together with the audio row at `refs === 0` (§S9, §S10). Reorder stays a no-op, and nothing touches a file the index does not name.
- **Upstream staleness is accepted, with one exception.** A `present` copy is never re-checked: it is what the sidecar said on download day, and re-checking on open would be a second sync (invariant 10) at a request per track per open; re-download the playlist (or remove and re-add a track) to pick up an edited lyric. The exception is the miss — a reachable reconcile re-asks a `none` older than five minutes, so a sidecar Navi writes next week appears with nobody clearing anything.
- **Lanes.** The transfer rides `NaviliteDownloads`' `URLSession` (research §3) — never the audio bridge lanes (`src/player/native.ts:481-492`), never `prepareNext`/`warmedUrl`/`discardPrepared`/`yieldToAudible`, never a track load. JS does one `readLyrics` read plus `parseLrc`/`romanizeLine` on a few hundred short strings, on the panel's own async path; `startCurrent` (`src/state/queue.ts:544`) stays synchronous and is not in the picture (invariant 1).
- **Playlist page, pager, gestures:** untouched. The estimate is arithmetic (§S12, §S13) and the only UI edit anywhere is the prefix word at `app.ts:1900`.

### Tests Nerd must write

- `test/lyrics-offline.test.ts` (new), every case with a stubbed `SidecarSource`/`LyricsSource` that counts calls. **New:** a `present` row → the doc's `timeMs` equal the stored LRC tags with **zero** network calls; the body is parsed at read time, not at download time (read a row written from a `.txt` → `synced: false`; rewrite the file as `.lrc`, read again → `synced: true`); a `none` row younger than five minutes → `null`, zero calls; an older `none` → the route is asked and a newly written sidecar wins. **Must not break:** a track with no row asks the three sources in today's order (assert the call sequence and an identical doc), untimed text is lines with `timeMs: null` and no highlight, and a synced doc highlights the same index for the same position. **Recovery:** a `present` row whose file is gone returns to the network without throwing and without a stale doc.
- `test/offline-estimate.test.ts` (extend): `LYRICS_ASSUMED_BYTES` added once per unresolved track with `exact: false`; a `present` row adds its real `bytes`, a `none` adds 0, both `exact: true`; two playlists sharing a song count its lyric bytes once; the `exact: false` prefix is `up to `.
- `test/offline-store.test.ts` (extend): a `failed` lyric leaves the playlist `partial` with `retry` while that track's audio row is `complete` and `pathFor` already returns its file (invariant 8 wins); a lyric failure never flips the audio row to `failed`; a `.lyrics.part` matching its `Content-Length` is promoted on reconcile, a mismatch is deleted and re-enqueued; removing the last `ref` deletes both files.
- Lane test (`test/download-lane.test.ts` / `test/native-boundary.test.ts`): the lyrics enqueue carries `suffix: 'lyrics'` and issues no `prepareNext`/`discardPrepared`/`unload` for the sounding `songId` (invariant 3).
- Manual, once, by the owner: airplane mode + a downloaded playlist → the highlight follows; a lyric-less track shows the empty line without the 15 s wait; the size the control showed still matches what the phone reports.

### Acceptance and the changelog line

In his terms: (1) a downloaded playlist's lyrics are there with no connection, and a timed lyric highlights the right line offline; (2) a track with no lyrics says so offline, at once, and still plays; (3) the size shown before a download includes the lyrics and is exact after it; (4) nothing in 1.9.11 changed — online lyrics, the highlight, gestures, the spectrum. One line to add to the §10 block and to `CHANGELOG.md` + `src/ui/changelog.ts`:

```markdown
- Playlists you download bring their lyrics with them: the words and the line highlight still work
  with no connection, and the download size includes them.
```

### Open questions

1. The 12 KB bound is asserted, not measured against his library; `find <music root> \( -name '*.lrc' -o -name '*.txt' \) -print0 | xargs -0 wc -c` settles it, and only the constant moves.
2. Mugger's research may name a canonical cache layout or timestamp-format edge cases (offsets, fractions). Nothing here depends on it: the offline copy is the route's own bytes, parsed by the parser already in the repo.
3. Device check for Nerd: that the plugin's `URLSession` reaches `<door>/lyrics` with cookies — the same session `nativeSidecarFetch` sees (`sidecar.ts:126`). If it does not, fix the route's auth, not the download lane.
