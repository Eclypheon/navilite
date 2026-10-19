import AVFoundation
import Capacitor
import Foundation
import MediaPlayer
import UIKit

/**
 * Navilite's own lock-screen remote commands, the audio session's re-arm, and — since v1.9.8, and
 * **for the whole queue since v1.9.9** — the track boundary itself while the app is not running.
 *
 * Why the file exists at all (v1.7): playback on iOS is AVFoundation, driven by
 * `@capgo/capacitor-native-audio`, which sets the `AVAudioSession` to `.playback`, activates it,
 * publishes the Now Playing card and targets `MPRemoteCommandCenter` — for **play, pause, stop,
 * toggle, skip-15s and scrub**. It does not enable `nextTrackCommand` / `previousTrackCommand`, so a
 * lock screen driven by that plugin alone has no next/previous buttons. Those two buttons are what
 * this plugin added first, and — since v1.9.10 — the Now **Playing** card as well (see the v1.9.10
 * section below), because the vendor's own writer publishes a duration in the same turn as the play,
 * before the item has one, and never comes back to correct it. It still never touches the session
 * *category*: two writers on the session is exactly how the transport goes dead.
 *
 * `activateSession()` is the second half: after a call, Siri, or another app taking the session, iOS
 * deactivates ours, and re-activating it is the documented fix for "playback looks fine but the
 * controls do nothing" after a return to the foreground. It only calls `setActive(true)` — it never
 * changes the category, so it cannot undo what the audio plugin set up.
 *
 * ## v1.9.9 — the queue is published here, and this side walks the whole of it
 *
 * v1.9.8 gave this file a "chain": the two warm slots the app happened to hold after the one that
 * was playing. It was the right idea with a cap in it, and the cap is what the owner found: the
 * chain was built by JavaScript, JavaScript is suspended the moment the app is not on screen, and
 * the chain was therefore never refilled. After two track ends with the app away it ran out, said
 * `advanceFailed`, and the music simply stopped — however long the phone stayed in his pocket.
 *
 * So this side is no longer told "these two slots follow"; it is **given the queue**. `setQueue`
 * states the app's resolved play order — every entry, with the asset the app already holds for it
 * when it holds one — the index that is playing, the repeat mode, and whether the web layer is
 * running. This file then owns, while the app is away:
 *
 *   - **the index**: which entry is playing (JS is told about every move, and re-states the index
 *     whenever it is awake);
 *   - **the next item**: it takes a track end by itself, preferring the slot the app already warmed
 *     for that entry, and **fetching the entry's own URL here when nothing holds it** — preloading it
 *     through the audio plugin and playing it once the item is `.readyToPlay`. That is the answer to
 *     "no boundary may be uncrossable": n entries, n boundaries, however long the app is away, and
 *     every one of them is either a slot play or a fetch this side does itself;
 *   - **the look-ahead**: after each boundary it preloads the entry that follows into its own window
 *     slot, so the next boundary is a play rather than a fetch;
 *   - **backtracking**: `previous` is `index - 1` over the same published list, re-fetching that
 *     entry if its slot is gone (there is no back queue, and there does not need to be — the list is
 *     the history). At index 0 it restarts the current track.
 *
 * Four rules keep it safe:
 *
 *   - **it only acts with the app off screen** (`awake: false`), which is the one state in which the
 *     web layer cannot act at all. With the app on screen the WebView owns the boundary exactly as it
 *     always has, so the two can never both advance a track;
 *   - **a play is only ever issued on an item that is `.readyToPlay`** (v1.9.9) — the property
 *     `preroll` raised on and the one 1.9.8 shipped without. A slot that is not ready yet is waited
 *     for, with a deadline, and a slot that failed is reported as a failed boundary;
 *   - **it only plays a slot the app named, or one it fetched itself for the entry it is playing**.
 *     An end belonging to an unloaded slot, or to a track the app has already replaced, is counted
 *     and ignored — never guessed at;
 *   - **every outcome is reported**: `advanced` with the track **and the index** it moved to, or
 *     `advanceFailed` with the reason, both of which the app adopts or recovers from. A boundary that
 *     happens without the app knowing is a boundary the app must be able to catch up with, which is
 *     what `now()` is for.
 *
 * ## v1.9.10 — every precondition, and a duration on the card
 *
 * The owner's two reports off 1.9.9 — *"it crashes when i go back to the app after the song ends in
 * the background"*, and *"sometimes skipping ahead a few songs in a row causes the app to crash"* —
 * are one shape: an AVFoundation operation issued against an item whose state has moved on. A guard
 * that excludes only `.failed` is not that guard. So **every** call this file makes against an item
 * or a player is now conditional on the whole precondition at once:
 *
 *   - the item must be `.readyToPlay` **and** the player must be (the pair `preroll` and a start
 *     need, and the pair 1.9.8 played without looking at);
 *   - the item must **not have played to its end** — `status` stays `.readyToPlay` for the whole life
 *     of an item, so by status alone an item that finished an hour ago reads like a fresh one;
 *   - the item must still be **the player's own item** (a slot is replaced under a warm when a new
 *     track goes into it, and the item then belongs to nothing this side is holding);
 *   - and the work must belong to the **statement it was started under**. `setQueue` carries a
 *     generation the app bumps on every statement; it is captured when a boundary is taken and
 *     re-checked at each call that follows, including at every rung of the fetch's own poll, so a
 *     queue the app has replaced can never be advanced, fetched or played by work that predates it.
 *
 * The checks are made in the same turn, on the main thread, immediately before the call they guard,
 * which is what makes this *impossible* rather than merely unlikely: nothing can run between the
 * check and the call it protects.
 *
 * The card is the third fix. The vendor publishes `MPNowPlayingInfoCenter` once, in the same turn as
 * its own `play`, with a duration read from an item that has not resolved one yet — and it never
 * republishes, so the scrubber shows dashes until something else happens to fill it in. This side now
 * publishes the card itself: the entry it is playing (the same list the boundary is walked over), the
 * item's own duration when it is known, the player's own position, and its own rate. It **merges**
 * into the existing dictionary (artwork and everything else the vendor put there survive), it
 * republishes for a short window afterwards so the vendor's own zero-duration write cannot be the
 * last word, and it keeps republishing while the duration is still indefinite — which is the one
 * fact that arrives late.
 *
 * The play itself goes through the audio plugin's **own** method (`play(assetId:time:)`), through
 * the Objective-C runtime: that call is what keeps the plugin's bookkeeping — the asset it believes
 * is playing, the Now Playing card, its position timer — describing the track that is actually
 * playing. Driving the `AVPlayer` directly would leave all of that on the track that just ended,
 * which is how a lock-screen card starts naming the wrong song. The fetch goes through the same
 * plugin's own `preload(assetId:assetPath:isUrl:notificationMetadata:)`, for the same reason.
 *
 * Registered from `ViewController.capacitorDidLoad()` (a local plugin has no npm package for
 * `cap sync` to discover, so registration is explicit), and reachable from JavaScript as
 * `NaviliteRemote`; `src/player/native.ts` treats it as optional and works without it.
 */
