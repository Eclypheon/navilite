import AVFoundation
import Capacitor
import Foundation
import MediaPlayer

/**
 * Navilite's own lock-screen remote commands, the audio session's re-arm, and — since v1.9.8 —
 * **the track boundary itself, while the app is not running**.
 *
 * Why the file exists at all (v1.7): playback on iOS is AVFoundation, driven by
 * `@capgo/capacitor-native-audio`, which sets the `AVAudioSession` to `.playback`, activates it,
 * publishes the Now Playing card and targets `MPRemoteCommandCenter` — for **play, pause, stop,
 * toggle, skip-15s and scrub**. It does not enable `nextTrackCommand` / `previousTrackCommand`, so a
 * lock screen driven by that plugin alone has no next/previous buttons. Those two buttons are what
 * this plugin added first, and nothing else: it must not touch the session category or the Now
 * Playing card, because two writers on one session is exactly how the transport goes dead.
 *
 * `activateSession()` is the second half: after a call, Siri, or another app taking the session, iOS
 * deactivates ours, and re-activating it is the documented fix for "playback looks fine but the
 * controls do nothing" after a return to the foreground. It only calls `setActive(true)` — it never
 * changes the category, so it cannot undo what the audio plugin set up.
 *
 * ## v1.9.8 — the boundary, and why it had to move here
 *
 * Everything that decided "what plays next" used to live in the WebView: the plugin's completion
 * arrives as a message to JavaScript, and JavaScript moved the queue. iOS suspends that JavaScript
 * the moment the app is backgrounded or the screen is locked — the audio is played by AVFoundation,
 * so WebKit has no reason to keep the page's process running — and the app suspends its own
 * end-of-track watchdog in the same instant (`engine.ts`, on hide). So a track that played to its
 * natural end with the app away had **no owner for "next" at all**, every time, which is exactly
 * what the owner reported: *"the auto advance also doesn't work when backgrounded it seems"*.
 *
 * So the native side is now given a boundary of its own: `arm` states which asset is playing and
 * which slots are to be played after it, and this file watches the audible item's own end
 * (`AVPlayerItemDidPlayToEndTime`) and plays the next slot itself. It is the same player the app is
 * already hearing, so nothing is reconfigured and nothing is restarted: the item for the next track
 * was fetched and buffered while the previous one played, so the hand-over is a play call.
 *
 * Three rules keep it safe:
 *
 *   - **it only acts with the app off screen** (`awake: false`), which is the one state in which
 *     the web layer cannot act at all. With the app on screen the WebView owns the boundary exactly
 *     as it always has, so the two can never both advance a track;
 *   - **it only plays a slot the app named**, and only when the item that just ended belongs to the
 *     player recorded as the audible one. An end belonging to an unloaded slot, or to a track the
 *     app has already replaced, is counted and ignored — never guessed at;
 *   - **every outcome is reported**: `advanced` with the track it moved to, or `advanceFailed` with
 *     the reason, both of which the app adopts or recovers from. A boundary that happens without
 *     the app knowing is a boundary the app must be able to catch up with, which is what `now()`
 *     is for.
 *
 * The play itself goes through the audio plugin's **own** method (`play(assetId:)`), through the
 * Objective-C runtime: that call is what keeps the plugin's bookkeeping — the asset it believes is
 * playing, the Now Playing card, its position timer — describing the track that is actually
 * playing. Driving the `AVPlayer` directly would leave all of that on the track that just ended,
 * which is how a lock-screen card starts naming the wrong song.
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
        CAPPluginMethod(name: "arm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "now", returnType: CAPPluginReturnPromise)
    ]

    /// The command/target pairs to remove again on `detach` — a target left behind would call into
    /// a web layer that is gone.
    private var targets: [(command: MPRemoteCommand, token: Any)] = []

    /* ------------------------------------------------------------- the boundary (v1.9.8) */

    /// The slots to be played after the one that is playing, in order, with the track each holds.
    private var chain: [(assetId: String, songId: String)] = []
    /// The slot behind the current one, for the lock screen's back button.
    private var previous: (assetId: String, songId: String)?
    /// The slot the app last told us is playing, and the track it holds. A **statement**, re-made by
    /// the app after every start, every warm and every visibility change — see `arm`.
    private var audible: (assetId: String, songId: String)?
    /// Whether the web layer is running. False is the only state in which this file may advance.
    private var awake = true
    /// What it has done, for the app's own reason line: taken, refused, or ignored.
    private var advances = 0
    private var failures = 0
    private var ignored = 0
    /// The one sentence that says which state the boundary is in — every one of them has a clearing
    /// path, and this names it.
    private var reason = "nothing has been armed yet"
    /// The end-of-item observation, installed once and never removed until `detach`.
    private var endObserver: NSObjectProtocol?

    private static let playSelector = NSSelectorFromString("play:")
    /// How long an `AVPlayerItemDidPlayToEndTime` for the audible item is trusted without asking.
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
                     * **With a track armed and the app away, the button advances here (v1.9.8).**
                     *
                     * The message this used to send goes to a suspended web view: the buttons the
                     * owner was given for exactly this case did nothing while the app was away. With
                     * nothing armed (or the app awake) the message is sent as it always was, and the
                     * web layer's own `next` — which owns the repeat mode, the end of the queue and
                     * the loading state — handles it.
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
            self.chain = []
            self.previous = nil
            self.reason = "detached — nothing is armed"
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
     * The app's statement of the boundary: which slot is playing, which slots follow it, and whether
     * the web layer is running.
     *
     * A statement rather than an increment on purpose. The app sends the whole picture after every
     * start, every warm and every lifecycle change, so nothing here can be left half-applied by a
     * message that did not arrive — and there is no flag that could stick.
     */
    @objc func arm(_ call: CAPPluginCall) {
        let assetId = call.getString("assetId")
        let songId = call.getString("songId")
        let entries = (call.getArray("chain") as? [[String: Any]]) ?? []
        let previousEntry = call.getObject("previous")
        let awake = call.getBool("awake") ?? true
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            self.chain = entries.compactMap { entry in
                guard let slot = entry["assetId"] as? String, let song = entry["songId"] as? String, !slot.isEmpty else { return nil }
                return (slot, song)
            }
            if let previousEntry, let slot = previousEntry["assetId"] as? String, let song = previousEntry["songId"] as? String, !slot.isEmpty {
                self.previous = (slot, song)
            } else {
                self.previous = nil
            }
            if let assetId, !assetId.isEmpty {
                self.audible = (assetId, songId ?? "")
            }
            self.awake = awake
            self.installEndObserver()
            self.reason = self.chain.isEmpty
                ? (self.awake
                    ? "the app is on screen and nothing is warm after the track that is playing"
                    : "the app is away and nothing is warm after the track that is playing, so there is nothing to advance to")
                : (self.awake
                    ? "the app is on screen, so the web layer takes the track boundary and this side is only told what follows"
                    : "the native player will play the next slot itself if this track ends while the app is away")
            call.resolve(["armed": self.chain.count, "previous": self.previous != nil, "awake": self.awake])
        }
    }

    /** Give the chain back — the app is not going where it was armed for. */
    @objc func disarm(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve(["armed": 0])
                return
            }
            self.chain = []
            self.previous = nil
            self.reason = "disarmed by the app — nothing is armed"
            call.resolve(["armed": 0])
        }
    }

    /**
     * What this side knows and has done: the slot it believes is playing, the track that slot holds,
     * the chain it is holding, and the counters.
     *
     * This is how a track that advanced while the app was away is ever learned about — the message
     * was addressed to a suspended web view — so the app asks on the way back and adopts the answer.
     */
    @objc func now(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            call.resolve([
                "assetId": self.audible?.assetId ?? "",
                "songId": self.audible?.songId ?? "",
                "armedSongIds": self.chain.map { $0.songId },
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

    /// The audible item reached its end. Play what was armed for it, or say why not.
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
        guard let next = chain.first else {
            failures += 1
            reason = "the track ended with the app away and nothing was warm behind it, so there was nothing to advance to"
            notifyListeners("advanceFailed", data: ["reason": reason])
            return
        }
        chain.removeFirst()
        if advance(to: next, how: "the track ended while the app was away") {
            advances += 1
            audible = next
            reason = "the native player took the boundary itself and is playing \(next.songId)"
            notifyListeners("advanced", data: ["songId": next.songId, "assetId": next.assetId])
        } else {
            failures += 1
            notifyListeners("advanceFailed", data: ["reason": reason])
        }
    }

    /// The lock screen's next button, when there is a chain to take it with.
    private func advanceIfAble() -> Bool {
        guard !awake, let next = chain.first else { return false }
        chain.removeFirst()
        guard advance(to: next, how: "the lock screen's next") else {
            notifyListeners("advanceFailed", data: ["reason": reason])
            return false
        }
        advances += 1
        audible = next
        reason = "the lock screen asked for the next track and the native player took it while the app was away"
        notifyListeners("advanced", data: ["songId": next.songId, "assetId": next.assetId])
        return true
    }

    /// And its back button. With the app awake the web layer's own rule applies (under three seconds
    /// in, "previous" restarts the track); with the app away there is nothing to ask, and going back
    /// a track is the thing the button is for.
    private func previousIfAble() -> Bool {
        guard !awake, let back = previous else { return false }
        guard advance(to: back, how: "the lock screen's previous") else {
            notifyListeners("advanceFailed", data: ["reason": reason])
            return false
        }
        advances += 1
        audible = back
        previous = nil
        reason = "the lock screen asked for the previous track and the native player took it while the app was away"
        notifyListeners("advanced", data: ["songId": back.songId, "assetId": back.assetId])
        return true
    }

    /**
     * Play one named slot, **through the audio plugin's own `play(assetId:time:)`**.
     *
     * The runtime call is deliberate and it is the mirror image of the reflective read the spectrum
     * does: the slot is the plugin's asset, and the plugin's method is what keeps its own record of
     * which asset is playing, the Now Playing card and its position timer in step with the sound. A
     * write straight to the `AVPlayer` would make the lock screen name the track that just ended.
     *
     * If the plugin is not there, or does not answer to that method, nothing is played and the app
     * is told — a boundary this side cannot take is never left silent.
     */
    private func advance(to next: (assetId: String, songId: String), how: String) -> Bool {
        guard let plugin = bridge?.plugin(withName: Self.audioPluginName) else {
            reason = "the audio plugin is not on the bridge, so \(how) could not be taken here"
            return false
        }
        guard plugin.responds(to: Self.playSelector), let method = plugin.method(for: Self.playSelector) else {
            reason = "the audio plugin does not answer to play(assetId:), so \(how) could not be taken here"
            return false
        }
        let call: CAPPluginCall = CAPPluginCall(
            callbackId: "navilite-native-advance",
            methodName: "play",
            options: ["assetId": next.assetId, "time": 0.0],
            success: { _, _ in },
            error: { _ in }
        )
        typealias PlayIMP = @convention(c) (AnyObject, Selector, AnyObject) -> Void
        let play = unsafeBitCast(method, to: PlayIMP.self)
        play(plugin, Self.playSelector, call)
        reason = "\(how) — the native player was asked for \(next.songId)"
        return true
    }
}
