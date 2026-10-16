# Design: downloaded-content surfaces (1.9.20)

Owner's report, Telegram 2026-10-15 evening, on the 1.9.19 build, plus his screenshot of the
Playlists tab (attachment 126, `img_6909a6dcd4f5.jpg`, re-sent 2026-10-16 11:06). This is the
**design gate**; implementation is Nerd's (`t_64b1e6a3`). The app's ownership line is research →
design + review (Sage) → implementation, and the previous release showed what skipping the gate
costs (`DECISIONS.md`, 1.9.19).

Inputs: his words, the screenshot decoded below, `src/state/offline.ts` (the store),
`src/ui/app.ts` (the surfaces), `src/storage/offline.ts` (the mirror),
`ios/App/App/NaviliteDownloads.swift` (the lane), `docs/design-offline-playlists.md` (the 1.9.12
design whose invariants and seams this one extends — "§" references are to that file).

---

## 0. What the gate found before designing anything

### 0.1 The duplicate, reproduced on the built app with a real server

Run, on this machine, against the shipped `dist/` of `main` (ac12206), with the mock answering as
a **real** Navidrome would (`node tools/mock-subsonic.mjs --port 4641 --stress --dist dist`), the
app's own offline mirror in `localStorage` holding **one** downloaded playlist whose id and name
are the mock's own (`pl-stress-ja`), and Chrome at 393 × 852 dpr 3:

```
route #/playlists · h1 “Playlists”

      [p.muted] (page subtitle: “getPlaylists / createPlaylist”)
  [div.list]
    [h2.section] Downloaded
    [button.row] “深夜のドライブ用プレイリスト（…）”   — 3 tracks · 3 on this phone · 23.2 MB
  [div.list]
    [button.row] “Late night”
    [button.row] “深夜のドライブ用プレイリスト（…）”   — 3 tracks · 1:15
    [button.row] “LateNightDrivingPlaylistWithNoSpaces…”
    [button.row] “夜のドライブのためにえらんだ長い…”   — 35 tracks · 13:55

tap targets: 5 — “Open 深夜のドライブ…（…）” twice, both → #/playlist/pl-stress-ja
```

**One playlist, two rows, one destination.** The first is the store's
(`renderPlaylists` → `ui/app.ts:2073-2077` → `offlinePlaylistRow`, `ui/app.ts:1779-1793`: sub-line
`record.done`/`record.bytes` — an *estimate* — and `cover(null)`, `ui/app.ts:1782`), the second is
the server's (`playlistRow`, `ui/app.ts:2102-2114`: `formatDuration`, and art through
`ctx.library.coverUrl`, `ui/app.ts:2105`). The section is **not** a placeholder that the server's
answer replaces: `ui/app.ts:2094-2099` replaces `serverHost` only, so both lists are painted
whenever the server answers at all.

