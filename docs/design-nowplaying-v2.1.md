# The native player — why beta.12 did not fix it, and the smallest design that does

Scope: asks A–D from the owner's report on 2.0.0-beta.12 (build 60). Diagnosis against
`d63f535`, the vendored plugin in `node_modules/@capgo/capacitor-native-audio` **as patched by
`tools/patch-native-audio.mjs`** (patches 1–10 applied; the file is post-install state, so the
line numbers below are the patched ones).

Nothing here was built, run on a device, or exercised against a Navidrome. Every claim below
is marked **[proven from the code]**, **[proven from the absence of code]**, or
**[unverified — needs the phone or Mugger's research]**. Mugger's card
("establish how iOS 18 governs the Now Playing module") had not landed
`docs/research-nowplaying-v2.1.md` when this was written; the one place its answer would change
the design is marked.

---

## 0. The verdict, in one paragraph

The shape of this bug is **one media session run by two owners that never compare notes, and a
card that describes a state nobody is in**. beta.10/.11/.12 each fixed one *writer* of
`MPNowPlayingInfoCenter` (stop nil-ing it here, stop deactivating the session there) and left the
**content** of the card — which is what the island and the lock screen actually render — being
written by whichever of two writers ran last, with `rate 0.0`, `duration 0`, no artwork, and
`currentlyPlayingAssetId == nil` for the whole of the gap. So the system is told, at every track
boundary and for as long as the next stream takes to fill, that nothing is playing. The island
believes it. That is A, and it is also most of C and D; B is a separate, real defect (nothing
preloads the next stream's *bytes*) that makes that "nothing is playing" window seconds long
instead of milliseconds.

Deleting the split is the fix: **one writer for the card (ours), one owner of the session (the
plugin's, never contested), one place that decides a boundary (the existing one), and one new
duty — keeping the card true for the whole 1–2 s after a boundary instead of for 0.75 s.**

---

## 1. Root cause per ask

### A. The card disappears between songs

Three mechanisms, in the order they matter. The first two are beta.12's own patch surface; the
third is why the patches could not be enough.

**A1 — our writer publishes "paused" during exactly the window in question. [proven from the code]**

`ios/App/App/NaviliteRemote.swift:1003`

```swift
info[MPNowPlayingInfoPropertyPlaybackRate] = player.timeControlStatus == .playing ? 1.0 : 0.0
```

`publishCard()` runs synchronously from `commit()` (line 699) the instant the boundary's `play:`
has been issued, and the item is not yet `.playing` then — it is `.waitingToPlayAtSpecifiedRate`,
and on a cold Navidrome transcode it stays there for the whole of the gap. So the first card after
a boundary says **rate 0**. The vendor's own `play` writes `1.0` (`Plugin.swift:1715`,
`updatePlaybackState(isPlaying: true)` at `:957`), but it runs on a `DispatchQueue.main.async`
queued by `play:` *before* our synchronous write in the same turn — so ours lands **after** the
vendor's, and is the last word.

**A2 — and the disagreement is never corrected, because the refresh ladder stops early.
[proven from the code]**

`refreshNowPlaying()` → `stepCard()` (lines 876–893) keeps writing every `cardStep = 0.25 s` but
only while the duration is unknown:

```swift
let known = self.publishCard()
if known && waited >= Self.cardGrace { return }   // cardGrace = 0.75
```

`publishCard()` marks the card "known" as soon as the item has a duration (line 998), which for a
preloaded item happens **before** playback starts. So the ladder is guaranteed to stop at ~0.75 s
after every boundary — which on a slow start is still inside `.waitingToPlayAtSpecifiedRate`.
Nothing writes the card again until the *next* boundary. Result: the card can sit at **rate 0,
frozen elapsed time, dead progress bar for the whole track** while audio is playing. The owner
sees a player that stopped following the music and then "came back" or vanished; he calls it
disappearing.

**A3 — the vendor's write is a wholesale replacement, so our card and its card are never the same
card. [proven from the code]**

`node_modules/.../Plugin.swift:1668–1718`, `updateNowPlayingInfo(audioId:audioAsset:)`:

```swift
var nowPlayingInfo = [String: Any]()          // 1672 — a FRESH dict
... title / artist / album from notificationMetadataMap ...
nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = audioAsset.getDuration()   // 1713 — 0 for a fresh slot
nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = 1.0                       // 1715
MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo                // 1717 — replace, not merge
```

It is called on **every** `play:` (`:955–957`) — i.e. once per track boundary, which is exactly
the moment under investigation — and it silently drops everything it did not build: our
`MPNowPlayingInfoPropertyExternalContentIdentifier`, the artwork, and (below) the whole art path.

**A4 — the patches beta.12 shipped were aimed at `nil`, and there is no longer a `nil`.
[proven from the absence of code]**

After patches 8/9/10, `grep 'clearNowPlayingInfo()\|nowPlayingInfo = nil'` over the patched
`Plugin.swift` leaves only:

- `:227` — inside `handlePlaybackCompletion`, guarded by `if !showNotification` (patch 9);
- `:895` — the `AVAudioPlayer`-channel path (`audioPlayerDidFinishPlaying`), not our transport;
- `:1634` — `deinitPlugin`.

and the only `setActive(false)` at a boundary is `:858` in `endSession()`, guarded by
`!self.showNotification` (patch 8; `showNotification: true` is set at
`src/player/native.ts:680`). So the code that *removed* the card is gone — and the card still goes.
It goes because it is being *published false*, not because it is cleared. This is the sentence the
next release has to be built around.

**[unverified — needs the phone, or Mugger] What the system does with a card that reports
`rate 0`, no playing asset and no art while the app is in the background.** Documented iOS
behaviour is that the media module belongs to the app that is the "now playing" app, and that
app is the one with an *active, playing* playback session; the Dynamic Island compact
presentation in particular is not a persistent widget. I could not prove from this repo which of
"module collapses" / "module shows paused" / "session torn down" happens on iOS 18.
**The design in §2 deliberately does not depend on which one it is**: it makes the card say
*playing* within one second of the boundary and for the whole gap, and it repairs a lost card on a
1 s timer rather than on the next track boundary. If Mugger's document shows a different lever
(e.g. a required `MPNowPlayingInfoPropertyMediaType` or an `MPNowPlayingInfoLanguageOptionGroup`),
it plugs into §2.3 without changing anything else.

### B. The gap between songs is seconds long

**B1 — the preload never asks AVFoundation for a byte of media. [proven from the absence of code]**

`preloadSlot()` (`NaviliteRemote.swift:753–776`) and the app's own `fillSlot`
(`src/player/native.ts:905+`) both call the plugin's `preload`, which builds the asset and stops:
`RemoteAudioAsset.swift:25–48` creates `AVURLAsset`, one `AVPlayerItem` and one `AVPlayer` per
channel, sets `automaticallyWaitsToMinimizeStalling = false` (line 39, patch `ios-start-eagerly`),
and **nothing else**. `grep -rn preroll` over the entire vendored plugin returns **nothing**: no
`preroll(atRate:)`, no `prepareForPlayback`. An `AVPlayer` with an item does not prefetch media
data until playback (or `preroll`) is requested — it resolves the asset's playable keys and
parks. So `item.status == .readyToPlay` in `awaitReady()` (line 663) is true while the buffer is
empty, the readiness poll passes immediately, and the boundary's `play` starts a fresh HTTP
connection and a fresh Navidrome transcode fill. That is the gap the owner hears.

**B2 — beta.11's patch removed a seek, not the fill. [proven from the code]**

`tools/patch-native-audio.mjs:268–278` (`ios-play-zero-skip-seek`) only avoids
`player.seek(to:)` when already at 0:00. A seek on an empty buffer is not the seconds of silence;
the absence of data is. The patch was necessary (the seek flushed whatever the item had) and it was
credited with the fill it never addressed.

**B3 — the vendor already owns a fade mechanism, and it is not the right one here.
[proven from the code]** `RemoteAudioAsset+Fade.swift` gives `playWithFade`, `stopWithFade`,
`setVolume(_:fadeDuration:)`. A crossfade requires starting the next track *before* the current one
ends — `AVPlayerItemDidPlayToEndTime` is too late by definition — so a fade alone cannot close the
gap. It becomes useful only on top of a primed player (§2.4).

### C. No album art

**C1 — for a downloaded track, the URL handed to both writers is unreadable by both.
[proven from the code]**

The chain, end to end:

- `src/state/queue.ts:893` and `:998` — `artworkUrl: this.library.coverUrl(...)`;
- `src/state/library.ts:76–78` — `coverUrl` prefers `resolveOfflineArt(...)`, which is
  `OfflineStore.artPathFor` (`src/state/offline.ts:704–713`), returned through `toLocalSrc`;
- `src/ui/app.ts:171` — `toLocalSrc: localFileSrc`, and `src/player/native.ts:1747–1757` is
  `Capacitor.convertFileSrc(path)` → on iOS a **`capacitor://localhost/_capacitor_file_/…`** URL;
- `src/player/native.ts:574–589` — `toAbsoluteArtworkUrl` sees an absolute scheme and returns it
  **unchanged**, so that string is what goes into the `setQueue` entry and the `preload` metadata.

Then both loaders reject it:

| loader | `URL(string:)` | `isFileURL` | http? | result |
|---|---|---|---|---|
| ours, `NaviliteRemote.swift:928–955` | ok | false | `scheme == "capacitor"` → false | falls out of the `if`/`else if`, lands on `FileManager.fileExists(atPath: "capacitor://localhost/_capacitor_file_/…")` → false → **gives up, permanently** |
| vendor, `Plugin.swift:1780+` | ok | false | `url.scheme == nil \|\| url.isFileURL` → false → treated as **remote** | `URLSession.dataTask(with: capacitor://…)` → fails |

Both writers therefore produce nothing, for every track that is downloaded, for ever. The vendor
*can* read a plain path or a `file://` URL (`scheme == nil || isFileURL` → `UIImage(contentsOfFile:)`);
ours can read `file://` too. **The information needed is already in the app** — `offline.ts:713`
builds the path from `row.path`, an absolute container path — it is the `convertFileSrc` hop, added
so the *web view* can read the file, that destroys it for the *native* side.

**C2 — for a streamed track the art is fetched, then overwritten. [proven from the code]**

The URL is `http(s)` and both loaders can fetch it, but the vendor's `updateNowPlayingInfo` at every
`play` replaces the dict without artwork (`:1717`) and re-adds it asynchronously, gated on
`currentlyPlayingAssetId == targetAudioId` (`:1694`, `:1698`). Ours re-adds it from
`artworkCache` on the next card rung (`:980–984`) — but the rungs stop at 0.75 s (A2), and the
first fetch takes longer than that on a cold cache. So the art appears only if a *later* statement
or boundary happens to rewrite the card while the cache is warm. Consistent with the owner's "no
art", intermittently.

**C3 — `preloadAhead` loads art for the wrong reason and too late. [proven from the code]**
`NaviliteRemote.swift:716` calls `loadArtwork(for: entry)` for the *next* entry after the audible
one, and `publishCard` calls it lazily for the current entry (`:983`) — i.e. art is requested at
the moment the card needs it. It should be requested when the queue is stated.

### D. Tapping the module does not bring Navilite back

**D1 — beta.12's URL-scheme work cannot be the mechanism. [proven from the absence of code]**

`Info.plist` now registers `navilite` and `app.navilite`, and `AppDelegate.swift` forwards
`application(_:open:options:)` to `ApplicationDelegateProxy`. Nothing in the app ever *sends* one
of those URLs, and nothing in the render path reads the forwarded one. The Lock Screen / Dynamic
Island media module is system UI: the tap is handled by SpringBoard, which brings the **now playing
app** to the foreground. There is no URL, notification, or delegate callback in that path for an
app to receive, register against, or break. Those two changes are inert with respect to D — they
are harmless, and they should not be counted as the fix in the release note.

**D2 — what actually decides it: the app must still be the now-playing app at the moment of the
tap. [proven from the code, and one unverified consequence]**

The app is the now-playing app while it has published `MPNowPlayingInfoCenter` info **and** holds an
active playback session. Both of those are exactly what A1–A4 and B are damaging: during the gap the
card reports rate 0 and no playing asset, and the fill is a cold start. The app is otherwise correct
here — `UIBackgroundModes: audio` is declared (`ios/App/App/Info.plist:44–47`), so the process stays
alive while it plays, and `showNotification: true` is configured.

The one thing the app is *missing* is a re-take on return. `grep` over `AppDelegate.swift`,
`SceneDelegate.swift` and `ViewController.swift` finds **no** lifecycle override at all: nothing
calls `activateSession()` or republishes the card when the app becomes active again after a
suspension, an interruption, or a call. Navilite only re-takes the session when the web layer
happens to call it, and only re-writes the card at the next `setQueue`/`commit`. So after any
session loss, the app can be running with a card that no longer belongs to it — which is the state
in which a tap goes nowhere or the module is gone. **This is the app-controllable half of D and it
is a real, fixable gap.**

**D3 — `MPNowPlayingInfoCenter.playbackState` is macOS-only. [confirmed against Apple's header/doc
as cited in the brief; unverified here only in the sense that this repo has no SDK copy to grep]**
So there is no explicit "I am playing" flag on iOS: the rate in the info dictionary **is** the flag.
That makes A1/A2 not a nicety but the whole of D on the app side.

---

## 2. The design

Priority order. Each step is independently shippable; steps 1–2 are what the owner will feel, 3 is
what makes it survive a suspension, 4 closes C, 5 closes B.

### 2.1 One writer: ours, and it merges. [A3]

**Vendor patch 11 — `ios-nowplaying-merge`**, `tools/patch-native-audio.mjs`.

Anchor (`Plugin.swift:1715–1717`, exact text):

```
            nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = 1.0

            MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
```

Replacement: merge into the existing dictionary, never shrink it, and never write a duration it
does not have:

```
            nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = 1.0

            // <marker>: merge, never replace — the artwork, the external content id and the
            // duration on this card are written by the app's own writer, and a wholesale assign
            // here is what dropped them at every track boundary.
            var merged = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
            if let duration = nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] as? Double,
               duration <= 0 {
                nowPlayingInfo.removeValue(forKey: MPMediaItemPropertyPlaybackDuration)
            }
            for (key, value) in nowPlayingInfo { merged[key] = value }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = merged
```

Why merge at the vendor rather than delete its writer: `updateNowPlayingInfo` is also the only
writer for the paths that never reach `NaviliteRemote` (a `playOnce`, the web engine on a
platform without the boundary plugin). Deleting it would be a bigger blast radius than making it
non-destructive. After this patch the *content* rule is: nobody removes a key; `NaviliteRemote` is
the only writer that adds artwork, `ExternalContentIdentifier`, and a corrected duration.

### 2.2 The truth about playing. [A1, A2, D3]

`ios/App/App/NaviliteRemote.swift`, two changes, both small:

1. **`publishCard()` must not report paused for a slot that has been asked to play.**
   Introduce `private var requestedPlaying: Bool` set `true` in `playSlot()` immediately after
   the `play:` call and `false` only from an explicit pause/stop path (there is none today — say so
   in a comment rather than inventing one). Then:

   ```swift
   let rate = player.timeControlStatus == .playing || (requestedPlaying && player.timeControlStatus != .paused) ? 1.0 : 0.0
   info[MPNowPlayingInfoPropertyPlaybackRate] = rate
   ```

   `.waitingToPlayAtSpecifiedRate` is *playing as far as the listener is concerned*: he pressed
   play, the app asked for it, audio is coming. Reporting 0 there is the bug.

2. **The ladder must run until the player agrees, not until the duration is known.**
   `stepCard`'s stop condition becomes `known && rate == 1.0 && waited >= cardGrace`, and
   `cardDeadline` goes from `8.0` to `15.0` (line 198). The cost is bounded — one dict write per
   250 ms for at most 15 s after a boundary, on the main thread, with the duration already
   resolved (the synchronous-`duration` hang fixed in v1.9.11 is not reintroduced: the guard at
   line 998 keeps the read behind `.readyToPlay`).

   This single condition is what keeps our write as the last one through the whole gap and into
   the first second of sound.

### 2.3 One owner of the session, and a card watchdog. [A, D2]

`ios/App/App/NaviliteRemote.swift` (and nothing in the plugin):

1. **A 1 s watchdog while a queue is published and the app is away.** A `Timer` (or the existing
   `after()` chain) started in `setQueue` when `awake == false` and stopped in `detach`/`setQueue`
   with `awake == true`. Each tick, under the generation token:
   - if `MPNowPlayingInfoCenter.default().nowPlayingInfo == nil` **or** the title does not equal
     `queue[index].title` **or** `nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate]` disagrees
     with the audible player's state → `refreshNowPlaying()`;
   - if `AVAudioSession.sharedInstance().isActive == false` → `try setActive(true)`.

   This is the part of the design that does not need Mugger's answer: whatever iOS did to the card,
   it is repaired within a second, and the repair is idempotent (it writes the same dict when
   nothing is wrong). Cap it: only while `!awake` and `index >= 0`, so a foregrounded app or a
   stopped queue costs nothing.

2. **Re-take on return to the foreground.** Add to `SceneDelegate.swift`
   (`sceneWillEnterForeground` / `sceneDidBecomeActive`) a call into `NaviliteRemote` (a static
   entry, e.g. `NaviliteRemote.applicationDidBecomeActive()`) that does
   `setActive(true)` + `refreshNowPlaying()` when a queue is published. `activateSession()` is
   already idempotent and documented as the fix for "playback looks fine but the controls do
   nothing" after a return; the card needs the same treatment and does not have it today.

**Do not** add `MPNowPlayingInfoCenter.default().playbackState` — macOS-only, it will not compile
for iOS or will silently do nothing.

### 2.4 Album art, from a path the native side can open. [C1, C2]

1. **Hand over a filesystem path, not a `capacitor://` URL.**
   `src/player/native.ts` — in `toAbsoluteArtworkUrl`'s siblings, add the inverse of
   `localFileSrc` (`:1747–1757`): a `toNativeArtworkPath(url)` that maps
   `capacitor://localhost/_capacitor_file_/…` → percent-decoded path. Use it at the two places
   that cross into native (`:895` for `preload` metadata, `:1041` for the queue statement), not in
   the web paths. Simpler and better, since `offline.ts:713` already has the raw path: add
   `artFilePathFor(coverArtId)` to `OfflineStore` returning `${dir}${art.file}` **before**
   `toLocalSrc`, and have `queue.ts:893`/`:998` pass a value that carries both — the web keeps the
   `convertFileSrc` form, native gets the path.
2. **Teach our loader all three forms.** `NaviliteRemote.loadArtwork` (`:928–955`): accept
   `file://` (`url.isFileURL` — already there), a plain path (already there), **and** strip a
   `capacitor://localhost/_capacitor_file_` prefix and percent-decode before
   `FileManager.fileExists`. The vendor then needs nothing: `Plugin.swift:1780+` already reads
   `scheme == nil || isFileURL`.
3. **Fetch art when the queue is stated, not when the card needs it.** In `setQueue`, after the
   entries are stored: `queue.forEach(loadArtwork)` for the playing entry and the next two (the
   `fetchingArtworkSongIds` set already prevents duplicates, and `artworkCache` is bounded at 50
   with a prune against the active queue at `:913–918`).
4. **Art must survive a vendor write** — that is §2.1, and it is why 2.1 is first.

### 2.5 The gap: prime the preload. [B1, B3]

The plugin already has the transport for this and no way to ask for it. Two vendor patches:

**Vendor patch 12 — `ios-preroll`**, `RemoteAudioAsset.swift`. A method on the asset, placed next
to `play(time:volume:)` (anchor: `    override func play(time: TimeInterval, volume: Float? = nil) {`),
inserted **before** it:

```swift
    /// <marker>: load the media data without starting it, so the boundary's `play` has bytes to
    /// render instead of a connection to open.
    func prerollForBoundary() {
        owner?.executeOnAudioQueue { [weak self] in
            guard let self else { return }
            for player in self.players {
                player.preroll(atRate: 1.0) { _ in }
            }
        }
    }
```

**Vendor patch 13 — `ios-preload-preroll`**, `Plugin.swift`. In `preloadAsset` (the function
`preload(_:)` delegates to at `:554–556`), after the asset has been registered in `audioList`, and
**only when asked**:

```swift
            // <marker>: only the entry the app is about to play is primed — priming the whole warm
            // pool would starve the audible stream for bandwidth.
            if call.getBool("preroll") == true, let remote = self.audioList[audioId] as? RemoteAudioAsset {
                remote.prerollForBoundary()
            }
```

Callers:

- `NaviliteRemote.preloadSlot(plugin:slot:entry:)` (`:753–776`) gains `preroll: Bool` and passes
  `"preroll": true` **only** from `preloadAhead` (the immediate next entry) and from nothing else.
- `src/player/native.ts` `fillSlot` / `prepare` — pass `preroll: true` for the **nearest** warm
  only (the next track), `false` for the previous and the one after next. The lane discipline
  (`createAssetLanes`, `:889`) already serialises these; priming adds no new writer.

**Why `preroll` and not "start it at volume 0".** Starting a player at volume 0 would also fill the
buffer, and it can be made a true gapless swap by setting the volume at the boundary — but it puts a
second player in `play` state, which is exactly what makes `currentlyPlayingAssetId`, the position
timer and `notifyPlaybackState` name the wrong track (the invariant `playSlot`'s comment at
`:779–800` exists to protect). `preroll` fires no notifications, claims nothing, and is invisible to
the plugin's bookkeeping. **If the phone shows the filler still too slow on a transcode**
(plausible: `preroll` stops at "likely to keep up", not at "N seconds buffered"), the escalation is
step 2 — un-mute a primed player ~3 s before the end, driven by the §2.3 watchdog, and let the
boundary be a `setVolume` swap instead of a `play`. That is a real crossfade and the vendor's
`setVolume(volume:fadeDuration:)` / `stopWithFade` already provide the ramp. It should be built
only if `preroll` measurably fails, because it is the version that can desynchronise the bookkeeping.

---

## 3. What must NOT change

- **The boundary owner stays as it is.** `NaviliteRemote` acts only when `awake == false`
  (`itemDidEnd`, `:447`); the web layer owns the boundary while the app is on screen. Every new
  timer in §2.3 carries the generation token and the `!awake` guard, or two owners come back.
- **The statement discipline** — `generation` / `current(token:)` checked in the same turn as the
  call it guards (`:860`, and the play at `:802–834`). The watchdog is a new actor on the card; it
  must not become a new actor on the *queue*.
- **`players: [AVPlayer]` reflection.** `NaviliteSpectrum` and `AudibleBridgePlayer` find the
  audible player by reflecting `players` on the asset; the plays keep going through the plugin's own
  `play:` so `currentlyPlayingAssetId`, the position timer and `notifyPlaybackState` stay true. Do
  not "simplify" a play into a direct `AVPlayer.play()`; that is the bug the file's header is
  about. `preroll` is the one legitimate direct touch, and it is why it was chosen.
- **The offline transport patches** (5 `ios-file-transport`, 6 `ios-single-decode`) and the whole
  offline art path: a downloaded track must keep playing and keep showing art with no network.
  §2.4 changes *which string* crosses into native, never the web view's `convertFileSrc` path.
- **The `reason` strings the owner reads** (`reason` on `now()`, and the `advanceFailed` payload).
  New states need new sentences — e.g. a card that had to be repaired on the watchdog is worth
  naming — not silence, and not a rewrite of the existing ones.
- **`showNotification: true`** in `src/player/native.ts:680`. Patch 8's entire session behaviour is
  conditional on it; turning it off would deactivate the session at every boundary.

---

## 4. How each ask is shown to be fixed without a phone

Cheap, in the repo, no device and no audible harness:

- **The patches still bite.** `npm run patch:native` exits 0 and prints 13 `applied` lines. It
  already fails loudly on a moved anchor (`tools/patch-native-audio.mjs:59–62`) — that is the
  regression net for patches 11–13. **(proves: the vendor edits land at build time)**
- **Type level.** `npm run typecheck` (the TS half of §2.4). **(proves: the native handoff compiles
  and the artwork-path function is used at both crossing points)**
- **One targeted test file, no suite.** A test for `toNativeArtworkPath` over the three forms
  (`capacitor://` from `convertFileSrc`, `file://`, plain path) and for `toAbsoluteArtworkUrl`
  unchanged for `http(s)` — the C1 regression is a pure string function and can be proven here.
- **The built IPA's bytes, once someone builds it** (not this card):
  `strings Payload/App.app/App | grep -c "the native player was asked for"` and the new reason
  sentences prove the new Swift is in the binary; `PlistBuddy -c 'Print :CFBundleShortVersionString'`
  proves the version. `strings` **cannot** show the vendor markers (they are comments and they are
  compiled away) — so the proof for §2.1/§2.5 is the patch script's exit 0 plus its output, and
  that must be quoted in the release note rather than implied.
- **The simulator** (no audio device needed, no fleet noise): the Now Playing card and the Dynamic
  Island can be observed with a queue stated and the app backgrounded, on a local file to remove
  Navidrome from the picture. What it can show: the card exists through the boundary, art renders,
  the rate reads 1.0 during the gap, tapping the module foregrounds the app. What it cannot show:
  anything about a live Navidrome transcode's fill time, and nothing about how the *phone's* island
  animates.
- **Owner only, stated plainly:** that the gap feels short on his data, and that tapping the module
  on his device opens Navilite. Both are subjective/system-owned; the app-side preconditions for
  them are what §2 can prove. If Mugger's document lands with a different system lever for D, this
  document's D section should be corrected and §2.3 kept — the watchdog and the lifecycle re-take
  are correct regardless of what the system does.

---

## 5. Order of work, and what "done" means

| # | change | closes | size |
|---|---|---|---|
| 1 | vendor patch 11 (merge, never replace) | A (content), C2 | one anchored patch |
| 2 | `publishCard` rate rule + ladder stop condition + `cardDeadline` | A, D3 | ~10 lines in `NaviliteRemote.swift` |
| 3 | watchdog (1 s) + `sceneDidBecomeActive` re-take | A, D2 | one timer, one delegate hook |
| 4 | native artwork path (both directions) + art fetched at `setQueue` | C | one string function, two call sites, one loader branch |
| 5 | vendor patches 12–13 (`preroll`, opt-in) + `preroll: true` for the next entry only | B | two anchored patches, one call site |

Steps 1–3 alone should make A and D true on the phone even if the exact dismissal rule is still
unknown; 4 and 5 are independent and do not need to ride in the same build. Nothing here requires
touching the audio session's category, the boundary owner, or the web layer's paths.