@objc(NaviliteRemote)
public class NaviliteRemote: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NaviliteRemote"
    public let jsName = "NaviliteRemote"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activateSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "now", returnType: CAPPluginReturnPromise),
        /* v2.0-beta.16 — the persisted boundary log, so the owner can hand over the measurement
         * instead of reading a row on a screen while driving (see `boundaries`). */
        CAPPluginMethod(name: "boundaries", returnType: CAPPluginReturnPromise)
    ]

    /// One entry of the published queue: the track, where it can be fetched from, and — when the app
    /// is already holding it warm — the asset id that holds it.
    struct Entry {
        let songId: String
        let url: String
        let title: String
        let artist: String
        let album: String
        let artworkUrl: String?
        /// The asset the **app** already holds this entry in, when it does. `nil` means nothing is
        /// warm for it and this side fetches it itself at the boundary.
        let slot: String?
    }

    /// The command/target pairs to remove again on `detach` — a target left behind would call into
    /// a web layer that is gone.
    private var targets: [(command: MPRemoteCommand, token: Any)] = []

    /* --------------------------------------------------------------- the queue (v1.9.9) */

    /// The app's resolved play order, as last stated. Entries only — never a copy of the queue's own
    /// model: what this side does with it is play it, one entry at a time.
    private var queue: [Entry] = []
    /// The entry that is playing, as an index into `queue`. Owned here while the app is away, and
    /// re-stated by the app whenever it is awake.
    private var index = -1
    /// `off` | `all` | `one`, as the app's repeat button says.
    private var repeatMode = "off"
    /// The number of the statement this queue came from (v1.9.10: **compared**, not merely kept).
    ///
    /// The app bumps it on every statement it publishes, and every boundary taken here captures it.
    /// It is re-checked immediately before each AVFoundation call that follows — the fetch's preload,
    /// every rung of its readiness poll, and the play itself — so work that belongs to a queue the app
    /// has since replaced can never reach an item (v1.9.10).
    private var generation = 0
    /// The slot the app last told us is playing, and the track it holds. A **statement**, re-made by
    /// the app after every start, every warm and every visibility change — see `setQueue`.
    private var audible: (assetId: String, songId: String)?
    /// Whether the web layer is running. False is the only state in which this file may advance.
    private var awake = true
    /// What it has done, for the app's own reason line: taken, refused, or ignored.
    private var advances = 0
    private var failures = 0
    private var ignored = 0
    /// The one sentence that says which state the boundary is in — every one of them has a clearing
    /// path, and this names it.
    private var reason = "nothing has been published yet"
    /// The end-of-item observation, installed once and never removed until `detach`.
    private var endObserver: NSObjectProtocol?

    /* ----------------------------------------------------- the fetch window (v1.9.9) */

    /// The two slots this side fetches into, and their current occupant. Deliberately **not** the
    /// app's own `navilite-slot-*` names: the app's pool of four is the app's, and a fetch here must
    /// never be mistaken for a warm slot the app is holding. One of the two is being played, the
    /// other is being fetched, and they swap at each boundary.
    private static let windowSlots = ["navilite-native-a", "navilite-native-b"]
    /// What this side has fetched into a window slot, and which entry it holds.
    private var fetchWindow: (slot: String, songId: String)?

    /* -------------------------------------------- the away advance queue (v2.0-beta.17) */

    /// The player **AVFoundation advances by itself** while the web layer is suspended.
    ///
    /// The boundary log from the owner's phone (beta.16, build 64) settled the previous route: every
    /// `ahead-issued` line was `awake:false`, and the slot it primed never came to hold an item while
    /// the app was away — `buffered:0`, "the slot never held an item to prime", one reload per attempt,
    /// each bumping the generation and cancelling itself. Priming a *plugin* slot from this side does
    /// not work in that state, and the seam then paid a cold fetch it could not complete (12 s deadline,
    /// five failed boundaries, `end`→`boundary` ≈ 19.7 s).
    ///
    /// So the seam stops needing this file at all: the next entries are attached to an `AVQueuePlayer`
    /// **while the app is awake** (`armAwayQueue`), and when a track ends with the app away AVFoundation
    /// advances to the item it already holds. No fetch, no `playSlot`, no preload — the advance is the
    /// platform's. `awaySlotName` is the synthetic name the queue's sound is published under, because no
    /// plugin asset holds it; nothing may look it up as one.
    private static let awaySlotName = "navilite-away-queue"
    /// How many entries are attached ahead of the one the queue is playing.
    private static let awayAhead = 2
    /// The queue itself, created once and re-filled from each statement.
    private var awayQueue: AVQueuePlayer?
    /// Every songId ever attached to the queue, in play order: `awayCursor` is how many of them the
    /// queue has sounded, so the one being heard is `awayEntries[awayCursor]` and the ones still
    /// attached are everything after it. Attachment only appends, so the two cannot drift.
    private var awayEntries: [String] = []
    private var awayCursor = -1
    /// The attached items, in `awayEntries` order — so a notification about one of them can be named as
    /// an entry instead of being anonymous (v2.0-beta.17 rework).
    private var awayItems: [AVPlayerItem] = []
    /// Entries whose attached item refused to play. A boundary for one of these is fetched, never
    /// played from the queue: a dead item inside an `AVQueuePlayer` is a stop, not an advance.
    private var awayFailed: Set<String> = []
    /// The observation of an attached item failing to play to its end — the notification
    /// `AVQueuePlayer` does post when it stops on a dead item, and the only signal that seam has.
    private var failureObserver: NSObjectProtocol?
    /// What the queue had reached when the app came back: the entry, the index and the position, so a
    /// return can resume where the queue was rather than at the app's own last clock reading.
    private var awayResume: (songId: String, index: Int, positionMs: Int)?
    /// Whether the sound being heard comes from the queue rather than a plugin slot. Every reader of
    /// the audible state goes through `audiblePlayer()` so this one flag is the only difference.
    private var awayOwnsAudible = false
    /// Which path the boundary being recorded took: `queue` (AVFoundation advanced), `slot` (a
    /// preloaded plugin slot played) or `fetch` (this side loaded the entry itself). Nil falls back to
    /// what the timestamps say, which is what every build before this one reported.
    private var boundaryPath: String?
    /// Whether this file itself issued the play for the boundary being recorded (finding 3): the
    /// **first** away seam after leaving is still hand-walked — `awayStart` reads the queue's status and
    /// issues `queuePlayer.play()` — so `path: "queue"` alone would overstate it. From the second away
    /// boundary on, AVFoundation advances by itself and nothing here runs at the seam.
    private var boundaryAppCode = false
    /// How long a fetch here may take before it is reported as a boundary that could not be taken.
    private static let fetchDeadline = 12.0
    /// How often a fetched slot is asked whether it can start yet (50ms for responsive background handoff).
    private static let fetchStep = 0.05
    /// How long a prime may keep asking whether its item has resolved: 50 ms steps, 10 s.
    private static let prerollAttempts = 200
    /// How long the boundary's clock keeps asking whether the player is running: 50 ms steps, 5 s.
    private static let audibleProbeAttempts = 100

    /* --------------------------------------------------- the lock-screen card (v1.9.10) */

    /// How often the card is refreshed after a state change, and at least how long it is refreshed
    /// for. The grace is what makes this side's write the last one: the vendor's own writer publishes
    /// a duration-less card in the same turn as its `play`, and a single write here could land under
    /// it.
    private static let cardStep = 0.25
    private static let cardGrace = 0.75
    /// The outside of the refresh — long enough for an indefinite item to resolve a duration, short
    /// enough that nothing here writes to the card for a whole track.
    /// Twelve seconds covers the seconds around a boundary and no more: Apple advises against
    /// periodic `nowPlayingInfo` pushes, so this window must end rather than become a steady-state
    /// writer (v2.1).
    private static let cardDeadline = 12.0
    /// Which refresh is current; a newer one retires the older one's ladder.
    private var cardTicket = 0
    /// How often the watchdog **reads** the card, and never more than that (v2.1).
    private static let watchdogStep = 2.0
    /// The read-mostly watchdog, and the statement it was started under.
    private var cardWatchdog: DispatchSourceTimer?
    private var cardWatchdogToken = 0
    /// A handed-off boundary is running: the card deliberately names the **incoming** entry while
    /// `index` still names the finished one, so the watchdog must not read a verdict from it.
    private var boundaryInFlight = false
    /// A play has been issued and the player has not yet said either *playing* or *waiting* for it
    /// (v2.0-beta.15). While this is true, `.paused` is a race with the start rather than a pause, so
    /// the card ladder must not accept it as settled — otherwise the head of a new track can be the
    /// moment the ladder stops, with 0.0 as the last word.
    private var awaitingFirstPlayback = false
    /// What the repairs have done, for the reason line and the `now()` payload.
    private var cardRepairs = 0
    private var sessionRetakes = 0
    /// The runtime identity (v2.0-beta.16): computed once, and the flag that keeps the identity line
    /// in the persisted log down to one per session.
    private var identity: [String: Any]?
    private var identityLogged = false
    /// Whether the audio session was active the last time it was asked (v2.0-beta.14).
    ///
    /// `AVAudioSession` has **no public getter** for this — `isActive` is not in the SDK (the
    /// compiler rejects it as "no member"), so the earlier claim that it had been public since iOS 6
    /// was false and is not repeated. What the flag is, instead, is a record kept honest by the two
    /// notifications that can invalidate the session without anything here asking: a media-services
    /// reset clears it, and an interruption that ends re-takes the session and sets it again. A
    /// session the system dropped while the app was away and none of those fired is still invisible
    /// to it — which is why the return to the foreground asserts the session unconditionally (a
    /// no-op when it is already active) rather than trusting the flag. Every decision below reads
    /// `sessionIsActive`; this field is the last reading, for the diagnostics row.
    private var sessionActive = true

    /// Whether the audio session is active right now (v2.0-beta.14).
    ///
    /// There is **no getter in the SDK**: `AVAudioSession.isActive` does not exist (the compiler
    /// rejects it), and `AVAudioApplication.activationState` — the iOS 16 answer — does not resolve
    /// under this SDK either. So the honest source is this side's record, and its correctness is
    /// earned by the two notifications installed in `installSessionObservers`: media services reset
    /// clears it, an interruption that ends re-takes the session. Two readers — the `now()` payload
    /// and `retakeSession` — and both read this one flag, so the four call sites cannot drift.
    private var sessionIsActive: Bool {
        return sessionActive
    }
    /// The return-to-foreground observation, installed with the end observer and removed with it.
    private var activeObserver: NSObjectProtocol?
    /// The session's own notifications (reset, interruption ended).
    private var sessionObservers: [NSObjectProtocol] = []

    /* -------------------------------------- the boundary's own clock (v2.0-beta.14) */

    /// Five moments of the last boundary taken here, so a recurrence on the owner's phone names
    /// itself in the diagnostics row instead of costing another blind round: the **item end** (t 0),
    /// the moment the card was announced for the incoming entry, the moment a fetch was issued (nil
    /// on the warm path), the moment the item reported ready, the moment the play call was issued,
    /// and the first frame the player was actually running. All relative to `boundaryStart`, in ms.
    private var boundaryStart: Date?
    private var cardAnnouncedAt: Date?
    private var fetchIssuedAt: Date?
    private var readyAt: Date?
    private var playIssuedAt: Date?
    private var audibleAt: Date?
    /// Why the boundary could not start from a slot that was supposed to be warm (v2.0-beta.16) —
    /// empty when it started from one, which is the fact the old row could not state.
    private var boundaryWhyNotWarm: String?

    /* --------------------------------- the look-ahead's own account (v2.0-beta.16) */

    /// What the look-ahead has loaded for the **next** boundary, and how far it got.
    ///
    /// The owner's gap is a constant (~10 s) and the fetch deadline here is 12 s, so the number has a
    /// shape: the seam that takes ten seconds is the seam that pays `fetch()` → `awaitReady()`. The
    /// question this record answers on his phone is *why the slot that was supposed to be warm was not
    /// startable*: `buffered` is the one fact the readiness poll never asked for — an item can be
    /// `.readyToPlay` (the metadata resolved) and hold **no audio**, which is exactly the state a
    /// boundary would wait ten seconds on.
    private struct Ahead {
        let slot: String
        let songId: String
        var issuedAt: Date
        var readyAt: Date?
        var primedAt: Date?
        var buffered: Double
        var likely: Bool
        var attempts: Int
        var gaveUp: String?
    }
    private var ahead: Ahead?
    /// How far the preloaded item's buffer must reach before the boundary counts as startable: three
    /// seconds of audio at the item's head is more than the seam needs, and it is reached in one
    /// preroll on a local network.
    private static let primeBuffer = 3.0
    /// How long the look-ahead keeps asking for that buffer: 50 ms steps, 30 s. It is paid out of the
    /// outgoing track (minutes long), not out of the seam.
    private static let primeAttempts = 600
    private static let primeStep = 0.05

    /* --------------------------------------- the persisted boundary log (v2.0-beta.16) */

    /// One JSON line per look-ahead and per boundary, in `Documents/navilite-boundaries.jsonl`.
    ///
    /// A row on a screen is not evidence the owner can hand over — it cannot be read while driving,
    /// and the last three rounds of this defect were diagnosed from source. This file is the
    /// measurement itself: `kind: "end"` (a track ended and whether this side took it), `"ahead"`
    /// (what the look-ahead loaded and how much audio it actually pulled), `"boundary"` (the five
    /// moments, the path, the slot, and why-not-warm), and `"audible"` (when sound actually began).
    /// The app copies it out from Settings → Boundary log.
    private static let logName = "navilite-boundaries.jsonl"
    /// One rotation is kept. An unbounded log on a phone is a bug of its own.
    private static let logRotateBytes = 512 * 1024
    private static let logTailLines = 60
    private var logCount = 0
    private var logTail: [String] = []

    /// Cached artwork: songId -> MPMediaItemArtwork (v2.0-beta.12).
    private var artworkCache: [String: MPMediaItemArtwork] = [:]
    /// songIds currently being fetched to avoid duplicate fetches.
    private var fetchingArtworkSongIds: Set<String> = []

    private static let playSelector = NSSelectorFromString("play:")
    private static let preloadSelector = NSSelectorFromString("preload:")
    private static let unloadSelector = NSSelectorFromString("unload:")
    private static let audioPluginName = "NativeAudio"

    @objc func attach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            if self.targets.isEmpty {
                let center = MPRemoteCommandCenter.shared()

                center.nextTrackCommand.isEnabled = true
                let next = center.nextTrackCommand.addTarget { [weak self] _ in
                    guard let self else { return .commandFailed }
                    /*
                     * **With a queue published and the app away, the button advances here (v1.9.9).**
                     *
                     * The message this used to send goes to a suspended web view: the buttons the
                     * owner was given for exactly this case did nothing while the app was away. With
                     * the web layer awake the message is sent as it always was, and the app's own
                     * `next` — which owns the repeat mode, the end of the queue and the loading
                     * state — handles it.
                     */
                    if self.advanceIfAble() { return .success }
                    self.notifyListeners("next", data: [:])
                    return .success
                }
                self.targets.append((command: center.nextTrackCommand, token: next))

                center.previousTrackCommand.isEnabled = true
                let previous = center.previousTrackCommand.addTarget { [weak self] _ in
                    guard let self else { return .commandFailed }
                    if self.previousIfAble() { return .success }
                    self.notifyListeners("previous", data: [:])
                    return .success
                }
                self.targets.append((command: center.previousTrackCommand, token: previous))
            }
            self.installEndObserver()
            self.installActiveObserver()
            call.resolve(["attached": true])
        }
    }

    @objc func detach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve(["attached": false])
                return
            }
            for target in self.targets {
                target.command.removeTarget(target.token)
            }
            self.targets.removeAll()
            self.removeEndObserver()
            self.removeActiveObserver()
            self.cancelWatchdog()
            self.boundaryInFlight = false
            if let plugin = self.bridge?.plugin(withName: Self.audioPluginName) {
                for slot in Self.windowSlots {
                    self.unloadSlot(plugin: plugin, slot: slot)
                }
            }
            self.queue = []
            self.index = -1
            self.fetchWindow = nil
            self.artworkCache.removeAll()
            self.fetchingArtworkSongIds.removeAll()
            self.reason = "detached — nothing is published"
            call.resolve(["attached": false])
        }
    }

    /// Re-activate the audio session without changing how it is configured. Idempotent.
    @objc func activateSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                call.resolve(["active": true])
            } catch {
                call.reject("audio session could not be activated: \(error.localizedDescription)")
            }
        }
    }

    /**
     * The app's statement of the queue: every entry in the order it will be played, which one is
     * playing, the repeat mode, and whether the web layer is running.
     *
     * A statement rather than an increment on purpose. The app sends the whole picture after every
     * start, every warm and every lifecycle change, so nothing here can be left half-applied by a
     * message that did not arrive — and there is no flag that could stick. An empty list is how the
     * app says "there is no queue" (it stopped, or it was cleared), and it disarms the boundary.
     *
     * It is also the app's own answer to "which track is on", which is what makes it the moment to
     * write the lock-screen card (v1.9.10): the entry, the item's own duration, the position and the
     * rate, from the list the boundary is walked over. Every state change the app reports re-writes it.
     */
    @objc func setQueue(_ call: CAPPluginCall) {
        let entries = (call.getArray("list") as? [[String: Any]]) ?? []
        let statedIndex = call.getInt("index") ?? -1
        let mode = call.getString("repeat") ?? "off"
        let isAwake = call.getBool("awake") ?? true
        let audibleAssetId = call.getString("audibleAssetId")
        let audibleSongId = call.getString("audibleSongId")
        let statedGeneration = call.getInt("generation") ?? 0
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            /*
             * A new statement supersedes any boundary in flight (v2.1): that boundary was taken under
             * the queue this replaces, so nothing is left half-announced and the watchdog may read
             * the card this statement writes.
             */
            self.boundaryInFlight = false
            self.queue = entries.compactMap { entry in
                guard let songId = entry["songId"] as? String, !songId.isEmpty,
                      let url = entry["url"] as? String, !url.isEmpty else { return nil }
                let slot = (entry["assetId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                return Entry(
                    songId: songId,
                    url: url,
                    title: (entry["title"] as? String) ?? "",
                    artist: (entry["artist"] as? String) ?? "",
                    album: (entry["album"] as? String) ?? "",
                    artworkUrl: (entry["artworkUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                    slot: slot
                )
            }
            /*
             * A published index only counts when it points at an entry. Anything else (an empty
             * list, an index from a queue this statement replaced) is "nothing is playing", and the
             * boundary then has nothing to take and says so rather than guessing.
             */
            self.index = (statedIndex >= 0 && statedIndex < self.queue.count) ? statedIndex : -1
            self.repeatMode = (mode == "all" || mode == "one") ? mode : "off"
            self.awake = isAwake
            self.generation = statedGeneration
            if let audibleAssetId, !audibleAssetId.isEmpty {
                self.audible = (audibleAssetId, audibleSongId ?? "")
            }
            self.installEndObserver()
            /*
             * **A handover arms the first boundary (v1.9.18).**
             *
             * `preloadAhead` used to run only after a boundary had been taken here, so the *first*
             * track end after the app went away was the one with nothing armed: the app is suspended
             * by then (its warm pool is frozen with it), and any entry it did not already hold a slot
             * for had to be fetched at the boundary — a fetch plus the readiness poll below, heard as
             * a pause before the next track starts. The statement that says `awake: false` is exactly
             * the moment this side learns it will own that boundary, so it is the moment to arm it.
             *
             * Idempotent by construction: `preloadAhead` returns immediately when a slot already
             * holds the entry (the app's warm slot included) and when this side has already fetched
             * it, so a repeated statement costs nothing and cannot replace a warm slot.
             */
            if !self.awake { self.preloadAhead(token: self.generation) }
            /*
             * The away advance queue is armed from **every** statement (v2.0-beta.17). While the app is
             * on screen that is the whole of its work: `armAwayQueue` attaches the entries after the one
             * playing to an `AVQueuePlayer` that AVFoundation can advance by itself, so the boundary that
             * happens in his pocket needs no preload and no fetch. A statement that says `awake: true`
             * while the queue owns the sound means the app is back and its own player must take over —
             * the queue hands the sound over rather than doubling the track that is about to start.
             */
            /*
             * **A handover, not a teardown (finding 5).** This used to stop the sounding queue before the
             * web layer had played anything: the music stopped, and the app's own start then had to
             * reach the network — the audible hole at every return. The queue is paused instead (one
             * player sounding), its items kept, and what it reached written down; and the app's stated
             * index is compared against that, because a watch that never tracked the queue's advance
             * comes back naming the track it left, which is the position jumping backwards.
             */
            if isAwake, let resumed = self.awayResume,
               statedIndex != resumed.index || (statedIndex >= 0 && statedIndex < self.queue.count && self.queue[statedIndex].songId != resumed.songId) {
                self.record("queue-handover-jump", [
                    "queueSongId": resumed.songId, "queueIndex": resumed.index, "queuePositionMs": resumed.positionMs,
                    "statedIndex": statedIndex,
                    "statedSongId": (statedIndex >= 0 && statedIndex < self.queue.count) ? self.queue[statedIndex].songId : "",
                    "why": "the app stated a different entry from the one the away queue had reached, so its own play resumes there rather than where the queue was"
                ])
            }
            if self.awake, self.awayOwnsAudible {
                self.handOverAwayQueue(why: "the app came back and stated the queue, so its own player takes the sound from the position the queue reached")
            }
            self.armAwayQueue(token: self.generation)
            /*
             * Art arrives at **statement** time, not card time (v2.1): by the time the card needs an
             * image the track is already playing, and the missing image is the visible defect. The
             * playing entry and the next two — those are the three the next boundaries can reach.
             */
            if self.index >= 0 {
                for offset in 0...2 where self.index + offset < self.queue.count {
                    self.loadArtwork(for: self.queue[self.index + offset])
                }
            }
            /*
             * The watchdog belongs to exactly one state (v2.1): the app away with a queue to walk.
             * Everywhere else it is cancelled — while the app is on screen the web layer owns the card.
             */
            if !self.awake, self.index >= 0, !self.queue.isEmpty {
                self.startWatchdog(token: self.generation)
            } else {
                self.cancelWatchdog()
            }
            self.reason = self.queue.isEmpty
                ? "the app published no queue, so there is nothing to advance to"
                : self.index < 0
                    ? "the app published a queue with no track playing, so there is nothing to advance from"
                    : self.awake
                        ? "the app is on screen, so the web layer takes the track boundary and this side is only told what follows"
                        : "the native player will play this queue itself if a track ends while the app is away (\(self.queue.count) entries, entry \(self.index + 1) playing)"
            // The lock-screen card, written from the statement the app has just made (v1.9.10).
            self.refreshNowPlaying()
            call.resolve([
                "queued": self.queue.count,
                "index": self.index,
                "awake": self.awake,
                "armed": self.queue.count > 0 && self.index >= 0
            ])
        }
    }

    /**
     * What this side knows and has done: the entry it believes is playing, the track that entry
     * holds, the queue it is holding, and the counters.
     *
     * This is how a track that advanced while the app was away is ever learned about — the message
     * was addressed to a suspended web view — so the app asks on the way back and adopts the answer,
     * **by index** (v1.9.9).
     */
    @objc func now(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            self.logIdentityOnce()
            let playing = (self.index >= 0 && self.index < self.queue.count) ? self.queue[self.index] : nil
            call.resolve([
                "assetId": self.audible?.assetId ?? "",
                "songId": self.audible?.songId ?? playing?.songId ?? "",
                "index": self.index,
                "queued": self.queue.count,
                "repeat": self.repeatMode,
                "generation": self.generation,
                "advances": self.advances,
                "failures": self.failures,
                "ignored": self.ignored,
                "awake": self.awake,
                /*
                 * What the away queue had reached when the app came back (finding 5): the entry, the
                 * index and the position, so the app's own play can resume where the queue was instead
                 * of where its last clock reading stood. Empty once the app's player has taken over.
                 */
                "resume": self.awayResume.map { ["songId": $0.songId, "index": $0.index, "positionMs": $0.positionMs] } ?? [:],
                "reason": self.reason,
                "cardRepairs": self.cardRepairs,
                "sessionRetakes": self.sessionRetakes,
                "sessionActive": self.sessionIsActive,
                /* v2.0-beta.16 — who this app is as the phone knows it, and what the system has
                 * asked its scene to do. The two facts the tap investigation is decided by, and
                 * neither is readable from JavaScript. */
                "identity": self.runtimeIdentity(),
                "scene": NaviliteSceneEvents.shared.summary,
                "timeline": self.boundaryTimeline(),
                /* v2.0-beta.16 — the persisted log's own whereabouts, so the app can copy it out and
                 * the row can carry the last lines without the owner opening a file by hand. */
                "logPath": self.logFileURL?.path ?? "",
                "logLines": self.logCount,
                "logTail": Array(self.logTail.suffix(2)),
                "cardTitle": (MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyTitle] as? String) ?? "",
                "cardRate": (MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue ?? 0,
                "artCached": playing.map { self.artworkCache[$0.songId] != nil } ?? false,
                /*
                 * What the system says the session's own shape is, and whether a card exists at all
                 * (v2.0-beta.15). Attribution is the thing the owner's tap test is about — the module
                 * expanded, the card named a track, and the tap opened nothing — and neither fact can
                 * be read from JavaScript. Category options including `mixWithOthers` are the one
                 * setting that costs the Now Playing entry outright.
                 */
                "sessionCategory": AVAudioSession.sharedInstance().category.rawValue,
                "sessionOptions": Self.optionNames(AVAudioSession.sharedInstance().categoryOptions),
                "cardPresent": MPNowPlayingInfoCenter.default().nowPlayingInfo != nil
            ])
        }
    }

    /* --------------------------------------- who this app is (v2.0-beta.16) */

    /// The plugin came up: write the session's identity line now, not at the first `now()` call.
    ///
    /// The identity is the answer to "was the tap aimed at an id that exists", and the owner reads it
    /// off the phone — so it must not depend on the web layer ever asking for diagnostics. On a build
    /// with no library configured, no `now()` may be called at all; the launch itself still proves
    /// what the app is, and this writes it.
    override public func load() {
        super.load()
        logIdentityOnce()
    }

    /// What the Now Playing entry's owner is, as the system sees it (v2.0-beta.16).
    ///
    /// mediaremoted publishes a Now Playing entry owned by a **CFBundleIdentifier**, and SpringBoard
    /// routes a tap on that card — or on the island's expanded view — back to whichever app the id
    /// names. If that id does not resolve to an installed, activatable app, the tap lands on nothing,
    /// and no Info.plist key, entitlement or `MPNowPlayingInfo` property can redirect it (the research
    /// on t_4145f5d9 closed that question). The one class of install that produces such an id is a
    /// sideloader that rewrites or mangles the bundle id — so this side reports the runtime facts
    /// instead of assuming them: the id it is running as, the id its embedded provisioning profile
    /// was issued for (empty on an App Store / TestFlight build, which has no profile), where the
    /// `.app` actually lives, and whether the install carries a receipt or a profile.
    ///
    /// Computed once: none of it can change while the process lives.
    private func runtimeIdentity() -> [String: Any] {
        if let identity { return identity }
        let bundle = Bundle.main
        let bundleId = bundle.bundleIdentifier ?? ""
        let path = bundle.bundleURL.path
        let appId = Self.provisioningAppId(bundle)
        let team = appId.split(separator: ".").first.map(String.init) ?? ""
        let facts: [String: Any] = [
            "bundleId": bundleId,
            "appId": appId,
            "teamId": team.isEmpty ? "unknown" : team,
            "appGroups": "not readable (no public API)",
            "path": path,
            "container": path.contains("/Containers/Bundle/Application/") ? "installed package" : "relocated or dev build",
            "signatureMatchesBundleId": appId.isEmpty ? false : appId.hasSuffix("." + bundleId),
            /* App Store / TestFlight installs carry a receipt and no profile; a sideloader's build
             * carries an embedded profile instead. That difference is the install method's own
             * fingerprint, and it is the one fact here the code cannot be wrong about. */
            "receipt": bundle.appStoreReceiptURL?.lastPathComponent ?? "none",
            "embeddedProfile": bundle.url(forResource: "embedded", withExtension: "mobileprovision") != nil
        ]
        identity = facts
        return facts
    }

    /// The `application-identifier` the embedded provisioning profile was issued for (v2.0-beta.16).
    ///
    /// The entitlement itself is not readable: `SecTaskCreateFromSelf` is not in the public SDK, and
    /// an app must not ship private API. The same value is written in plain text inside
    /// `embedded.mobileprovision` on any dev or sideloaded build, so it is read from there — a
    /// profile the owner's install method rewrote shows the rewritten id, which is exactly the
    /// question. An App Store / TestFlight build has no profile: empty, and reported as such.
    private static func provisioningAppId(_ bundle: Bundle) -> String {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else { return "" }
        var rest = Substring(text)
        var found: [String] = []
        while let key = rest.range(of: "<key>application-identifier</key>") {
            rest = rest[key.upperBound...]
            guard let open = rest.range(of: "<string>"), let close = rest.range(of: "</string>"),
                  open.lowerBound < close.lowerBound else { continue }
            found.append(String(rest[open.upperBound..<close.lowerBound]))
            rest = rest[close.upperBound...]
        }
        // A profile can list several ids (a wildcard, and the exact one); the exact one wins.
        let id = bundle.bundleIdentifier ?? ""
        return found.first(where: { $0.hasSuffix("." + id) }) ?? found.first ?? ""
    }

    /// The session's identity, once, into the log — the answer to "was the tap aimed at an id that
    /// exists", written down where it can be read off the phone (v2.0-beta.16).
    private func logIdentityOnce() {
        guard !identityLogged else { return }
        identityLogged = true
        var facts = runtimeIdentity()
        for (key, value) in NaviliteSceneEvents.shared.summary {
            facts["scene_" + key] = value
        }
        record("identity", facts)
    }

    /// The session's category options as words, for the diagnostics row (v2.0-beta.15): `none` when
    /// there are none, which is the state a Now Playing entry needs.
    private static func optionNames(_ options: AVAudioSession.CategoryOptions) -> String {
        var names: [String] = []
        if options.contains(.mixWithOthers) { names.append("mixWithOthers") }
        if options.contains(.duckOthers) { names.append("duckOthers") }
        if options.contains(.allowBluetooth) { names.append("allowBluetooth") }
        if options.contains(.allowBluetoothA2DP) { names.append("allowBluetoothA2DP") }
        if options.contains(.defaultToSpeaker) { names.append("defaultToSpeaker") }
        if options.contains(.interruptSpokenAudioAndMixWithOthers) { names.append("interruptSpokenAudioAndMixWithOthers") }
        if options.contains(.allowAirPlay) { names.append("allowAirPlay") }
        return names.isEmpty ? "none" : names.joined(separator: "+")
    }

    /* ------------------------------------------------------------ taking the boundary */

    /// Watch the end of the audible item. One observer for the whole app, object: nil, so a slot
    /// changing under it cannot leave the wrong item watched (the item is checked when it fires).
    private func installEndObserver() {
        guard endObserver == nil else { return }
        endObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name.AVPlayerItemDidPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.itemDidEnd(notification)
        }
        /*
         * **The other end of an item: one that will not play at all (v2.0-beta.17 rework).**
         * `AVQueuePlayer` stops at a 404/invalid item inside its queue and posts nothing else — no
         * end-of-item notification, no `commitQueue`, no fetch, no card change — so before this
         * observer a dead entry was indistinguishable from silence while the card still said playing.
         * Object `nil` for the same reason as the end observer: the item is checked when it fires.
         */
        failureObserver = NotificationCenter.default.addObserver(
            forName: NSNotification.Name.AVPlayerItemFailedToPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            self?.awayItemDidFail(notification)
        }
    }

    private func removeEndObserver() {
        guard let endObserver else { return }
        NotificationCenter.default.removeObserver(endObserver)
        self.endObserver = nil
        if let failureObserver {
            NotificationCenter.default.removeObserver(failureObserver)
            self.failureObserver = nil
        }
    }

    /// An item could not be played to its end. When it is one the away queue holds, the boundary for it
    /// is taken by the **fetch** path, with the player's own reason in the log and on the card.
    ///
    /// This is finding 1 of the rework: the only status read on the queue path was `awayStart`'s, which
    /// runs once at the first seam, so a track that resolved and then died (a 404 that lands after
    /// `play()` was issued) was never noticed by anything — and a queue that stops inside its own items
    /// never emits the end-of-item notification that would have advanced it.
    private func awayItemDidFail(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem else { return }
        let why = (notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription
            ?? item.error?.localizedDescription
            ?? "no reason given by the player"
        guard let at = awayItems.firstIndex(where: { $0 === item }) else {
            // Not an item this side attached: the app's own slot, or one already taken out.
            record("away-item-failed-unattached", ["awake": awake, "why": why])
            return
        }
        let songId = at < awayEntries.count ? awayEntries[at] : ""
        // The item that should be sounding now, or the first one the seam was going to start from.
        /*
         * **The entry the queue is SOUNDING - not the one after it (v2.0-beta.18).**
         *
         * `at <= awayCursor + 1` called the next entry audible as well, and the fetch path below clears
         * `awayOwnsAudible` and plays on a second player without pausing the queue: a failure
         * notification about the entry *after* the sounding one would have started a second track while
         * the queue was still running. Exactly one entry is audible, so exactly one is compared.
         */
        let sounding = awayOwnsAudible ? at == awayCursor : at == 0
        awayFailed.insert(songId)
        record("away-item-failed", [
            "songId": songId, "at": at, "cursor": awayCursor, "owned": awayOwnsAudible,
            "sounding": sounding, "awake": awake, "why": why
        ])
        // It comes out of the queue, so the queue cannot stop on it a second time.
        awayQueue?.remove(item)
        awayItems.remove(at: at)
        if at < awayEntries.count { awayEntries.remove(at: at) }
        if awayCursor >= at { awayCursor = max(awayCursor - 1, -1) }
        guard sounding, !awake else { return }
        /*
         * **The queue is paused before this side fetches (v2.0-beta.18).** The drained branch below has
         * always paused before it fetches; this one did not, so the fetch-play on a second player could
         * land while the queue was still making sound. One boundary, one player.
         */
        awayQueue?.pause()
        /*
         * The entry that should be sounding is the one that died: this boundary belongs to the fetch
         * path. The queue stops owning the sound first, so exactly one player issues the play, and the
         * card is corrected before the fetch starts — the screen never says "playing" over a track
         * that is not sounding.
         */
        awayOwnsAudible = false
        awayCursor = -1
        audible = nil
        boundaryPath = nil
        let target = queue.firstIndex(where: { $0.songId == songId }) ?? max(index + 1, 0)
        reason = "the away queue's item for \(songId) failed to play (\(why)), so it is being fetched here"
        boundaryWhyNotWarm = reason
        notifyListeners("advanceFailed", data: ["reason": reason, "index": index])
        take(entry: target, how: "the away queue's item failed to play", token: generation)
    }

    /// The audible item reached its end. Play the next entry, or say why not.
    private func itemDidEnd(_ notification: Notification) {
        /*
         * A notification about an item this app is not hearing is not a track boundary: unloading a
         * warm slot stops its asset and can end an item nobody has played, and so can a load that is
         * replacing the audible one. Both are counted rather than acted on.
         */
        guard let item = notification.object as? AVPlayerItem else { return }
        /*
         * **The away queue's own end (v2.0-beta.17).** AVFoundation has already moved to the item after
         * the one that ended, so this boundary is a fact to record rather than an advance to issue — no
         * fetch, no `playSlot`, nothing of this file's in the way. When the queue has nothing left
         * attached it stops owning the sound and the hand-walked path below takes the boundary (which
         * fetches), reported as exactly that.
         */
        if awayOwnsAudible, let queuePlayer = awayQueue {
            /*
             * The entry the queue has advanced to is read from the queue's own list and the ORDER — not
             * `index + 1`, which refused the wrapped advance at the last entry and dead-ended the seam
             * (finding 2 of the rework).
             */
            let next = awayCursor + 1
            let held = next < awayEntries.count ? awayEntries[next] : nil
            let target = held.flatMap { songId in queue.firstIndex(where: { $0.songId == songId }) } ?? -1
            let dead = held.map { awayFailed.contains($0) } ?? true
            if held != nil, target >= 0, !dead, queuePlayer.currentItem != nil {
                awayCursor = next
                beginBoundary()
                boundaryInFlight = true
                boundaryPath = "queue"
                commitQueue(entry: queue[target], target: target, how: "the track ended while the app was away")
                return
            }
            /*
             * **A drained queue must not dead-end (finding 2).** This branch used to clear
             * `awayOwnsAudible` and then fall into the plugin-slot guard below, where `audible` still
             * named `navilite-away-queue` — a name no plugin player answers to — so every drained
             * boundary was logged `end-ignored` and returned: no fetch, no advance, music stopped while
             * the card said playing. Three routes reach it: repeat-all at the last entry, a top-up that
             * added nothing, and any boundary before a top-up ran.
             *
             * The boundary now goes to the fetch path in the same turn, with the route in the log.
             */
            let route = held == nil
                ? "the away queue had no entry attached after the one that ended"
                : dead
                    ? "the away queue's item for \(held ?? "that entry") had already failed"
                    : "the next entry the queue held is no longer in the published order"
            record("queue-drained", [
                "attached": awayEntries.count, "cursor": awayCursor, "held": held ?? "none",
                "target": target, "dead": dead, "why": "\(route), so this boundary goes to the fetch path"
            ])
            queuePlayer.pause()
            awayOwnsAudible = false
            awayCursor = -1
            awayEntries = []
            awayItems = []
            // The queue's sound was published under a name no plugin player answers to; it is gone now.
            audible = nil
            boundaryPath = nil
            boundaryWhyNotWarm = "\(route), so this boundary is fetched here"
            beginBoundary()
            boundaryInFlight = true
            takeNext(how: "the away queue drained at the boundary", automatic: true, token: generation)
            return
        }
        guard let recorded = audible, let found = AudibleBridgePlayer.player(recorded.assetId, from: bridge), found.player.currentItem === item else {
            ignored += 1
            record("end-ignored", ["why": "the item that ended is not the audible player's current item"])
            return
        }
        /*
         * And with the web layer running this side does not act at all: the app owns the boundary
         * then, exactly as it did before this release, and two owners is how a track gets skipped.
         * The reason says so, because "the native side stayed out of it" and "the native side could
         * not" are different states and the owner has to be able to tell them apart on the screen.
         */
        guard !awake else {
            reason = "the app was on screen, so the web layer took the track boundary as it always has"
            /*
             * The line that settles the argument (v2.0-beta.16): if every track end in the log says
             * `awake: true` while the app was in his pocket, then nothing in this file ever ran at the
             * seam and every native fix before this one was a fix to a path that was not being taken.
             */
            record("end", ["taken": false, "slot": recorded.assetId, "songId": recorded.songId,
                           "why": "the app was on screen, so the web layer owns this boundary"])
            return
        }
        record("end", ["taken": true, "slot": recorded.assetId, "songId": recorded.songId,
                       "duration": item.status == .readyToPlay ? item.duration.seconds : -1])
        /*
         * The statement in force at this moment travels with the boundary (v1.9.10). Everything the
         * advance goes on to do — a fetch, each rung of its readiness poll, the play — re-checks it, so
         * a queue the app replaces while this is in flight can no longer be advanced into.
         */
        /*
         * The card names the **incoming** entry before the handoff starts (v2.1) — but that is now
         * `take()`'s own job, so every boundary gets it, automatic or from a button. Without it the
         * finished track is published as paused for the whole fetch, which is the second the owner
         * hears as "the card went dead at the boundary". `commit()` corrects it with the real slot.
         */
        takeNext(how: "the track ended while the app was away", automatic: true, token: generation)
    }

    /// The lock screen's next button, when there is a published queue to take it with.
    private func advanceIfAble() -> Bool {
        guard !awake else { return false }
        guard index >= 0, index < queue.count else { return false }
        /*
         * A button is not the end of a queue: on the last entry it wraps to the top, which is the
         * rule the app's own `next` has always had ("a button should always do something").
         */
        return takeNext(how: "the lock screen's next", automatic: false, token: generation)
    }

    /// And its back button. With the app awake the web layer's own rule applies (under three seconds
    /// in, "previous" restarts the track); with the app away this is the same rule, over the same
    /// published list — and it is **repeatable**: it used to forget the track behind it after one
    /// press, so a second press on the lock screen did nothing at all.
    private func previousIfAble() -> Bool {
        guard !awake, index >= 0, index < queue.count else { return false }
        let token = generation
        guard index > 0 else {
            // At the top of the queue: previous restarts this track rather than wrapping.
            let entry = queue[index]
            guard playSlot(entry: entry, slot: audible?.assetId, time: 0, how: "the lock screen's previous", token: token) else {
                return false
            }
            reason = "the lock screen asked for the previous track; this is the first entry of the queue, so the native player restarted it"
            notifyListeners("advanced", data: ["songId": entry.songId, "assetId": audible?.assetId ?? "", "index": index])
            refreshNowPlaying()
            return true
        }
        return take(entry: index - 1, how: "the lock screen's previous", token: token)
    }

    /// Take the boundary: the next entry in the published order, or a reason it could not be taken.
    ///
    /// This is the whole of "no boundary is uncrossable": the target is an entry of a list this side
    /// holds, so the only thing that can stop it is the entry itself failing to load — and that says
    /// so, on the screen, instead of silence.
    private func takeNext(how: String, automatic: Bool, token: Int) -> Bool {
        guard index >= 0, index < queue.count else {
            fail("\(how): no track was published as playing, so there was nothing to advance from")
            return false
        }
        var target = index + 1
        if target >= queue.count {
            switch repeatMode {
            case "one":
                // The same entry again, which is what the app's own repeat-one advance does.
                return take(entry: index, how: "\(how) (repeat one)", restart: true, token: token)
            case "all":
                target = 0
            default:
                if automatic {
                    fail("\(how): the last track of the queue ended and repeat is off, so there was nothing after it")
                    return false
                }
                // A button always does something: the same wrap the app's own next does.
                target = 0
            }
        }
        return take(entry: target, how: how, token: token)
    }

    /**
     * Play one entry of the published queue: from the slot that holds it (the app's warm slot, or
     * this side's own fetched one), and, when nothing holds it, by **fetching it here**.
     */
    @discardableResult
    private func take(entry target: Int, how: String, restart: Bool = false, token: Int) -> Bool {
        /*
         * **The statement this boundary came from is checked before anything is issued (v1.9.10).**
         * The app re-states the queue — and with it the index and the slots — on every start and every
         * visibility change, so a boundary that was taken under one statement may not still be a
         * boundary under the next one.
         */
        guard current(token: token) else { return false }
        guard target >= 0, target < queue.count else {
            fail("\(how): the entry it points at is not in the published queue")
            return false
        }
        /*
         * **Every boundary arms the window here, in one place (v2.1).** `announceUpcoming` writes the
         * incoming entry's card before the handoff starts, and `boundaryInFlight` stops the watchdog
         * and the refresh ladder from calling that card wrong while `index` still names the finished
         * track. It used to be set only by `itemDidEnd`, so a lock-screen next/previous — which comes
         * in through `advanceIfAble`/`previousIfAble` — crossed its boundary with the finished track
         * on the card at rate 0 for the whole fetch. `commit()` and `fail()` close it.
         */
        beginBoundary()
        boundaryInFlight = true
        announceUpcoming(token: token)
        let entry = queue[target]
        /*
         * **The away queue is asked first (v2.0-beta.17).** The other two routes below both depend on
         * something existing outside this process: the app's warm slot (frozen the moment the web layer
         * is suspended — the measurement in `armAwayQueue`'s note), or a fetch this side issues, which
         * the owner's log shows never resolving while the app is away. The queue holds the entry already,
         * inside AVFoundation, so this boundary needs neither.
         */
        if awayStart(entry: entry, target: target, how: how, token: token) { return true }
        /*
         * A boundary the queue cannot take — a lock-screen jump, or a queue that has drained — must not
         * be sounded twice (v2.0-beta.17): the queue stops before the hand-walked path issues its own
         * play, so exactly one player is making the sound at every seam.
         */
        if awayOwnsAudible {
            stopAwayQueue(why: "this boundary is not the queue's to take, so the queue stops before another player sounds the same track")
        }
        let slot = holding(entry.songId)
        if let slot {
            /*
             * The buffer the slot was holding at the moment of the play (v2.0-beta.16) — the number
             * that tells "the seam had audio to render" from "the seam had a resolved item and no
             * bytes". It travels with the boundary's log line.
             */
            boundaryWhyNotWarm = nil
            if playSlot(entry: entry, slot: slot, time: 0, how: how, token: token) {
                commit(target: target, slot: slot, entry: entry, how: how)
                return true
            }
            /*
             * If the slot holds the item and is still buffering (v2.0-beta.11) — not failed and
             * has not played to its end — wait for it to become ready rather than throwing away
             * the preloaded bytes and forcing a full cold re-fetch over the network.
             */
            if let found = AudibleBridgePlayer.player(slot, from: bridge),
               let item = found.player.currentItem,
               found.player.currentItem === item,
               item.status != .failed,
               found.player.status != .failed,
               !NaviliteSpectrum.hasEnded(item) {
                reason = "\(how): \(entry.songId) is already buffering in \(slot), waiting for readiness"
                boundaryWhyNotWarm = reason
                awaitReady(slot: slot, entry: entry, target: target, how: how, waited: 0, token: token)
                return true
            }
            /*
             * The slot the app named refused the play — reported, then the entry's own URL is
             * fetched here rather than the boundary being lost: the app's slot may have been
             * unloaded or never have held this track, and "the warm slot was wrong" is not a reason
             * for the music to stop.
             */
            reason = "\(how): the slot holding \(entry.songId) would not play, so it is being fetched again here"
            boundaryWhyNotWarm = reason
        }
        if restart {
            // Restarting the current entry with no slot to restart from is nothing to fetch.
            fail("\(how): there is nothing on the player to restart")
            return false
        }
        if boundaryWhyNotWarm == nil {
            boundaryWhyNotWarm = "\(how): nothing held \(entry.songId) — no slot from the app and none from the look-ahead"
        }
        return fetch(entry: target, how: how, token: token)
    }

    /// The slot holding an entry, if anything does: the app's own warm slot for it, or this side's
    /// fetch window.
    private func holding(_ songId: String) -> String? {
        if let fetchWindow, fetchWindow.songId == songId { return fetchWindow.slot }
        for entry in queue where entry.songId == songId {
            if let slot = entry.slot { return slot }
        }
        return nil
    }

    /**
     * Fetch an entry here and play it — the path that makes the boundary total.
     *
     * The app warms three tracks around the one playing, and it is suspended when the app is away, so
     * past those three a boundary is a cold fetch. That used to be the end of the music. Here the
     * entry's own URL goes into this side's fetch slot through the plugin's own `preload`, and the
     * entry is played **once its item reports `.readyToPlay`** — the same state `preroll` needs, and
     * the state 1.9.8 played without looking at (which is the crash: a play issued on an item that
     * was not ready).
     */
    private func fetch(entry target: Int, how: String, token: Int) -> Bool {
        /*
         * A fetch loads a track into a slot of this side's own, over the network (v1.9.10): if the
         * statement that asked for it has been replaced, the slot it would fill belongs to a queue
         * nobody is walking any more, so nothing is loaded at all.
         */
        guard current(token: token) else { return false }
        guard let plugin = bridge?.plugin(withName: Self.audioPluginName) else {
            fail("\(how): the audio plugin is not on the bridge, so the next track could not be fetched here")
            return false
        }
        let entry = queue[target]
        let slot = fetchSlot()
        fetchIssuedAt = Date()
        guard preloadSlot(plugin: plugin, slot: slot, entry: entry) else {
            fail("\(how): the audio plugin does not answer to preload(assetId:assetPath:isUrl:), so \(entry.songId) could not be fetched here")
            return false
        }
        fetchWindow = (slot, entry.songId)
        reason = "\(how): nothing held \(entry.songId), so the native player is fetching it here"
        awaitReady(slot: slot, entry: entry, target: target, how: how, waited: 0, token: token)
        return true
    }

    /// The slot a fetch goes into: this side's window slot that is not the one playing.
    private func fetchSlot() -> String {
        for slot in Self.windowSlots where slot != audible?.assetId {
            return slot
        }
        // Both window slots are playing, which cannot happen — but it must not name the audible one.
        return Self.windowSlots.first ?? "navilite-native-fetch"
    }

    /**
     * Wait, with a deadline, until a fetched slot is ready — then play it.
     *
     * Nothing is issued before `.readyToPlay`, which is the crash of v1.9.8 written the other way
     * round: instead of `preroll` on an item that has not resolved, this is a plain poll of the two
     * states AVFoundation exposes, and the play happens when they say they are ready.
     */
    private func awaitReady(slot: String, entry: Entry, target: Int, how: String, waited: Double, token: Int) {
        /*
         * **Every rung of this poll is checked against the statement it started under (v1.9.10).**
         * This is the one place in the file where a fetch is in flight across turns of the run loop,
         * so it is the one place the app can genuinely get in first: `setQueue` is a statement, not an
         * increment, and a statement that has landed means the slot, the index and the entry this poll
         * is holding are all from a queue nobody is playing. Nothing is played, and the fetch is
         * reported as the boundary it no longer is.
         */
        guard current(token: token) else {
            reason = "\(how): the app stated a new queue while \(entry.songId) was being fetched here, so nothing was played"
            return
        }
        guard let found = AudibleBridgePlayer.player(slot, from: bridge), let item = found.player.currentItem else {
            if waited >= Self.fetchDeadline {
                fail("\(how): \(entry.songId) could not be fetched here within \(Self.fetchDeadline) s (the player holds no item for it)")
                return
            }
            after(Self.fetchStep) { [weak self] in
                self?.awaitReady(slot: slot, entry: entry, target: target, how: how, waited: waited + Self.fetchStep, token: token)
            }
            return
        }
        if item.status == .failed || found.player.status == .failed {
            let why = item.error?.localizedDescription ?? found.player.error?.localizedDescription ?? "no reason given by the player"
            fail("\(how): \(entry.songId) could not be fetched here (\(why))")
            return
        }
        guard item.status == .readyToPlay, found.player.status == .readyToPlay else {
            if waited >= Self.fetchDeadline {
                fail("\(how): \(entry.songId) was not ready to play within \(Self.fetchDeadline) s")
                return
            }
            after(Self.fetchStep) { [weak self] in
                self?.awaitReady(slot: slot, entry: entry, target: target, how: how, waited: waited + Self.fetchStep, token: token)
            }
            return
        }
        if playSlot(entry: entry, slot: slot, time: 0, how: how, token: token) {
            commit(target: target, slot: slot, entry: entry, how: how)
        } else {
            fail("\(how): \(entry.songId) was fetched here but the player refused to play it")
        }
    }

    private func after(_ seconds: Double, _ work: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    /// The entry played. The index, the audible slot and the app's own view of it all move together.
    ///
    /// No statement check of its own (v1.9.10): every caller reaches here in the **same turn of the
    /// main thread** as the `playSlot` that succeeded — which is where the statement was checked — so
    /// the check that let the play through is the check that applies here.
    private func commit(target: Int, slot: String, entry: Entry, how: String) {
        // The handed-off boundary has landed on a real slot: the card now matches `index` again.
        boundaryInFlight = false
        index = target
        audible = (slot, entry.songId)
        if fetchWindow?.slot == slot {
            fetchWindow = nil
        }
        advances += 1
        reason = "\(how) — the native player is playing \(entry.songId) (entry \(target + 1) of \(queue.count))"
        notifyListeners("advanced", data: ["songId": entry.songId, "assetId": slot, "index": target])
        // The card names the track that has just started, with the position and rate it starts at.
        refreshNowPlaying()
        // When the first frame is actually running (v2.0-beta.14) — the last of the five numbers.
        beginAudibleProbe(token: generation)
        // The boundary's own line in the persisted log (v2.0-beta.16), written **before** the
        // look-ahead is re-armed: `preloadAhead` replaces the record this one is about.
        recordBoundary(outcome: "taken")
        /*
         * The app's own player is now sounding this entry on screen, so the queue's paused items are
         * dropped and the handover reading is spent (finding 5). While the app is away the queue must
         * stay armed — it is the thing that takes the next boundary — so this is gated on `awake`.
         */
        if awake {
            awayResume = nil
            if awayQueue != nil, !awayItems.isEmpty {
                stopAwayQueue(why: "the app's own player is sounding this entry on screen, so the queue's items are dropped")
            }
        }
        preloadAhead(token: generation)
    }

    /* ---------------------------------------------- the away advance queue (v2.0-beta.17) */

    /// The entries the queue should hold ahead of the one playing: the next `awayAhead` of the
    /// published order, wrapping only when repeat is on.
    private func awayPlan() -> [Entry] {
        guard index >= 0, index < queue.count else { return [] }
        var plan: [Entry] = []
        var step = 1
        while plan.count < Self.awayAhead, step <= queue.count {
            var target = index + step
            if target >= queue.count {
                guard repeatMode == "all" else { break }
                target -= queue.count
            }
            if target != index, !plan.contains(where: { $0.songId == queue[target].songId }) {
                plan.append(queue[target])
            }
            step += 1
        }
        return plan
    }

    /// Attach the entries ahead of the one playing to the away queue — **while the app is awake**.
    ///
    /// The statement is the app's whole play order, so the queue is rebuilt from it rather than
    /// appended to: an entry the app has cancelled (a warm track it no longer holds, or one it took out
    /// of the order) must not stay attached to a player that would still sound it later. While the
    /// queue owns the sound it is only topped up, because rebuilding it would stop the audible track.
    private func armAwayQueue(token: Int) {
        guard current(token: token) else { return }
        guard !awayOwnsAudible else {
            topUpAwayQueue(token: token)
            return
        }
        if awayQueue == nil {
            let player = AVQueuePlayer()
            // The same rule the audible slot has: start on the first seconds that arrive.
            player.automaticallyWaitsToMinimizeStalling = false
            player.volume = 1.0
            awayQueue = player
        }
        guard let queuePlayer = awayQueue else { return }
        /*
         * **A reading about items that are about to go is dropped with them (v2.0-beta.18).** This ran
         * on every statement and re-armed the queue while `awayResume` kept naming a position in items
         * it had just removed, so the next statement could publish a position that no longer existed.
         */
        if awayResume != nil {
            record("queue-resume-dropped", [
                "songId": awayResume?.songId ?? "",
                "why": "the queue was re-armed, so the position it handed back describes items that no longer exist"
            ])
            awayResume = nil
        }
        queuePlayer.removeAllItems()
        awayEntries = []
        awayCursor = -1
        for entry in awayPlan() {
            guard let url = URL(string: entry.url) else { continue }
            let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
            let item = AVPlayerItem(asset: asset)
            guard queuePlayer.canInsert(item, after: nil) else { continue }
            queuePlayer.insert(item, after: nil)
            awayEntries.append(entry.songId)
            awayItems.append(item)
        }
        if !awayEntries.isEmpty {
            record("queue-armed", [
                "entries": awayEntries.joined(separator: ","),
                "awake": awake,
                "why": "the entries after the one playing are attached to the away queue now, so that boundary is AVFoundation's advance instead of a fetch"
            ])
        }
    }

    /// Add whatever the published order now has after the queue's tail, so more than one away boundary
    /// is covered. Only the **unplayed** tail is compared, so an entry the queue legitimately sounds
    /// twice (repeat all) is still attached a second time.
    private func topUpAwayQueue(token: Int) {
        guard current(token: token), awayOwnsAudible, let queuePlayer = awayQueue else { return }
        /*
         * **Cancel by identity, in the owned state too (finding 4).** Only appending here left an entry
         * the app had taken out of the order attached to a player that would still sound it later: the
         * statement is the app's current order, so anything attached after the cursor that is no longer
         * in `awayPlan()` is a cancellation and comes out of the queue. The item being heard is never
         * touched — only what is attached after it.
         */
        let wanted = Set(awayPlan().map { $0.songId })
        var removed = 0
        for at in stride(from: awayEntries.count - 1, through: max(awayCursor + 1, 0), by: -1) {
            guard at < awayEntries.count, at < awayItems.count else { continue }
            guard !wanted.contains(awayEntries[at]) else { continue }
            queuePlayer.remove(awayItems[at])
            awayEntries.remove(at: at)
            awayItems.remove(at: at)
            removed += 1
        }
        let from = min(max(awayCursor + 1, 0), awayEntries.count)
        let attached = Set(awayEntries[from...])
        var added = 0
        /*
         * **A dead entry is not attached again (v2.0-beta.18).** A track that failed to play from this
         * queue is dropped from `awayEntries`, and without this gate the next statement's top-up put it
         * straight back - removed and re-created once per statement while the app was away, for a 404
         * that will never play. The failure was already reported; the app fetches it at the boundary.
         */
        let skipped = awayPlan().filter { !attached.contains($0.songId) && awayFailed.contains($0.songId) }.map { $0.songId }
        if !skipped.isEmpty {
            record("queue-topup-skip", [
                "skipped": skipped.joined(separator: ","),
                "why": "these entries already failed to play from this queue, so they are not attached again"
            ])
        }
        for entry in awayPlan() where !attached.contains(entry.songId) && !awayFailed.contains(entry.songId) {
            guard let url = URL(string: entry.url) else { continue }
            let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
            let item = AVPlayerItem(asset: asset)
            guard queuePlayer.canInsert(item, after: nil) else { continue }
            queuePlayer.insert(item, after: nil)
            awayEntries.append(entry.songId)
            awayItems.append(item)
            added += 1
        }
        if added > 0 || removed > 0 {
            record("queue-topup", ["added": added, "removed": removed, "attached": awayEntries.count,
                                   "why": "the queue was topped up (and any entry the app has cancelled was taken out) so the next boundary is still an advance"])
        }
    }

    /// The seam, asked before any slot and before any fetch: **does the queue already hold the entry
    /// this boundary needs?** If it does, AVFoundation playing its own next item is the whole boundary —
    /// no preload, no readiness poll, no network call from here.
    ///
    /// A queue whose item will not load is a refused play, and it is reported as one: the entry is
    /// taken out of the queue so the fallback is not queued behind a dead item, and the caller's
    /// existing `holding`/`fetch` path takes the boundary exactly as it did before this release.
    @discardableResult
    private func awayStart(entry: Entry, target: Int, how: String, token: Int) -> Bool {
        guard current(token: token) else { return false }
        guard let queuePlayer = awayQueue, awayCursor < 0,
              let first = awayEntries.first, first == entry.songId else { return false }
        guard let item = queuePlayer.currentItem else { return false }
        /*
         * A dead item is a refusal, whether it reports it now or failed before it was current (finding
         * 1: the status read alone missed a 404 that landed after `play()` was issued, because the
         * notification for that arrives later and is handled in `awayItemDidFail`; `awayFailed` is how
         * that earlier verdict survives to this seam).
         */
        if item.status == .failed || queuePlayer.status == .failed || awayFailed.contains(entry.songId) {
            let why = awayFailed.contains(entry.songId)
                ? "its item failed to play to its end"
                : (item.error?.localizedDescription ?? queuePlayer.error?.localizedDescription ?? "no reason given by the player")
            record("queue-refused", ["songId": entry.songId, "slot": Self.awaySlotName, "why": why])
            queuePlayer.remove(item)
            awayEntries.removeFirst()
            if !awayItems.isEmpty { awayItems.removeFirst() }
            reason = "\(how): the away queue's item for \(entry.songId) would not load (\(why)), so it is being fetched again here"
            boundaryWhyNotWarm = reason
            return false
        }
        awayCursor = 0
        awayOwnsAudible = true
        boundaryPath = "queue"
        // The first away seam is played from here, and the log says so (finding 3).
        boundaryAppCode = true
        queuePlayer.play()
        commitQueue(entry: entry, target: target, how: how)
        return true
    }

    /// The boundary the queue took. The same move as `commit`, for a slot no plugin asset holds: the
    /// index and the entry move together, the card is re-stated from the queue's own item, and the
    /// boundary line says `path: "queue"` because no fetch and no `playSlot` happened.
    private func commitQueue(entry: Entry, target: Int, how: String) {
        boundaryInFlight = false
        index = target
        audible = (Self.awaySlotName, entry.songId)
        advances += 1
        reason = "\(how) — AVFoundation advanced the away queue itself to \(entry.songId) (entry \(target + 1) of \(queue.count), no fetch)"
        notifyListeners("advanced", data: ["songId": entry.songId, "assetId": "", "index": target, "queue": true])
        refreshNowPlaying()
        recordBoundary(outcome: "taken")
        topUpAwayQueue(token: generation)
    }

    /// Stop the queue and let the app's own player own the sound again: the app has come back and
    /// re-stated the queue, and two players sounding one track is never the answer.
    private func stopAwayQueue(why: String) {
        guard let queuePlayer = awayQueue else { return }
        let owned = awayOwnsAudible
        queuePlayer.pause()
        queuePlayer.removeAllItems()
        awayOwnsAudible = false
        awayCursor = -1
        awayEntries = []
        awayItems = []
        if owned {
            record("queue-stopped", ["why": why])
        }
    }

    /// Give the sound back to the app's own player **without tearing the queue down first** (finding 5).
    ///
    /// The return path used to `pause` + `removeAllItems` the sounding queue before the web layer had
    /// played anything, so the music stopped and then waited for the app's own start to reach the
    /// network — an audible hole at every return. This pauses (exactly one player is sounding), keeps
    /// the items (a quick re-suspend is then instant), and writes down the entry, index and position the
    /// queue had reached, so the app can resume *there* instead of where its own clock last stood.
    private func handOverAwayQueue(why: String) {
        guard let queuePlayer = awayQueue, awayOwnsAudible else { return }
        let seconds = queuePlayer.currentTime().seconds
        let positionMs = seconds.isFinite && seconds > 0 ? Int((seconds * 1000).rounded()) : 0
        let songId = awayCursor >= 0 && awayCursor < awayEntries.count ? awayEntries[awayCursor] : (audible?.songId ?? "")
        awayResume = (songId: songId, index: index, positionMs: positionMs)
        queuePlayer.pause()
        awayOwnsAudible = false
        record("queue-handover", [
            "songId": songId, "index": index, "positionMs": positionMs,
            "attached": awayEntries.count,
            "why": why
        ])
    }

    /**
     * **The app asks what the queue reached, and takes the sound back (v2.0-beta.18).**
     *
     * The return path needs the queue's own position *and* needs the queue stopped before the app's
     * player starts, and it needs both in one answer: this performs the handover (`handOverAwayQueue`
     * pauses, so exactly one player is sounding - see `audiblePlayer`) and returns the reading, which
     * the app adopts by starting its own slot at that position.
     */
    @objc func handover(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            if self.awayOwnsAudible {
                self.handOverAwayQueue(why: "the app asked what the away queue reached on the way back, so its own player takes the sound from there")
            }
            let reading = self.awayResume
            call.resolve([
                "songId": reading?.songId ?? "",
                "index": reading?.index ?? -1,
                "positionMs": reading?.positionMs ?? 0
            ])
        }
    }

    /**
     * **And the app's own player has started that entry, so the queue lets go (v2.0-beta.18).**
     *
     * Called only after the start has committed, never before: while the reading is pending the paused
     * items are the only thing that still knows the position, and a statement that rebuilt the queue
     * first would drop it. Clearing it here is what makes the next statement re-arm from the app's own
     * index instead of the queue's.
     */
    @objc func releaseHandover(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            let had = self.awayResume != nil
            if had {
                self.record("queue-handover-released", [
                    "songId": self.awayResume?.songId ?? "",
                    "positionMs": self.awayResume?.positionMs ?? 0,
                    "why": "the app's own player has started that entry at that position, so the queue lets go"
                ])
                self.awayResume = nil
            }
            call.resolve(["released": had])
        }
    }

    /// Whether the away queue already holds an entry ahead of the one sounding - the fact the look-ahead — the fact the look-ahead
    /// checks so it does not decode the same track a second time (finding 6).
    private func awayHoldsEntry(_ songId: String) -> Bool {
        guard awayQueue != nil else { return false }
        let from = max(awayCursor + 1, 0)
        guard from < awayEntries.count else { return false }
        return awayEntries[from...].contains(songId)
    }

    /// The player actually making the sound: the away queue while it owns the audible item, else the
    /// plugin slot the app named. Every reader of the audible state goes through here, so a track the
    /// queue advanced itself to is reported with its own duration, position and rate.
    private func audiblePlayer() -> AVPlayer? {
        /*
         * **The handover's reading outlives the flag that spends it (v2.0-beta.18).**
         * `handOverAwayQueue` sets `awayOwnsAudible` false and leaves the queue PAUSED on the item it was
         * sounding - that paused queue is the only thing that still knows where the track was. Reading
         * the app's own slot instead (which has not been loaded with this entry at all) reported its own
         * stale position and threw the queue's truth away with the flag, so the reading is kept for as
         * long as `awayResume` names it.
         */
        if awayOwnsAudible || awayResume != nil, let awayQueue { return awayQueue }
        guard let audible else { return nil }
        return AudibleBridgePlayer.player(audible.assetId, from: bridge)?.player
    }

    /**
     * Fetch the entry **after** the one now playing, so the next boundary is a play rather than a
     * fetch. This is the treadmill v1.9.8 was missing in the other direction: 1.9.8 waited for the
     * app to arm the next slot and had nothing to do when the app could not.
     */
    private func preloadAhead(token: Int) {
        guard current(token: token) else { return }
        guard !awake, index >= 0, index < queue.count else { return }
        var target = index + 1
        if target >= queue.count {
            if repeatMode == "all" { target = 0 } else { return }
        }
        let entry = queue[target]
        loadArtwork(for: entry)
        /*
         * **One decode, not two (finding 6).** When the away queue already holds this entry, the
         * boundary will be AVFoundation's own advance — so a fetch into a plugin slot here is a second
         * decode of the same track, competing with the one that matters for the same connection. While
         * the app is away the listener hears whichever loses as a slow boundary.
         */
        if awayHoldsEntry(entry.songId) {
            record("ahead-skipped", ["songId": entry.songId, "attached": awayEntries.count,
                                     "why": "the away queue already holds this entry, so the look-ahead does not decode it a second time"])
            return
        }
        /*
         * **"Something holds it" is not "it can start" (v2.0-beta.16).** The old early return treated
         * a slot's name as a promise. The look-ahead's own record is the honest test: if this side
         * loaded that entry and its prime never pulled a buffer, the slot is a name with no audio in
         * it, and the boundary would pay a cold fetch through it — the ten seconds. It is loaded
         * again here instead, and only into a slot of this side's own, and only while the audible
         * track has long enough left that the reload cannot be heard.
         */
        if let holding = holding(entry.songId) {
            guard let plugin = bridge?.plugin(withName: Self.audioPluginName) else { return }
            guard Self.windowSlots.contains(holding) else { return }
            guard let state = ahead, state.songId == entry.songId,
                  state.gaveUp != nil || state.buffered < Self.primeBuffer else { return }
            guard Self.remainingSeconds(from: audible?.assetId, bridge: bridge) > 20 else { return }
            record("reload", [
                "slot": holding,
                "songId": entry.songId,
                "buffered": (state.buffered * 10).rounded() / 10,
                "why": state.gaveUp ?? "the prime stopped short of a startable buffer"
            ])
            guard preloadSlot(plugin: plugin, slot: holding, entry: entry, preroll: true) else { return }
            fetchWindow = (holding, entry.songId)
            ahead = Ahead(slot: holding, songId: entry.songId, issuedAt: Date(), readyAt: nil, primedAt: nil,
                          buffered: 0, likely: false, attempts: 0, gaveUp: nil)
            primeAhead(slot: holding, songId: entry.songId, token: token)
            return
        }
        guard let plugin = bridge?.plugin(withName: Self.audioPluginName) else { return }
        let slot = fetchSlot()
        // It fetches exactly the entry after the audible one: that is the boundary, so it is primed.
        guard preloadSlot(plugin: plugin, slot: slot, entry: entry, preroll: true) else { return }
        fetchWindow = (slot, entry.songId)
        ahead = Ahead(slot: slot, songId: entry.songId, issuedAt: Date(), readyAt: nil, primedAt: nil,
                      buffered: 0, likely: false, attempts: 0, gaveUp: nil)
        record("ahead-issued", ["slot": slot, "songId": entry.songId])
        // The vendor's preroll fires in the same turn as the preload, before its item has resolved;
        // this is the same prime, issued at the one moment it can actually load anything — and kept
        // up until the slot holds a buffer the boundary can start from (v2.0-beta.16).
        primeAhead(slot: slot, songId: entry.songId, token: token)
    }

    /**
     * Prime the slot the next boundary will start, **once its item has resolved** (v2.0-beta.14).
     *
     * `preroll(atRate:)` on an `AVPlayerItem` whose `status` is still `.unknown` returns without
     * loading a byte — it cannot, the asset has not resolved. The vendor's own prime (patch 12,
     * `RemoteAudioAsset.prerollForBoundary`) is called from `preload` in the *same turn* as the asset
     * is constructed, and the construction only queues the player, so that call is the one that
     * loads nothing: the slot reads as warm (`fetchWindow` names it, `holding()` finds it) while it
     * holds no media, and the boundary then pays the connection and the first buffer — the seconds of
     * silence after the card has already shown the new track.
     *
     * This is that prime, moved to the state that can perform it: the item is asked every 50 ms (the
     * same step the readiness poll uses) until it reports `.readyToPlay`, then `preroll(atRate: 1.0)`
     * fills the buffer while the slot is still paused and silent. **Only the immediate next entry** —
     * one connection, so the audible stream is not starved.
     *
     * **v2.0-beta.16 — the prime is kept up until the slot can actually start.** A single `preroll`
     * loads what it loads and stops: a paused player does not keep pulling, so the item that was
     * primed at the head of a three-minute track could still be holding a second of audio at the
     * boundary, and `.readyToPlay` — the only thing the old prime (and the readiness poll) ever
     * asked — is true for an item with no audio at all. So the ask is repeated once a second and the
     * item's own `loadedTimeRanges` are read every 50 ms until it covers three seconds, at which
     * point the boundary is a play and nothing else. What it reached is written into the boundary
     * log either way; a prime that never gets there says why, because that sentence is the answer to
     * "why was the slot that was supposed to be warm not startable".
     */
    private func primeAhead(slot: String, songId: String, token: Int, attempt: Int = 0) {
        guard current(token: token), !awake, slot != audible?.assetId else { return }
        guard let found = AudibleBridgePlayer.player(slot, from: bridge), let item = found.player.currentItem else {
            guard attempt < Self.primeAttempts else {
                finishPrime(why: "the slot never held an item to prime")
                return
            }
            after(Self.primeStep) { [weak self] in
                self?.primeAhead(slot: slot, songId: songId, token: token, attempt: attempt + 1)
            }
            return
        }
        if item.status == .failed || found.player.status == .failed {
            finishPrime(why: "the item failed to load (\(item.error?.localizedDescription ?? "no reason given by the player"))")
            return
        }
        // Nothing is issued on an item that has played to its end (the crash of v1.9.8, again).
        if NaviliteSpectrum.hasEnded(item) {
            finishPrime(why: "the item had already played to its end")
            return
        }
        let buffered = Self.bufferedSeconds(item)
        let likely = item.isPlaybackLikelyToKeepUp
        if ahead?.songId == songId {
            if ahead?.readyAt == nil, item.status == .readyToPlay, found.player.status == .readyToPlay {
                ahead?.readyAt = Date()
            }
            ahead?.buffered = buffered
            ahead?.likely = likely
            ahead?.attempts = attempt
        }
        /*
         * **The gate is the buffer, not the status (v2.0-beta.16).** `.readyToPlay` means the asset's
         * metadata resolved; it says nothing about whether there is a second of audio to render. A
         * boundary that started from an item in that state was silent from the moment of the play
         * until the network caught up — with `automaticallyWaitsToMinimizeStalling = false` the player
         * even reports itself as playing while it starves, which is why the old row looked healthy.
         */
        if buffered >= Self.primeBuffer, ahead?.primedAt != nil {
            ahead?.gaveUp = nil
            finishPrime(why: nil)
            return
        }
        guard attempt < Self.primeAttempts else {
            finishPrime(why: item.status == .readyToPlay
                ? "the item resolved but pulled only \(String(format: "%.1f", buffered)) s of audio"
                : "the item never resolved (status \(NaviliteSpectrum.statusName(item.status)))")
            return
        }
        /*
         * Ask for the bytes without starting. A paused player stops pulling once the previous preroll
         * has done all it can, so the ask is repeated (once a second) while the item is resolved and
         * the buffer is short. This is the one lever that fills the slot early instead of at the seam.
         */
        if item.status == .readyToPlay, found.player.status == .readyToPlay, attempt % 20 == 0 {
            if ahead?.primedAt == nil { ahead?.primedAt = Date() }
            found.player.preroll(atRate: 1.0) { _ in }
        }
        after(Self.primeStep) { [weak self] in
            self?.primeAhead(slot: slot, songId: songId, token: token, attempt: attempt + 1)
        }
    }

    /// Close the look-ahead's account: one line in the log, whether it reached a startable buffer or
    /// ran out of time trying (`why` non-nil). Nothing is played, stopped or unloaded here.
    private func finishPrime(why: String?) {
        guard var state = ahead, state.gaveUp == nil else { return }
        state.gaveUp = why
        ahead = state
        var facts: [String: Any] = [
            "slot": state.slot,
            "songId": state.songId,
            "attempts": state.attempts,
            "buffered": (state.buffered * 10).rounded() / 10,
            "likely": state.likely,
            "startable": why == nil
        ]
        if let ready = state.readyAt {
            facts["readyMs"] = Int((ready.timeIntervalSince(state.issuedAt) * 1000).rounded())
        }
        if let primed = state.primedAt {
            facts["primeMs"] = Int((primed.timeIntervalSince(state.issuedAt) * 1000).rounded())
        }
        if let why { facts["why"] = why }
        record("ahead", facts)
    }

    /// How far an item's own buffered ranges reach, in seconds from its start — the fact the old
    /// readiness poll never asked for (v2.0-beta.16).
    private static func bufferedSeconds(_ item: AVPlayerItem) -> Double {
        var furthest = 0.0
        for value in item.loadedTimeRanges {
            let range = value.timeRangeValue
            let start = CMTimeGetSeconds(range.start)
            let length = CMTimeGetSeconds(range.duration)
            guard start.isFinite, length.isFinite else { continue }
            furthest = max(furthest, start + length)
        }
        return furthest
    }

    /**
     * Whether a player is stalled over its item — the state the ten-second silence actually is.
     *
     * `AVPlayerItem.isPlaybackStalled` is gone from the current SDK (v2.0-beta.16, Xcode 26), so the
     * same fact is read from the two properties that still exist: an item whose buffer is empty and
     * which the player does not believe it can keep up, or a player that is waiting to minimise
     * stalling. Read only for the diagnostics line — nothing in the boundary depends on it.
     */
    private static func stalled(_ item: AVPlayerItem?, _ player: AVPlayer) -> Bool {
        guard let item else { return false }
        // A player that has run dry over an item it can no longer keep up with, or an item whose
        // buffer is empty while the player says it is waiting — either is the silent seam.
        if item.isPlaybackBufferEmpty && !item.isPlaybackLikelyToKeepUp { return true }
        return player.timeControlStatus == .waitingToPlayAtSpecifiedRate && item.isPlaybackBufferEmpty
    }

    /// How much of the audible track is left, in seconds (0 when it cannot be read). The look-ahead
    /// uses it to decide whether a slot may be reloaded without the reload being heard.
    private static func remainingSeconds(from assetId: String?, bridge: CAPBridgeProtocol?) -> Double {
        guard let assetId, let found = AudibleBridgePlayer.player(assetId, from: bridge),
              let item = found.player.currentItem,
              item.status == .readyToPlay else { return 0 }
        let duration = item.duration.seconds
        let position = found.player.currentTime().seconds
        guard duration.isFinite, position.isFinite, duration > 0, position >= 0 else { return 0 }
        return max(0, duration - position)
    }

    /* ------------------------------------------------- the boundary log (v2.0-beta.16) */

    /// Append one record to the persisted log. A log that cannot be written is not a boundary that
    /// failed: nothing here throws and nothing here waits.
    private func record(_ kind: String, _ facts: [String: Any] = [:]) {
        var line: [String: Any] = facts
        line["kind"] = kind
        line["at"] = Int((Date().timeIntervalSince1970 * 1000).rounded())
        line["awake"] = awake
        line["index"] = index
        line["generation"] = generation
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        logCount += 1
        logTail.append(text)
        if logTail.count > Self.logTailLines { logTail.removeFirst(logTail.count - Self.logTailLines) }
        appendLogLine(text)
    }

    /**
     * One line into the persisted log, from outside the plugin (v2.0-beta.16).
     *
     * The scene callbacks (see `SceneDelegate.swift`) are the only evidence that the system asked
     * this app to come to the front, and they happen whether or not the web layer is alive to read
     * them — so they go into the same file as the boundaries. That is the artifact the owner can
     * hand over, and the one a run with no scene line at all answers plainly: nothing arrived.
     */
    static func appendSceneLine(_ facts: [String: Any]) {
        var line: [String: Any] = facts
        line["kind"] = "scene"
        line["at"] = Int((Date().timeIntervalSince1970 * 1000).rounded())
        guard let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent(logName),
              let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            manager.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data((text + "\n").utf8))
    }

    private var logFileURL: URL? {
        return FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent(Self.logName)
    }

    private func appendLogLine(_ text: String) {
        guard let url = logFileURL else { return }
        let manager = FileManager.default
        if let size = (try? manager.attributesOfItem(atPath: url.path))?[.size] as? NSNumber,
           size.intValue > Self.logRotateBytes {
            let previous = url.appendingPathExtension("1")
            try? manager.removeItem(at: previous)
            try? manager.moveItem(at: url, to: previous)
        }
        if !manager.fileExists(atPath: url.path) {
            manager.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data((text + "\n").utf8))
    }

    /// The whole log, as lines, for the app's own copy-out (v2.0-beta.16).
    private func logLines() -> [String] {
        guard let url = logFileURL, let text = try? String(contentsOf: url, encoding: .utf8) else {
            return logTail
        }
        return text.split(separator: "\n").map(String.init)
    }

    /**
     * The boundary log, for the app's copy-out (v2.0-beta.16).
     *
     * The owner cannot read a row on a screen while driving, and every round of this defect so far was
     * diagnosed from source because the phone's own numbers never left the phone. This hands them
     * over: the file's path, its every line, and the last few on their own for the row.
     */
    @objc func boundaries(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            let lines = self.logLines()
            call.resolve([
                "path": self.logFileURL?.path ?? "",
                "lines": lines,
                "count": lines.count,
                "tail": Array(lines.suffix(5))
            ])
        }
    }

    /// One line summarising the boundary that has just been taken or refused, with every fact that
    /// tells a warm seam from a cold one.
    private func recordBoundary(outcome: String) {
        guard let start = boundaryStart else { return }
        func ms(_ at: Date?) -> Int {
            guard let at else { return -1 }
            return Int((at.timeIntervalSince(start) * 1000).rounded())
        }
        var facts: [String: Any] = [
            "outcome": outcome,
            "path": boundaryPath ?? (fetchIssuedAt == nil ? "warm" : "fetch"),
            "cardMs": ms(cardAnnouncedAt),
            "fetchMs": ms(fetchIssuedAt),
            "readyMs": ms(readyAt),
            "playMs": ms(playIssuedAt),
            "audibleMs": ms(audibleAt),
            "slot": audible?.assetId ?? "",
            "entry": index + 1,
            "queued": queue.count,
            "reason": reason
        ]
        /*
         * **Who was at the seam (finding 3).** `path: "queue"` means the queue took it; it does not mean
         * no app code ran. The first away boundary is hand-walked (`awayStart` reads the status and
         * issues the play), and only from the second one on is the advance AVFoundation's own — the log
         * says which, per boundary, so the claim can be checked instead of believed.
         */
        facts["appCodeAtSeam"] = boundaryAppCode
            ? "yes — the first away seam is played by this file after it checked the item"
            : (boundaryPath == "queue" ? "no — AVFoundation advanced to its own next item" : "n/a — no queue boundary")
        if index >= 0, index < queue.count {
            facts["songId"] = queue[index].songId
            facts["title"] = queue[index].title
        }
        if let ahead {
            facts["aheadSlot"] = ahead.slot
            facts["aheadSong"] = ahead.songId
            facts["aheadBuffered"] = (ahead.buffered * 10).rounded() / 10
            facts["aheadStartable"] = ahead.gaveUp == nil
            if let gave = ahead.gaveUp { facts["aheadWhy"] = gave }
        } else {
            facts["aheadSlot"] = "none"
        }
        facts["whyNotWarm"] = boundaryWhyNotWarm ?? "n/a — a slot held the next entry and did not refuse the play"
        if let player = audiblePlayer(), let item = player.currentItem {
            facts["bufferedAtPlay"] = (Self.bufferedSeconds(item) * 10).rounded() / 10
            facts["likely"] = item.isPlaybackLikelyToKeepUp
            facts["stalled"] = Self.stalled(item, player)
            facts["duration"] = item.status == .readyToPlay ? item.duration.seconds : -1
        }
        record("boundary", facts)
    }

    /// Start the boundary's clock: the end of the finished item is t 0, and the four moments after it
    /// are each recorded where they happen (v2.0-beta.14).
    private func beginBoundary() {
        boundaryStart = Date()
        cardAnnouncedAt = nil
        fetchIssuedAt = nil
        readyAt = nil
        playIssuedAt = nil
        audibleAt = nil
        boundaryWhyNotWarm = nil
        // Which route this boundary took is decided by the route, never inherited from the last one.
        boundaryPath = nil
        boundaryAppCode = false
    }

    /// The last boundary, in milliseconds from its item end — the five numbers §6 asks for. `-1`
    /// is "did not happen on this boundary": a warm start has no fetch, and a boundary still in
    /// flight has no audible frame yet.
    ///
    /// **Only an away boundary is timed here** (v2.0-beta.15): `beginBoundary()` is reached from
    /// `take()`, which runs only while the app is away. So the reading travels with its own clock —
    /// `startedAt` (epoch ms) and `ageMs` (how long ago that boundary began) — and the row names it as
    /// the last *away* boundary, so a stale reading can never be mistaken for the current one.
    private func boundaryTimeline() -> [String: Any] {
        guard let start = boundaryStart else {
            return [
                "path": "none", "startedAt": -1, "ageMs": -1,
                "cardMs": -1, "fetchMs": -1, "readyMs": -1, "playMs": -1, "audibleMs": -1,
                "pathDetail": "no away boundary has been taken yet",
                "whyNotWarm": "", "buffered": -1, "ahead": self.aheadSummary()
            ]
        }
        func ms(_ at: Date?) -> Int {
            guard let at else { return -1 }
            return Int((at.timeIntervalSince(start) * 1000).rounded())
        }
        var facts: [String: Any] = [
            "path": boundaryPath ?? (fetchIssuedAt == nil ? "warm" : "fetch"),
            "startedAt": Int((start.timeIntervalSince1970 * 1000).rounded()),
            "ageMs": Int((Date().timeIntervalSince(start) * 1000).rounded()),
            "cardMs": ms(cardAnnouncedAt),
            "fetchMs": ms(fetchIssuedAt),
            "readyMs": ms(readyAt),
            "playMs": ms(playIssuedAt),
            "audibleMs": ms(audibleAt),
            /*
             * The two facts the old row never carried (v2.0-beta.16): what the play had to render
             * with, and why the slot that was supposed to be warm was not startable. `path` alone
             * could not tell a warm seam from a warm-looking one.
             */
            "pathDetail": fetchIssuedAt == nil ? "the seam was a play" : "the seam paid a fetch",
            "whyNotWarm": boundaryWhyNotWarm ?? "",
            "ahead": aheadSummary()
        ]
        if let item = audiblePlayer()?.currentItem {
            facts["buffered"] = (Self.bufferedSeconds(item) * 10).rounded() / 10
            facts["likely"] = item.isPlaybackLikelyToKeepUp
        } else {
            facts["buffered"] = -1
        }
        return facts
    }

    /// What the look-ahead holds for the next boundary, in one phrase for the row.
    private func aheadSummary() -> String {
        guard let ahead else { return "none" }
        let buffered = String(format: "%.1f", ahead.buffered)
        if let gave = ahead.gaveUp {
            return "\(ahead.slot) NOT startable — \(buffered)s buffered (\(gave))"
        }
        return "\(ahead.slot) \(buffered)s buffered, startable"
    }

    /// When the audible player is actually running: `.playing` **and** its clock off zero. Bounded,
    /// silent, and read-only — 50 ms for up to 5 s (v2.0-beta.14).
    private func beginAudibleProbe(token: Int, attempt: Int = 0) {
        guard current(token: token), let audible,
              let found = AudibleBridgePlayer.player(audible.assetId, from: bridge) else { return }
        let item = found.player.currentItem
        let position = found.player.currentTime().seconds
        /*
         * Sound, not "the player says it is playing" (v2.0-beta.16): every item here is created with
         * `automaticallyWaitsToMinimizeStalling = false`, so a play issued on an unbuffered item
         * reports `.playing` and a clock that creeps forward while nothing is audible — which is how a
         * ten-second silence could read as an immediate start in the old row. The clock has to be a
         * quarter second in and the item must not be stalled before this counts as the first sound.
         */
        if found.player.timeControlStatus == .playing, position > 0.25,
           !Self.stalled(item, found.player) {
            audibleAt = Date()
            if let start = boundaryStart {
                record("audible", [
                    "ms": Int((Date().timeIntervalSince(start) * 1000).rounded()),
                    "slot": audible.assetId,
                    "buffered": item.map { (Self.bufferedSeconds($0) * 10).rounded() / 10 } ?? -1,
                    "likely": item?.isPlaybackLikelyToKeepUp ?? false,
                    "stalled": Self.stalled(item, found.player)
                ])
            }
            return
        }
        guard attempt < Self.audibleProbeAttempts else {
            /*
             * Five seconds after the play and still nothing audible: the state itself is the evidence
             * — a player that says `.playing` over an item that is stalled is exactly the silence the
             * owner hears, and this line is what tells it apart from a boundary that never started.
             */
            record("audible-gave-up", [
                "attempts": attempt,
                "position": position.isFinite ? position : -1,
                "control": String(describing: found.player.timeControlStatus),
                "stalled": Self.stalled(item, found.player),
                "buffered": item.map { (Self.bufferedSeconds($0) * 10).rounded() / 10 } ?? -1
            ])
            return
        }
        after(Self.fetchStep) { [weak self] in
            self?.beginAudibleProbe(token: token, attempt: attempt + 1)
        }
    }

    /**
     * Unload a named slot from the audio plugin before re-using it (v2.0-beta.11).
     *
     * `NativeAudio` rejects `preload` calls if the assetId already exists in `audioList`.
     * Explicitly unloading frees the previous track's AVPlayer and clears the entry from `audioList`.
     */
    private func unloadSlot(plugin: CAPPlugin, slot: String) {
        guard plugin.responds(to: Self.unloadSelector), let method = plugin.method(for: Self.unloadSelector) else {
            return
        }
        guard let call = CAPPluginCall(
            callbackId: "navilite-native-unload",
            methodName: "unload",
            options: ["assetId": slot],
            success: { _, _ in },
            error: { _ in }
        ) else { return }
        typealias UnloadIMP = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        let unload = unsafeBitCast(method, to: UnloadIMP.self)
        unload(plugin, Self.unloadSelector, call)
    }

    /**
     * One entry into one of this side's own slots, **through the audio plugin's own `preload`**.
     *
     * The metadata goes with it so the lock screen names the track that is being fetched rather than
     * the one that ended, which is the same reason the play goes through the plugin.
     *
     * With `preroll` the vendor is asked to prime the slot for an immediate start (patch 13). Only a
     * boundary asks for it: `fetch()` is about to play the slot itself, where priming is pointless.
     */
    private func preloadSlot(plugin: CAPPlugin, slot: String, entry: Entry, preroll: Bool = false) -> Bool {
        guard plugin.responds(to: Self.preloadSelector), let method = plugin.method(for: Self.preloadSelector) else {
            return false
        }
        unloadSlot(plugin: plugin, slot: slot)
        var metadata: [String: String] = ["title": entry.title, "artist": entry.artist, "album": entry.album]
        if let artworkUrl = entry.artworkUrl { metadata["artworkUrl"] = artworkUrl }
        var options: [String: Any] = [
            "assetId": slot,
            "assetPath": entry.url,
            "isUrl": true,
            "notificationMetadata": metadata
        ]
        if preroll { options["preroll"] = true }
        let call: CAPPluginCall = CAPPluginCall(
            callbackId: "navilite-native-fetch",
            methodName: "preload",
            options: options,
            success: { _, _ in },
            error: { _ in }
        )
        typealias PreloadIMP = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        let preload = unsafeBitCast(method, to: PreloadIMP.self)
        preload(plugin, Self.preloadSelector, call)
        return true
    }

    /**
     * Play one entry from one named slot, **through the audio plugin's own `play(assetId:time:)`**.
     *
     * The runtime call is deliberate and it is the mirror image of the reflective read the spectrum
     * does: the slot is the plugin's asset, and the plugin's method is what keeps its own record of
     * which asset is playing, the Now Playing card and its position timer in step with the sound. A
     * write straight to the `AVPlayer` would make the lock screen name the track that just ended.
     *
     * **The whole precondition is checked first, in the same turn as the call (v1.9.10).** v1.9.9
     * excluded only a `.failed` player or item, which is not the state a start needs and does not
     * cover the two states that actually took the app down:
     *
     *   - the statement this play belongs to must still be the app's current one (`token`);
     *   - the player and the item must both be `.readyToPlay` — the pair a start needs, and the pair
     *     1.9.8 played without looking at;
     *   - the item must still be **the player's own item**;
     *   - the item must **not have played to its end**: `.readyToPlay` stays true for the whole life
     *     of an item, so by status alone a finished track reads like a fresh one, and the owner's
     *     "it crashes when i go back to the app after the song ends in the background" is exactly a
     *     start issued against one.
     *
     * A slot that cannot be played here answers `false`, and the caller fetches the entry instead —
     * never a silent stop.
     */
    private func playSlot(entry: Entry, slot: String?, time: Double, how: String, token: Int) -> Bool {
        guard current(token: token) else {
            reason = "\(how): the app has stated a new queue since this boundary was taken, so the player was not asked for \(entry.songId)"
            return false
        }
        guard let plugin = bridge?.plugin(withName: Self.audioPluginName) else {
            reason = "the audio plugin is not on the bridge, so \(how) could not be taken here"
            return false
        }
        guard let slot, !slot.isEmpty else {
            reason = "no slot was named for \(entry.songId), so \(how) could not be taken here"
            return false
        }
        guard let found = AudibleBridgePlayer.player(slot, from: bridge), let item = found.player.currentItem else {
            reason = "the slot the app named for \(entry.songId) holds no item, so \(how) could not be taken from it"
            return false
        }
        /*
         * The four facts that decide whether this item may be started, asked together and named in the
         * reason: which state the player and the item are actually in, whether the item has ended, and
         * whether it is still the player's own.
         */
        guard found.player.currentItem === item,
              found.player.status == .readyToPlay,
              item.status == .readyToPlay,
              !NaviliteSpectrum.hasEnded(item) else {
            reason = found.player.currentItem !== item
                ? "the slot the app named for \(entry.songId) holds a different item now, so \(how) could not be taken from it"
                : NaviliteSpectrum.hasEnded(item)
                    ? "the slot the app named for \(entry.songId) has already played to its end, so \(how) could not be taken from it"
                    : "the slot the app named for \(entry.songId) is not ready to start (player \(NaviliteSpectrum.statusName(found.player.status)), item \(NaviliteSpectrum.statusName(item.status))), so \(how) could not be taken from it"
            return false
        }
        // The item and the player are both ready in this turn: this is the moment the handoff stops
        // waiting, and the number the diagnostics row reports as "ready" (v2.0-beta.14).
        if readyAt == nil { readyAt = Date() }
        guard plugin.responds(to: Self.playSelector), let method = plugin.method(for: Self.playSelector) else {
            reason = "the audio plugin does not answer to play(assetId:), so \(how) could not be taken here"
            return false
        }
        let call: CAPPluginCall = CAPPluginCall(
            callbackId: "navilite-native-advance",
            methodName: "play",
            options: ["assetId": slot, "time": time],
            success: { _, _ in },
            error: { _ in }
        )
        typealias PlayIMP = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        let play = unsafeBitCast(method, to: PlayIMP.self)
        playIssuedAt = Date()
        awaitingFirstPlayback = true
        play(plugin, Self.playSelector, call)
        reason = "\(how) — the native player was asked for \(entry.songId)"
        return true
    }

    /* ------------------------------------------------------ the statement, and the card */

    /// Whether the statement a piece of work was started under is still the app's current one.
    ///
    /// Every boundary taken here captures `generation` and re-checks it immediately before the call it
    /// guards — the fetch's preload, each rung of its readiness poll, the play — and the check and the
    /// call are in the same turn of the main thread, so nothing can run between them (v1.9.10).
    private func current(token: Int) -> Bool {
        token == generation
    }

    /**
     * Write the lock-screen card, and keep writing it until the one fact that arrives late has
     * arrived (v1.9.10).
     *
     * The vendor's own writer publishes the card once, in the same turn as its `play`, with the
     * duration of an item that has not resolved one yet — and never comes back. So the card showed no
     * length at all until something else happened to fill it in, which is the owner's *"the lock
     * screen could not show a duration"*. Two things fix it here: the write is repeated over a short
     * window (so the vendor's duration-less write cannot be the last word), and it keeps being
     * repeated while the duration is still indefinite, which is what makes it appear by itself the
     * moment AVFoundation knows it — no seek button needed.
     */
    private func refreshNowPlaying() {
        cardTicket += 1
        let ticket = cardTicket
        publishCard()
        stepCard(ticket: ticket, waited: 0)
    }

    /// One rung of the refresh: write the card, and either stop or come back.
    private func stepCard(ticket: Int, waited: Double) {
        guard ticket == cardTicket, waited < Self.cardDeadline else { return }
        after(Self.cardStep) { [weak self] in
            guard let self, ticket == self.cardTicket else { return }
            let settled = self.publishCard()
            // Everything is on the card once the duration is known, the player says it is playing
            // (or was paused on purpose) and the grace has passed.
            if settled && waited >= Self.cardGrace { return }
            self.stepCard(ticket: ticket, waited: waited + Self.cardStep)
        }
    }

    /* ------------------------------------------- keeping the card true (v2.1) */

    /// Whether the audible player says audio is being heard or is on its way.
    ///
    /// `.waitingToPlayAtSpecifiedRate` is "the listener pressed play and audio is coming" — that is a
    /// track boundary — and `.paused` is a real pause from any surface, the lock screen included.
    /// Nil when there is no audible slot to ask.
    private func audibleIsPlaying() -> Bool? {
        guard let player = audiblePlayer() else { return nil }
        let status = player.timeControlStatus
        return status == .playing || status == .waitingToPlayAtSpecifiedRate
    }

    /// The card for the entry that is **about to** start, written before the handoff begins (v2.1).
    ///
    /// Between the finished item's end and `commit()` the card would otherwise name the track that
    /// just ended and say it is paused — for the whole fetch, when a fetch is what the handoff needs.
    /// `commit()` corrects this with the real slot and the real position, as it always has.
    private func announceUpcoming(token: Int) {
        guard current(token: token), index >= 0, index < queue.count else { return }
        var target = index + 1
        if target >= queue.count {
            guard repeatMode == "all", !queue.isEmpty else { return }
            target = 0
        }
        guard target < queue.count else { return }
        let finished = queue[index].songId
        let entry = queue[target]
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        applyEntry(entry, to: &info)
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = 0.0
        info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        // The incoming entry has no duration until its own slot plays: cleared, never guessed.
        info.removeValue(forKey: MPMediaItemPropertyPlaybackDuration)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        cardAnnouncedAt = Date()
        reason = "\(finished) ended and the app is away, so the card names \(entry.songId), which the native player is about to start"
    }

    /**
     * An entry's own fields on the card — written by **both** writers (v2.1).
     *
     * There are two of them: `publishCard` for the entry that is playing, `announceUpcoming` for the
     * one the player is about to start. While each spelled its own keys out, the media type existed
     * on one of them and not the other, so the card the viewer actually reads — the one published on
     * the first track and on every track started with the app awake — carried no statement of what
     * kind of item it is, which is what the artwork view reads. One function, so the two writers
     * cannot drift apart again.
     *
     * A field the entry does not have is left alone rather than written empty: an empty title is not
     * a title, and the calling writers decide the position, duration and rate, which differ between
     * them.
     */
    private func applyEntry(_ entry: Entry, to info: inout [String: Any]) {
        if !entry.title.isEmpty { info[MPMediaItemPropertyTitle] = entry.title }
        if !entry.artist.isEmpty { info[MPMediaItemPropertyArtist] = entry.artist }
        if !entry.album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = entry.album }
        info[MPNowPlayingInfoPropertyExternalContentIdentifier] = entry.songId
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        info[MPNowPlayingInfoPropertyIsLiveStream] = false
        if let cached = artworkCache[entry.songId] {
            info[MPMediaItemPropertyArtwork] = cached
        } else {
            loadArtwork(for: entry)
        }
    }

    /// Start the watchdog. It exists only in the state it is for — the app away with a queue — and it
    /// carries the statement it was started under, so a replaced queue retires it.
    private func startWatchdog(token: Int) {
        if cardWatchdog != nil, cardWatchdogToken != token {
            cardWatchdog?.cancel()
            cardWatchdog = nil
        }
        guard cardWatchdog == nil else { return }
        cardWatchdogToken = token
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + Self.watchdogStep, repeating: Self.watchdogStep)
        timer.setEventHandler { [weak self] in
            self?.watchdogTick()
        }
        timer.resume()
        cardWatchdog = timer
    }

    private func cancelWatchdog() {
        cardWatchdog?.cancel()
        cardWatchdog = nil
    }

    /// One tick: **read** the facts that can drift, and write only the one that is wrong.
    ///
    /// Nothing is written when nothing is wrong, and the session is never taken unconditionally —
    /// this is a repair, not a second writer. Apple advises against periodic `nowPlayingInfo` pushes.
    private func watchdogTick() {
        guard current(token: cardWatchdogToken), !awake, index >= 0, index < queue.count else { return }
        /*
         * The session is **asserted** here, on this loop's own cadence, rather than read (v2.0-beta.15).
         * There is no getter for its activation state, so `setActive(true)` is the repair itself: a
         * no-op while the session is live, and the one thing that takes it back when the system
         * dropped it while the app was away without a notification — the case this loop exists for.
         * It moves the retake count only when the flag already said the session was gone, so the
         * number stays a count of rescues rather than of ticks.
         *
         * **But not at a player that is stopped** (v2.0-beta.15). `setActive(true)` on a playback
         * category that does not mix *interrupts* whatever else is sounding, so a listener who paused
         * from the lock screen with a queue armed and had the session dropped would have this 2 s
         * loop take the session back — and cut off the podcast he is hearing instead. A player this
         * side can read as stopped is a player that needs no rescue from here; a player it cannot
         * read (nil) is not evidence of a stop, and while a handed-off boundary is in flight the
         * audible slot is mid-start, so both keep the assertion.
         */
        let audiblePlaying = audibleIsPlaying()
        if boundaryInFlight || audiblePlaying != false {
            retakeSession("the audio session had been deactivated while the app was away")
        }
        /*
         * A handed-off boundary is in flight (v2.1): `announceUpcoming` deliberately wrote a card that
         * names a track which is **not** `index` yet, and `queue[index]` plus `audibleIsPlaying()`
         * still describe the finished one. Reading a verdict here would call that card wrong and
         * republish the finished entry at rate 0 — the exact "card goes dead at the boundary" symptom
         * this release removes. So while the boundary is in flight the session is checked, and
         * nothing is judged: `commit()` or `fail()` ends the window and the next tick reads again.
         */
        if boundaryInFlight { return }
        /*
         * A player this side cannot read is not a paused one (v2.1). `audibleIsPlaying()` answers nil
         * when the slot is not on the bridge, which is a state `publishCard` refuses to write from —
         * folding that nil into rate 0 here posted a paused card mid-playback, and because the card
         * then matched the rate being asked for, nothing ever repaired it. Judge nothing this tick;
         * the next one reads again.
         */
        guard let playing = audiblePlaying else { return }
        let entry = queue[index]
        let card = MPNowPlayingInfoCenter.default().nowPlayingInfo
        let cardTitle = card?[MPMediaItemPropertyTitle] as? String
        let cardRate = (card?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue
        /*
         * The artwork is part of the verdict too (v2.1): a card that is right in title and rate but
         * carries no image was never repaired, because `loadArtwork` writes the card without the
         * image it is still fetching and `publishCard` could leave that as the last word — while
         * `now()` went on reporting the art as cached. Read as "cached here, absent there", so an
         * image that has never been loaded is not by itself a reason to write.
         */
        let cardArt = card?[MPMediaItemPropertyArtwork] as? MPMediaItemArtwork
        let wantRate: Double = playing ? 1.0 : 0.0
        let why: String?
        if card == nil {
            why = "there was no card at all"
        } else if !entry.title.isEmpty && cardTitle != entry.title {
            /*
             * An entry with no title is not a disagreement (v2.1): `publishCard` never writes an
             * empty title, so comparing against one made the mismatch permanently true and the tick a
             * 2 s steady-state writer — the one thing the watchdog must never become.
             */
            why = "the card named \"\(cardTitle ?? "")\" instead of \"\(entry.title)\""
        } else if cardRate != wantRate {
            why = "the card said \(cardRate ?? -1) while the player said \(wantRate)"
        } else if cardArt == nil, artworkCache[entry.songId] != nil {
            why = "the card had no artwork while \(entry.songId)'s was cached"
        } else {
            why = nil
        }
        guard let why else { return }
        refreshNowPlaying()
        cardRepairs += 1
        reason = "the card disagreed with the player — \(why) — so it was written again"
    }

    /// Watch the app coming back (v2.1). After any suspension the app must still be the Now Playing
    /// app when the tap lands, so the session is taken again and the card re-stated.
    private func installActiveObserver() {
        guard activeObserver == nil else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.appDidBecomeActive()
        }
        /*
         * The two facts that can invalidate the session without anything here asking (v2.1): a media
         * services reset tears it down, and an interruption that ends is the moment it may be taken
         * again. Both are recorded rather than acted on periodically.
         */
        sessionObservers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.sessionActive = false
            self?.reason = "the system reset media services, so the audio session must be taken again"
        })
        sessionObservers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 0
            guard let kind = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            /*
             * An interruption takes the session away, and the end of it is the moment the session may
             * be taken again (v2.0-beta.15). The flag is cleared at the start so the re-take below is
             * counted once, as the rescue it is — where it used to be counted on every interruption,
             * whether or not the session had gone.
             */
            if kind == .began {
                self.sessionActive = false
                return
            }
            guard kind == .ended else { return }
            self.retakeSession("an interruption ended and the audio session had to be taken again")
            self.refreshNowPlaying()
        })
    }

    private func removeActiveObserver() {
        if let activeObserver {
            NotificationCenter.default.removeObserver(activeObserver)
            self.activeObserver = nil
        }
        for observer in sessionObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        sessionObservers.removeAll()
    }

    /// Take the audio session again, and count a **rescue** rather than an attempt (v2.0-beta.15).
    ///
    /// The flag is the only record of the session's state this side has, so it is the receipt this
    /// helper counts: the number moves exactly when the flag said the session was gone and the call
    /// returned, which is once per rescue no matter how many of the three doorways report the same
    /// event — the watchdog, an interruption that ended, or the app coming back. On a session that is
    /// already active this is a silent no-op, and the reason line is left alone when nothing was wrong.
    @discardableResult
    private func retakeSession(_ what: String) -> Bool {
        let wasGone = !sessionIsActive
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            reason = "\(what), and it could not be taken again: \(error.localizedDescription)"
            return false
        }
        sessionActive = true
        if wasGone {
            sessionRetakes += 1
            reason = "\(what), and the native player took it again"
        }
        return true
    }

    private func appDidBecomeActive() {
        guard index >= 0, !queue.isEmpty else { return }
        /*
         * Asserted on every return (v2.0-beta.14), and counted only when the session was known to be
         * gone (v2.0-beta.15). `setActive(true)` on a session that is already active is a no-op, so
         * asserting it on every return is safe and is the only thing that rescues a session the
         * system dropped without a notification — which the flag cannot see. The same helper the
         * watchdog and the interruption end use, so one rescue is one count rather than three.
         */
        guard retakeSession("the app came back to a session that had been deactivated") else { return }
        refreshNowPlaying()
    }

    /**
     * Load album artwork from a local file path or remote URL and cache it (v2.0-beta.12).
     *
     * Once loaded, updates the Now Playing card if the song is still the current track.
     */
    private func loadArtwork(for entry: Entry) {
        guard let artworkUrlString = entry.artworkUrl, !artworkUrlString.isEmpty else { return }
        guard !fetchingArtworkSongIds.contains(entry.songId) else { return }
        fetchingArtworkSongIds.insert(entry.songId)

        let songId = entry.songId
        let applyImage: (UIImage) -> Void = { [weak self] image in
            DispatchQueue.main.async {
                guard let self else { return }
                self.fetchingArtworkSongIds.remove(songId)
                /*
                 * Built with a resizing handler (v2.1): the system asks for the artwork at the size it
                 * is going to draw — island, lock screen, Control Centre — and handing back the original
                 * image unchanged is what makes a large image draw wrong at island size.
                 */
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { size in
                    let renderer = UIGraphicsImageRenderer(size: size)
                    return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
                }
                self.artworkCache[songId] = artwork
                // Keep cache bounded
                if self.artworkCache.count > 50 {
                    let activeIds = Set(self.queue.map(\.songId))
                    for key in self.artworkCache.keys where !activeIds.contains(key) {
                        self.artworkCache.removeValue(forKey: key)
                    }
                }
                // Only update nowPlayingInfo if this song is still the current entry
                if self.index >= 0 && self.index < self.queue.count && self.queue[self.index].songId == songId {
                    var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
                    info[MPMediaItemPropertyArtwork] = artwork
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                }
            }
        }

        /*
         * A downloaded track's art is stated as `capacitor://localhost/_capacitor_file_/<path>`, which
         * no loader here can open (v2.1) — the reason downloaded art never appeared. The path under the
         * prefix is the same absolute file path the plain-path branch below already handles.
         */
        let capacitorPrefix = "capacitor://localhost/_capacitor_file_"
        if artworkUrlString.hasPrefix(capacitorPrefix) {
            let encoded = String(artworkUrlString.dropFirst(capacitorPrefix.count))
            let path = encoded.removingPercentEncoding ?? encoded
            if let image = UIImage(contentsOfFile: path) {
                applyImage(image)
                return
            }
        }

        if let url = URL(string: artworkUrlString) {
            if url.isFileURL {
                if let image = UIImage(contentsOfFile: url.path) {
                    applyImage(image)
                    return
                }
            } else if let scheme = url.scheme, scheme.hasPrefix("http") {
                URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                    guard let data = data, let image = UIImage(data: data) else {
                        DispatchQueue.main.async {
                            self?.fetchingArtworkSongIds.remove(songId)
                        }
                        return
                    }
                    applyImage(image)
                }.resume()
                return
            }
        }

        // Direct local file path fallback
        if FileManager.default.fileExists(atPath: artworkUrlString), let image = UIImage(contentsOfFile: artworkUrlString) {
            applyImage(image)
            return
        }

        fetchingArtworkSongIds.remove(songId)
    }

    /**
     * One write of the card: the entry that is playing, the item's own duration when it has one, the
     * player's own position, and its own rate.
     *
     * **Merged** into whatever is already there rather than replacing it, so the artwork the vendor
     * loaded and anything else on the card survive this write. Answers whether the duration is known,
     * which is what the refresh above stops on; a card with nothing to say is answered as known, so
     * the refresh stops rather than writing nothing eight seconds long.
     */
    @discardableResult
    private func publishCard() -> Bool {
        /*
         * While a boundary is in flight the card deliberately names the entry the player is **about
         * to** start, and `queue[index]` plus the audible player still describe the finished one
         * (v2.1). A write here would overwrite that announcement with the finished track at rate 0 —
         * the "card goes dead at the boundary" symptom this window exists to remove. The watchdog
         * already refuses to judge in this state; this guard is the one both callers go through, so
         * the refresh ladder cannot do it either. `commit()` re-opens the card by calling
         * `refreshNowPlaying()` once the window has closed.
         */
        if boundaryInFlight { return true }
        guard let entry = (index >= 0 && index < queue.count) ? queue[index] : nil else { return true }
        /*
         * The player the card is about is the slot the app named as **audible** — never a warm slot and
         * never a guess. Without one nothing here writes at all, and the card the vendor published
         * stays exactly as it is, which is what every build before this one did.
         */
        guard let player = audiblePlayer() else { return true }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        applyEntry(entry, to: &info)
        /*
         * The duration, and **only from an item that has already been inspected (v1.9.11)**.
         *
         * `AVPlayerItem.duration` on an item whose asset has not been loaded is a synchronous
         * question to the media server over XPC, on the thread that asks it — and this method runs on
         * the main thread, is written once and then re-written every 150 ms for up to `cardDeadline`
         * seconds after every start. That is the main thread held across a network round trip at
         * every boundary and every skip, which is the hang and the `0x8BADF00D` kill in the log the
         * owner sent. A card with no duration is the state this method already handles — it answers
         * `known: false`, which is what keeps the refresh going until AVFoundation has one.
         */
        let item = player.currentItem
        let duration = item?.status == .readyToPlay ? (item?.duration.seconds ?? 0) : 0
        let known = duration.isFinite && duration > 0
        if known { info[MPMediaItemPropertyPlaybackDuration] = duration }
        let elapsed = player.currentTime().seconds
        if elapsed.isFinite { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed }
        /*
         * The player's own two-state reading (v2.1), not "has it started yet". The old line wrote 0
         * for the whole of a track boundary — after the vendor had written 1.0 — so a paused card was
         * the last word for the rest of the track. `.waitingToPlayAtSpecifiedRate` means the listener
         * pressed play and audio is coming, which is exactly the boundary; `.paused` is a real pause
         * from any surface, and a lock-screen pause must still be able to post 0.
         */
        let status = player.timeControlStatus
        let playing = status == .playing || status == .waitingToPlayAtSpecifiedRate
        /*
         * Once the player has said it is playing or on its way, `.paused` is a pause again (v2.0-beta.15).
         * Before that it is a race with the play that was just issued — `commit()` writes the card in
         * the same turn — and accepting it as settled at the head of a track stopped the ladder there
         * with 0.0 as the last word.
         */
        if playing { awaitingFirstPlayback = false }
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        /*
         * `MPNowPlayingInfoCenter.default().playbackState` is deliberately **not** set: Apple's page
         * says that property is macOS-only, so on iOS the rate is the only statement available.
         */
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        // Settled once the duration is known and the player is not still waiting to start; a pause is
        // settled too, because the 0 written there is the true state rather than a race with the start
        // — but only once this start has been seen playing or on its way at least once.
        return known && (playing || (status == .paused && !awaitingFirstPlayback))
    }

    /// A boundary that could not be taken, always with a reason (v1.9.9): the one thing this side may
    /// never do is stop the music without saying why.
    private func fail(_ why: String) {
        // Every path that ends a boundary goes through `commit` or through here, so this is where a
        // handed-off boundary stops being in flight even when it never reached a slot.
        boundaryInFlight = false
        // And a start that never produced sound clears the paused latch with it (v2.0-beta.15):
        // left set, the *next* real pause on the next item would never settle the card ladder, which
        // is the "paused card is the last word" bug this latch exists to fix, one track later.
        awaitingFirstPlayback = false
        failures += 1
        reason = why
        recordBoundary(outcome: "failed")
        notifyListeners("advanceFailed", data: ["reason": why, "index": index])
    }
}