The screenshot is that, plus the reason it reads as a second *entity* rather than a second *row*:
the pairs are not adjacent (the store's order is `requestedAt` descending, `state/offline.ts:442`;
the server's is its own), one of each pair has a placeholder glyph where the other has art, and the
sub-lines differ in kind (`5 GB` of estimate vs `17:03:55` of runtime) — so nothing on the screen
says which of the two is "the downloaded one", and nothing else on the screen says "downloaded" at
all: there is no per-row badge anywhere (`songRow`, `ui/app.ts:2550-2611`, draws a play mark, a
title, a sub-line and a time — no download state).

The report's literal wording is *not* the mechanism, and the gate should say so out loud:
**nothing creates a playlist for downloads.** `createPlaylist` has exactly one caller, the Create
button (`ui/app.ts:2061`; `state/library.ts:165`; `api/subsonic.ts:302-303`). The defect is one
server playlist drawn on two surfaces at once, neither marked.

### 0.2 What that changes about the brief

The brief said "find what actually creates the row he sees and prove it". It is not a created row —
it is a **second, additive painting of the same playlist**, and it is additive *permanently*, not
only in the offline degrade. The acceptance that follows is therefore sharper than "remove the
section": **no playlist name may appear twice on that screen, with the network up or refused, and a
fully downloaded playlist must read as downloaded on its own single row** (operator, 2026-10-16).

---

## 1. Invariants

Numbered, falsifiable, each with the seam that makes it true.

1. **One row per playlist, always.** No view may paint the same playlist twice, with the network up
   or refused. The store's knowledge *annotates* the row another source draws; it never appends a
   row of its own. The only exception is a screen the server cannot answer at all
   (`renderOffline`, `ui/app.ts:1746-1776`), where there is no other row to annotate and the store
   *is* the list.
2. **A "downloaded" claim is read synchronously and only from a verified file.** A track is
   downloaded iff `pathFor(songId) !== null` (`state/offline.ts:339-342`, i.e. a `complete` row,
   §I8). A playlist's state comes from `record()` (`:422`) — never from the manifest's length,
   never from `staging`, never from "was requested".
3. **Nothing on these surfaces waits on a round trip**, and no transport message is ever a view's
   primary content (1.9.18 §1, §3). The badge, the downloaded-songs list and the art path answer
   from memory.
4. **The store's estimate is never presented as what is on the phone.** `record.bytes`
   (`state/offline.ts:119`, computed by `estimateBytes`, `:175-202`) is a *ceiling for a download
   that has not happened*; the row's "on this phone" figure is measured from the rows. The
   screenshot shows the two confused (`5 GB` next to `269 on this phone`).
5. **Art is a third axis of a download, beside audio and lyrics, and it gates nothing.** A missing,
   failed or 404 art transfer leaves the track playable, leaves `pathFor` untouched, and never
   holds a playlist on `· retry`. (Same rule §"Offline lyrics" spells for a failed lyric — invariant
   8 wins.)
6. **One chokepoint for art resolution: `Library.coverUrl`** (`state/library.ts:54-56`), exactly as
   `Library.streamUrl` (`:69-82`) is the one for audio. `player/palette.ts` is **not edited**: the
   theming machinery (`paletteFromArtwork`, `applyPaletteVars` `ui/app.ts:1317-1338`, the
   visualizer) already exists and what is missing is art on disk.
7. **The offline surfaces are the same views with less input, never second views** (1.9.18 §1,
   extended): one playlist renderer, one song renderer, one badge.
8. **The art file belongs to the download.** When the last index row that names it goes, the file
   goes (§S9/S10's refs rule, extended to the shared cover file — §5.6, §5.7).
9. **Nothing added to a durable record may be non-optional.** `readIndex()`
   (`NaviliteDownloads.swift:383-386`) returns `[:]` when the decode fails, and the boot sweep
   (`:601-614`) then deletes **every file the index does not name**. One non-optional field added to
   `IndexRow` or `Job` against a phone holding an index written by 1.9.19 is a silent 5 GB deletion.
   The same goes for the mirror (`src/storage/offline.ts:91-127`: an unparseable mirror is dropped,
   and a dropped mirror is a cold start with no local rows).
10. **A download never starts without a tap** (§I10, unchanged). Art is enqueued inside
    `download()`/`resume()` only — never by a view, never by a boot reconcile, never to "top up"
    something the owner did not ask for.

---

## 2. Item 1 — one row per playlist

### 2.1 Seams

| # | seam | change |
| --- | --- | --- |
| A1 | `ui/app.ts:2073-2077` | **Delete the `Downloaded` section**, the `h2` and the `offlinePlaylistRow` mapping. The store-drawn list is what is left when the server cannot answer, and that case is `renderPlaylists`' own `catch` (`:2083-2093`) — draw it there, from the same renderer, not beside the server's rows. |
| A2 | `ui/app.ts:2094-2099` | The server's rows become the single list; keep `rememberPlaylistName` (name adoption is what makes the offline row honest). |
| A3 | `ui/app.ts:2102-2114` (`playlistRow`) | The one row renderer. It takes the store's annotation for its id and draws badge + measured size + art (§3, §5). Its art goes through `ctx.library.coverUrl`, so it is local when local art exists and the server's when it does not. |
| A4 | `ui/app.ts:1779-1793` (`offlinePlaylistRow`) | Deleted. `renderOffline`'s store list (`:1764-1775`) and `renderPlaylists`' offline list both use the A3 renderer with a store-shaped input (below). One renderer, so the heading, the badge and the sub-line cannot drift between the two. |
| A5 | `ui/app.ts:2072` | The subtitle. `'getPlaylists / createPlaylist'` is a developer's note on his screen — visible in the screenshot he sent, which is the same defect 1.9.19's item 5 fixed ("the header uses words, not the id"). Replace with the facts: `` `${n} playlist${n === 1 ? '' : 's'}` `` (and when offline, `n on this phone`). One line, on a line already being edited — flagged here rather than smuggled in. |

### 2.2 The row's input, and where its facts come from

One shape, two sources — and the difference between them is a single flag, never a second renderer:

```ts
/** What the one playlist row needs. Every field is optional except the id and the name. */
export interface PlaylistRowInput {
  id: string;
  name: string;
  /** The playlist's length: the server's `songCount`, or the manifest's length offline. */
  songCount?: number;
  /** Its runtime: the server's `duration`, or the sum of the manifest's own `Song.duration`. */
  duration?: number;
  /** Its cover: the server's `coverArt`, or a manifest song's — whatever is in hand. */
  coverArt?: string;
  /** True when this row *is* the whole content of the screen (no server answer at all). */
  local?: boolean;
}
```

Offline, `downloadedPlaylists()` (`state/offline.ts:435-444`) already carries the record, whose
`songs` are full `Song`s: `songCount = record.total`,
`duration = record.songs.reduce((t, s) => t + (s.duration ?? 0), 0)`,
`coverArt = record.songs[0]?.coverArt ?? record.songs[0]?.albumId`. So the offline row shows
`269 tracks · 17:03:55 · 5 GB on this phone` — the same shape as the online row, with the store's
own facts filling the same slots. That is what makes the two lists one list.

### 2.3 Why this does not just move the duplicate

The trap is a "fix" that draws the store's row *instead of* the server's when a record exists:
that would lose the server's current name, count and runtime for exactly the playlists the owner
cares most about, and it would still be a second painting (of a second shape) the moment the store
is only *partly* right. The design annotates instead: the server's row is the row; the store's
facts are appended within it (§3). Offline, where there is no server row, the store's facts are
the row — through the same renderer, in the same slots.

---

## 3. Item 2 — badges

### 3.1 The store's answer, one predicate each

Tracks (nothing new): `pathFor(songId) !== null` (`state/offline.ts:339`). This is already the
predicate the 1.9.19 fix uses to decide which rows are playable (`ui/app.ts:2280`), so a badge and a
playable row can never disagree.

Playlists (new, and the whole of the arithmetic):

```ts
/**
 * What the store knows about a playlist, for the one row the UI draws.
 *
 * `state` is the badge: nothing here is a second state machine — it is `record()` plus the one
 * question the record cannot answer on its own, "is the playlist in front of me still the one that
 * was downloaded?" (`expectedTracks`, the server's `songCount` when there is a server).
 */
export interface PlaylistBadge {
  state: 'none' | 'partial' | 'downloading' | 'complete';
  /** Complete files among the playlist's songs — never `record.total`, never the estimate. */
  done: number;
  /** The playlist's length as the store knows it (the manifest's). */
  total: number;
  /** **Measured** bytes of the audio rows that are here (§I4). 0 when none. */
  bytes: number;
  /** A cover id that is on this phone, when one is (§5). */
  coverArt?: string;
}

playlistBadge(playlistId: string, expectedTracks?: number): PlaylistBadge
```

Rule, in full:

```
record = playlists[playlistId]
if (!record || record.state === 'idle'))       -> { state: 'none' }
if (record.state === 'failed' && record.done === 0) -> { state: 'none' }   // nothing landed
if (expectedTracks != null && expectedTracks > record.total) -> { state: 'partial' }
else if (record.state === 'complete')          -> { state: 'complete' }
else if (record.state === 'estimating' || record.state === 'downloading') -> { state: 'downloading' }
else                                           -> { state: 'partial' }
```

`expectedTracks > record.total` is the *grown playlist* case: a playlist the owner added to after
downloading it is not "entirely downloaded", and the row must not say it is. The control on the
playlist page reaches the same conclusion through `missingCount` (`state/offline.ts:716-725`,
`ui/app.ts:2158`) because it needs to know *which* tracks are missing in order to fetch them; the
badge needs only *whether*. Both read `record`; neither re-derives the other's answer, and the two
cannot disagree: `missingCount(songs) > 0` ⟺ `songCount > record.total` for the same playlist
(`missingCount` counts a track as missing when it is not in the manifest **or** not complete).

The badge table — this is the whole of what the owner sees:

| store state | playlist row | track row |
| --- | --- | --- |
| `none` (nothing downloaded) | nothing — a badge on every playlist would be noise | nothing |
| `downloading`, `estimating` | hollow arrow glyph, sub-line `n of m on this phone` | filled glyph only for the tracks already complete |
| `partial`, `failed` with `done > 0` | hollow arrow glyph, sub-line `n of m on this phone` | as above |
| `complete` | **filled arrow glyph** (`✓`-in-a-circle shape), sub-line `m tracks · d · 5 GB on this phone` | filled glyph |
| `complete` but grown (`expectedTracks > total`) | hollow glyph, sub-line `n of m on this phone` | as above |

### 3.2 Rendering, and what must not become a second tap target

- `songRow` (`ui/app.ts:2550-2611`): the badge is a `<span class="row-dl" aria-hidden="true">`
  holding the glyph, placed immediately before `.row-time` (`:2578`). **Not** a button: the whole
  row is one tap target (v1.5, `:2559-2564`). The accessible name carries it instead — the row's
  `aria-label` (`:2570`) becomes `` `Play ${song.title}${here ? ', downloaded' : ''}` ``.
- `playlistRow` (A3): the same span, plus the measured figures in the existing `.row-sub`.
- New glyphs in `ui/dom.ts`'s `ICONS` (`:108-129`): `download` (arrow into a tray) and
  `downloadPartial` (the same arrow, hollow). Two paths, no images, no new asset pipeline; the
  glyphs inherit `currentColor` like every other icon.
- **Live update without a re-render.** The badges are painted from the store synchronously, and a
  download that completes while the list is on screen must flip them. The row's `.row-dl`, `.row-sub`
  and `aria-label` are registered per song id in a small per-render registry, and one
  `subscribeOffline` listener (`ui/app.ts:2125-2128`) walks the registry and re-reads the predicate
  — *not* a `ctx.render()`: a re-render would drop the scroll offset and the highlighted row, and
  the download control already shows the pattern (`:2178-2184`, repaint your own node only).
  Subscriptions are dropped per render (`clearOfflineSubscriptions`, `:2130-2139`).
- Offline, nothing here fetches: `pathFor` and `playlistBadge` are pure reads of the in-memory
  mirror (§I3).

---

## 4. Item 3 — browsing the library for downloaded songs

### 4.1 The surface

A view, `#/downloads`, titled **On this phone** — reachable from two places and from nowhere else:

- a row at the top of the Library screen (`renderArtists`, `ui/app.ts:1889-1923`), above the artist
  list, drawn from the store alone (`N tracks · 5 GB`), whether or not the server answers;
- the existing Settings row `Downloaded music: 5 GB · 269 tracks` (`ui/app.ts:2478`), which becomes
  tappable (it already paints the numbers this view lists).

Body: the downloaded tracks, drawn with the **existing** `songRow` (`:2550`), so they carry the
badge, the art and the tap-to-play behaviour the rest of the app has — `Play all` above them, queue
context `{ kind: 'downloads', name: 'On this phone' }`, which is what the now-playing line reads out
(`ui/app.ts:2802-2810`). That context kind is one word added to the union at `api/types.ts:133-137`
(`kind: 'album' | 'artist' | 'playlist' | 'favourites' | 'search' | 'song'`); nothing branches on it
today, and a kind of its own is the point — the queue must not claim these rows came from a playlist.

### 4.2 Why it is not a synthetic playlist

- It has **no id, no name and no server object**: nothing in `getPlaylists`, nothing in the
  Playlists list, nothing creatable, renamable, deletable or shareable, and no code path that could
  ever POST it to the library.
- It is a **filter's result over rows that already exist** (`downloadedSongs()`), not a container
  the store invents: its membership is `pathFor(songId) !== null` — the same predicate as the badge,
  so a track cannot be in this list and unbadged, or badged and absent from it.
- It is a **route**, not an entity: a route is a view the app can draw, and this one draws rows the
  app already has. The forbidden thing (item 1) is a *playlist-shaped row under the Playlists tab*;
  a view that exists only on the phone cannot be confused with something on the server.
- It is honest about where it lives: the title says **On this phone**, the same words the rows and
  the offline pill already use, so it can never be mistaken for a library playlist.

New store method, synchronous, no I/O:

```ts
/**
 * Every track with a complete file on disk, as `Song`s, for the one view that browses them.
 *
 * Rows only — never the manifests: a song in two playlists is one row and one entry here, and a
 * song whose playlist record was removed is still on the phone only if its row survived (§S9/S10).
 * Order is the library's own (artist, album, title), because this is "browse my library", not
 * "what did I download last".
 */
downloadedSongs(): Song[]
```

### 4.3 The one thing that makes it work cold: the mirror must carry the metadata

`seedRows` (`state/offline.ts:318-336`) copies **path, bytes, state and lyrics** from the mirror and
nothing else — `title: ''`, `artist: ''`, `album: ''`, `durationSec: 0`. On iOS the mirror is what
makes the first paint local at all (1.9.19's own defect: the records were empty for the length of
`bridge.list()`), so a downloaded-songs list drawn from the mirror as it stands today would print a
column of **blank titles** for up to 5 s on a cold, offline launch — the 1.9.19 defect, rebuilt in
a new place.

So the mirror row gains five optional fields (`src/storage/offline.ts:18-34`, additive, §I9):

```ts
export interface OfflineMirrorRow {
  path: string;
  bytes: number;
  state: 'complete' | 'staging' | 'failed';
  /** Copy metadata (v1.9.20): what the browse list and the badges need with no round trip. */
  title?: string;
  artist?: string;
  album?: string;
  coverArt?: string;
  durationSec?: number;
  lyrics?: { ... };
}
```

- written by `saveMirror` (`state/offline.ts:1069-1083`) from the row it already has;
- carried by `seedRows` (`:318-336`);
- tolerated by `parseMirror` (`src/storage/offline.ts:104-125`) — a row without them parses exactly
  as today, which is what keeps 1.9.19's mirror valid (`title` absent → `''`, `downloadSec` absent →
  `0`, so the *worst* case is the first paint after the upgrade showing a row with an empty sub-line
  until `list()` lands once, and never again: the next `saveMirror` writes them).
- The two live paths both have the metadata already: a row from `list()` carries it
  (`NaviliteDownloads.swift:307-319`), and a row from `addRef` carries it from the job
  (`state/offline.ts:922-933`).

---

## 5. Item 4 — the album art, downloaded with the song

The purpose is his: **populated on the spectrum page, and theming the spectrum**. The theming is
already there (`paletteFromArtwork` → `applyPalette` → `applyPaletteVars` → the visualizer, all
since v1.4.1); what is missing is art that exists on disk offline. This section designs storage and
one resolution point, and nothing else.

### 5.1 What is fetched, and once per what

One art transfer per **distinct cover id** per playlist download, at `size=512` (`getCoverArt`,
`api/subsonic.ts:390-392`): 512 is what the spectrum page's own cover is (`ui/app.ts:2682`, `size
512`) and what the palette reads at 256 (`:1504`) — one file serves both, and the list thumbs
(128) downscale in the browser for free, exactly as they do online today.

One file per cover, **not** per song: a 12-track album is one cover. Storing it per track would
cost twelve copies of the same JPEG for one album — the owner reads the "Downloaded music" figure
(`ui/app.ts:2478`) and would see exactly what that costs (§I4 in the other direction: never store
twelve times what one file is worth).

The dedupe key exists on every `Song` already: `song.coverArt ?? song.albumId`
(`ui/app.ts:1504`, `:2682` use the same expression for the same reason). A track with neither has no
art to fetch and contributes zero.

### 5.2 The lane: a third kind, and why the two obvious shortcuts are fatal

`NaviliteDownloads` keys every transfer `"<kind>:<songId>"` (`NaviliteDownloads.swift:74-77`), and
`kind` is **derived from the suffix, never stored** (`:79`, `:127-128`):

```swift
private static func kind(forSuffix suffix: String) -> String {
    suffix == lyricsKind ? lyricsKind : audioKind
}
```

So today *anything* that is not `lyrics` is the **audio** axis. Enqueuing art with
`suffix: 'art'` and stopping there gives this, in order:

1. `Job.taskKey` is `audio:<songId>` (`:131`) and `persist(job:)` keys the jobs dictionary by it
   (`:398-402`) → **the art job overwrites the audio job for that song** in
   `navilite.offline.jobs`;
2. `didFinishDownload` (`:455-492`) → `finish(kind: 'audio', …)` takes the `else` branch
   (`:523-529`) and writes `index[songId] = IndexRow(suffix: "art", bytes: <the JPEG's>, state:
   "complete", …)` → **the song's audio row now names the cover as its file**, so
   `pathFor(songId)` (`state/offline.ts:339-342`) returns `<songId>.art` and the player is handed a
   JPEG as the track;
3. `remove(songId)` (`:277-301`) walks a fixed suffix list (`:290`, `["mp3", "flac", "wav", "m4a",
   "ogg", "opus", "lyrics"]`) → the `.art` file survives every removal as an orphan.

So the seam is explicit: **`kind(forSuffix:)` (`:79`) gains `art`**, and every place that branches
on kind is walked: `cancel` (`:262-275`), `remove` (`:277-301`), `finish` (`:496-537`),
`didFinishDownload`'s suffix default (`:458`).

### 5.3 The durable shapes (all additive, all optional — §I9)

```swift
// NaviliteDownloads.swift:138-151 — IndexRow
var art: ArtRow?         // NEW, optional: never a decode failure against a 1.9.19 index.json
var coverArt: String?    // NEW, optional: this row's cover id, so art can be found by cover

// NaviliteDownloads.swift:154-159, beside LyricsRow
private struct ArtRow: Codable { var file: String; var bytes: Int; var fetchedAt: Double? }

// NaviliteDownloads.swift:116-135 — Job
var coverArt: String?    // NEW, optional: a job persisted by 1.9.19 must still decode
```

`enqueue` (`:233-260`) accepts `coverArt` and passes it on; `list()` (`:303-331`) reports `art` and
`coverArt` beside `lyrics`; the JS bridge types (`state/offline.ts:47-61`, `:63-74`) gain the same
two optional fields, and `IndexRow` there mirrors `ArtRow` as
`art?: { state: 'present' | 'none' | 'failed'; file?: string; bytes: number; fetchedAt?: number }`
— the lyrics shape, because the two axes have the same job.

### 5.4 The transfer's key is the cover id

The art job is enqueued with `songId = <cover id>` and `suffix = 'art'`: taskKey `art:<coverId>`,
staging file `<coverId>.art.part`, final file `<coverId>.art` — one transfer, one file, no
per-song copies, and the staging/index/sweep code paths keep the shape they already have. Two
consequences the implementer must not miss:

1. **The `done`/`failed` event's `songId` field carries a cover id.** The JS side's
   `onDone`/`onFailed` (`state/offline.ts:749-801`) start with `const row = this.rows.get(event.songId); if (!row) return;` — for an art event that lookup **misses and the event is dropped on the
   floor**: every art row stays `pending` for ever, the estimate never becomes exact, and no cover
   ever reaches a screen. Both handlers need an `event.kind === 'art'` branch that fans out by
   cover id instead of looking up a song, which also means `DownloadEvent.kind`
   (`state/offline.ts:76-86`) gains `'art'` beside `'audio' | 'lyrics'`, and `enqueueArt` sits
   beside `enqueueLyrics` (`:812-841`) inside the same per-song loop (`:644-669`) — one transfer per
   distinct cover id, with the cover's songs in its `refs`.
2. **Native has to fan out too.** `finish(kind:songId:suffix:job:bytes:destination:)` (`:496-537`)
   writes one row. For art it must set `art` on **every** index row whose `coverArt` equals the
   cover id (and create none if none matches: an art transfer for a cover whose audio never landed
   is not a row). The same fan-out is what the JS side does.

### 5.5 Resolution: one chokepoint, and the WebView question

```ts
/** The local art for a cover id, or null. Synchronous, memory only (§I2, §I3). */
artPathFor(coverArtId: string): string | null
```

and in `Library.coverUrl` (`state/library.ts:54-56`), the one edit that lights up every screen:

```ts
coverUrl(coverArtId: string | undefined, size = 512): string | null {
  if (!coverArtId) return null;
  return this.resolveOfflineArt(coverArtId) ?? this.client.coverArtUrl(coverArtId, size);
}
```

(The resolver is injected exactly like `resolveOffline` for audio, `state/library.ts:43-48`, so the
browser bundle and the tests can pass a stub.) Callers, unchanged and all now offline-capable:

| caller | what it gets |
| --- | --- |
| `syncPalette` `ui/app.ts:1504` (→ the theme, → the visualizer) | local art → `paletteFromArtwork` → `fromArt: true` offline |
| player bar cover `:2681`, spectrum page cover `:2682` | local art instead of a broken `<img>` and its `♪` placeholder |
| album cards / list thumbs `:1952`, `:1964`, `:2032`, `:2105`, `:2377` | local art |
| `offlinePlaylistRow` `:1782` (`cover(null, …)`) | **deleted** — the store row draws the manifest's cover like any other row |

**How the WebView reads a file in Application Support.** The page's origin is
`https://localhost` (Capacitor's scheme, `capacitor.config.ts`) and the art file is a `file://` URL
under `Library/Application Support/navilite-offline/`. A `file://` URL is not fetchable from that
origin, and inside a WKWebView an `<img src="file://…">` is blocked — which is *why* the audio path
never needed this (the player reads the file natively, `queue.ts:600`/`:861`/`:946` send the path to
the native side, not to the page).

The bridge that exists for exactly this is `Capacitor.convertFileSrc(path)` — exported from
`@capacitor/core` (`types/definitions.d.ts:12`, on the `CapacitorGlobal` interface; the package's own
web fallback is the identity function, so nothing needs a platform branch) — which on iOS produces a
custom-scheme URL (`capacitor://localhost/_capacitor_file_/<path>`) and makes the art **same-origin
with the page**. That is the whole answer to the tainted-canvas failure mode: a same-origin fetch is
not a cross-origin fetch, `ctx.getImageData` (`player/palette.ts:46`) has nothing to refuse, and
`paletteFromArtwork`'s cross-origin branch (`:35`, `mode: 'cors'`) is not in the picture. The
existing fallback stays as the safety net it is: any failure (no `convertFileSrc`, a refusal, a bad
image) returns `DEFAULT_PALETTE` with `fromArt: false` (`:48-51`) rather than a `SecurityError`.

`convertFileSrc` is called in `artPathFor`, i.e. in the store, not in the view — the same place
`pathFor` hands the player a `file://` URL today. Where the platform cannot do it (the PWA:
`createDownloadsBridge()` is `null`, so there are no rows at all), `artPathFor` returns `null` and
`coverUrl` returns the network URL — the browser build is byte-unchanged.

### 5.6 The estimate: art counted once per cover, in the owner's number

His standing rule (lyrics, `docs/design-offline-playlists.md` §"The estimate includes the lyrics"):
*anything downloaded as part of a playlist is counted in the playlist's total size estimate.* So
`estimateBytes` (`state/offline.ts:175-202`) gains a third term, deduped by cover:

```ts
/** An upper bound for one 512 px cover; the rule is the lyrics rule. */
export const ART_ASSUMED_BYTES = 256 * 1024;

// …after the audio and lyric terms:
const covers = new Set<string>();
let art = 0, artExact = true;
for (const song of songs) {
  const cover = song.coverArt ?? song.albumId;
  if (cover === undefined || cover === '') continue;       // nothing to fetch
  if (covers.has(cover)) continue;                          // one cover per album
  covers.add(cover);
  const row = rows?.get(song.id)?.art;                      // the row is per song, the file per cover
  if (row?.state === 'present' && typeof row.bytes === 'number') art += row.bytes;
  else if (row?.state === 'none') { /* asked: this album has no cover. Zero, and exact. */ }
  else { art += ART_ASSUMED_BYTES; artExact = false; }
}
return { total: audio + lyrics + art, exact: audioExact && lyricsExact && artExact };
```

Two properties matter and both are testable: **one assumption per cover, not per track** (a 14-track,
2-album playlist adds 512 KB, not 3.5 MB — otherwise the number is a lie in the other direction),
and **after the first download the term is the measured file** (`art.bytes`), so the same playlist
reads exact the way it does for lyrics (§4 of the 1.9.12 design). `ART_ASSUMED_BYTES` is a bound for
the re-encoded 512 px cover the app asks for; Navidrome passes an original through whole when it is
already smaller than the requested size, so a pathological multi-megabyte original is the one case
where `up to` is optimistic — the free-space guard's 250 MB margin (`FREE_SPACE_MARGIN`,
`state/offline.ts:163`) absorbs it, asking the server for each cover's length first would be a round
trip per album (§I3), and the honest remedy if it bites is to move the constant, the way
`LYRICS_ASSUMED_BYTES` says so in its own comment (`:154-159`).

