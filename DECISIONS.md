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

## 1.9.24, 2026-10-16 — the chip's third word is a fact about the item playing now, never a clock (the spectrum fix of `t_bec7b1bd`, released)

`b760253` (on `main`, unreleased until this cut) replaced the engine's timed verdict with a per-item fact. What it
establishes, and the one state it deliberately leaves open.

1. **While a native track is playing, the chip's third word ("spectrum…") may only be ended by a fact about the tap
   on the item playing now**: this item's own frames answering *live* (`src/player/engine.ts:2751`), this item's
   frames reading *silent* after 12 polls with the counter growing for this item (`2780-2789`), this item's frames
   *frozen* (the same frame repeated 10 polls, `2805`), or a build with no tap at all (`2542`). **No poll count,
   elapsed millisecond, timer or retry budget is a term** — `MAX_SPECTRUM_RECHECKS`, `SPECTRUM_SLOW_POLL_MS`,
   `slowSpectrumPoll` and `retrySpectrumOnce` (the 5 s retry) are deleted, not tuned.
2. **The counter that decides "this item's tap has answered" is per item, not per process.** `tapFramesForItem`
   (`2847`) counts only growth observed while the plugin says the tap is on the item the player is playing, and
   `forgetTapFrames` rewinds it whenever the tap leaves that item (`startNative` `2300`, `adoptNativeAdvance`
   `1831`, the orphan branch `2653`). It can only *under*-count, and it can never state another item's frames as
   this item's — which is what the old reading (`frame.frames`, the tap's process-lifetime counter,
   `NaviliteSpectrum.swift:605`) did on every change of track after the first that ever produced a frame, and why
   the chip said *native audio* about a tap that had produced nothing for the item playing.
3. **"This build has no tap" and "the tap is on an item the player has moved off" are two sentences, not one.** The
   plugin has always sent `attached` (`NaviliteSpectrum.swift:422`) and the engine discarded it;
   `NativeSpectrumFrame.attached` is declared (`src/player/native.ts`) and the orphan branch re-asks the plugin on
   the plugin's own evidence rather than on elapsed time.
4. **The state this leaves open, and why that is the deliberate answer.** A tap that is attached to this item and
   producing nothing — standing still, or a request that never lands — generates no growth, so it never ends the
   third word: the chip keeps saying "spectrum…" for the whole track where v1.9.23 eventually said *native audio*
   from a clock. The engine cannot tell "will never attach" from "still attaching" without one, and the clock is
   the false capability claim this fix exists to remove; the state is *named* on the reason line instead
   (`spectrumArming`). Ending it needs a new input — the plugin's own refusal reason for this item — and that is
   its own card (`t_aedab91d`), never a timer. This is a departure from §24.7 of the verification record, agreed
   by review (`t_d7dd3e62`, SHIP).
5. **What the fix does not touch.** The chip's three words, the one-engine rule, and the native half: no file under
   `ios/` or `tools/` changed, the v1.9.22 guards on the three detach sites hold, nothing detaches or re-attaches
   a tap on a playing item, and no envelope or idle spectrum is synthesised.

## The tap on the item playing now owns its own analysis, 2026-10-16 (card `t_4b279e4b` — released as v1.9.25)

The owner's report after installing v1.9.24 — *"the lines stay dead the whole track, the spectrum seems to jump up at
the start and then go to zero and remain there the whole track"*, *"while it's flat it says native audio … mostly
when i skip out of a loud passage … on a cold start the spectrum always works"* — what the fix establishes, and the
one half of it only his phone runs.

