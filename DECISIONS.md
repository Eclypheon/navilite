# Decisions

Locked by the owner on 2026-10-10. Downstream work must respect these unless he changes them
(and if one turns out to be impossible, raise it — do not quietly substitute something else).

## Product

- **v1 scope**: browse the library, play, visualise — **plus playlists and favourites**.
  Offline caching is explicitly *not* in v1 (he chose "also playlists and favourites" over
  "all of the above").
- **"Visualises like kew" means a real spectrum from the actual audio stream**, not a decorative
  animation. Consequence: the player needs access to the audio samples, which for a web or
  wrapped build means either CORS-enabled streaming from Navidrome or a same-origin proxy in
  front of it. If that proves impossible on a target platform, raise it — do **not** silently
  swap in a fake visualiser.
- **Targets**: PWA + Android APK + iOS IPA, from as much shared code as possible.

## Platform / distribution

- **iOS**: no paid Apple Developer account, and he does not want to buy one now. The iPhone build
  is a **sideloaded dev build, re-signed every 7 days** (AltStore / SideStore style). Nothing may
  assume TestFlight, the App Store, or a paid certificate — including any entitlement that needs
  the paid programme.
- **Android**: sideloaded APK; no Play Store requirement stated.
- **Repository**: **public** — `Eclypheon/navilite`.

## Networking

- **The phone reaches the library over Tailscale.** Do not expose Navidrome to the public
  internet for this app. Tailnet name: `alienlab.tailbed832.ts.net`.