### 5.7 Pruning: the art goes when the download goes

The rule is §S9/S10's, extended by one sentence: **the art file is deleted when the last index row
naming it is deleted.** Seams, all existing ones:

| path | where | what must happen |
| --- | --- | --- |
| one track's last ref | `dropRef` (`state/offline.ts:936-950`) → `bridge.remove(songId)` | native `remove` (`:277-301`) gains `art` to its suffix list (`:290`) **and** the shared-file scan: if no remaining index row names that `art.file`, delete `<coverId>.art` |
| the whole playlist | `remove(playlistId)` (`:690-698`) → the same refs walk | as above, per track |
| a file gone behind the app's back | `voidMissingFile` (`:364-378`) → `bridge.remove` | as above |
| every download | `removeAll` (`:701-710`) → `bridge.remove` per song | as above, and `clearMirror` drops the art rows with the rows |
| the boot sweep | `reconcile()`'s orphan pass (`NaviliteDownloads.swift:601-614`) | **`named` must include every `art.file` in the index** (`:603` currently builds `"<songId>.<suffix>"` and `"<songId>.lyrics"`) — the cover file is named after a *cover id*, so it is not `<songId>.<suffix>` for any row, and without this line **every cover is deleted on the next launch** |

### 5.8 Downloads that already exist on his phone (1.9.19 mirrors and manifests)