1. **A frame is drawn, and may spend the chip's third word, only if this item's tap produced it — which is a
   statement about that tap's own pace, not about a read** (`src/player/engine.ts`: `noteTapFrames`,
   `holdsThisItemsOwnFrame` and the branch above `nativeBands` in `pollSpectrum`; amended by Sage's SEND BACK of
   `2e1eb9d`, `t_48f5660b`). `bands`/`live` are a **last-value register** — the last frame the FFT ever produced,
   zeroed only in `detach` — so on a track whose own analysis is gone the plugin hands over the *previous* item's
   last frame, non-zero and `live`. The frozen rule (`checksum !== 0 && checksum === lastNativeChecksum`,
   `FROZEN_FRAMES_BEFORE_THEME`) was the writer of what he reads: ten identical reads of that register, ~330 ms in,
   and the chip went to *native audio* with the bars flat. It now only ever sees frames this item's tap produced, so
   it catches the live-but-stuck tap it was written for and nothing else; a register that simply stopped is a
   different state, with its own sentence (§3).
   **What this point said when it was first written — *"only if this item's tap produced it since the last read"* —
   rested on a premise nothing had measured: that a healthy tap advances its counter once per 33 ms read. It does
   not.** Frame production is quantized to the PCM buffer AVFoundation hands the tap (`drainAndAnalyze` resets
   `sinceLastFrame` per callback instead of subtracting the hop, `NaviliteSpectrum.swift:678`), the `maxFrames` a
   tap declares at `prepare` was discarded (`:811`), and 4096-frame buffers are ~11 frames/s against 30 reads/s —
   so two reads in three would have blanked the bars, and flapped the chip between *spectrum* and *spectrum…*, on a
   tap that was measuring perfectly: the quiet skip and the cold start, i.e. exactly the cases that work today.
   The plugin now **keeps that declaration** and publishes, for the item its tap is on, `itemFramePeriodMs`
   (`maxFrames` over the sample rate, floored at the tap's own FFT hop — how long this tap can legitimately go
   between two frames) and `itemFrameAgeMs` (how old the frame it is holding is, on the monotonic clock of the
   analysis that produced it; `-1` before its first). The rule is that comparison and nothing else: a frame is
   drawn when this item's tap produced it since the last read, **or** when it is this item's own last frame and no
   older than its own period; past that the register is named and not drawn. No engine constant, no poll count, no
   `setTimeout`, no *"give up after N s"* — §515.1's deleted shapes stay deleted — and both halves of the honesty
   stay: `itemFrames === 0` (the register holding the previous item's frame: his loud skip) is still never drawn or
   judged, and a held frame decides nothing — it does not feed the frozen rule, does not count toward the silence
   verdict, does not refresh the pinned-end watchdog's live stamp and does not touch the chip, which keeps the third
   word for a track whose tap has never answered (§515.4 stands). The two sentences §3 lists for the undrawn states
   read, after this amendment, *"the frame the plugin is holding was not produced by this item's tap — the bars
   follow the audio, and this track's own tap has yet to give one"* and — for a tap that *had* produced for this
   item and stopped — *"this item's tap produced its last frame longer ago than its own frame period — nothing is
   measuring this track now"*. The failing cadence is stated by the harness (`test/engine-native.test.ts`, the
   v1.9.26 case: a frame every three reads with a declared 93 ms period, which is the 4096-frame buffer at
   44.1 kHz, asserting `readSpectrum()` non-null, the engine live and the chip on *spectrum* on every read — it
   fails on `2e1eb9d` on two reads in three). What only his phone can settle is the real number:
   `status.tap.framePeriodMs` / `frameAgeMs` are printed on the screen's own line (`src/ui/app.ts`).
2. **"Nothing has been measured for this item" is a plugin fact, not an inference.** `NativeSpectrumFrame.itemFrames`
   (new; `NaviliteSpectrum.snapshot`) is the analysis's own count for the item its tap is on: zero at the install,
   growing while that item is measured. The engine uses it when the plugin sends it and falls back to the growth of
   the process-lifetime `frames` (§515.2's rule, unchanged) when it does not. A tap measuring *silence* still
   produces frames; a tap whose analysis is gone produces none — the distinction the engine could not read before,
   and the reason this defect looked like the owner's *"there isn't enough silence between the songs"*.
3. **The state §515 left open is answered in §515's own terms.** A tap on the item playing now that has produced
   nothing **for that item** keeps the chip's third word (the same word §515.4 gives a tap that never answered),
   the bars follow the audio, and the reason line names *which* register it is looking at — *the frame the plugin is
   holding was not produced by this item's tap* (his loud skip: the register still looks live)
   or *the tap on the item that is playing has produced no frame for this track* (it is flat). (§516.1 as amended
   rewords both of those to carry the pace, and adds the third state — a tap that produced for this item and has
   now stood still longer than its own frame period; the states themselves are unchanged.) No verdict is
   spent, no re-attach is issued and no timer exists: a verify cannot restart a tap AVFoundation has stopped
   preparing, so asking would be a round trip that corrects nothing — the shape v1.9.24 deleted for `resync`.
4. **And the cause is native, where §515.5 said nothing changed: it is not.** One `AudibleSpectrumTap` per process
   held one PCM ring, one analysis timer and one FFT for **every** item, while `prepare`/`unprepare` are per item
   and arrive in an order AVFoundation chooses — so the outgoing item's teardown landing after the incoming item's
   `prepare` left the track playing now with no analysis for the rest of its life, and neither half could put it
   back. `SpectrumAnalysis` (new, `ios/App/App/NaviliteSpectrum.swift`) is **one analysis per install**, handed to
   the tap as its `clientInfo`, so every callback lands on the state of its own item: a teardown stops only the
   analysis its own item started, and an outgoing item's PCM can no longer be windowed as the item that is playing.
   This is *the* answer to *"on a cold start the spectrum always works"* — with no outgoing item there is no race.
   No mix is written, nothing is detached, nothing is delayed: a hand-over still measures nothing until AVFoundation
   prepares the new item's own tap, so the bars are live on the new track from that item's first frame.
5. **The boundary's adoption resets the per-item state too** (`adoptNativeAdvance`: `nativeBands`,
   `lastNativeChecksum`, `identicalNativeFrames`, beside the resets it already had). It takes the item over without
   passing through `startNative`, so without this the previous item's register was judged against the track the
   native player had just started itself.
