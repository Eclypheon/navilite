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
        CAPPluginMethod(name: "now", returnType: CAPPluginReturnPromise)
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
    /// How long a fetch here may take before it is reported as a boundary that could not be taken.
    private static let fetchDeadline = 12.0
    /// How often a fetched slot is asked whether it can start yet (50ms for responsive background handoff).
    private static let fetchStep = 0.05

    /* --------------------------------------------------- the lock-screen card (v1.9.10) */

    /// How often the card is refreshed after a state change, and at least how long it is refreshed
    /// for. The grace is what makes this side's write the last one: the vendor's own writer publishes
    /// a duration-less card in the same turn as its `play`, and a single write here could land under
    /// it.
    private static let cardStep = 0.25
    private static let cardGrace = 0.75
    /// The outside of the refresh — long enough for an indefinite item to resolve a duration, short
    /// enough that nothing here writes to the card for a whole track.
    private static let cardDeadline = 8.0
    /// Which refresh is current; a newer one retires the older one's ladder.
    private var cardTicket = 0

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
                "reason": self.reason
            ])
        }
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
    }

    private func removeEndObserver() {
        guard let endObserver else { return }
        NotificationCenter.default.removeObserver(endObserver)
        self.endObserver = nil
    }

    /// The audible item reached its end. Play the next entry, or say why not.
    private func itemDidEnd(_ notification: Notification) {
        /*
         * A notification about an item this app is not hearing is not a track boundary: unloading a
         * warm slot stops its asset and can end an item nobody has played, and so can a load that is
         * replacing the audible one. Both are counted rather than acted on.
         */
        guard let item = notification.object as? AVPlayerItem else { return }
        guard let recorded = audible, let found = AudibleBridgePlayer.player(recorded.assetId, from: bridge), found.player.currentItem === item else {
            ignored += 1
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
            return
        }
        /*
         * The statement in force at this moment travels with the boundary (v1.9.10). Everything the
         * advance goes on to do — a fetch, each rung of its readiness poll, the play — re-checks it, so
         * a queue the app replaces while this is in flight can no longer be advanced into.
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
        let entry = queue[target]
        let slot = holding(entry.songId)
        if let slot {
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
        }
        if restart {
            // Restarting the current entry with no slot to restart from is nothing to fetch.
            fail("\(how): there is nothing on the player to restart")
            return false
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
        preloadAhead(token: generation)
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
        // Already held, by the app or by this side: nothing to fetch, and nothing to replace.
        if holding(entry.songId) != nil { return }
        guard let plugin = bridge?.plugin(withName: Self.audioPluginName) else { return }
        let slot = fetchSlot()
        guard preloadSlot(plugin: plugin, slot: slot, entry: entry) else { return }
        fetchWindow = (slot, entry.songId)
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
     */
    private func preloadSlot(plugin: CAPPlugin, slot: String, entry: Entry) -> Bool {
        guard plugin.responds(to: Self.preloadSelector), let method = plugin.method(for: Self.preloadSelector) else {
            return false
        }
        unloadSlot(plugin: plugin, slot: slot)
        var metadata: [String: String] = ["title": entry.title, "artist": entry.artist, "album": entry.album]
        if let artworkUrl = entry.artworkUrl { metadata["artworkUrl"] = artworkUrl }
        let call: CAPPluginCall = CAPPluginCall(
            callbackId: "navilite-native-fetch",
            methodName: "preload",
            options: [
                "assetId": slot,
                "assetPath": entry.url,
                "isUrl": true,
                "notificationMetadata": metadata
            ],
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
            let known = self.publishCard()
            // Everything is on the card once the duration is known and the grace has passed.
            if known && waited >= Self.cardGrace { return }
            self.stepCard(ticket: ticket, waited: waited + Self.cardStep)
        }
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
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
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
        guard let entry = (index >= 0 && index < queue.count) ? queue[index] : nil else { return true }
        /*
         * The player the card is about is the slot the app named as **audible** — never a warm slot and
         * never a guess. Without one nothing here writes at all, and the card the vendor published
         * stays exactly as it is, which is what every build before this one did.
         */
        guard let audible, let found = AudibleBridgePlayer.player(audible.assetId, from: bridge) else { return true }
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        if !entry.title.isEmpty { info[MPMediaItemPropertyTitle] = entry.title }
        if !entry.artist.isEmpty { info[MPMediaItemPropertyArtist] = entry.artist }
        if !entry.album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = entry.album }
        info[MPNowPlayingInfoPropertyExternalContentIdentifier] = entry.songId
        if let cached = artworkCache[entry.songId] {
            info[MPMediaItemPropertyArtwork] = cached
        } else {
            loadArtwork(for: entry)
        }
        let player = found.player
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
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.timeControlStatus == .playing ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        return known
    }

    /// A boundary that could not be taken, always with a reason (v1.9.9): the one thing this side may
    /// never do is stop the music without saying why.
    private func fail(_ why: String) {
        failures += 1
        reason = why
        notifyListeners("advanceFailed", data: ["reason": why, "index": index])
    }
}