What is already there: audio rows, lyric rows, the manifests, the mirror — all of it parses and
keeps working, because every field this design adds is optional (§I9) and nothing is re-written
that does not need to be.

What he sees, in order:

1. **Badges appear immediately for everything he has already downloaded** — they are read from the
   audio rows 1.9.19 wrote (`pathFor`), not from any new field. The Playlists screen stops
   duplicating on the first launch of 1.9.20 (`item 1`), and the downloaded playlists read as
   downloaded on their single rows.
2. **The downloaded-songs view works immediately** — it is rows + `pathFor`.
3. **Art is absent for the old downloads**, and the honest thing is to say so rather than to
   pretend: no cover on those rows, no offline art on the spectrum page, and the palette falls back
   to `DEFAULT_PALETTE` (offline) exactly as it does today.
4. **Getting it back costs one tap and no audio.** There is no automatic backfill: invariant 10
   forbids a download the owner did not ask for, and a boot-time art fetch would be a sync. Instead
   the playlist page's control gains the state it needs — for a record that is `complete` on audio
   and lyrics but has a cover that is not here, the label reads **`✓ 312 MB · ↓ covers`** and the
   tap calls `download()` (`ui/app.ts:2185-2203`, `state/offline.ts:571-625`), which is already
   idempotent per song: `enqueueSongs` (`:644-669`) skips every `complete` row and only adds the
   playlist's ref, and `enqueueLyrics` (`:812-841`) returns early on a resolved lyric. So the tap
   fetches **only the covers** — no audio byte is re-fetched — and when they land the label returns
   to `✓ 312 MB`, whose tap is the removal it is today. `label()` (`:2159-2177`) gains one case;
   the click handler (`:2185-2203`) gains one. Nothing else on the control moves.