6. **The reason line carries the tap's own numbers now** (`EngineStatus.tap`: frames for this item, the plugin's
   two frame counters, its install/verify counts, and the slot the plugin says the tap is on against the slot the
   bridge is playing — plus, since the amendment above, the tap's own pace for the item, `framePeriodMs` and
   `frameAgeMs`, which is the pair the drawing rule is a comparison of and the one number about a real tap that no
   build has ever printed). Three of those were already computed and dropped at the bridge; for a defect that has been
   diagnosed from source three times, one reading of his is worth more than a fourth pass.
7. **What is not claimed.** The native ordering cannot be reproduced in node. The harness states *"this item's tap
   has stopped producing for it"* — all the engine ever sees — and proves the engine's half of it
   (`test/engine-native.test.ts`, the v1.9.25 regression: six steps, both entry points a transition has, and it
   fails on the pre-fix engine by drawing the previous item's frame at a skip). That the teardown lands after a
   `prepare` on his phone, and that this item's analysis now survives it, is **unverified on device** until he
   skips out of a loud passage on the build that carries it.

## The chip's word is a fact about the item in hand, never a capability reached by elimination, 2026-10-16 (card `t_9329e3b0` — released as v1.9.26)

The owner, on the v1.9.24 build he had just installed, with a track loaded and **paused** on the playlist page for
`Jap` (1:28 / 4:55). His screenshot: the mini-player's chip reads `NATIVE AUDIO`, and the debug line under it reads
`paused · native · spectrum off · player: paused · pause`:

> *"the spectrum always works but on the playlist pages, the bottom bar seems to keep flashing to native audio
> spectrum off even though the spectrum is working fine"*

1. **The word is one fact, on the status, computed in the engine** (`EngineStatus.visualiser: { word, tone }`),
   because every input it has is the engine's and one of them — *can this build measure this item at all?* — the UI
   could not read. It replaces the expression that was at `src/ui/app.ts:3356`
   (`status.spectrum ? 'spectrum' : status.spectrumArming ? 'spectrum…' : status.backend === 'native' ? 'native
   audio' : 'theme'`), whose third branch was a **capability claim reached by elimination**: `spectrumArming` is only
   ever reported while a native track is *playing*, so `paused`, `ended`, `interrupted`, `loading` and "nothing
   loaded" all fell through to the word that means *"the spectrum cannot run on the item playing now"*. The app now
   prints the field and computes nothing (`VisualiserWord` is the definition of every word).
2. **The words, and what each one claims.** `spectrum` (the bars are being fed by the item in hand now);
   `spectrum…` (a native item is playing and its tap has not answered for it — §515.4's word, and the word a tap
   refused for a whole track keeps: that call of 2026-10-16 stands, re-litigated nowhere); the transport's own
   words — `idle`, `loading`, `paused`, `ended`, `interrupted`, `error` — worn when **the only reason nothing is
   being measured is that nothing is playing**; `native audio` (a build with no tap on its native player — Android
   today — or this item's tap ruled out *while it plays* by its own verdict: silence for
   `ZERO_POLLS_BEFORE_THEME`, or one frozen frame over and over); `theme` (the same statement on the web path).
   Every transport state's word is a total `Record` (`STOPPED_WORD`), so a state added to `EngineState` does not
   compile until its word exists.
3. **What licenses a capability word is an *evidenced* absence**, which is now a three-valued fact
   (`measuringPathForTheItem`): `tap`/`analyser` (the path exists), `none` (a bridge that is built and says it has
   no tap; a browser whose Web Audio graph could not be built) and `unknown` (nothing has answered yet — a bridge
   still being built is a load in progress, and `startNative` reports `error` if it cannot be built). Only `none`
   spends `native audio`/`theme`; `unknown` falls to the transport's word, because "the bridge is not built yet" is
   not a fact about what the build can do. Two things are deliberately not read as `none`: a **suspended audio
   context** (a lifecycle fact — WebKit suspends Web Audio when the page is hidden and the visualiser re-arms on
   the way back in) and a **cross-origin stream the library will not hand over** (this item's own verdict, spoken
   while it plays).
4. **No masking, and no removal.** The word is recomputed from current facts on every status event (the player
   emits a dozen a second) — nothing is frozen, and nothing is hidden. The legitimate case is *more* reachable, not
   less: a build with no tap wears `native audio` in every transport state, playing or paused, which the harness
   states on a bridge whose `hasNativeSpectrum` is false. The native half is untouched: what may still end the
   chip's third word while a native track *plays* is unchanged (§515, §516 — this item's frames, the silence
   verdict, the frozen verdict, a build with no tap), and no `spectrumArming` / `spectrumLive` / verdict
   semantics moved.
