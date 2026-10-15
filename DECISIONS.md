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