- **The canonical origin is `https://alienlab.tailbed832.ts.net:9443`** — tailnet-only, HTTPS on
  the node's publicly trusted Let's Encrypt certificate, one origin serving this app's `dist/` with
  `/rest`, `/api`, `/auth`, `/share` proxied to Navidrome. A PWA installs from it with nothing to
  install on the phone (publicly trusted cert, so Android's user-CA restriction does not apply).
- **Port 443 is not it.** `https://alienlab.tailbed832.ts.net` with no port is a **public
  Tailscale Funnel to a different service (wizarr)**. The port is part of the address; a server URL
  without it is wrong.
- Navidrome (0.64.2) was LAN-only; the tailnet HTTPS door above is now deployed
  (`tailscale serve --bg --https=9443 http://127.0.0.1:5702` → Caddy → navidrome:4533). Anything
  host-level (Caddy, quadlets, ufw, Uptime Kuma) is **Nova's** territory: route it through him
  rather than changing the box directly.

## Verified on his instance — contradicts the research brief on one point

Measured 2026-10-10 on Navidrome **0.64.2 as configured here**, with an `Origin` header set (i.e. the
exact situation a browser or a Capacitor webview is in):

```
$ curl -D - -H "Origin: https://navilite.example" \
    http://127.0.0.1:4533/rest/stream.view?id=1&u=x&t=x&s=x&v=1.16.1&c=navilite
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-Content-Duration, X-Total-Count, X-Nd-Authorization
Vary: Origin
```

`Access-Control-Allow-Origin: *` is present on **`/rest/stream`**, on `/rest/ping.view`, and on `/`.
The research document's claim that Navidrome "does not send ACAO on `/rest/*` by default" is **wrong
for this instance** (it matches the hedging in the client it cites — the stream endpoint *often*
doesn't, not *never*).

**Consequences for the build:**

- The same-origin proxy is still the right design (one URL, no CORS class of bugs, cleaner TLS), but
  it is **not** the hard blocker the research implied. A real-spectrum `AnalyserNode` is not
  precluded here on CORS grounds.
- The header set is **version- and config-dependent**: re-measure after any Navidrome upgrade before
  relying on it, and keep the same-origin deployment as the thing that makes the question moot.
- Note `Vary: Origin` — whatever emits this is a real CORS middleware, not an accident.

## Lyrics (owner's call, 2026-10-11)

- **The lyrics live in his music folder**, one file per song next to the audio, sharing the song's
  file name. Navidrome reads them (`LyricsPriority`:
  `.ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded` — `.md` is not a supported extension) and serves
  them to clients.
- **The app reads them through the library**, never from a third party. Since v1.3 (owner's call on
  the same day: *"i don't think you are forced to only pull what navidrome is capable of parsing …
  if it can't go through navidrome's api, write something custom to serve it"*) the order is:
  the library's **own lyric route** first (`GET /lyrics?path=<song.path>`, host-side card
  `t_766e7aa5` — the sidecar file itself, read at request time, `.lrc` preferred over `.txt` for the
  same track), then OpenSubsonic `getLyricsBySongId` (id-keyed, so it cannot pick the wrong song),
  then legacy `getLyrics` as a fallback for a server that lacks the newer call — and that fallback's
  blob is discarded unless the server's own artist/title match the track that is playing, because
  that call keys on artist+title and would otherwise hand over the wrong song's words. Every refusal
  or failure of the route means "ask Navidrome", never an error on screen.
- **Nothing is committed, bundled or shipped.** No lyrics text in the repo, none in `dist/`, none in
  the APK/IPA. The only copy away from his server is a per-device cache
  (`src/storage/lyrics.ts`, `localStorage`, clearable from Settings).
- **Untimed is the normal case, not a degraded one.** Many of his files have no timings: the panel
  is built for plain text first and the line highlight simply lights up when a `.lrc`-style file
  does carry `[mm:ss.xx]` timings. Nothing is gated on timing.
- Kanji cannot be romanised in the browser without a dictionary (~40 MB), so the local converter
  handles **kana only** and a kana line is romanised as a safety net; the expected input is already
  romaji or English, written by Navi.

## The queue and the track boundary (owner's standard, 2026-10-12)

- **One engine, and the prepared track is not a second one.** v1.7.6 deleted the second `AVPlayer`;
  it does not come back. The queue keeps **one** track ahead, loaded on the *same* plugin under a
  second asset id (`navilite-next`), and nothing ever sends that asset `play`: it is buffered and
  silent, never tapped for the spectrum, never in the engine's state machine. At a track boundary it
  is *adopted* — played and renamed as the audible slot — so the boundary fetches nothing. Three
  attempts at "prefetch" before this one measured a request that the audible player could not read
  (`library.prefetch` still fetches, but only to measure the link); do not go back to that.
- **One track ahead, not two.** Two prepared items would contend for a relay link that the audible
  stream is already using.
- **The URL is bound when the track is prepared** and used unchanged at the boundary: `maxBitRate` is
  part of the stream URL, and building it twice (once to warm, once to play) asks Navidrome for two
  different transcodes of the same file.
- **A seek can never change whether the queue advances.** There is no counter between the seek and
  the end of a track: the report window (`reportsMutedUntil`) is a deadline, so a plugin seek whose
  promise never settles cannot hold the end-of-track doors shut. The end-of-track reading in
  `onState` is deliberately checked *before* that window.
- **A tap is a state transition, and so is an advance.** Both move the cursor, set the loading state
  and redraw; a track that ends must not look like a track that never started.

## Ownership

- Research: **Mugger** (`researcher`) — modality verdict in flight (`t_4c24f452`).
- Implementation: **Nerd** (`nerd`).
- Host / networking changes: **Nova** (`alienlab`).

## Deferred by the owner

- Moving the iOS build onto a paid account / TestFlight.
- Offline caching of albums (past v1).

## Queued for 1.9.12 (owner's request, 2026-10-13 — do NOT start until he has tested 1.9.11 and collated issues)

**Make the play queue visible, as a fourth pager page.**
His words: "perhaps it should be made visible to the user so swiping left from lyrics would bring you to the
queue page instead of back to the playlist page."

Today the pager is playlist | spectrum | lyrics and swiping left from lyrics wraps back to the playlist. The
queue exists as a real model (`PlaybackQueue` in src/state/queue.ts, with its own order array, shuffle and
repeat) but it has no user-facing surface, so what will play next is invisible. The request is to add the
queue as a page so a swipe left from lyrics lands there (and presumably wraps back to the playlist beyond).

Open questions for whoever designs it: is it a fourth page or does it replace the playlist page in the ring;
does it show the queue order with the current item marked; can it be reordered / appended to / jumped from;
and how shuffle and repeat read on that page (they act on the queue order, not the playlist, and that should
be visible there).

## v2.0 scope (owner's list, 2026-10-13). RESEARCH AND DESIGN ONLY - do not build any of it yet.

1. **The play queue made visible** - a queue page so a swipe left from lyrics lands on the queue rather than
   the playlist. Today the pager is playlist | spectrum | lyrics; the queue exists as a model with its own
   order array, shuffle and repeat, but has no surface.
2. **Reduce the background auto-advance delay** - 1.9.11 works in foreground and background; the background
   gap is described as "pretty much imperceptible ... if it can't be resolved it's fine". Low priority,
   investigate only.
3. **Crossfade between tracks**, foreground AND background. Open design questions: two players with volume
   ramps, and what is legal for a ramp while backgrounded/locked (a JS or Timer tick probably is not);
   interaction with the spectrum tap, the lock-screen fields, gapless same-album playback, and the
   seek/backtrack model; memory, battery and data cost of two overlapping streams.
4. **Multi-user permissions** - per-user playlist visibility plus an admin panel for the admin user to
   control what added users can see. Touches Navidrome's user/playlist/sharing model, the Subsonic
   user-management endpoints, and the app's own (currently absent) auth: today the app uses one Navidrome
   account. Security-sensitive - admin credentials must never live in a client.

Status: research commissioned (crossfade, multi-user, background latency floor). Design to follow the
research, then the owner decides what is built. **If all four land, this is v2.0.**

## Owner's re-prioritisation, 2026-10-15 (the day 1.9.11 was tagged stable)

- **Crossfade (item 3 above) is SHELVED for now** — not abandoned, just not the next thing built.
  Its v2.0 research stays on file for whenever it is picked back up. Do not design or build around it.
- **New priority: offline playlist downloads.** A playlist must be downloadable to the device so it
  plays with no connection, and **when a local copy of a song exists the app plays the device copy
  instead of fetching it** — faster, and no data burnt. The download control lives on the playlist
  surface: compact, and it shows **the total size of all songs in the playlist being downloaded**, so
  the owner knows the space it will take on his phone.
- Release shape: **1.9.11 is the current stable; the build carrying this feature is 1.9.12 (nightly).**
- **Lyrics are part of the download (owner's addition, later the same day):** a downloaded playlist
  includes each song's lyrics, so they render offline and **still highlight the current line wherever
  timestamps are present**; a song with no lyrics or untimed lyrics must degrade gracefully.
  **The lyrics bytes are included in the playlist's total size estimate.**
- Ownership: research (Mugger) → design + review (Sage) → implementation (Nerd).

## 1.9.18, 2026-10-15 — offline browsing, and what a screen does with no server

Owner's report: with playlists already downloaded and no connection, opening a downloaded playlist's
song list rendered `could not reach https://… (TypeError: Load failed)…` as the page, and the library
was unreachable offline entirely. Playback itself was fine.

Four decisions, all of them about who owns a screen's content:

1. **The playlist page is LOCAL FIRST.** A downloaded playlist's song list is read from the durable
   manifest (`storage/offline.ts` → `state/offline.ts`) and drawn *synchronously*, before anything is
   asked of the server; the server's list, when it answers, replaces it. Nothing about the page waits
   on a round trip — including the hanging-connection case, which is what the browser harness proves.
2. **A manifest carries the playlist's NAME** (additive, optional field). It is the only fact about a
   downloaded playlist that cannot be rebuilt from the files, and the offline browse list needs it.
   Manifests written by older builds have none: the server's own list fills it in on the next visit
   (`rememberPlaylistName`), and until then the row reads "Downloaded playlist" rather than inventing
   one.
3. **"Unreachable" is a first-class failure.** `SubsonicError.unreachable` marks a rejected `fetch`
   (no tailnet, airplane mode, timeout) as distinct from an HTTP/Subsonic answer. A server-only view
   that gets one degrades to the offline state — an `Offline` badge plus what is on the phone — and
   **no transport message may ever be a view's primary content** (it goes to the console). A real
   answer from a server that is there keeps its own message.
4. **The launch does not wait for the server.** The device's own queue snapshot is local and still
   restores exactly as before; the server's `getPlayQueue` fallback (a fresh install, a stale
   snapshot) now runs *after* the first paint, and takes the owner to the spectrum when it lands on a
   launch he has not touched. With the connection up but nothing answering, the app used to be blank
   for the whole 20 s request timeout.

Item 4 of the owner's v2.0 list (the background auto-advance delay) is touched here only at the
native boundary: the handover statement (`awake: false`) now arms the native side's own look-ahead,
so the *first* boundary after the app goes away is a play from a loaded item rather than a fetch.
DECISIONS.md's own note on that item stands — "if it can't be resolved it's fine", low priority — and
the change is not device-verified here: the simulator cannot settle a background gap.

## 1.9.19, 2026-10-15 — the three defects Sage's review of 1.9.18 found

Review of 17995e4 (t_aad111fa) returned SEND BACK: the offline work was real but its headline claim
was not reliably true *on the phone*, and two smaller defects followed from the same mistake — reading
"the local list" as if it were "the list that is actually here". Fixes, in the order they matter:

1. **The offline store is warm before the first paint.** The playlist records `record()` and
   `downloadedPlaylists()` answer from were built in `hydrate()`, *after* `await bridge.list()` — a
   native round trip lasting up to `BRIDGE_TIMEOUT_MS` (5 s). Boot starts hydration without awaiting
   it and paints the first route anyway, so on iOS the Library and a downloaded playlist drew their
   offline state off an empty store for that whole window: "nothing is downloaded on this phone yet"
   over a phone full of downloads, with nothing re-rendering when the reconcile landed. The records
   are now rebuilt from the mirror's manifests **in the constructor**, in the same tick as the rows
   were already being seeded, from exactly the data `hydrate()` would use. The Chrome harness cannot
   see this defect at all — `createDownloadsBridge()` is null on the web, which makes `hydrate()`
   synchronous — so the regression test drives the store directly with a bridge whose `list()`
   answers on a timer and asserts the record exists *before* any await
   (`test/offline-browse.test.ts`).
2. **A partial download paints only the tracks that are here.** `record.songs` is the manifest —
   what the download was *asked* for — while `record.done` counts complete files, so a cancelled or
   grown download drew tracks with no file as ordinary rows: offline a tap on one was silence with
   nothing said, and "play the playlist" walked onto them. The local paint now checks each row
   against the synchronous resolver (`pathFor`), marks the ones that are not here, leaves them out of
   the queue, and the header says `n of m on this phone`. The server's own answer is untouched (every
   track of it is streamable).
3. **The deferred launch restore only adopts onto an untouched launch.** `getPlayQueue` lands after
   the first paint since 1.9.18, so a queue the owner had already started could be overwritten by the
   last session's — bar, now-playing screen and highlight jumping while the audio kept playing his
   choice, and the native side republished the stale queue. `Queue.restore()` returns false when
   `currentSong !== null`; a launch convenience is only adopted when nothing has been chosen.
4. **"Unreachable" is narrower than "any `TypeError`"** (`api/subsonic.ts`: `isTransportFailure`). A
   genuine `TypeError` thrown inside a view used to be presented as the `Offline` pill with its
   message going to the console only — the app blaming the network for its own bug. Only the
   transport's own messages qualify, and a real error keeps the path to the screen it always had.
5. **A not-downloaded playlist's header uses words, not the id** (`“pl-…uuid” is not downloaded`).

## The spectrum proof, re-baselined, 2026-10-15 (card t_e62d2b6b — the tool, not the player)

`tools/spectrum-proof.mjs` fails on v1.9.19 **and** on the pre-fix v1.9.18: after the audio goes
quiet the lit pixels keep falling — 31220 → 7184 → 2501 → 1337 → 668 at +160 / +240 / +320 / +400 ms
— where the v1.2 baseline in `docs/verification.md` §10.4 records the same 1277 at +160 *and* +240,
byte-identical. The tool's criterion ("t+160 ms === t+240 ms, both ≤ 10 % of the loud frame") is no
longer true of a spectrum the owner is happy with.

**Decision: the tail is deliberate, so the tool is re-baselined — the player is not changed.**
This is the v1.7.4 release envelope (`src/player/visualizer.ts`: `ATTACK_S = 0.045`,
`RELEASE_S = 0.1`, `FLOOR = 0.01`), which exists because the owner asked for the opposite of the
v1.2 snap — *"Pausing should cause the spectrum to gracefully all drop to zero"*. An exponential
release with a 0.1 s time constant is *by construction* still moving hundreds of milliseconds after
the music stops; the criterion was written when a silent frame collapsed the bars on the next frame,
and nothing has asserted it since v1.7.4. The bisect says so: `git bisect run` between v1.2
(f9fd6e5, good) and ac12206 (bad), with the tool itself as the test, lands on **4bee9f9 — v1.7.4**,
the only commit in the range that changes what the bars are drawn from (v1.2 and v1.7.3 pass, v1.7.4
and every later commit fail, in the bisect's own log).

The measurements that shape the new window, all on this machine (macOS, headless Chrome, 393×852
dpr 3, `node tools/mock-subsonic.mjs --port 4599 --stress`):

| build | playing | +160 | +240 | +700 | +900 | +1200 | first byte-identical |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1.9.19 (dist of ac12206) | 29625–31220 | 5860–11330 | 2408–3806 | 668 | 668 | 668 | **+480 ms**, flat to +2 s |
| v1.9.18 (17995e4, own worktree) | 29939–31017 | 6763–18201 | 3067–5589 | 668 | 668 | 668 | **+560 ms**, flat to +2 s |
| v1.2 (f9fd6e5, own worktree) | 21665–22650 | 1277 | 1277 | 1277 | 1277 | 1277 | immediately |
| v1.1 (its `visualizer`+`engine` over v1.2, rebuilt) | 20631–20763 | 5713–17060 | 2360–5664 | 1243 | 1246 | 979 | **never** (still moving at +1.5 s) |

The judgement therefore sits at **+900 ms and later, not at +700**: the same build settled at +480 ms
in one run and +560 ms in the next (the last pixel change is a bar leaving the envelope's floor), so
the criterion takes three readings half a second apart — +900, +1200, +1500 — compared as PNGs
rather than as lit counts, since a frame can have the same count and be a different picture.

The decay is the envelope and nothing else: successive 80 ms readings fall by 1.9–2.9×, i.e. a 0.1 s
time constant, and the settled value is 668 px = 64 bands × the 1 px minimum bar — the analyser has
reached digital silence and what is left on screen is exactly the "no bar" rectangle per band. So
the tool now asserts what the shape actually promises: **the tail only falls, it reaches flat inside
the envelope's own window (the release's ~460 ms to the floor plus the media pipeline's ~100 ms), the
flat frame is byte-identical from +900 ms to +1500 ms and is ≤ 10 % of the loud frame, and the frame
it left is flat bars** — one separated run of lit pixels per canvas column, nothing lit below the
bars' baseline. The v1.2 readings are still taken and printed, so §10.4's baseline stays comparable.

The tool was not weakened to make it pass. Against the v1.1 control it fails on two independent
counts (never settles — 1243 / 1246 / 979 / 922 lit pixels at +700 / +900 / +1200 / +1500 ms, no two
frames alike; and 118 of its lit columns hold a second run of lit pixels) — the same defect family
the tool was written for. Runs rather than distinct colours are used for the shape check because the
bars' bottom edge lands on `0.98 × height`, which is a fractional line on most canvas heights: one
antialiased row then blends the bar with the backdrop at two alphas, i.e. two colours in a column on
a perfectly ordinary v1.2 frame (measured: 629 such columns). A gap in a column has no such
ambiguity. The per-frame claim itself (64 flat rectangles, no caps, no reflections) is asserted on
every frame in `test/visualizer.test.ts`; the pixel tool asserts what that test cannot see — that the
shape survives a *silence* in a real browser, after the envelope has finished moving.

Controls under the re-baselined tool, each built in its own scratch worktree and served on its own
port, with the settled frame's shape counted: v1.9.19 **pass** (668 lit px flat at +700/+900/+1200/
+1500, 0 second runs, 0 below baseline, twice), v1.9.18 (17995e4) **pass**, v1.7.4 (4bee9f9 — the
commit the bisect blames) **pass**, v1.2 (f9fd6e5) **pass** at its documented 1277, v1.1 **fail**.
So the sequence of verdicts is now the same as the design's, with v1.7.4 no longer a false alarm.

Not covered here: this reads the **streaming** spectrum (the mock's WAV through the web engine). The
local-file path (`playlistPath`/`localFile`, the v1.9.16/17 ground) is a different engine and was not
exercised by this check.

**What this criterion is blind to, named rather than left implicit** (from t_e62d2b6b, 2026-10-16).
It is a **settled-state** criterion: it asserts that the tail only falls, that +900/+1200/+1500 ms are
byte-identical, that what is left is ≤ 10 % of the loud frame, and that the frame it settles on is
flat bars. It is therefore **silent about how the tail got there**. The shape between +240 ms and
+900 ms is printed (the +700 ms reading is in the output) and judged by nothing; and a build that
drops from loud to flat **instantly** — the v1.2 snap the owner asked to be rid of — passes every one
of those four assertions exactly as the v1.7.4 envelope does (v1.2 is a passing control under this
tool, §above). So: the tool proves the spectrum *ends* silent and flat, and does not prove the
release is *graceful*; that property is asserted only by the envelope's own constants in
`src/player/visualizer.ts` (`ATTACK_S`/`RELEASE_S`/`FLOOR`) and by the eye of the person watching it.
It also says nothing after +1500 ms — a bar creeping back up two seconds later is outside its window.
Anyone reading a pass from this tool must not read it as an envelope claim.

## 1.9.20, 2026-10-16 — downloaded content annotates the rows that already exist

Owner's report (Telegram 2026-10-15 evening, with his screenshot of the Playlists tab on 1.9.19):
*"a separate playlist is created for downloaded songs, this should not be the case … the duplicated
playlist confuses the user"*, plus four asks in the same message — a mark beside a downloaded track
and beside a playlist when the whole playlist is downloaded, a way to browse the library for
downloaded songs, and **album art downloaded with the song so it can populate and theme the spectrum
page**.

**What the gate found, on the built app with a real server answering** (`dist/` of ac12206 against
`tools/mock-subsonic.mjs`, Chrome at 393 × 852, the app's own offline mirror holding one downloaded
playlist that also exists on the server): the screen draws that playlist **twice** — once from the
store (`renderPlaylists`' `Downloaded` section, `ui/app.ts:2073-2077` → `offlinePlaylistRow:1779`,
`cover(null)`, sub-line from the store's record) and once from the server's own list
(`playlistRow:2102`, art, `formatDuration`) — and both rows navigate to the same playlist. The
section is **not** a placeholder the server's answer replaces: `ui/app.ts:2094-2099` replaces the
server half only, so both lists are painted whenever a server answers at all. His screenshot reads
the pairs as a second entity rather than a second row because the two orders differ, one of each pair
has a placeholder glyph where the other has art, and the sub-lines differ in kind (`5 GB` of
*estimate* next to `269 on this phone`, versus `17:03:55` of runtime).

**Nothing creates a playlist for downloads, and the report's wording is not the mechanism.**
`createPlaylist` has exactly one caller, the Create button (`ui/app.ts:2061` →
`state/library.ts:165` → `api/subsonic.ts:302-303`). The defect is one playlist painted on two
surfaces at once. Six decisions follow; the long form, the seams and the file:line plan are in
`docs/design-downloaded-surfaces.md`, which is part of this release.

1. **One row per playlist, always.** The store's knowledge **annotates** the row another source
   draws; it never appends a row of its own. The only place the store *is* the list is a screen the
   server cannot answer at all (`renderOffline`), where there is no other row to annotate. His
   screenshot's `DOWNLOADED` heading over four rows — two names, twice each — is the failing case,
   and the acceptance is exact: **no playlist name may appear twice on that screen, with the network
   up or refused, and a downloaded playlist must read as downloaded on its one row.**
2. **The mark is one predicate, read synchronously, and it is never the estimate.** A track is
   downloaded iff the store holds a `complete` row for it (`pathFor`) — the same predicate that
   already decides whether a row is playable, so a badge and a playable row cannot disagree. A
   playlist's mark comes from its record: `complete` only when audio and lyrics are all in **and**
   the playlist in front of him has not grown since (`expectedTracks > record.total` ⇒ `partial`,
   because the row must not claim to hold tracks it has never seen). And the row's size figure is
   **measured from the rows**, never `record.bytes`, which is a ceiling for a download that has not
   happened: the screenshot shows the two confused.
3. **Browsing downloaded songs is a view, not an entity.** `#/downloads` — **On this phone** — at the
   top of the Library and from the Settings row that already prints its numbers. It is a filter's
   result over rows that already exist, with no id, no name, nothing on the server, nothing to
   create, rename or delete, and membership is the same `pathFor` predicate as the badge; its queue
   context is its own (`downloads`), not a playlist's. A route is a view; a playlist-shaped row under
   the Playlists tab is an entity — that distinction is the whole of why this does not re-create the
   defect above.
4. **Album art is a third axis of a download, beside audio and lyrics, and it gates nothing.** One
   file per **cover id** (`<coverId>.art`), not per track: a 12-track album is one cover, and storing
   twelve copies would show up in the "Downloaded music" figure he reads. Resolution has **one
   chokepoint** — `Library.coverUrl`, exactly as `streamUrl` is the one for audio — so the palette,
   the player bar, the spectrum page and every thumb become offline-capable in one edit, and
   `player/palette.ts` is **not touched**: the theming machinery has existed since v1.4.1 and what
   was missing was art on disk. **A missing or failed cover never gates anything**: a track's audio
   row decides whether it plays, a playlist's state is decided by audio and lyrics, and no album art
   failure may put a playlist on `· retry`. The art bytes count in the playlist's total size estimate
   **once per cover**, measured after the first download and bounded by a constant before it — the
   same rule and the same shape as `LYRICS_ASSUMED_BYTES`.
5. **Downloads that already exist on his phone keep working, and are not re-fetched.** The marks
   appear immediately from the audio rows 1.9.19 wrote; the browse view works immediately; the art is
   absent until he asks for it. The way he asks is the control he already has: a `complete` playlist
   with a cover that is not here reads `✓ 312 MB · ↓ covers`, and that tap calls the same
   `download()` — which only enqueues what is *not* already on disk, so **no audio byte is
   re-fetched**, and the label returns to `✓ 312 MB` (whose tap is the removal it is today) once the
   covers land. There is no automatic backfill: a download the owner did not ask for is still not a
   download, and a boot-time art fetch would be a sync.
6. **Every field added to a durable record must be optional.** `NaviliteDownloads.readIndex()`
   (`:383-386`) answers `[:]` when a decode fails, and the boot sweep (`:601-614`) then deletes
   **every file the index does not name** — so a single non-optional field added to `IndexRow` or
   `Job` against the 1.9.19 records on his phone is a silent deletion of 5 GB of downloaded music,
   not a rendering fault. The same rule binds the JS mirror, whose parse failure is likewise a
   silent cold start with no local rows. This is the one rule in this release that exists to protect
   data rather than to render a screen, and it is why the native edits are so narrow. The mirror also
   gains the copy metadata (title, artist, album, cover, duration), because the first paint of a cold
   offline launch is drawn from the mirror alone — without it the new browse view would be a column
   of blank titles for the seconds `bridge.list()` takes, which is 1.9.19's own defect rebuilt in a
   new place.
7. **The spectrum proof asserts the reading it prints, and its blind spot is named.** `tools/
   spectrum-proof.mjs:164` asserted the tail's monotonicity across +240 → +1200 ms while skipping the
   +700 ms reading it puts in its own output; the +700 ms reading joins the chain. And the
   re-baselined criterion's silence about *how* the tail got there is now written down in the section
   above, so no reader takes a pass from that tool for an envelope claim it never made.

## 1.9.21, 2026-10-16 — the two gaps v1.9.20's review left (one playlist, one pair of numbers)

Both were filed by v1.9.20's own acceptance review against item 2's "honest for a partial" and item
3's "there whether or not the server answers", and both are small. They land unreleased, on the same
branch as 1.9.21's race fix — no version, changelog or native field is touched by either.

1. **A row's `n of m` is the playlist in front of the owner, not the manifest.** `badge.total` is what
   was *asked for* when the playlist was downloaded; the row is drawn beside the playlist the server
   has just described, which may be longer (the owner adds a track to a playlist he downloaded: the
   row read `270 tracks · 269 of 269 on this phone` under the hollow mark while that playlist's own
   page said `269 of 270 · retry`). The denominator is therefore `Math.max(badge.total, songCount)` —
   the server's own length where it has answered, the manifest's otherwise — and the numerator stays
   the complete files among the manifest's songs, i.e. what actually plays. The **same figures** feed
   the sub-line and the accessible name (`… of … downloaded` is what VoiceOver reads), because the two
   disagreeing is the same defect one layer up; and the page's own control's grown label is one
   function so that a test can assert the row and the page agree on the numbers rather than on two
   spellings of them.
2. **The Library's own entry row survives the offline page.** `renderArtists` draws "On this phone"
   synchronously, before it awaits anything, and the router's `fail` then handed the whole screen to
   `renderOffline` — so the row the design promises "whether or not the server answers"
   (`design-downloaded-surfaces.md` §4.1) was thrown away in exactly the case the downloaded music
   exists for, leaving Settings → `Downloaded music: … →` as the only way in. Of the card's two
   options, the row is **kept on the offline page for the Library's head** rather than letting the
   Library keep its own header on the unreachable path: the offline page already *is* the Library
   degraded (its heading, its badge, its own downloaded playlists), and the entry row is the Library's
   own door, drawn from the store alone — so nothing about it needs the server to have answered. It is
   appended **above** the playlists' rows in that page's one list (never a second rows list), and the
   transport's message is still nowhere on the screen.

## 1.9.21, 2026-10-16 — released: a slow answer may only paint the view it was asked for, and only while that view is the screen

This is the cut that carries the three fixes already committed on `main` (the race guard `a0d296e`, the
review's two gaps `7453ebd`) to the owner's phone: version bump, changelog entry, tag and IPA are this
release's, and nothing else is in it. The two sections above record the fixes themselves; this one
records **the rule they establish**, because it now binds every view that awaits anything, not only the
views the two lanes happened to touch.

1. **The invariant: an answer may paint only its own view, and only while that view is still the
   screen.** `overtaken(shell, route)` reads the router's own `shell.viewRoute` at the moment of the
   write, and the guard sits on every paint that can reach the screen: the Library, the playlists
   screen, the playlist page, the downloads view, the album page, the artist page, Favourites, Search,
   and the router's own failure fallback. A view whose answer lands after the owner has walked
   somewhere else is dropped — silently, because he has already been shown the screen he asked for,
   and a message about the one he left is noise. That a **rejection is a paint too** is the part the
   card did not name: `renderRoute`'s `fail` was replacing the destination with an error box about a
   screen two back, so it is guarded by the same rule.
2. **The guard is keyed to the render, not to the request.** Each view captures its route once at the
   top of the *render*, never per request, so a second Enter while the first search is still in flight
   is the *same* render and both answers are current ones and land. Stated because the neighbouring
   reading — "drop any answer that is not the newest request" — would silently cancel a legitimate
   repaint and would have made the second search look broken.
3. **Only the write to the screen is guarded; the data work never is.** The guard filters one paint;
   it does not cancel the work behind it. Where `state/library.ts` caches — artists, an artist, an
   album, a playlist, the starred set — the answer is in the cache whether or not its paint was
   dropped, so walking back to that view draws from memory rather than repeating the round trip.
   (Search is not cached; a dropped search answer is simply discarded.) One awaited paint is left
   unguarded **deliberately**: `renderAlbums`' lazy `load()` writes into a list host its own render
   created, which the next render's own header has already detached, so a late answer there lands
   where nothing is shown — measured, not assumed: it passes in the RED run of §18 above. Guarding it
   would be uniformity with no defect to fix, and it is named here rather than left to look like an
   oversight.
4. **The suite's own determinism is deliberately not in this cut, and nothing changes about how the
   suite is run.** The pager check's 20 s patience under `npm test`'s parallel load (card `t_744cba0b`,
   the flake recorded in `docs/verification.md` §18 and §14.5) is parked at the owner's request — he
   does not want the machine loaded while he is using it — and this release was **un-gated** from that
   card rather than holding two ready fixes behind a harness tuning. So `npm test` is still exactly
   `node --test "test/*.test.ts"` with no concurrency flag, no patience change and no plumbing change;
   the fix exists only in that card's workspace, uncommitted, and if the pager flake appears in this
   release's evidence it is reported as what it is rather than tuned away.
5. **This cut's artifact is the iOS IPA.** `npm run ipa:unsigned` is what was run, and the Android
   `versionCode` is bumped (40 → 41) so that the next APK build carries 1.9.21 — no APK was built for
   this release, and none of the claims in §20 of the verification record rest on one.

## The suite's own determinism, 2026-10-16 (card t_744cba0b — unreleased)

Two files asked the same test fixture for the same port, and the flake that was filed as a load phenomenon
turned out to be that collision. What the fix establishes, and what it changes about how the suite is run.

1. **No test file names a port, and no test drives a library it did not start.** Every browser-driven file
   starts its mock through `test/support/mock-fixture.ts`, which asks the OS for a port and takes the number
   from *its own child's* `navilite-mock-port` line (printed from the child's listen callback), then proves the
   child is answering. The rule is the point, not the file: a hard-coded port is a claim about a machine, and
   two files that make the same claim lose it silently — the loser's mock dies of `EADDRINUSE` into a stdio
   nobody reads, the winner answers the loser's readiness probe, and the loser's check spends the rest of its
   run driving a library that another test file will kill. What follows from it: **a harness that drives a
   shared fixture must own that fixture's address.**
2. **A failed bind, and a wait that runs out of patience, must name themselves.** The mock prints one line and
   exits non-zero on a bind failure; a wait in `tools/layout-probe-browser.js` that times out reports the page's
   own state (route, heading, rows, text). The card's evidence could not be read for seventeen runs because the
   interesting failure was the *silent* one, and this is the rule that came out of it: the failure a harness
   cannot name is the failure that gets misfiled as load.
3. **The suite keeps node's default concurrency.** No `--test-concurrency` bound: with the collision gone, ten
   consecutive `npm test` runs are green (249/249, 0 skipped, ~37–39 s each) at the default, and bounding it would
   make every run slower for no reading that any of this rests on. The lever the card offered as "the blunt
   one" is deliberately not pulled — §21 of the verification record has the numbers.
4. **Nothing about the pager check's assertions or its 20 s patience changed.** The flake was in the driving.
   The wait's *message* now carries the page's state, which is diagnosis rather than a longer wait.
5. **What this supersedes.** The v1.9.21 release decision said the suite's determinism was not in that cut and
   that "nothing changes about how the suite is run … no plumbing change"; that was true of that release, and
   this is the commit that changes the plumbing — `Cdp.send`'s deadline, Chrome's debug port read from its own
   `DevToolsActivePort` instead of a guessed one, and the browser's whole process group killed instead of its
   launcher. The suite command itself is still exactly `node --test "test/*.test.ts"`.