5. **The UI change, and two documentation truths.** The chip prints `visualiser.word` and wears
   `visualiser.tone`, with the app's own `loading…` kept for the tap's synchronous paint (v1.9.0) — and the new
   `stopped` tone, which is neither a measurement (green/`live`) nor a fallback (amber/`fallback`), so a pause
   reads as information rather than as a failure. The chip's own comment that said *"`native audio` is what this
   chip says for every state that is not playing"* is corrected, and the README's sentence about *"the mode chip
   on the player bar and the now-playing screen"* is corrected with it: **the bar's chip is the app's only one,
   and the now-playing screen has no chip visible at all.** The screen lost its own in v1.1 (`2ed9ed7`) and
   replaces the bar with a full-screen overlay that paints over the bar's: measured in Chrome at 393 x 852, with
   a track playing, `section.now` is `0,0,393x852`, opaque, `z-index 10`, the chip node sits at `x295 y755
   84x24`, and `document.elementFromPoint` at the chip's own centre returns the overlay — so a DOM-presence
   query says *"the chip is on the now-playing screen"* about a node the owner cannot see. **"The two surfaces
   cannot disagree" therefore reduces to one field and one VISIBLE node** (the bar's), and the browser harness's
   now-screen check is worded as what it reads — one node, one field — with that coverage measured beside it
   (`test/chip-word-browser.test.ts`; §29.2 of `docs/verification.md`).
6. **What this does not change, stated because it looks like the same defect and is not.** On the *web* path, a
   **playing** item whose analyser has not yet produced its first frame wears `theme` for ~90 ms (the meter
   samples every 100 ms); that window is the pre-existing verdict timing of the web path — no transport state is
   involved, the owner's build is native, and the native equivalent is covered by `arming` (v1.9.6). The probe
   filters on the transport state for exactly this reason, and §28.5 says so rather than implying the run is
   clean of the word.
7. **Released as v1.9.26.** The fix landed on `main` unreleased (`d769fd4`), and this entry said so at the time:
   no version bump, no artifact, no tag, `CHANGELOG.md`'s release heading untouched. This cut (its own card,
   `t_77e69a9b`, after Sage's SHIP on `t_1c2d1c51`) is what stamps and ships it — the version in the seven files
   of `docs/VERSIONING.md` §3, the changelog entry in his terms in both copies, the IPA, and §29 of
   `docs/verification.md`. The fix commit itself carried none of those; the code in it is unchanged by the cut.

## The browser's own first-frame window is the spectrum's word, not a capability verdict, 2026-10-16 (card `t_71dc787e` — released as v1.9.27)

Sage, out of the verification of `t_9329e3b0`/`t_1c2d1c51`, measured in Chrome at 393 x 852 over the mock library
(the real app at `d769fd4`), reading `test/chip-word-browser.test.ts`'s own word list:

```
384 ms  "theme"      (the chip changed, state playing)
512 ms  "spectrum"   (the chip changed, state playing)
```

`theme` — the amber `fallback` tone, the word for *"this browser has no Web Audio, or the samples are not real"* —
for 128 ms at the start of a track, while the transport was **playing** and the Web Audio graph was built and
working. Same at `8689a2e` (99 ms), so it is pre-existing, not a regression from the v1.9.26 fix. The licence it was
reached by is the second one in `visualiserWord` (`if (this.state === 'playing') return native ? 'native audio' :
'theme'`), taken whenever the bars were not being fed; the native path has a word for "the tap has not answered yet"
(`arming`, v1.9.6) and the web path had none, so its own first-frame window fell through to the claim that the app
cannot measure the item it is measuring. **By the invariant's own words that is a defect**: at that moment the app
*does* have the capability and the chip says it does not. It is user-visible on the web page / PWA — the third way
he uses the app — not on the phone, and not the word in his screenshot, hence its own card rather than a SEND BACK.

1. **The decision, first, because the vocabulary has a trap in it: no new word was needed, and the capability word
   was not replaced.** `spectrum…` already means exactly this — *"an item is playing and the thing that measures it
   has not answered for it yet"* (§515.4, the owner's call of 2026-10-16, unchanged) — so **no new vocabulary was
   added and no owner's call was required for one.** The trap: a blanket `theme` → `spectrum…` while playing would
   delete the statement the word exists for. A cross-origin stream the library will not hand over, or an analyser
   producing silence for ever, *is* "the spectrum cannot run on this item" and must keep saying `theme`. So the two
   states are separated by the register the web path already keeps for its verdict — `zeroFrames` — and not by the
   transport or by a clock.
2. **The rule, in one place:** `analyserArming()` — `backend === 'web'`, an analyser exists, `spectrumLive` is
   false, and fewer than `ZERO_FRAMES_BEFORE_THEME` (18, at the meter's 100 ms) frames have come back unusable.
   `status()` computes `spectrumArming` as *the transport is playing* AND (`spectrumArming` || `analyserArming()`),
   which is the same question asked of the two ways of measuring — *has the thing that measures this item answered
   for it yet?* The field is exact: it is never true while `spectrum` is true (a live frame resets the counter, so
   the `spectrumLive` check is half the question and the first half), and `visualiserWord` still checks `spectrum`
   first. The playing branch at the bottom of `visualiserWord` — the licence — is now reached on this path **only**
   by the item's own verdict: `ZERO_FRAMES_BEFORE_THEME` analyser frames of silence (the tainted cross-origin
   stream, or an analyser producing nothing) or one frozen frame over and over, with `silenceReason` naming which.
