# One player, one published state, one tap on it

Design for the NaviLite playback rearchitecture. Status: **design only** — this document changes no
code. Tree: `main` @ `10ee522`; delivered build `v2.0.0-beta.20` (87) @ `f136979`.

The owner, on that build: *"it seems to load then after 2 seconds or so manages to attach controls to
the song but the spectrum still remains dead."* Two players, one tap, and a set of flags that arbitrate
between them. The instruction that produced this document: *"let's scrap all this and go for the one
player architecture instead of putting more work into patching this spaghetti code. go clean up all
your junk and make sure everything that is initiated has a way to expire and nothing loops endlessly
so all exceptions are gracefully handled."*

The rule this design obeys, verbatim from the app's own spoken rules (`media-player-web-ui`, section
"Playback engine: exactly ONE, and both consumers read from it"): one engine plays, the clock and the
visualiser are both derived from it, the tap is installed once per item at creation and keyed to item
identity, and a published frame is not a measurement until it names the item that produced it.

---

## 1. The single owner

**Survivor: the `AVQueuePlayer` owned by `NaviliteRemote`** — constructed exactly once, at
`ios/App/App/NaviliteRemote.swift:2125` (`rebuildAwayQueue`, `:1896`). It is the only object in the
tree that can both make a sound and advance to the next entry while the web layer is suspended, and
the skill's suspend/resume rule ("the side that owns *next* must be the side that keeps running")
makes that non-negotiable.

**Deleted: the Capacitor native-audio plugin's own player** —
`@capgo/capacitor-native-audio`'s `AudioAsset`/`Plugin.swift`, whose player is constructed at the
anchor the repo already patches (`tools/patch-native-audio.mjs:127`:
`let player = AVPlayer(playerItem: playerItem)`). It is not merely unused: **the dependency is
removed from all three places it is declared** — `package.json:34`
(`"@capgo/capacitor-native-audio": "^8.4.32"`), the dynamic import at `src/player/native.ts:1122`
(`const { NativeAudio } = await import('@capgo/capacitor-native-audio')`), and the Swift Package
declaration at `ios/App/CapApp-SPM/Package.swift:16` + `:25`. The plugin's Swift then leaves the app
binary, and no build can construct its player.

On iOS this tree has exactly **two** players today, and this is the pair being reduced to one: the
queue at `NaviliteRemote.swift:2125` and the plugin's `AVPlayer` above. (The
`BackgroundAudio` plugin registered at `native.ts:1464` is the Android foreground service —
`start`/`stop` only, `:1703-1719` — and is not a player on either platform.) The plugin is also a
second writer of the lock-screen card through the `notificationMetadata` it is handed at
`native.ts:1515`; after S1, `publishCard` (`NaviliteRemote.swift:5119`) is the only writer.

Everything the plugin was load-bearing for is already ours or moves into `NaviliteRemote`:

| the plugin gave us | where it lives after S1 |
|---|---|
| decoding a URL into a playable item | `AVPlayerItem(asset:)` in the one factory — the three existing sites `NaviliteRemote.swift:1909`, `:2201`, `:2257` collapse into it |
| play / pause / seek | `queueTransport` (`NaviliteRemote.swift:3404`) — already exists, already handles lock-screen commands |
| lock-screen metadata | `publishCard` (`:5119`) — already exists and already writes `MPNowPlayingInfoCenter` |
| lock-screen transport | the `MPRemoteCommandCenter` handlers at `:524` (`next`) and `:533` (`previous`) — already ours |
| audio-session activation | `activateSession` (declared `native.ts` `NaviliteRemotePlugin`) — already ours |
| the surface the tap was installed on | the queue's own `currentItem`, which we constructed, so we hold it directly |

### Every call site of the plugin player, and where it becomes an intent on the survivor

Call sites are in `src/player/native.ts` (`NativeAudio` is the plugin handle). All sixteen, so the
S1 card does not have to search for a seventeenth:

| call site | what it does today | becomes |
|---|---|---|
| `:1122` `await import('@capgo/capacitor-native-audio')` | loads the plugin | **delete** — the dependency is gone |
| `:1123` `NativeAudio.configure({...})` | sets the plugin's audio mode | **delete** — the audio session is ours (`activateSession`) |
| `:1430` `addListener('currentTime')` → `events.onPosition` | the position feed | **delete** — `positionMs` rides the snapshot (§2) |
| `:1434` `addListener('playbackState')` → `events.onState` | the state feed | **delete** — `rate`/`state` ride the snapshot |
| `:1449` `addListener('complete')` → the JS end detector | the boundary's trigger | **delete** — the queue's own `endObserver` (`NaviliteRemote.swift:986`) is the native end fact |
| `:1515` `NativeAudio.preload({assetId, assetPath, isUrl, notificationMetadata})` | warm a slot; publishes Now Playing | **delete** — warming is the queue's own next items (`armAwayQueue` `:2118`, `topUpAwayQueue` `:2219`); the card is `publishCard` `:5119` |
| `:1510`, `:1529`, `:1980` `NativeAudio.unload({assetId})` | free a slot | **delete** — an entry leaves by leaving the queue |
| `:1944` `NativeAudio.play({assetId: slotName, time: 0})` | the *adopt* path | **delete** — there is nothing to adopt; the queue already holds the item |
| `:2162` `NativeAudio.play({assetId: audibleId, time})` | start the audible asset | `queueTransport({op:'play', index, positionMs})` |
| `:2183` `NativeAudio.pause({assetId})` | pause | `queueTransport({op:'pause'})` |
| `:2186` `NativeAudio.resume({assetId})` | resume | `queueTransport({op:'play'})` |
| `:2189` `NativeAudio.stop({assetId})` | stop / teardown | **delete** — a stop was a teardown of a second player; the queue is paused, never torn down per track |
| `:2202` `NativeAudio.setCurrentTime({assetId, time})` | seek | `queueTransport({op:'seek', positionMs})`, with ±0.5 s tolerance |
| `:2210-2212` `isPlaying`/`getCurrentTime`/`getDuration` | the truth probe | `snapshot()` (the player's own `currentTime`, `rate`, `currentItem.duration`) |
| `:2276` `spectrum.start({url, positionMs, assetId})` | install the tap by asking a plugin to find "the audible player" | **delete** — the tap is installed in the factory, at item creation (§3) |
| `:2292` `spectrum.stop()` | detach the tap | **delete** — nothing detaches a tap except the item's own `finalize` |
| `:2300` `spectrum.bands()` | poll a process-wide register | `snapshot()` in §2 |
| `:1587` `spectrum.configureBuffer(...)`, `:1610` `spectrum.warmSlot(...)` | buffer policy and warm handoff | folded into `makeItem` (`preferredForwardBufferDuration`, `automaticallyWaitsToMinimizeStalling = false`) and into `armAwayQueue` |

The intent surface already exists and is already called from the web layer: `queueTransport`
(`NaviliteRemote.swift:3404`, declared `native.ts:216`/`:541`) takes `'pause' | 'resume' | 'seek'` today
and is called from `engine.ts:2256`, `:2301`, `:2377`; `previous`/`next` are `previousAway` (`:1496`)
and `awayNext` (`:1554`). S1 adds exactly one op to that union (`'play'`, meaning start entry N at
position P) and moves the six remaining plugin calls onto it. No new bridge surface is invented.

Swift side, the arbitration functions that exist only because there are two players — all **delete**:

`pluginSoundingSlots()` `:3625` · `silenceOthers(except:why:)` `:3698` · `playSlot(entry:slot:time:how:token:)`
`:4440` · `appSoundingPlayer()` `:3170` · `appSoundingEntry()` `:3182` · `isSounding(_:)` `:3193` ·
`audiblePlayer()` `:3491` · `awayHoldsEntry(_:)` `:3481` · the reflective `AudibleBridgePlayer` in
`NaviliteSpectrum.swift` (the lookup at `:1000-1010` and its `find`/`player(_:from:)` members) ·
`awayOwnsAudible` (declared `:271`, 25 writes/reads) · `answeredOffer` `:265` + `armOfferDeadline()`
`:2651` + `settleUnreleasedOffer(_:)` `:2664` · `handoverTakeMs(for:)` `:2767` · `spendHandover(...)`
`:2804` · `handOverAwayQueue(why:fresh:)` `:2422` · `handover(_:)` `:2972` · `releaseHandover(_:)`
`:3057` · `abandonHandover(_:)` `:3449` · `returnReading()` `:2866` (rewritten as the snapshot, §2).

`queueIsSounding` and `queuePositionMs(_:)` (`:2755`) survive — they are reads of the surviving
player, and they stop being a *judgement about which player owns the sound*. `queueIsSounding`
becomes `player.timeControlStatus == .playing` with no second party to compare against.

### The one player, structurally: one item factory

The tap must be installed at item creation (§3), so **item creation must be one place**. Today it is
three (`:1909`, `:2201`, `:2257`). S1 collapses them:

```
private func makeItem(for entry: Entry, token: Int) -> AVPlayerItem?
```

It is the only caller of `AVPlayerItem(asset:)` in the app. It creates the asset
(`AVURLAsset`, precise duration read off the main thread), creates the item, sets
`automaticallyWaitsToMinimizeStalling = false` and `preferredForwardBufferDuration`, installs this
item's tap (§3), and returns it. A fourth construction site cannot appear without a reviewer seeing
`AVPlayerItem(asset:` in a diff — the grep below is the acceptance.

### Acceptance — the grep a later card runs

```sh
# 1. exactly one player construction in the whole Swift tree we ship
grep -rn --include=*.swift -E "AVQueuePlayer\(|AVPlayer\(" ios/App/App ios/App/CapApp-SPM node_modules/@capgo 2>/dev/null \
  | grep -v '^[^:]*:[0-9]*: *//'
#    after S1: exactly ONE line — ios/App/App/NaviliteRemote.swift:2125

# 2. the plugin is gone, not idle
grep -rn "@capgo/capacitor-native-audio" package.json package-lock.json ios/App 2>/dev/null   # 0 lines
grep -rn "NativeAudio\." src/ | wc -l                                                         # 0

# 3. exactly one item construction
grep -rn "AVPlayerItem(asset:" ios/App/App/*.swift                                            # 1 line, in makeItem

# 4. the browser's player is the only other one, and is web-only
grep -rn "new Audio(\|createElement('audio')" src/                                            # 1 line, inside `backend === 'web'`
```

Grep 1 is the structural claim: two players cannot sound at once because the second one's constructor
is not in the app any more. Greps 2–4 are the guards against it creeping back.

---

## 2. The published state

**One snapshot. One producer. One cadence.**

`NaviliteRemote.snapshot()` — one function, assembled from the surviving player and the current
analysis, under no lock that the audio thread touches (the analysis publishes an immutable frame; the
snapshot reads that reference).

| field | source | why the web layer needs it |
|---|---|---|
| `generation` | queue rebuild counter | a snapshot from a superseded queue is discarded, not rendered |
| `entry.songId`, `entry.index` | the queue's `currentItem` mapped through the published order | row, title, playlist position |
| `entry.url`, `entry.assetId` | the item that was made | identity for the palette/artwork path |
| `entry.key` | a stable per-item token minted in `makeItem` | **the item identity the spectrum frame is dated to** |
| `positionMs` | `player.currentTime()` of the queue | the clock — read, never written from a request |
| `durationMs` | the library's number, player's only when the library has none or the two agree (the Opus rule, `DECISIONS.md`) | progress |
| `rate`, `state` | `timeControlStatus` → `idle\|loading\|playing\|paused\|ended\|interrupted\|error` | the chip's word, from a total map |
| `queue.index`, `queue.count`, `repeat` | the published order the queue holds | `playing from {playlist} (x/y)` |
| `spectrum.bands[64]` | the current analysis' latest frame | the bars |
| `spectrum.itemKey` | the item that analysis was installed on | **the dating fact**: a frame whose `itemKey` is not `entry.key` is never drawn |
| `spectrum.frames`, `spectrum.lastAnalysisAt`, `spectrum.framePeriodMs` | **that item's own** counter and stamp | a real measurement vs a register that stopped |
| `spectrum.attached` | the analysis exists for that item | the honest null |

Cadence: **one** `setInterval` in the web layer, `SNAPSHOT_POLL_MS = 33` (`engine.ts:184` today as
`SPECTRUM_POLL_MS`), calling `snapshot()` and handing the whole thing to the consumers. It replaces,
in the same call, today's separate 33 ms `spectrum.bands()` poll (`:3325`), the 200 ms clock tick
(`CLOCK_TICK_MS`, `:186`, `:1010`) and the return reading. Fewer bridge calls than today, one cadence,
one producer. The canvas draws the last snapshot on its own `requestAnimationFrame` and holds the
last frame between polls — it never asks the bridge anything.

Consumers: the player bar, the now-playing screen, the canvas, and the lock-screen card (which keeps
`publishCard` `:5119`, now fed from the snapshot instead of from `awayOwnsAudible`). No consumer reads
a second source. There is no `taken`, no `offer`, no `answeredOffer`, no `adopt`, no `handover`.

**A return is a read.** Foreground/visibility events call `snapshot()` and render it. Nothing is
started, stopped, re-created or "adopted" on a return; the player was never interrupted by the app
(`engine.ts`'s `resume()` `:2287` loses its adopt/handover branches and keeps only session
reactivation + a read). That deletes the class the current build is in: there is no lag between "the
row arrives" and "the bars work", because both arrive in the same snapshot, dated to the same item.

---

## 3. The spectrum tap

Installed **once per item, at item creation, keyed to item identity**. Not on a state transition, not
on a "playing" report, never re-attached, never detached by a transport or a lifecycle path.

Today: `NaviliteSpectrum.start` (`NaviliteSpectrum.swift:968`) is called from JS
(`native.ts:2276`), finds the player reflectively (`AudibleBridgePlayer.find`, `:1000`), and
`attach(to:...)` (`:223`) begins with `detach()` (`:245`) — so **every install takes the tap off
whatever item was sounding**, waits up to `trackWaitSeconds = 5.0` (`:126`) for a track list, and is
guarded by a generation (`install(...)`, `:1041`). A background-created queue item never goes through
this path at all: `armAwayQueue` builds items at `:2201` and nothing asks the spectrum about them.
That is the shipped defect — the tap is on an item that is not sounding, and the frame register
answers zeros.

After S1:

- `makeItem` installs the tap as part of building the item, on the main actor, before the item is
  inserted into the queue (`insert`, `preroll`, `play` all happen after). The tap's track is resolved
  through the async property API off the main thread (never `tracks`/`tracksWithMediaType` on main —
  the `0x8BADF00D` class the skill documents).
- The install is **keyed to the item**, so a second call for the same item verifies and returns; there
  is no `start`/`verify` bridge surface left to call it from JS at all. `start`(`:968`), `stop`
  (`:1096`), `warmSlot`(`:1192`) and `configureBuffer`(`:1135`, folded into the factory) are deleted
  from the plugin's API; only `bands()`-equivalent (inside `snapshot()`) remains, and `bands()` itself
  goes when the snapshot takes over in S2.
- `installCount` / `verifyCount` (`:142`, `:146`) and the whole lifecycle-count bookkeeping go: there
  is nothing to install twice, so the counters measure nothing.
- **One analysis object per item** already holds this shape — `SpectrumAnalysis` (`:496`), handed to
  the tap as `clientInfo`, with its own ring, FFT, prepared flag and its own `DispatchSourceTimer`
  (`:580`, cancelled in `retire()` `:815`, `:829-830`). That is correct and stays; what changes is
  that the object is created by `makeItem` for *its* item, so an outgoing item's teardown cannot reach
  the incoming item's analysis. `currentAnalysis` (`:170`) stays as the "which item is this" pointer,
  not as "the one analysis for the process".
- The published frame carries **that item's** `frames`, `framePeriodMs` and `lastAnalysisAt`
  (`snapshot()` `:422` already publishes `itemFrames`/`itemFramePeriodMs`/`itemFrameAgeMs` — keep
  those) and its `itemKey`. `lifetimeFrames` (`:175`, `:424`, `:470-476`) is deleted: a
  process-lifetime counter read as "this item's tap has answered" is exactly the mistake the rules
  name.
- **No second decode.** Nothing opens the stream twice; the tap is on the audible item's own buffers.
  `engine.ts` may not construct an audio graph for visualisation in the native backend (it does not
  today — `METER_INTERVAL_MS`, `:281`, is a UI meter, not a decode).
- **No synthetic envelope**, and no silence-dependent comparator: `identicalNativeFrames`,
  `lastNativeChecksum`, `spectrumZeroPolls`, `spectrumPolls` (`engine.ts:3313-3317`, reset at `:2097-2110`, `:3030-3052`, `:3364` and the
  `pollSpectrum` body) are deleted. The drawing rule is the producer's own pace
  (`framePeriodMs`/`lastAnalysisAt`), per item — a tap slower than the poll is still live, and a
  quiet passage is not evidence of absence.
- Pause is a tap that keeps being called and yields nothing to draw. Detach happens in exactly two
  places, neither reachable from a transport or lifecycle path: item `finalize` (platform) and app
  teardown.

---

## 4. Expiry for everything initiated

The owner asked for this in the same breath as the rearchitecture. Every timer, retry, poll,
deadline, observer, task, session activation and listener in the playback path, with its owner and
its end. Anything without an expiry is deleted or given one in S3.

### Native (`NaviliteRemote.swift`, `NaviliteSpectrum.swift`)

| what starts it | owner | expiry / deadline | who cancels | what the user sees if it expires |
|---|---|---|---|---|
| fetch of a slot for a boundary (`:1976-2012`) | boundary path | `fetchDeadline = 12.0` (`:282`) | the fetch resolving, or the deadline | `advanceFailed` (`:1077`, `:5239`) → the row stays on the entry that is really playing, chip reads `error`, one retry per entry, never a loop |
| the "card" read after a boundary | `publishCard` | `cardDeadline = 12.0` (`:320`) | the read landing | the card keeps the previous item's metadata rather than a blank card; logged once |
| `cardWatchdog` `DispatchSourceTimer` (`:326`, `startWatchdog` `:4800`) | away-with-a-queue state only | `watchdogStep = 2.0`, started only in that state (`:776-778`) | `cancelWatchdog()` `:4816` on any other state | one `advanceFailed` repair; the watchdog fires once per token, not per tick |
| offer deadline (`armOfferDeadline` `:2651`) | return path | the deadline the offer arms | the answer, or `settleUnreleasedOffer` | **deleted in S1** — there is no offer |
| debounce (`:2028` `DispatchQueue.main.asyncAfter`) | per-start | one-shot, checks `current(token:)` on fire | nothing to cancel; the token guard is the expiry | the start is reported as superseded, not silently dropped |
| `endObserver` (`:986`), `failureObserver` (`:1000`) | the queue | lifetime of the plugin, removed at `:1011`/`:1014` | `removeObserver` | — (no expiry needed: bounded to the object) |
| `activeObserver` (`:4930`), session observers (`:4942`, `:4950`) | scene + audio session | removed at `:4976`/`:4980` | `removeObserver` | — (same) |
| tap install attempt loop (`NaviliteSpectrum.swift:1041`) | **deleted in S1** — install happens in `makeItem`, synchronously with item creation | — | — | — |
| `warmSlot` warm-up (`:944-948`, `warmStep 0.1`, `warmDeadline 6.0`) | **deleted** — warming is the queue's own items | — | — | — |
| `analysisTimer` (`:580`, `analysisIntervalMs 10`) | one per `SpectrumAnalysis` | cancelled in `retire()` (`:815`, `:829-830`), which is called from `finalize` | `retire()` | never outlives its item; a retired analysis publishes nothing |

### Web (`engine.ts`, `native.ts`)

| what starts it | owner | expiry / deadline | who cancels | what the user sees if it expires |
|---|---|---|---|---|
| `clockTimer` 200 ms (`:678`, `:1010`) | engine | merged into `SNAPSHOT_POLL_MS` in S2 | `clearInterval` `:1023` / `dispose()` | the clock holds its last value; the chip reads the snapshot's state word |
| `meterTimer` 100 ms (`:690`, `:4041`) | engine | stopped with playback | `clearInterval` `:4047` | — |
| `spectrumPoll` 33 ms (`:394`, `:3325`) | engine | **only while `backend === 'native'` AND the app is visible AND a consumer is subscribed** | `clearInterval` `:3359`, and S3 adds `visibilitychange` + `dispose()` | bars hold the last frame and the chip reads `paused`/`idle`; the poll never outlives the screen |
| start in flight (`START_DEADLINE_MS = 15000`, `:140`, timer `:978-981`, cleared `:958`) | `startNative` (`:2969`) | 15 s, one per start, `concludeStart` | `clearTimeout`, or the deadline | `state: error` + one honest sentence; no automatic re-start |
| seek (`SEEK_TIMEOUT_MS 1500` `:98`, `SEEK_VERIFY_TIMEOUT_MS 1000` `:112`) | seek path | per seek, single-flight, generation token | the read-back, or the deadline | the position snaps to the engine's own reading; the bar never shows a request the player refused |
| `TRANSPORT_MUTE_MS`/`SEEK_MUTE_MS` 1500 (`:82`, `:91`) | input suppression | 1.5 s | the next state change | — |
| `RESUME_CONFIRM_MS 300` (`:2335`) | resume | one-shot 300 ms | resolves | a resume that did not confirm reports `interrupted`, never hangs |
| `SPECTRUM_RECHECK_MS 5000` (`:220`), `SPECTRUM_ORPHAN_RECHECK_MS 1000` (`:204`) | spectrum | **deleted** — no re-install path exists to recheck | — | — |
| `PINNED_END_HOLD_MS 2000` / `NATIVE_END_SLACK_MS 900` | end detection | one report per end | the next track | a track that ends with no completion event advances once, at the watchdog deadline |
| `bounded`/`boundedSettled` (`native.ts:910-926`) | every bridge call | per call deadline, timer cleared at `:926` | the call settling | the call answers `unavailable`, never an unhandled promise |
| recovery loop `handover-refused` → `queue-handover` (36 ms) | **deleted in S2** — the shape being designed out | — | — | — |
| `requestAnimationFrame` (`visualizer.ts:159`, `:213`) | the canvas | bound to visibility + teardown | `cancelAnimationFrame` | the bars stop drawing; nothing accumulates |
| `removeRemoteCommands` listeners (`native.ts` `listenRemoteCommands`, `:2317+`) | engine | one registration per `attach`, one detach returned | the returned disposer / `dispose()` | a captured remote command is a no-op after teardown |

**Two gaps this table exposes, and S3 fixes:** `Engine` has no `dispose()` at all (the four
`clearInterval` calls are each inside one path, so a screen that outlives the engine keeps the meter
and the clock), and `spectrumPoll` is not bound to visibility. Both become one `Engine.dispose()` that
owns every handle the engine mints, plus a `visibilitychange` handler that stops the poll and keeps the
last snapshot.

**The loop shape, named so it cannot come back:** one attempt per entry per return, at most. Any
retry that can re-ask must either name a token that has since changed (and then stop) or carry a
deadline that ends it. A 36 ms `handover-refused` → `queue-handover` cycle is the anti-pattern: two
paths answering each other with no attempt counter and no owner.

---

## 5. Error paths

Every bridge call, fetch, decode and file write in the playback path answers a named failure state
and a user-visible consequence. No empty `catch`, no `try?` that swallows a transport error, no
promise left unhandled.

| operation | today | after |
|---|---|---|
| `snapshot()` (was `bands()`/`now()`) | `spectrumFrame()` swallows every error and returns `null` (`native.ts:2297-2313`) | answers `{ unavailable: '<reason>' }`; the chip reads `error`, one tooltip sentence names the step |
| transport intent (`queueTransport`) | `bounded(...)` deadline, some `console.warn`-only catches (`native.ts:2183`, `:2189`) | a refusal is a named result (`not_ready`/`post_end`/`superseded`); the UI paints the engine's own reading, not the request |
| item creation (`makeItem`) | three sites, mixed guards | returns `nil` with a reason: `no_track` (the asset has no audio track), `unplayable` (`item.status == .failed`), `superseded` (token moved). A boundary that gets `nil` falls to `advanceFailed` and stops at the entry that is playing |
| seek | `SEEK_TIMEOUT_MS` deadline, then a mute window | deadline answers `unsettled`; the bar repaints from the engine; one retry is allowed, a second is refused by the seek token |
| audio-session activation | `activateSession` catch → `{active:false}` (`native.ts:2236-2243`) | unchanged, plus the state word `interrupted` instead of a silent `paused` |
| Now Playing publish (`publishCard`) | `try?`-free today; a nil player is declined | keeps declining, and the snapshot's `state` still reaches the screen — the card and the screen cannot disagree |
| download/file writes | `NaviliteDownloads.swift` — HTTP status gate already correct | untouched; the queue treats a missing offline file as a fetch failure with the file's own reason |
| any bridge call | `native.ts` `bounded`/`boundedSettled` | unchanged mechanism, plus every call site must pass a *name* so the refusal reads in the log |

Rule for the review: a `catch` in the playback path either maps to a named state or is a bug. A
`try?` in the playback path is allowed only where the value is genuinely optional and its absence is
already a rendered state (e.g. artwork bytes).

---

## 6. The inventory to delete

Measured on `10ee522`. `wc -l` is the file's length; `vocab` is `grep -cE` over the arbitration
vocabulary that names the two-player machinery, which is the floor on lines the design removes from a
file that otherwise survives.

Vocabulary used for the count (reproducible, one command):

```sh
RE='handover|Handover|adopt|Adopt|awayOwnsAudible|awayQueue|awaySlot|awayItems|awayCursor|awayResume|awayPlan|armAwayQueue|awayStart|commitQueue|playSlot|pluginSoundingSlots|silenceOthers|audiblePlayer|appSoundingPlayer|queuePositionMs|queueIsSounding|WarmPool|warmSlot|answeredOffer|taken|offered'
```

| file | lines | vocab | verdict |
|---|---|---|---|
| `src/player/away-queue.ts` | 296 | 21 | **delete** — its three rules become `armAwayQueue`/`publish` behaviour in `NaviliteRemote`; the model file has no second implementation to describe any more |
| `src/player/audio-owner.ts` | 145 | 9 | **delete** — the whole file is the arbitration between two players; with one player there is no invariant to state, only a constructor |
| `src/player/warm-pool.ts` | 110 | 5 | **delete** — warming is the queue's own next items; a `songId → url` claim map describes a slot system that no longer exists |
| `src/player/engine-contract.ts` | 428 | 12 | **rewrite** — `path: 'adopt' \| 'handover'` (`:371`), `adoptions` (`:373`), `adoptOutcome` (`:285`) go; `PlayerEvent`, `reduce`, `PublishedTrack`, `VisualiserWord` stay |
| `src/player/engine.ts` | 4147 | 142 | **rewrite** — the native half of the state machine loses adopt/handover/offer/taken, the frozen-frame comparators, `verifySpectrum` (`:3820`) and `attachSpectrum` (`:3879`, called `:2119`, `:3196`); the web branch (`new Audio()` `:734`) stays |
| `src/player/native.ts` | 2564 | 148 | **rewrite** — `adopt()` (`:1883`), `adoptOutcome` (`:1226`), `handoverOf` (`:730`), `handoverAnswerOf` (`:761`), the slot lanes, and every `NativeAudio.*`/`spectrum.*` call site listed in §1 |
| `ios/App/App/NaviliteRemote.swift` | 5241 | 191 (arbitration-only regex) | **rewrite** — the queue survives; the arbitration (§1 list) and `returnReading` go. `awayPlan`/`armAwayQueue`/`awayStart`/`commitQueue` **stay** — they are the survivor's own advance, and deleting them would delete gapless advance |
| `ios/App/App/NaviliteSpectrum.swift` | 1548 | 10 | **rewrite** — `AudibleBridgePlayer`, `start`/`stop`/`warmSlot`/`configureBuffer` entry points, `lifetimeFrames`, install/verify counters; `AudibleSpectrumTap`, `SpectrumAnalysis` and the FFT stay |
| `node_modules/@capgo/capacitor-native-audio` (dependency) | — | — | **delete** — `package.json` entry + the registered plugin; not counted below because it is not this repo's source |

**Removal count.** Whole-file deletes: `296 + 145 + 110 = **551**`. Arbitration lines inside surviving
files: `142 + 148 + 12 + 191 + 10 = **503**`. Total **1054 lines removed or rewritten out** (a floor —
whole comment blocks that explain the deleted machinery go with it).

**Addition count.** One item factory (~60), the snapshot producer (~90), a transport-intent dispatch
table in `queueTransport` (~40), `Engine.dispose()` + the visibility binding (~35), named failure
states (~50), the test doubles that pin the new invariants (~80). **≈ 355 lines**, almost all inside
files that already exist.

Net: **≈ 700 lines fewer**, two files gone, one npm dependency gone, and one decision procedure gone
(the arbitration) — which is the point: the total goes down, and the defect class stops being
expressible.

---

## 7. The slice plan

Five slices, in this order. Each is one working tree, ≤60 tool calls, independently committable, and
buildable on its own (`npm run typecheck && npm test`, one iOS build where marked). Each slice's card
states "this card does not bump, tag or build a release".

**S1 — one player, and the tap on it.** *(must land together: a tap on a deleted player is the current defect)*
Delete `@capgo/capacitor-native-audio` (dependency, registration, the three `AudioAsset` calls), the
Swift arbitration list in §1, and the `spectrum.start/stop` entry points. Add `makeItem` (the one
construction site, with the tap installed inside it) and move `queueTransport`'s play/pause/seek onto
the queue. Accept: grep 1 of §1 prints exactly one line; grep 3 prints one; the build compiles; the
device checks are listed, not claimed.
*Parent: none. This is the slice that makes two players sounding at once structurally impossible.*

**S2 — one published snapshot; a return is a read.** Add `snapshot()` and the single 33 ms poll;
delete `now()`, `bands()`, `handover()`, `releaseHandover`, `abandonHandover`, `returnReading`,
`adopt()`, the `adoptOutcome` surface, `engine-contract.ts`'s `path`/`adoptions`, and the frozen-frame
comparators in `engine.ts`. Accept: `grep -rn "handover\|adopt\|taken" src/player | wc -l` = 0; a
foreground round trip issues exactly one bridge call (the snapshot).
*Parent: S1.*

**S3 — every initiated thing expires.** Add `Engine.dispose()` owning every handle; bind the poll to
visibility; add the attempt/deadline guard that makes the recovery loop inexpressible; delete the
offer deadline and the two spectrum recheck constants. Accept: the expiry table in §4 has no row
without a cancel path; a test that mounts/unmounts the player five times leaves zero live intervals.
*Parent: S2.*

**S4 — named failures.** Every `catch`/`try?` in the playback path mapped to a state; the chip's word
from the total map; one tooltip sentence per failure step. Accept: no empty `catch` in
`src/player/`, and a test per named state that asserts the word and the absence of a capability claim.
*Parent: S3.*

**S5 — subtraction sweep, web parity, guards.** Delete `away-queue.ts`, `audio-owner.ts`,
`warm-pool.ts` (or, if a slice needs one of them until the end, delete it here — never leave it
"unused"); make the `new Audio()` construction lazy behind `backend === 'web'`; add the four guard
tests from §1 as the suite's own assertions; update `DECISIONS.md` and `AGENTS.md`.
Accept: `npm run typecheck && npm test` green, the four greps green, and `wc -l` of `src/player/`
below its S0 number.
*Parent: S4.*

Rollback: each slice is one commit, and S1's diff is the only one whose revert restores a shipped
behaviour; the rollback point is tag `v2.0.0-beta.20` (`f136979`), which stays installable.

**What stays, and where it lives:**

| works today | where it lives after the design |
|---|---|
| gapless advance | the queue's own advance — `armAwayQueue` `:2118` / `awayStart` `:2278` / `commitQueue` `:2341`, untouched |
| background advance while JS is suspended | the same native queue — the reason the queue is the survivor |
| offline downloads | `NaviliteDownloads.swift` + `src/offline/` — untouched; the queue takes the same `url` resolution |
| lyrics | `src/ui` — untouched |
| the pager | `src/ui/pager` — untouched |
| Now Playing / lock screen | `publishCard` `:5119`, `MPRemoteCommandCenter` `:524`/`:533`, now fed by the snapshot |
| the browser build | `engine.ts`'s `new Audio()` (`:734`), constructed **only** when `backend === 'web'` — one owner per platform, never both |

---

## 8. What cannot be proved on this Mac

Marked device-only in every acceptance above:

1. **The audible gap** at the moment the plugin path stops existing. No simulator, no harness and no
   build log can say whether a return is gapless. Only the owner's phone, listening.
2. **True inaudibility of the removed path.** "There is only one player object" is a grep; "nothing
   else makes a sound" is an ear. The second half is device-only.
3. **Background survival** — advance while suspended, the lock-screen card, and the pause path — is
   the owner's install route and his phone; the app's own Info.plist is not proof either way.
4. **Whether the tap produces frames on the queue's items on the device.** In the simulator the audio
   path may not run the tap with the same buffer cadence (or at all); the per-item frame count is the
   reading, and it has to be read on the phone.
5. **Whether a `WKWebView` `HTMLAudioElement` with no `src` is inert** (the reason S5 moves
   `new Audio()` behind `backend === 'web'`). Presumed inert, not proven inert; the change is cheap
   and the claim stays unproved until the phone says so.
6. **Press-to-sound latency after the rearchitecture.** Measurable as a number only on the device.

What this Mac *can* prove, and the slices must: the greps in §1, `npm run typecheck`, the test suite,
one iOS build per slice that touches Swift, and the removal/addition counts (`wc -l`, `git diff --numstat`).