---

## 6. Failure modes, and what each one does

| failure | how it shows on the phone | what the design does |
| --- | --- | --- |
| **Art fetch fails while the audio succeeds** (444/500, a truncated body, a dropped connection) | nothing at all: the track is on the phone and playable, the badge is on, the row looks complete | art row `failed`; the playlist's state is decided by audio + lyrics only (§I5). It never reads `· retry` for a cover. A reachable reconcile may re-ask it; until then the row has no cover and the palette is the default one |
| **The album has no cover at all** (Navidrome answers `404`) | the same `♪` placeholder the online path shows today | `art.state = 'none'` — a recorded fact, zero bytes, and the estimate does not carry a phantom 256 KB for it |
| **A 200 response whose body is not an image** (a JSON error envelope, an HTML door page) | a cover that never renders; the palette stays default | native refuses to promote a body that is not an image: an **image sniff** at the one door that turns bytes into a row (`finish`, `NaviliteDownloads.swift:496-537`), the exact shape of the lyrics rule at `:503` (`looksLikeRouteError`). JS is already safe behind it — `createImageBitmap` throws and `paletteFromArtwork` catches (`player/palette.ts:48-51`) |
| **Tainted canvas on the read** | theme stuck on the app's default colours with no explanation | impossible by construction: the art is served same-origin through `Capacitor.convertFileSrc` (§5.5). If the platform ever refuses, the palette falls back *labelled* (`fromArt: false`) and the cover shows the placeholder |
| **A partially downloaded playlist** | the row says `n of m on this phone` with the hollow glyph; the songs not here are not in this view and are not in the queue | the badge is `partial` (never `complete`), the downloaded-songs view lists only `complete` rows (§4.2), and the playlist page keeps 1.9.19's `not-on-phone` rows (`ui/app.ts:2337-2349`) |
| **A playlist grown after its download** | the row says `n of m on this phone`, the control says `n of m · retry` | §3.1's `expectedTracks > record.total` rule — the row stops claiming to be complete, and the retry fetches only the new tracks |
| **Art for a track whose audio never became complete** | nothing | the art fan-out (`finish`) writes to rows that exist; a cover whose audio never landed has no row to annotate, and its file is not named by the index — the boot sweep collects it (`:601-614`) |
| **A 1.9.19 index.json against the new fields** | — | impossible: every new field is optional, and `readIndex()`'s failure mode (`[:]` → the sweep) makes this a hard rule, not a preference (§I9) |
| **A cold launch with no connection** | the Playlists screen, the badges and the downloaded-songs view are all correct from the mirror on the first paint | the metadata lives in the mirror (§4.3) and the records are rebuilt in the constructor (1.9.19's fix, `state/offline.ts:293-314`) |
| **Two playlists sharing an album** | one cover file, two rows badged from their own records | the file is keyed by cover id (§5.4), the playlists' refs are per song as before, and neither removal takes the other's file while a row still names it (§5.7) |

---

## 7. File:line plan

**New files.** None required. (Two new glyph paths in `ui/dom.ts`; two new test files if the
implementer prefers them separate — see §8.)

**Edits, in the order they matter.**

1. `src/ui/app.ts:2073-2077` — delete the `Downloaded` section from `renderPlaylists`; `:2094-2099`
   the server's rows become the one list; the offline catch (`:2083-2093`) draws the store's rows
   through the same renderer; `:2072` the subtitle (words, not endpoint names).
2. `src/ui/app.ts:1779-1793` — delete `offlinePlaylistRow`; `:2102-2114` `playlistRow` becomes the
   one renderer (badge + measured size + `coverUrl` art), and `renderOffline`'s list (`:1764-1775`)
   uses it with `local: true`. Why: item 1's acceptance is "no name twice, up or refused", and one
   renderer is what makes that checkable.
3. `src/state/offline.ts` — `playlistBadge()` (§3.1), `downloadedSongs()` (§4.2), `artPathFor()`
   (§5.5), the art term in `estimateBytes` (+`ART_ASSUMED_BYTES`, §5.6), `IndexRow.art`/`coverArt`,
   `saveMirror`/`seedRows` carrying the metadata (§4.3), the `art` branches in `onDone`/`onFailed`
   (§5.4), and `enqueueArt` inside `enqueueSongs` (`:644-669`) — one transfer per distinct cover, at
   the same place the lyric transfer is enqueued, from an injected `artUrl` factory (the store still
   never builds a URL — its own header rule, `:5-11`).
4. `src/storage/offline.ts:18-34`, `:104-125` — the five optional row fields, written and parsed.
   Why: without them the browse view and the badges are blank for the first seconds of every cold
   launch (§4.3).
5. `src/state/library.ts:54-56` (and the constructor at `:43-48`) — `coverUrl` consults the art
   resolver. Why: one chokepoint lights up the palette, the player bar, the spectrum page and every
   thumb at once, and keeps `player/palette.ts` untouched (§I6).
6. `src/ui/app.ts:2550-2611` (`songRow`) — the badge span, the registry entry, the `aria-label`;
   `ui/app.ts:2125-2139` — the one listener that flips them without a re-render.
7. `src/ui/app.ts:1889-1923` (`renderArtists`) — the `On this phone` entry row; a new
   `renderDownloads` + `case 'downloads'` in `renderRoute` (`:1636-1680`; `setActiveTab`, `:1691-1701`
   already leaves the previous tab highlighted for a head with no tab, which is right for a screen
   reached from the Library); `:2478` the Settings row becomes a link to it.
8. `src/ui/app.ts:2159-2203` — the `↓ covers` label and its tap on the download control (§5.8).
9. `src/ui/dom.ts:108-129` — `download` and `downloadPartial`.
10. `ios/App/App/NaviliteDownloads.swift:79` (`kind(forSuffix:)`), `:116-135` (`Job.coverArt`),
    `:138-159` (`IndexRow.art`, `IndexRow.coverArt`, `ArtRow`), `:233-260` (`enqueue` takes
    `coverArt`), `:262-275` (`cancel`), `:277-301` (the suffix list **and** the shared-file scan),
    `:303-331` (`list` reports art), `:455-492` + `:496-537` (the art branch, the fan-out, the image
    sniff), `:601-614` (the sweep's `named` set).
11. `src/player/native.ts:1603` (`createDownloadsBridge`) — the bridge's `enqueue`/`list` types carry
    `coverArt`/`art`; no new lane, no new plugin.
12. `tools/mock-subsonic.mjs:576-581` — the cover is served already; add nothing but a
    **`Content-Length`-exact** body if it is not exact (it is: the PNG is generated once and cached,
    `:255-259`), and a fixture whose track has **no cover** so the `none` path is exercisable.
13. `DECISIONS.md` — the 1.9.20 section (written with this design, already in the tree), and the
    >900 ms blind spot named in the spectrum section (§9.2).
14. `CHANGELOG.md` + `src/ui/changelog.ts` + the three version sites (`package.json:3`,
    `android/app/build.gradle:10-11`, both version fields in
    `ios/App/App.xcodeproj/project.pbxproj`) — S13 of the 1.9.12 design, unchanged.

---

## 8. The checks the implementer must run

Cap, as the fleet's own rule says: **reuse the existing harness, run it ONCE.** Do not build a
device farm and do not produce before/after pairs.

1. `npm run test` and `npm run typecheck` — clean.
2. `npm run build`, then the existing offline harness, with the API reachable and then refused:
   `node tools/mock-subsonic.mjs --port 4633 --stress --dist dist` and
   `node tools/offline-check.mjs --app http://127.0.0.1:4633 --online-playlist pl-stress-ja`.
   Its current assertions must stay green — in particular the library degrade
   (`tools/offline-check.mjs:290-297`) still listing the downloaded playlist offline.
3. **The new acceptance, added to that harness as assertions rather than as prose** (the pattern
   `test/offline-views.test.ts` already uses — it re-reads the harness's JSON and asserts its
   numbers):
   - with the server **up** and a playlist both downloaded and on the server: the playlist name
     appears **exactly once** in the Playlists view's rows (today it appears twice — §0.1 is the
     reproduction to keep as the failing case), and that row carries the downloaded badge;
   - with the server **refused**: still exactly once, still badged;
   - with the server **refused**: `#/downloads` lists the downloaded tracks by title, with **zero**
     network requests made while it draws (the same "does not wait" claim 1.9.18's harness makes for
     the playlist page, `tools/offline-check.mjs:341-355`).
4. Store-level unit tests (extend `test/offline-estimate.test.ts`, `test/offline-browse.test.ts`,
   and the store's own dependency check in `test/offline-store.test.ts`):
   - `playlistBadge` for each row of §3.1's table, including `complete` + `expectedTracks >
     record.total` → `partial`;
   - the estimate counts art **once per cover** (a 14-track / 2-album playlist must add 2 ×
     `ART_ASSUMED_BYTES`, not 14), and reads exact once the rows carry `bytes`;
   - `downloadedSongs()` lists only `complete` rows, one entry per song, sorted, and **survives a
     cold start from the mirror alone** (the 1.9.19 test's shape: a bridge whose `list()` answers on
     a timer, asserting the titles before any await);
   - an art `done` event whose key is a cover id updates **every** row that carries that cover (the
     dropped-event hazard of §5.4, as a test);
   - removing the last ref deletes the art file exactly when the last row naming it goes, and not
     while another playlist still names it.
5. The native seams, as source-level assertions (the precedent is `test/download-lane.test.ts`
   reading `NaviliteDownloads.swift`, since Swift cannot be run here): `kind(forSuffix:)` maps
   `art`; the sweep's `named` set includes `art.file`; `remove`'s suffix list and its shared-file
   scan; every new `Codable` field optional. These are greps with teeth, and they are the only
   defence against the two silent catastrophes (§I9, §5.2).
6. `node tools/spectrum-proof.mjs` — must still pass unchanged (§9.1 is the only edit to the tool,
   and it tightens it).

## 9. The two bounded leftovers from `t_e62d2b6b`

1. **`tools/spectrum-proof.mjs:164`** asserts the tail only falls across `+240 → +1200` while
   printing the `+700` reading it never uses:
   ```js
   const falls = t240.lit <= t160.lit + slack && t1200.lit <= t240.lit + slack;
   ```
   → include the printed reading in the chain it belongs to:
   ```js
   const falls =
     t240.lit <= t160.lit + slack &&
     t700.lit <= t240.lit + slack &&
     t1200.lit <= t700.lit + slack;
   ```
   One line, no re-baseline, and it makes the tool assert the number it puts in front of a reader.
2. **The >900 ms blind spot gets named in `DECISIONS.md`**, in the spectrum section itself: the
   re-baselined criterion is a *settled-state* criterion (+900/+1200/+1500 byte-identical, ≤ 10 % of
   the loud frame, flat bars), so it is silent about **how the tail got there** — the shape between
   `+240` and `+900` is printed and unjudged, and it would pass a build that drops instantly (the
   v1.2 snap the owner asked to be rid of) just as happily as the v1.7.4 envelope he asked for. It
   says nothing after +1500 ms either. Naming it is the point: the criterion is not an envelope
   assertion and must not be read as one.

---

## 10. What is source-only, and cannot be device-verified in this session

Stated rather than implied — none of the following is claimed as verified by this design or by any
check the implementer can run here:

1. **Art in the WebView.** That `Capacitor.convertFileSrc` renders a `<img>` from
   Application Support and that a `fetch` of the same URL yields an **untainted** canvas
   (`getImageData` succeeding) is a platform claim taken from Capacitor's own bridge, not from this
   machine. It is checkable only on the phone (or in the simulator), and it is the one thing that
   decides whether item 4's theming works offline. If it fails there, the fallback is already
   correct (default palette, `fromArt: false`) but the feature is not delivered — that is a
   device-verification item for the owner's own hands, and `docs/verification.md` should carry it.
2. **The native art axis end to end**: `URLSession` → staging → `<coverId>.art` → the index row →
   `list()` → the badge. Everything above `list()` can be exercised against a bridge double here;
   nothing below it can.
3. **The migration on his actual phone**: that a 1.9.19 `index.json` and `navilite.offline.jobs`
   decode against the new optional fields (they must, §I9 — but the assertion here is a source
   claim, not a device result), and that his existing 5 GB / 1.4 GB of downloads still play.
4. **What `getCoverArt?size=512` actually returns on his instance** (bytes, format, and whether an
   original is passed through whole). `ART_ASSUMED_BYTES` is a bound asserted from the request, not
   measured against his library — same standing as `LYRICS_ASSUMED_BYTES`. One playlist re-download
   settles it.
5. **Background transfers of art** (the lane's own background behaviour, unchanged from 1.8.x, and
   not exercised here).
6. **The layout at 393 px** with the badge in the row: the harness measures overflow, and the
   `test/layout-393.test.ts` fixture should be extended with a badged row and a badged playlist row;
   the device itself is the owner's.

---

## 11. Changelog lines for him, and the acceptance list

```markdown
- Downloading a playlist no longer shows it twice — the playlists screen lists each playlist once,
  with a download mark on the ones that are on your phone and how much space they take.
- A song that is on your phone shows a small download mark next to it, wherever you see it.
- You can browse everything that is downloaded in one place: "On this phone", at the top of the
  Library. It is not a playlist — it is your own music, and it is there with no connection.
- Album art is downloaded with your music, so the spectrum page shows the cover and takes its
  colours from it with no connection.
- Downloads from before this version keep working and are marked as downloaded straight away; their
  album art comes down the next time you use the download button on that playlist, without
  re-downloading any music.
```

What the owner judges (his own words in brackets):

1. The Playlists screen lists each playlist **once**, up or down, and the ones on the phone read as
   downloaded on that one row ("the duplicated playlist confuses the user").
2. A downloaded track carries a mark wherever he sees it, and a downloaded playlist carries one on
   its row ("a playlist that is entirely downloaded").
3. "On this phone" is where he browses downloaded songs, with no connection, and nothing about it
   pretends to be a playlist.
4. With no connection the spectrum page shows the artwork and wears its colours.
5. The size the download control promises includes the art, and matches what the phone reports (the
   standing rule from the lyrics work).
6. Nothing that worked in 1.9.19 changed: playback, the offline playlist page, lyrics offline, seek,
   shuffle, the lockscreen card, the spectrum, the whole of the library online.
7. The release is clean: one commit, this document and the code, changelog and version bumped in all
   three places, tree clean, tag pushed.