3. **The register is per item, which is the web half of `tapFramesForItem`** (v1.9.24's rule on the native side):
   `startWeb` clears `zeroFrames`, `identicalFrames` and `lastChecksum` for the item that is starting, before the
   element plays. Read as this item's own answer, an item that has just started an unmeasurable stream wears its
   own `spectrum…` first and then its own verdict — never the verdict the previous item's samples left behind. The
   cost is named rather than hidden: a genuinely unmeasurable stream is announced ~1.8 s into *each* item; the
   alternative is a verdict about one item spent on another, which is the class of defect the last three releases
   have been about.
4. **What it does not change.** The silenced / frozen / tainted verdicts still reach `theme` and still name the
   case (measured below, in a browser). The v1.9.26 words are otherwise untouched: the transport's own word for
   every stopped state, one source (`EngineStatus.visualiser`), and the **native path is not modified at all** —
   `hasSpectrumTap`, `arming`, `ZERO_POLLS_BEFORE_THEME` and every native verdict behave exactly as Sage verified
   them. The chip's UI file is untouched: it prints the engine's field and nothing else.
5. **A window of the same class was found on the native path while fixing this one, and it is deliberately NOT
   fixed here — it is its own card.** On the native path a **resume** reaches `playing` with no frame in hand and
   with `spectrumArming` left false (the flag is only set by a load, an adoption, or a poll that found nothing), so
   `visualiserWord` is reached by the licence for one bridge round trip. Measured on the fake bridge
   (`test/engine-native.test.ts`), the instant `resume()` is called:

   ```
   state playing, spectrum false, arming false — the chip reads "native audio"
   ```

   Fixing it is **not** the one-line `spectrumArming = true`: on the native path `(spectrumLive, spectrumArming) =
   (false, false)` while playing is also how a *reached verdict* looks (a tap that has read silence or one frozen
   frame for the whole track), and re-arming there would re-open "the spectrum is coming" over an item the engine
   has already ruled out — §515's silence verdict, which the owner has asked for twice. It needs a third fact
   (this item's verdict, as a field) and it needs his phone to verify, so it is filed as `t_71dc787e`'s follow-up
   card rather than folded in here. On the **web** path the same window is already closed by this entry, because
   the register that decides the verdict is the register the window is read from.
6. **Released as v1.9.27, with the native half and in one version.** The fix, its harnesses, this entry and §30 of
   `docs/verification.md` were committed unreleased (`48f9497`); the cut is `t_55732fc5`, and it carries this and
   `t_c8cc01c6` as **one** version rather than two — the two windows are one rule read on the two ways of
   measuring (the entry at the end of this file), and the owner has asked not to be streamed version after
   version. The release commit carries the version files, the changelog in his words, and §32 of
   `docs/verification.md`; **no line of `48f9497`'s code was changed by the cut.**

## The other half of the same window: a native resume, and the per-item fact that keeps it honest, 2026-10-16 (card `t_c8cc01c6` — released as v1.9.27)

Filed out of `t_71dc787e`, where the web path's first-frame window was closed and this one was measured and
deliberately left alone. Item 5 of that entry is this card's brief; the probe below is the same probe, on
`test/engine-native.test.ts`'s fake bridge (`nativeEngine(recording())`, play → settle → pause → `resume()`):

```
probe A1 native playing:        "spectrum" (spectrum true, arming false)
probe A2 native paused:         "paused"   (spectrum false, arming false)
probe A3 the instant resume() is called: state playing, spectrum false, arming false — the chip reads "native audio"
probe A4 native resumed:        "spectrum"
```

A3 is a status the app really emits (`resume()` dispatches the state, `applyState` runs and `emit()` fires before
the bridge is asked anything), so the amber capability word is painted on an item whose tap was measuring a
moment ago, until the poll's own round trip answers — on his phone, at every resume and at every return from the
background.

1. **The fix is a third fact, not a re-arm — and the reason is §515's silence verdict.** `spectrumArming` is
   written only by `startNative` (a load), `adoptNativeAdvance` and the polls that find the tap producing nothing
   or sitting on another item; a resume is none of those, and `disarmConsumers` (the pause) clears `spectrumLive`,
   so the window opened by elimination. But `(spectrumLive, spectrumArming) = (false, false)` **while the transport
   plays** is also exactly how a *reached verdict* looks — the tap has read silence for `ZERO_POLLS_BEFORE_THEME`,
   or returned one frozen frame over and over, and both of those paths clear `spectrumArming`. Setting
   `spectrumArming = true` in `startConsumers` would therefore say *the spectrum is coming* over an item the engine
   has already ruled out, which is the owner's silence verdict of 2026-10-16 and the whole of the last three
   releases. The engine keeps the fact it was missing instead.
2. **The fact:** `tapVerdictForItem` — *this item's tap has answered with its own verdict.* Set where the two
   verdicts are written (the `answered` branch of `pollSpectrum`, whose sentence names digital silence, and the
   frozen-frame branch, whose sentence names the repeating frame); cleared in `forgetTapFrames`, which is the one
   place a new item (a load, an adoption) and an item the tap has left (the orphan branch) already pass through;
   and cleared by this item's own live frame, because a tap measuring again supersedes its own old verdict —
   exactly what a real analyser frame does to the web half's `zeroFrames`.
3. **The window:** `tapArming()` — `backend === 'native'`, `spectrumLive` false, the tap **is on this item**
   (`hasSpectrumTap`, which is also what keeps a build with no tap on `native audio`), and no verdict for it. It is
   the mirror of `analyserArming()` (item 2 of §t_71dc787e), and it is OR'd in beside it and the flag:
   `status()` computes `spectrumArming` as *the transport is playing* AND (`spectrumArming` || `analyserArming()` ||
   `tapArming()`). The flag stays for the windows the writers own (a request in flight at a start, an adoption, an
   orphan, a tap producing nothing); the derived read is what survives the transitions no writer sees — a resume,
   and the return from the background that adopts the player's own `playing`.
4. **No clock and no budget.** What ends the window is this item's tap producing its own frame (live, silent or
   frozen) or giving its own verdict about it. v1.9.24 deleted the timer shape and none is reintroduced; the
   measured window below is the fake's own stated answer latency, and on the phone it is the plugin's round trip.
5. **What must not regress, and is asserted:** a track whose tap read silence for the whole track, and one whose
   tap returned one frozen frame, keep `native audio` across a pause **and** a resume — the verdict is about the
   *item*, and at the resume instant the chip is the verdict's word (not `spectrum…`, which is what a re-arm would
   have produced). A tap that starts measuring again ends its own verdict, and the window is then walked again
   from this item's frames. The paused / ended / interrupted words, the web path and the no-tap build's
   `native audio` are untouched (`t_71dc787e` and `t_1c2d1c51` verified them; not re-litigated).
6. **No new vocabulary, therefore no owner's call.** `spectrum…` already means *playing, and the thing that
   measures it has not answered for it yet* (§515.4, the owner's call of 2026-10-16); this entry spends that word
   on one more transition and adds nothing to the dictionary.
7. **Released as v1.9.27, with the web half it mirrors.** The fix, its harness, this entry and §31 of
   `docs/verification.md` were committed unreleased (`36ddb14`); the cut (`t_55732fc5`, gated on Sage's
   verification `t_1c099158`) stamps both halves at once, for the reason item 6 of §t_71dc787e names. The release
   commit carries the version files, the changelog in his words, and §32 of `docs/verification.md`; **no line of
   `36ddb14`'s code was changed by the cut.**

## The first-frame window is one rule on both ways of measuring, 2026-10-16 (cards `t_71dc787e` + `t_c8cc01c6`, released as v1.9.27)

The two entries above were written a minute apart, on either side of a deliberate deferral; this is the invariant
they add up to, stated once, because the next thing to touch `visualiserWord` will read them as two local fixes
unless it is written down that they are one rule.

1. **The rule.** While the transport is **playing**, the word on the bar is a statement about *the item in hand*,
   and *"the thing that measures this item has not answered for it yet"* is **never** reported as *"this build
   cannot measure it"*. The capability word (`native audio` on the phone, `theme` on the web) is reached only by
   the item's own verdict — and, on a build with no tap at all, by the absence of the thing itself.
2. **One rule, two registers, because there are two ways of measuring.** The web path answers from `zeroFrames`
   (`analyserArming()`), the native path from the tap's own verdict for this item (`tapVerdictForItem`,
   `tapArming()`). `status()` spends one word on both:
   `spectrumArming = playing && (spectrumArming || analyserArming() || tapArming())`. The named flag stays for the
   windows the writers do see (a request in flight at a start, an adoption, an orphan, a tap producing nothing);
   the two derived reads are what survive the transitions no writer sees — a resume, a return from the background,
   an analyser's first frame.
3. **No new vocabulary, therefore no owner's call was needed.** §515.4's `spectrum…` — *"playing, and the thing
   that measures it has not answered for it yet"*, the owner's call of 2026-10-16 — is spent on one more
   transition on each path. No word was added, removed or re-defined, and the dictionary in `CHANGELOG.md` 1.9.26
   still holds verbatim.
4. **No clock, no count.** What ends a window is the item's own frame or its own verdict, never elapsed time and
   never a poll budget. v1.9.24 deleted the timer shape; the two windows added here are read out of registers the
   fix already keeps, and neither introduces one.
5. **The verdict outranks the window, and that is the point of the third fact.** `(spectrumLive, spectrumArming) =
   (false, false)` while playing is how a *reached* verdict looks on both paths, so neither window may re-arm by
   flag: an item whose tap read silence, or returned one frozen frame, keeps `native audio` across a pause **and**
   a resume. Silent re-arming would have said *the spectrum is coming* over an item the engine has already ruled
   out — §515's silence verdict, the owner's own.
6. **Both halves shipped in one version**, verified separately before the cut (`t_7481b20f`, `t_1c099158`) and
   recorded in §30 and §31 of `docs/verification.md`; `v1.9.27` carries the combination and §32 records that cut.
   The two named residuals (§30.5.3's ~1.8 s per item on a genuinely unmeasurable stream, §31.3.4's ~0.3 s restart
   of a frozen tap's verdict after a resume) are stated there and are **not** closed by this release.

## Honest silence is not a capability failure, and the word for it is one the chip already wears, 2026-10-16 (card `t_5c7fc694` — decision only, unreleased)

The question, in the card's own terms: **is honest silence — the spectrum running, and this passage of the item
genuinely silent — a capability failure?** Answered from the two cards that supplied the evidence, not from
preference: the cold repro (`t_13b5cca0` — `docs/repro/t_13b5cca0/REPRO.md` and the traces, verdicts and fixtures
in `docs/repro/t_13b5cca0/logs/`) and the trace from the analyser read to the returned word (`t_9c379c56` — raw
readings at `/Users/neokester/.hermes/profiles/sage/cache/scratch/t_9c379c56/evidence-t_9c379c56.md`, attached to
that card).

1. **No. The repro separates "silent" from "capability dead" by measurement — same app, same graph, same seconds.**
   On the shipped-shaped web build (`9271ab0`, shipped paths identical to the `v1.9.27` release commit `b40ec02`;
   Chrome 155.0.8059.84, `--headless=new --mute-audio`, no device, no simulator) a 22 s item with a 5.000 s
   passage whose PCM is **220,500 samples that are exactly zero**, played same-origin through the app's own
   controls, read: `analyser maxByte 0, nonzeroBins 0 of 1024, rmsByte 0.0` with the element **playing**
   (`paused false`, `currentTime 9.053 s`, `volume 1`, `muted false`, context `running`) — and the **same
   analyser on the same element measured that same item's samples at `maxByte 255` a moment before and a moment
   after** (`+14202 ms`, when the word returned to `spectrum`). The control run over a quiet-but-**nonzero**
   passage holds `spectrum` across the very seconds in question (`maxByte` 181–186, `nonzeroBins` 5–6,
   `themeAtMs: null`). So the capability the word `theme` claims to name — *"this browser cannot read this item"*
   — was present and working, and the passage was **silent**: those are two different facts, and this build has
   the second one while standing on the first.
2. **What the code does with it is a capability claim built on a premise this repro falsifies.**
   `src/player/engine.ts:510` states the premise in its own words — *"~1.8 s of silence from the analyser while
   audio is definitely playing = not real samples"* — and `sample()` (`3738`) implements it: 18 consecutive
   frames with no energy (`3772-3777`, 18 × `METER_INTERVAL_MS` 100 ms = 1800 ms) set `spectrumLive = false` and
   write a reason line, and `visualiserWord` then reaches `engine.ts:1555`
   (`if (this.state === 'playing') return this.backend === 'native' ? 'native audio' : 'theme'`) and spends the
   amber capability word. Measured on that run: `theme` at **+10903 ms — 1801 ms after the first all-zero read**,
   over 4.902 s of the playing item (`+9102 → +14003 ms`), with the engine's own reason line blaming *"a tainted
   cross-origin stream"* on a stream that is same-origin, untainted and measurable. Silence-amplitude is being
   read as an unmeasurability verdict; the item's real, readable, quiet-passage PCM is the thing that produces it.
3. **Nothing inside the analysis window can tell the two states apart, which is why this was not visible as a
   local bug.** `t_9c379c56` traced every hop and measured the ambiguity: the analyser's zeros are the same zeros
   for a digitally silent song and for a stream the browser will not hand over (measured in Chrome through the
   engine's own analyser config: 1024/1024 zero bins while the element plays, for both), the frozen rule (`3756`,
   the same frame `FROZEN_FRAMES_BEFORE_THEME` 10 times) reaches the same licence, and both states end at the same
   line `1555`. The two facts that would discriminate are **outside** that window: whether this item's load refused
   sample access (`handleMediaError`, `3811`, refusal named at `3813-3816`, observed per item and then overwritten
   by the silence verdict at `3773-3777`) and
   whether the context is suspended (`3785`, used only to choose a sentence). So the defect is not a bad sentence —
   it is that the word was decided by a count of quiet frames instead of by the item's own evidence about its
   samples.
4. **The decision, and the defect in one sentence.** Honest silence is **not** a capability failure; the defect is
   that on the web path the app spends the capability word `theme` — and the reason line that accuses a tainted
   cross-origin stream — on ≥1.8 s of all-zero frames from an item whose own samples the same browser read at 255
   immediately before and immediately after, i.e. it states *"this build cannot measure this item"* about an item
   it is measuring. The fix's acceptance criteria are in item 6; the work is card `t_4253898e`, not this one.
5. **The correct word already exists: `spectrum` — so no word is coined, and no owner's call is needed.**
   §634.2 defines `spectrum` as *"the bars are being fed by the item in hand now"*, and that is exactly what is
   true of an honest silent passage: the bars **are** being fed, by the item in hand, with that item's own
   samples — a flat spectrum is still this item's own measurement, and the bar's flatness is the honest picture of
   it. The state does not need its own word, because no distinct truth is left over: the three states the user must
   be able to tell apart are *measuring now* (`spectrum`), *not answered for this item yet* (`spectrum…`, §515.4's
   owner's call, unchanged) and *this build cannot measure this item* (`theme` / `native audio`), and honest
   silence is the first of them. This is the same method the two previous cards used (v1.9.26 and v1.9.27, §833.3:
   *"no new vocabulary, therefore no owner's call was needed"*). **Coining a word for it would be the owner's call**
   — the chip's dictionary is his (§634.2, the dictionary in `CHANGELOG.md` 1.9.26) — but it is not needed here, so
   no question is put to him, nothing is sent to the orchestrator on that account, and this card does not stop on
   one. What is spent on the silent passage is §515.4's rule read one step further: the item's own measurement
   decides the word, and its own measurement says *real samples, currently flat*, not *no samples*.
6. **Fix acceptance criteria (card `t_4253898e`).** The term must be an **evidence-based per-item fact**, never a
   count of quiet frames; no timer, no frozen word, no masking.
   1. **The term.** While the transport is playing, whether a capability word may be worn must be decided for the
      item in hand by whether **this item's** samples are readable — a question the engine already has an answer
      to for the item, observed per item at the load's own refusal of cross-origin sample access (`3813-3816`),
      with the build-level absence (a graph that could not be built, `graphFailedReason` set at `3672` and
      `3703`, read through `measuringPathForTheItem`, `1579`)
      read as it is today. That register is this item's, and is cleared where this item's other registers are
      (`startWeb`, `2643-2645`), so it can never answer for another item. `zeroFrames >= ZERO_FRAMES_BEFORE_THEME`
      (`3773`) may no longer *by itself* end the third word while playing.
   2. **The behaviour.** On an item whose samples the browser will hand over, every all-zero analyser read is that
      item's **own silence**: the word stays `spectrum` for as long as the transport plays and the samples are this
      item's, and the reason line names the item's own silence — never a tainted cross-origin stream
      (`silenceReason`, `3784-3790`).
   3. **`theme` keeps its reach, unchanged.** The case where the stream genuinely is not handed over still reads
      `theme` while playing (the second run of `test/chip-word-browser.test.ts` covers it), so the legitimate
      statement is not deleted by this fix. Nothing is pinned or hidden: the word is recomputed from current facts
      on every status event.
   4. **No clock, no budget, no frozen word.** §515.1's rule (v1.9.24) holds: no elapsed-ms, retry, poll or frame
      budget is added as a term, and no word is frozen across a transition to keep a screen quiet.
   5. **Fail-before and green on the same cold repro, muted.** `docs/repro/t_13b5cca0/silent-passage-probe.mjs
      --fixture silent-gap` and `--fixture quiet-only` (headless Chrome, `--mute-audio`, no simulator). Before
      (fixed reverted): the shipped run's own record — `logs/verdict-silent-gap.json`, `theme` at `+10903 ms`.
      After: the silent-gap run's word sequence is `spectrum…` → `spectrum` for every read (`themeAtMs: null`)
      with the element playing and the analyser all-zero across the 5.000 s, and the `quiet-only` control's word
      sequence is unchanged (`spectrum…`, then `spectrum` across all 219 reads). Raw command output and both logs
      on the fix card.
   6. **Scope and release discipline.** Web path only: no native file, `test/engine-native.test.ts` untouched,
      §515.1's silence verdict and §515.4's word stand as the owner set them. Unreleased: no version bump, no tag,
      no artifact, `CHANGELOG.md`'s release heading untouched.
7. **What this entry does not decide, named so the next card confronts it instead of inheriting it.** (a) The
   native path's silence verdict (§515.1: this item's tap reading silence ends the third word) has the same shape —
   a reading with no energy spent as a verdict about the samples — and the tap has no equivalent *per-item read*
   fact; it is the owner's own call of 2026-10-16 and is deliberately **not** re-litigated here. (b) In the same
   family, `t_9c379c56`'s second finding (a suspended `AudioContext` reaching the capability word through the
   frozen rule, with no silent audio at all) is unrepaired and is not this entry's subject. (c) Post-fix,
   `docs/verification.md` §30.5.4's sentence (*"`theme` is still reachable while playing — by design, on an item
   whose own samples have answered"*) is true only in its narrowed sense — *answered that the browser will not hand
   them over* — and the fix's own record should say so rather than leave the wider reading standing.
8. **Nothing shipped, and nothing was implemented.** This card is a decision in writing: `DECISIONS.md` only, no
   version bump, no tag, no artifact, `CHANGELOG.md`'s release heading untouched, `src/` and `test/` untouched (the
   fix, with its fail-before proof, is card `t_4253898e`; the release that may carry it is a later card, per the
   owner's rule of 2026-10-16).

