import Accelerate
import AVFoundation
import Foundation
import os

#if canImport(Capacitor)
import Capacitor
#endif

/**
 * The native spectrum: an FFT of the audio that is actually being heard, taken from an
 * `MTAudioProcessingTap` on the **audible** player's own `AVPlayerItem`.
 *
 * ## Why this file exists at all
 *
 * The visualiser was flat twice on the owner's phone, and both times the fix was in the web layer:
 * keep an `<audio>` element pointed at the same stream, route it through an `AnalyserNode` and draw
 * what the analyser reads. Both times the reasoning was sound and the result was silence:
 *
 *   - v1.7 left the analyser disconnected from the destination, so `getByteFrequencyData()` returned
 *     zeros and raised nothing;
 *   - v1.7.1 connected it and muted with a gain of 0, which does read — *if* the browser hands over
 *     the samples at all. It hands over silence instead whenever the stream is CORS-cross-origin
 *     without `Access-Control-Allow-Origin`, which is a property of the owner's own library server
 *     and entirely out of this app's hands.
 *
 * Worse, the web copy was also the thing breaking playback on return: a WKWebView media element
 * starting or stopping is WebKit activating and deactivating the app's `AVAudioSession`. So the
 * samples come from the native side, where there is no origin, no CORS and no WebKit.
 *
 * ## What v1.7.6 changed, and why it matters
 *
 * Until v1.7.6 this plugin built its **own** `AVURLAsset` / `AVPlayerItem` / `AVPlayer`, pointed it
 * at the same stream, called `play()`, and analysed that. The copy could not be heard — its tap
 * zeroed the buffers it handed back — but it was still a second decode of the same file, a second
 * network fetch of it, and a second clock, all competing with the player that makes the sound. The
 * independent review's words for it were exact: the second engine *"was not eliminated; it was
 * moved from the web layer to the native layer and relabelled"*. Two decodes of one stream contend
 * for bandwidth, and a tap stream that cannot keep up starves the audible player's buffer — a
 * concrete reason for a visualiser that stutters while the audio plays.
 *
 * There is exactly one `AVPlayer` in the app — `NaviliteRemote`'s queue, the only player any file in
 * this app constructs — and every item it builds carries this file's tap from `makeItem`:
 *
 *   1. the tap goes on the item **when the item is made**, on the main actor, with the item's audio
 *      track resolved off main through `AVAsset.loadTracks` (a synchronous `tracks` read on a remote
 *      asset is the `0x8BADF00D` watchdog kill, so it is never done); one install per item, keyed to
 *      the item, and `snapshot()` publishes the install belonging to the player's `currentItem`;
 *   2. an `MTAudioProcessingTap` (post-effects) is installed on that player's current
 *      `AVPlayerItem` through an `AVMutableAudioMix`, and the samples it is handed are **passed
 *      through untouched**: this tap measures the audio the user hears, it does not mute it, it does
 *      not own it, and it does not start, stop or seek anything;
 *   3. `Accelerate`'s vDSP does a 2048-point FFT with a Hann window on a hop of 1024 samples, and
 *      the magnitudes are folded into the same 64 log-spaced bands the canvas draws;
 *   4. JavaScript polls `bands()` and draws them.
 *
 * The bands are in the same 0…255 scale as `AnalyserNode.getByteFrequencyData()`, over the same 64
 * bands, so `src/player/visualizer.ts` draws them with the same code and the same rules: the current
 * frame only, no after-image.
 *
 * There is one clock now, and it is the player's, so `resync` has nothing left to correct. If the
 * plugin is missing, the player cannot be found, or the tap cannot be created, the app keeps playing
 * exactly as it does and the visualiser falls back to its album-art theme — every one of those paths
 * is a *reported* failure, never a silent one.
 *
 * ## What v1.7.7 changed: the tap's lifetime
 *
 * v1.7.6 moved the tap onto the audible item but left its *lifecycle* where the old design had it —
 * armed when the engine entered `playing`, torn down when it left. So every pause, every seek, every
 * return from the background took the mix off the item and put a new one back on a player that was
 * already rendering. That is two defects at once, and the owner reported both: the spectrum that
 * would not come back until a whole new track was loaded (the detach won, and nothing re-armed it),
 * and *"a short pause"* in the middle of a song right before the bars returned (reconfiguring a
 * playing item's audio pipeline is audible).
 *
 * The rule is now a lifetime rule:
 *
 *   - **the tap is installed once per item, and never removed by a transport or lifecycle event.**
 *     Pause, resume, seek, background, foreground, interruption, the last second of a track: the tap
 *     is already there, so the plugin only *verifies* it (`attach` returns without writing anything);
 *   - **a paused tap is not a stopped tap.** While nothing is rendering the tap is simply not called;
 *     the bars settle to zero because the engine has no frame to hand the canvas, and they come back
 *     with the first samples after the resume, one hop (~23 ms) behind the sound;
 *   - **`detach` is for exactly two things** — a genuinely different item, and an explicit teardown.
 *     Nothing in the transport or the app lifecycle is allowed to reach it.
 *
 * The install count and the verify count are both in `bands()`'s snapshot, so "installed once" is a
 * number a harness can read rather than a claim in a comment.
 *
 * The engine half of this file deliberately imports nothing but AVFoundation, Accelerate and
 * Foundation, which is what lets the tap itself be exercised on the host (`swiftc` on macOS) as well
 * as in the app.
 */

/**
 * A failure the caller can see, carrying the sentence JavaScript gets back as the rejection.
 *
 * `Result`'s failure type has to be an `Error`, and the strings here are already the message the
 * visualiser logs, so the message is the payload rather than something to re-wrap at each site.
 */
enum NativeSpectrumError: LocalizedError {
    case failure(String)

    var errorDescription: String? {
        if case let .failure(message) = self { return message }
        return nil
    }
}

/**
 * The tap on the player that is being heard, and the FFT behind it.
 *
 * Everything that can fail here (no loaded audio track on the item, a mix already in place, the tap
 * cannot be created, the buffers are a format that cannot be read) fails as a *reported* failure:
 * the caller is told, and the visualiser is left to draw its theme. Nothing in this class touches
 * playback the user can hear, and nothing in it fetches or decodes a second copy of the stream.
 */
final class AudibleSpectrumTap {
    /// The one tap object the app installs from (v2.0.0-beta.33).
    ///
    /// It used to exist only as a stored property of the bridge plugin, so JavaScript was the only
    /// thing that could ask for a tap. Item creation now happens in `NaviliteRemote.makeItem`, native
    /// code that must not be told what to measure through a bridge, so the object is shared:
    /// whichever side touches it first creates it, and both see the same installs.
    static let shared = AudibleSpectrumTap()

    static let bandCount = 64
    /// 2048-point FFT (1024 usable bins), a hop of 1024 samples — ~23 ms of audio at 44.1 kHz,
    /// which is a frame for every animation frame the canvas draws.
    static let windowSize = 2048
    static let hop = 1024
    /// The dB window the bands are mapped through, matching the web analyser's `minDecibels` of
    /// -95: below this is silence, at 0 dB the band is full scale.
    static let floorDecibels: Float = -95
    /// How long `attach` waits for the audible item to have its audio track known. The player that is
    /// being tapped is already playing or about to, so this is a formality, not a load.
    static let trackWaitSeconds = 5.0
    /// How often the analysis queue looks for a fresh window of PCM (v1.8.0). Shorter than the hop
    /// (~23 ms of audio), so nothing waits for it: a window is ready on roughly every second tick.
    static let analysisIntervalMs = 10

    /// Guards the counts this object keeps about itself — never a measurement (v1.9.25).
    private let lock = NSLock()
    /**
     * **One install per item (v2.0.0-beta.33).** The tap used to be a single slot: `attach` began
     * with `detach()`, so installing the tap on a *new* item took it off whatever item was sounding
     * — which, now that every queue item is tapped at creation, would leave the tap on the last item
     * built and the item playing with none. A queue holds several items at once, so this object holds
     * several installs, keyed by the item they are on. Nothing is ever removed because a *different*
     * item was tapped: an install goes away when its own item does (`finalize`), or on teardown.
     */
    private var installs: [ObjectIdentifier: ItemTap] = [:]
    private weak var player: AVPlayer?
    /// Evidence of the lifecycle rule v1.7.7 exists for: how many times a tap was *installed* on an
    /// item, and how many times a healthy one was only *verified*. The second grows with every pause,
    /// resume, seek and return to the foreground; the first may only grow for a new item.
    private var installCount = 0
    private var verifyCount = 0

    /// What the lifecycle rule has done so far — the numbers the card is judged on.
    var lifecycleCounts: (installs: Int, verifies: Int) { (installCount, verifyCount) }

    /**
     * **The measurement of one item, and of no other (v1.9.25).**
     *
     * Until this release the analysis *was* this object: one PCM ring, one analysis timer and one FFT
     * for every item in the process — while the callbacks that start and stop them (`prepare`,
     * `unprepare`) belong to an **item** and arrive in an order AVFoundation chooses. An outgoing
     * item's teardown landing after the incoming item's `prepare` therefore cancelled the timer and
     * destroyed the FFT that the item *playing now* was being measured with, and neither half of the
     * app could put it back: `prepare` had already been called for that item and is not called again,
     * and the plugin's only answer to being asked is a verify of an item that already carries our tap
     * (`attach`, below). The owner's own report of that state, after installing v1.9.24:
     *
     *     "the lines stay dead the whole track, the spectrum seems to jump up at the start and then
     *      go to zero and remain there the whole track" — "the audio plays but the spectrum stays
     *      dead at zero"
     *
     * One analysis per install is the repair. The tap's own storage **is** the analysis, so every
     * callback a tap makes lands on the state of its own item: a teardown can only stop the analysis
     * its own item started, and the PCM of an item the player has left can never be windowed as the
     * item that is playing. Nothing about the audio changes — the FFT is on its own queue
     * (`SpectrumAnalysis.analysisQueue`), no mix is written and no tap is reconfigured.
     */
    /**
     * The install for the item the player is on **now** — the one whose frame `snapshot` publishes.
     *
     * With one install per item, "which item is being measured" is not a pointer kept in step by
     * hand: the player's own `currentItem` is the answer, and the install it names is the one this
     * app is hearing (v2.0.0-beta.33). An item that is attached but not sounding still carries its
     * own tap — it simply publishes nothing until it is the current item.
     */
    private func sounding() -> ItemTap? {
        guard let current = player?.currentItem else { return nil }
        return installs[ObjectIdentifier(current)]
    }

    private var currentAnalysis: SpectrumAnalysis? { sounding()?.analysis }

    /// Frames the FFT has produced for the life of the app process — what `snapshot`'s `frames` has
    /// always been. Nothing decides anything from it any more (v1.9.25; see
    /// `SpectrumAnalysis.frames`, which is the same count **for one item**).
    private var lifetimeFrames = 0

    /* -------------------------------------------------------------------- the track */

    /**
     * The audio track of `item`, **awaited** — and the only track list this file ever reads (v1.9.11).
     *
     * Until v1.9.1 the fallback below was `item.asset.tracks(withMediaType:)` — the deprecated
     * **synchronous** accessor, which blocks until AVFoundation has loaded the asset, over the
     * network, on the very stream that is starting. Called from `install`, that one line put every JS
     * callback, every tap and the plugin's own `play` call behind a cold fetch of the new track, which
     * is why an autoplay after a finished track was *slower* than a tap from cold and why the bars
     * stayed dark while it was.
     *
     * v1.9.1 replaced that with `loadTracks`, but kept `AVPlayerItem.tracks` in front of it as "the
     * free half" — the item's own list, which is populated as the item becomes ready. **It is not
     * free, and it is what took the app down**: the owner's own device log shows the main thread
     * inside a synchronous round trip to the media server,
     *
     *     AVPlayerItem.tracks -> AVAsset tracksWithMediaType: -> AVURLAsset tracks
     *       -> AVFigAssetInspector trackCount -> remoteXPCAsset_CopyProperty
     *       -> xpc_connection_send_message_with_reply_sync -> mach_msg2_trap
     *
     * which on a remote item that has not been inspected yet is a network round trip that never
     * answers, and FRONTBOARD then kills the app for it (`0x8BADF00D`, "failed to terminate
     * gracefully"). So there is no shortcut any more: every track list this app reads comes from the
     * **async** property API (`load(_:)` / `loadTracks`), which yields instead of blocking, and the
     * item's own list is never touched. Nothing in this file reads a property of a remote asset
     * synchronously.
     */
    static func audioTrack(of item: AVPlayerItem) async -> AVAssetTrack? {
        let tracks = try? await item.asset.loadTracks(withMediaType: .audio)
        return tracks?.first
    }

    /* ------------------------------------------------------------------ attachment */

    /**
     * **Install this item's own tap, from the moment the item exists (v2.0.0-beta.33).**
     *
     * Called by `NaviliteRemote.makeItem` on the main actor while it builds a queue item, so that
     * "an item the queue can play without a tap" is not a state this app can express. Every item the
     * queue will play — the sounding one and the parked ones behind it — goes through it, including
     * the items `armAwayQueue` creates in the background, which no JS path ever reached.
     *
     * The item's audio track is resolved through the **async** property API, off the main thread
     * (`audioTrack(of:)`), never `tracks`/`tracksWithMediaType`: on a remote asset those are a
     * synchronous round trip to the media server, which is the `0x8BADF00D` class of watchdog kill
     * this file's own comments describe. So the mix is written when the track list answers — for an
     * item that was created a moment ago, before AVFoundation has a buffer to render.
     *
     * A second call for the same item verifies and returns: there is nothing to install twice.
     */
    func install(on item: AVPlayerItem, player: AVPlayer, requestedUrl: URL?) {
        if carriesOurTap(item) {
            verifyCount += 1
            self.player = player
            return
        }
        Task.detached(priority: .userInitiated) { [weak self] in
            let track = await AudibleSpectrumTap.audioTrack(of: item)
            await MainActor.run {
                guard let self else { return }
                if case let .failure(error) = self.attach(to: item, track: track, player: player, requestedUrl: requestedUrl) {
                    /*
                     * A tap that could not be installed is *reported*, never swallowed: `snapshot`'s
                     * `attached` stays false and the register answers zeros — the honest state — and
                     * this line names why, because the engine can only say "not attached".
                     */
                    print("[navilite] spectrum: no tap on the item just made: \(error.errorDescription ?? "no reason given")")
                }
            }
        }
    }

    /**
     * Install the tap on the audible player's own item.
     *
     * This is the whole of v1.7.6's change of engine: no asset is loaded, no player is created, no
     * `play()` is called, and the position is not seeked to — the item handed in is the one the user
     * is hearing, and the tap only reads it.
     *
     * `requestedUrl` is the stream the caller asked about. It is not used to open anything (the
     * player already has it); a mismatch is worth a line in the log, but it is not a reason to refuse
     * to measure.
     */
    func attach(to item: AVPlayerItem, track: AVAssetTrack?, player: AVPlayer, requestedUrl: URL?) -> Result<Double, NativeSpectrumError> {
        /*
         * **Verify; do not reinstall.** This is the rule v1.7.7 exists for.
         *
         * Installing an audio mix on an item that is being rendered reconfigures that item's audio
         * pipeline, and that reconfiguration is *audible* — the owner heard it as "a short pause"
         * in the middle of a song, right before the bars came back. So an item that already carries
         * this tap is only *checked* here: no mix is written, no tap is created, no buffer touched,
         * and the call reports success. Every pause, resume, seek, return from the background and
         * last second of a track arrives on this path. Only a genuinely *different* item — a new
         * load — falls through to the install below, which is the one moment in an item's life when
         * a tap can be installed without reconfiguring anything the listener is hearing.
         *
         * v1.9.25 — and the analysis it verifies is *this item's*, held by the tap that carries it:
         * a request about the item being heard can never be answered by the state of another one.
         */
        if carriesOurTap(item) {
            verifyCount += 1
            self.player = player
            return .success(publishedSampleRate)
        }
        // An install whose own item has been released is not worth holding, and this is where a new
        // install arrives, so it is where the registry is pruned (v2.0.0-beta.33).
        prune()
        /*
         * The track is handed in rather than looked up here (v1.9.1): the lookup is asynchronous,
         * and doing it inside `attach` would either make this whole install asynchronous for no
         * reason or — as it was until v1.9.1 — block the main thread in the deprecated synchronous
         * accessor while the new stream is being fetched.
         */
        guard let track else {
            return .failure(.failure("the audible player has no loaded audio track yet"))
        }
        /*
         * The item belongs to the plugin that is making the sound. If something else has already put
         * an audio mix on it, taking it over would change how the user's audio is rendered — that is
         * not this file's business, so it reports instead. Reaching this line with a mix still on the
         * item therefore means the mix is *not* ours: `detach` above removed ours, if it was there.
         */
        if item.audioMix != nil {
            return .failure(.failure("the audible player's item already carries an audio mix, and the spectrum will not take it over"))
        }
        #if DEBUG
        if let requestedUrl, let played = (item.asset as? AVURLAsset)?.url, played != requestedUrl {
            print("[navilite] spectrum: tapping \(played.absoluteString) (the caller asked about \(requestedUrl.absoluteString))")
        }
        #endif

        /*
         * **The analysis is made first, because the tap's own storage is it (v1.9.25).**
         *
         * `clientInfo` is what every one of this tap's callbacks hands back — `prepare`, `process`,
         * `unprepare`, `finalize` — so the object it points at *is* the thing that gets measured and
         * the thing that gets torn down when this item is. One per install is what keeps an item's
         * teardown from reaching the item that is playing (see `currentAnalysis`).
         */
        let analysis = SpectrumAnalysis(owner: self)
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: Unmanaged.passRetained(analysis).toOpaque(),
            init: audibleSpectrumTapInit,
            finalize: audibleSpectrumTapFinalize,
            prepare: audibleSpectrumTapPrepare,
            unprepare: audibleSpectrumTapUnprepare,
            process: audibleSpectrumTapProcess
        )
        var created: MTAudioProcessingTap?
        let status = MTAudioProcessingTapCreate(
            kCFAllocatorDefault,
            &callbacks,
            kMTAudioProcessingTapCreationFlag_PostEffects,
            &created
        )
        guard status == noErr, let tap = created else {
            // The retain handed to the tap's clientInfo is ours to drop when the tap never exists.
            if let info = callbacks.clientInfo {
                Unmanaged<SpectrumAnalysis>.fromOpaque(info).release()
            }
            return .failure(.failure("the audio tap could not be created on the audible player (OSStatus \(status))"))
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        parameters.audioTapProcessor = tap
        /*
         * No volume ramp is ever set on these parameters, and `AVAudioMixInputParameters` documents
         * that an input plays at 1.0 until a ramp says otherwise — so the mix this file installs on
         * someone else's item cannot attenuate it. The user's volume still works: that lives on the
         * player, not here.
         */
        let mix = AVMutableAudioMix()
        mix.inputParameters = [parameters]
        item.audioMix = mix

        installs[ObjectIdentifier(item)] = ItemTap(item: item, tap: tap, mix: mix, analysis: analysis)
        self.player = player
        installCount += 1
        /*
         * **And the item this install replaces is not touched (v2.0.0-beta.33).**
         *
         * Until this version the tap was one slot, so a new install had to *retire* the analysis of
         * whatever item it displaced — the two items could not both be measured. A queue is several
         * items, so both are: each holds its own tap, its own analysis and its own FFT, and the one
         * the player is actually on is the one `snapshot` publishes (`sounding()`). An analysis is
         * retired by its own item's `finalize`, and by nothing else.
         */
        return .success(analysis.published.sampleRate)
    }

    /// The analysis's own sample rate, or 0 while no item is being measured (v1.9.25).
    private var publishedSampleRate: Double { currentAnalysis?.published.sampleRate ?? 0 }

    /**
     * Whether this tap is installed on `item` *right now*.
     *
     * The question is asked of the **tap**, not of the mix object, and the difference is not pedantry:
     * `AVPlayerItem.audioMix` hands back a *copy* of the mix it holds, so `item.audioMix === installedMix`
     * is false even in the instant after we installed it. v1.7.6 asked that question twice and both
     * answers were wrong in the same direction — `detach` never actually took its own mix off the item
     * (it only forgot it), and the next `attach` then saw a mix it did not recognise and refused with
     * *"the audible player's item already carries an audio mix"*. That refusal is precisely the owner's
     * *"to make it show again i have to select another song"*: only a genuinely new item could ever be
     * tapped, and the trip through the refusal is what the plugin reported as a failed start.
     *
     * So the test is on the processing tap, which is a CF object and is handed back by the item as the
     * very same instance we put there.
     */
    private func carriesOurTap(_ item: AVPlayerItem) -> Bool {
        guard let entry = installs[ObjectIdentifier(item)], entry.item === item else { return false }
        guard let processor = item.audioMix?.inputParameters.first?.audioTapProcessor else { return false }
        return processor === entry.tap
    }

    /// Drop the installs whose own item has been released (v2.0.0-beta.33).
    ///
    /// `ItemTap.item` is weak: the queue owns its items, and an install must not keep a track the
    /// player has finished with alive. Once an item is gone its entry measures nothing, and without
    /// this its analysis — and its FFT — would be held by the registry for the life of the process.
    /// Called from the two places an install can arrive (`install`, `attach`) and from `snapshot`, so
    /// an entry cannot outlive its item by more than one of those calls.
    private func prune() {
        let gone = installs.filter { $0.value.item == nil }.map { $0.key }
        for key in gone {
            installs[key]?.analysis.retire()
            installs.removeValue(forKey: key)
        }
    }

    /// Whether this tap is already on `item` — the readiness test `install` uses, so an item whose
    /// own track list is not built yet is still *verified* rather than re-tapped (v1.9.1).
    func isTapped(_ item: AVPlayerItem) -> Bool {
        carriesOurTap(item)
    }

    /**
     * Take the tap off the item and forget it.
     *
     * Pausing, seeking or unloading anything is not this class's to do: the item and the player are
     * the plugin's, and they carry on exactly as they were. Dropping the mix is what finalizes the
     * tap and releases our retain.
     *
     * v1.7.7 — **this is reached from exactly two places**, and neither is a transport or lifecycle
     * event: a *different* item being attached (where the item it leaves behind is one the plugin has
     * already replaced), and an explicit teardown request (`NaviliteSpectrum.stop`, which the engine
     * only sends when there is nothing left to measure). A pause, a resume, a seek, a return from the
     * background and the last second of a track must never arrive here: taking the mix off an item
     * that is being rendered reconfigures its audio pipeline, and that is the audible gap the owner
     * reported. Persisting the tap across all of them is the whole of this release.
     *
     * The mix is only cleared when the item still carries *ours* — someone else's mix is left alone,
     * because the audio being rendered is not this file's to change.
     *
     * v1.9.25 — and the analysis goes with the tap, because it belonged to this item: the register the
     * engine reads (`snapshot`'s `bands`/`live`) is that analysis's, so letting go of it is the same
     * reading `detach` always produced — an all-zero frame that is not live. `lifetimeFrames` is
     * deliberately *not* reset: it is the tap's count since the app started, and no decision is made
     * from it any more.
     */
    func detach() {
        for entry in installs.values {
            if let item = entry.item,
               item.audioMix?.inputParameters.first?.audioTapProcessor === entry.tap {
                item.audioMix = nil
            }
            entry.analysis.retire()
        }
        installs.removeAll()
        player = nil
    }

    /* -------------------------------------------------------------------- reporting */

    /// The frame the canvas should draw now, plus the honesty bookkeeping around it.
    ///
    /// The keys are the contract `src/player/native.ts` reads; `positionMs` and `playing` are the
    /// *audible* player's own answers now, which is what they always claimed to be.
    ///
    /// `bands`, `live`, `silentFrames`, `readable` and `sampleRate` are **the analysis's** answers —
    /// the item the tap is on — and none of them says anything about any other item (v1.9.25).
    /// `frames` is still the process-lifetime count; `itemFrames` is that count **for this item**,
    /// which is the fact the engine decides from: a register that does not move is not a measurement
    /// of the item playing now.
    ///
    /// v1.9.26 — and so are **`itemFramePeriodMs` and `itemFrameAgeMs`**: the pace this item's own tap
    /// declared at `prepare` and the age of the frame it is holding. They are published together
    /// because they are only meaningful together: the engine draws this item's last frame while its age
    /// is no longer than its own period, and names the state (drawing nothing) once it is older. Both
    /// are this analysis's, so a frame from one item can never be judged against another item's pace.
    func snapshot() -> [String: Any] {
        lock.lock()
        let lifetime = lifetimeFrames
        lock.unlock()
        let player = self.player
        let heard = sounding()
        let item = heard?.item
        let itemSeconds = item?.currentTime().seconds ?? 0
        let playerSeconds = player?.currentTime().seconds ?? itemSeconds
        let measurement = heard?.analysis.published
        return [
            "bands": (measurement?.bands ?? [UInt8](repeating: 0, count: AudibleSpectrumTap.bandCount)).map { Int($0) },
            "bandCount": AudibleSpectrumTap.bandCount,
            "live": measurement?.live ?? false,
            "frames": lifetime,
            // Frames **this item's** tap has produced (v1.9.25) — the per-item fact.
            "itemFrames": measurement?.frames ?? 0,
            // The pace of **this item's** own tap, and the age of the frame it is holding (v1.9.26):
            // the two numbers the engine's drawing rule is a comparison of. `maxFrames` over the sample
            // rate, floored at one hop, and an age that is `-1` until this analysis produces a frame.
            "itemFramePeriodMs": measurement?.framePeriodMs ?? 0,
            "itemFrameAgeMs": measurement?.sinceLastFrameMs ?? -1,
            // Frames the FFT has produced from digital silence — what "flat" looks like when it is
            // the *audio* that is flat rather than the measurement that is broken.
            "silentFrames": measurement?.silentFrames ?? 0,
            "positionMs": playerSeconds.isFinite ? playerSeconds * 1000 : 0,
            "playing": player?.timeControlStatus == .playing,
            // Whether the tap is currently on an item at all — the difference between "no frames
            // because it is quiet" and "no frames because nothing is tapped".
            "attached": item != nil,
            /*
             * Whether the item the tap is on is still the item the player is playing — v1.8.0.
             *
             * This is the answer the engine's orphan check reads. It is a plain identity comparison
             * between the item this tap was installed on and `player.currentItem`, made here, where
             * both are in hand: a track change replaces the player's item, and the tap stays on the
             * old one until it is installed on the new one. `playing` cannot see that, because the
             * player *is* playing — the new track — throughout.
             */
            "itemIsCurrent": item != nil && item === player?.currentItem,
            // The lifecycle rule, as numbers: installs may only grow for a new item, verifies grow
            // with every pause, resume, seek and return to the foreground.
            "installs": installCount,
            "verifies": verifyCount,
            "readable": measurement?.readable ?? true,
            "sampleRate": measurement?.sampleRate ?? 0
        ]
    }

    /// One frame the FFT has produced, counted for the app process (v1.9.25) — see `lifetimeFrames`.
    ///
    /// Called from the analysis queue by whichever analysis produced it, which is why the count needs
    /// this object's own lock: the analyses come and go, the number does not.
    fileprivate func noteAnalyzedFrame() {
        lock.lock()
        lifetimeFrames += 1
        lock.unlock()
    }
    /**
     * One item's tap: the mix written on that item, and the analysis that mix's tap measures into.
     *
     * The tap belongs to an **item**, not to the process (v2.0.0-beta.33). A queue holds several
     * items and every one of them carries its own, so this is the object that means "this item's
     * measurement". `item` is weak — the queue owns its items, and an install must not keep a track
     * the player has finished with alive — which is what lets `prune` tell an install whose item has
     * gone.
     */
    private final class ItemTap {
        weak var item: AVPlayerItem?
        let tap: MTAudioProcessingTap
        /// The mix this app wrote on the item — held so its own retain is predictable, and the only
        /// mix this class will ever remove.
        let mix: AVMutableAudioMix
        let analysis: SpectrumAnalysis

        init(item: AVPlayerItem, tap: MTAudioProcessingTap, mix: AVMutableAudioMix, analysis: SpectrumAnalysis) {
            self.item = item
            self.tap = tap
            self.mix = mix
            self.analysis = analysis
        }
    }
}

/**
 * The measurement of **one item** (v1.9.25): the window of PCM that item's tap handed over, the FFT
 * over it, the timer that drives the pair, and the frame they produce.
 *
 * It is created by `attach` for the item that install is putting a tap on, and it is the tap's own
 * storage — so `prepare`, `process`, `unprepare` and `finalize` all land here, on the state of the
 * item they are about, and never on another item's. That is the whole of the repair for the owner's
 * *"the lines stay dead the whole track"*: the teardown of an item the player has left stops the
 * analysis **that item started**, and the item playing now keeps its own timer and its own FFT.
 *
 * A retirement is final: once the plugin has installed a newer item's tap (`retire`), a late
 * `prepare` for this one does not start it up again. A plain `unprepare` is not final — the same
 * item can be prepared again (AVFoundation does that when an item is re-rendered) and the analysis
 * starts measuring again, which is why the timer is created at `prepare` rather than here.
 */
final class SpectrumAnalysis {
    /// The tap object this analysis belongs to. Weak, because it holds us.
    private weak var owner: AudibleSpectrumTap?

    /// Guards the published frame — the four values `snapshot` reports.
    private let lock = NSLock()
    private var bands = [UInt8](repeating: 0, count: AudibleSpectrumTap.bandCount)
    /// Frames **this** analysis has produced: zero at the install, and reset by nothing else. The
    /// plugin publishes it as `itemFrames`, and it is what makes "this item's tap has produced
    /// nothing yet" a fact about the item rather than an inference from a process-wide counter.
    private var frames = 0
    private var silentFrames = 0
    private var lastFrameLive = false
    private var readable = true
    private var sampleRate: Double = 0
    /// **The pace of this item's own tap, kept instead of discarded (v1.9.26).**
    ///
    /// `prepare` hands the tap's own declaration of the largest buffer it will ever be given
    /// (`maxFrames`), and until this version the plugin threw it away — which is what let the engine's
    /// drawing rule rest on an assumption nothing had measured, that a healthy tap produces a frame per
    /// read. Frames are produced when the PCM ring has accumulated one hop, and the ring is filled per
    /// *callback*, so the real rate is quantized to this number: `maxFrames / sampleRate` is how long
    /// this tap can legitimately go between two frames, floored at one hop (below `hop` samples no
    /// second frame can exist, however small the buffers are).
    private var framePeriodMs: Double = 0
    /// When this analysis produced its last frame, on the monotonic clock — 0 before its first (v1.9.26).
    ///
    /// The engine compares this against `framePeriodMs` to tell "this item's tap is between its own
    /// frames" (draw what it holds) from "this item's tap has stopped" (name it, draw nothing). Both
    /// numbers are properties of *this* item's analysis, which is why neither is a clock the engine
    /// keeps or a count of polls it has made.
    private var lastFrameUptime: Double = 0

    /// The frame as one value, read under the lock (v1.9.25).
    var published: PublishedFrame {
        lock.lock()
        let frame = PublishedFrame(
            bands: bands,
            live: lastFrameLive,
            frames: frames,
            silentFrames: silentFrames,
            readable: readable,
            sampleRate: sampleRate,
            // v1.9.26 — the pace, and the age of what is being held: read together, under the same
            // lock, so a frame can never be reported against the period of another moment.
            framePeriodMs: framePeriodMs,
            sinceLastFrameMs: frames == 0 ? -1 : max(0, (SpectrumAnalysis.uptime() - lastFrameUptime) * 1000)
        )
        lock.unlock()
        return frame
    }

    /// The monotonic clock this analysis stamps its frames with, in seconds.
    ///
    /// Uptime rather than a date: it cannot go backwards (a clock change or an NTP correction must not
    /// make a frame look younger or older than it is), and the age it produces is compared only with
    /// this analysis's own period.
    private static func uptime() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    }

    /*
     * ------------------------------------------------------------------ the hand-off
     *
     * v1.8.0 — **nothing here runs on the audio render thread any more.**
     *
     * Until v1.8.0 the tap's `process` callback did the windowing, the 2048-point FFT, the band fold
     * *and* took an `NSLock` — on the thread that is rendering the audio the user is hearing. vDSP is
     * fast and a frame every ~23 ms is small, so it usually got away with it, but a render thread must
     * never block on a lock the main thread can hold, and it must not allocate. Apple's own guidance
     * for `MTAudioProcessingTap` is to copy the samples out and process elsewhere. So the callback now
     * writes the PCM it is handed into a small preallocated ring and returns; a timer on a dedicated
     * queue drains that ring and does the window, the FFT and the fold off the audio thread.
     *
     * The lock on the render thread is an `os_unfair_lock` held for a sample-store loop, not an
     * `NSLock` held across an FFT: it is the kernel's own unfair lock, which donates priority rather
     * than inverting it. The `lock` above is still what guards the published bands, and it is now only
     * ever taken off the render thread.
     */
    private var pcm = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)
    private var pcmWrite = 0
    private var sinceLastFrame = 0
    private var pcmLock = os_unfair_lock_s()
    private let analysisQueue = DispatchQueue(label: "app.navilite.spectrum.analysis", qos: .userInitiated)
    private var analysisTimer: DispatchSourceTimer?
    /// Set false to tell a handler that is already queued that the FFT setup is going away.
    private var draining = false
    /// Set once this analysis belongs to an item the plugin has replaced: it is never started again.
    private var retired = false
    /// The window the analysis queue is working on. Owned by `analysisQueue`, never shared.
    private var analysisWindow = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)

    // FFT, built once per item, on the analysis queue — never on the render thread.
    private var fftSetup: FFTSetup?
    /// The format of the buffers the tap hands us, as reported by **this item's** tap at `prepare`.
    private var tapFormat: AudioStreamBasicDescription?
    private var window = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)
    private var windowed = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)
    private var realp = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    private var imagp = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    private var magnitudes = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    private var magnitudesSquared = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    /// `[from, to)` bin ranges, one per band — the same log spacing `visualizer.ts` uses.
    private var bandRanges: [(from: Int, to: Int)] = []

    init(owner: AudibleSpectrumTap) {
        self.owner = owner
    }

    fileprivate func prepare(sampleRate: Double, format: AudioStreamBasicDescription, maxFrames: CMItemCount) {
        guard !retired else { return }
        self.sampleRate = sampleRate
        self.tapFormat = format
        /*
         * v1.9.26 — **the tap's own pace, kept.** `maxFrames` is this tap's own statement of the
         * largest buffer it will ever be handed in one `process` call, and it is what quantizes frame
         * production: the ring is filled per callback and a frame is produced when it holds a hop, so
         * `maxFrames / sampleRate` is how long this item's tap can legitimately go between two frames.
         * (The hop is the floor: with buffers smaller than a hop, frames still cannot come faster than
         * one hop of audio, and a tap that declares a tiny `maxFrames` must not be judged against it.)
         *
         * Nothing else changed here; this number is published beside `itemFrames` and compared with the
         * age of this analysis's own last frame, so the engine can tell a tap that is between its
         * frames from one that has stopped without holding a clock of its own.
         */
        let declaredFrames = max(Double(maxFrames), Double(AudibleSpectrumTap.hop))
        self.framePeriodMs = sampleRate > 0 ? declaredFrames / sampleRate * 1000 : 0
        /*
         * Everything the analysis needs is built here, on `analysisQueue`, and the timer that drains
         * the PCM ring is started with it. `prepare` is called by the tap before the first `process`,
         * so this is the one moment nothing is being analysed; doing it inside the queue's own
         * `sync` is what makes the FFT setup and the timer's handler mutually exclusive.
         *
         * The guard is on *this* analysis's timer (v1.9.25): a timer belonging to another item is not
         * a reason to skip this item's first frames, which is exactly how the measurement of the item
         * playing now used to be thrown away — the incoming item's `prepare` returned here because
         * the outgoing item's timer was still running, and then that timer was destroyed.
         */
        analysisQueue.sync {
            guard self.analysisTimer == nil else { return }
            let log2n = vDSP_Length(log2(Float(AudibleSpectrumTap.windowSize)))
            guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return }
            self.fftSetup = setup
            vDSP_hann_window(&self.window, vDSP_Length(AudibleSpectrumTap.windowSize), Int32(vDSP_HANN_NORM))
            self.buildBandRanges()
            self.draining = true
            let timer = DispatchSource.makeTimerSource(queue: self.analysisQueue)
            let interval = AudibleSpectrumTap.analysisIntervalMs
            timer.schedule(deadline: .now() + .milliseconds(interval), repeating: .milliseconds(interval), leeway: .milliseconds(2))
            timer.setEventHandler { [weak self] in self?.drainAndAnalyze() }
            self.analysisTimer = timer
            timer.resume()
        }
    }

    /// The same log spacing the canvas uses: 64 bands over bins 2 … 60% of the spectrum, geometrically.
    private func buildBandRanges() {
        let binCount = AudibleSpectrumTap.windowSize / 2
        let end = max(8, Int(Double(binCount) * 0.6))
        let minLog = log(2.0)
        let maxLog = log(Double(end))
        var edges: [Int] = []
        for index in 0...AudibleSpectrumTap.bandCount {
            let value = Int(floor(exp(minLog + (maxLog - minLog) * (Double(index) / Double(AudibleSpectrumTap.bandCount))))) - 1
            edges.append(value)
        }
        bandRanges = (0..<AudibleSpectrumTap.bandCount).map { band in
            let from = max(0, min(binCount - 1, edges[band]))
            let to = max(from + 1, min(binCount, edges[band + 1]))
            return (from, to)
        }
    }

    /**
     * One tap callback's worth of PCM, and nothing else.
     *
     * `bufferList` is the rendered audio the user is hearing: reading it is the whole point, and it
     * is never written to — the buffers carry straight on to the output, which is what makes this a
     * measurement of the sound rather than a copy of it.
     *
     * v1.8.0 — this runs on the render thread, so it does the one cheap thing: decode each sample into
     * the float ring. No FFT, no lock held across computation, no allocation, no dispatch. The window
     * and the transform happen on `analysisQueue` (see `drainAndAnalyze`), which is what keeps the
     * visualiser from ever being the reason the audio stutters.
     *
     * v1.9.25 — and the ring is **this item's**. It used to be one ring for the process, which meant
     * an outgoing item whose tap was still rendering wrote its samples into the window the item
     * playing now was being measured with.
     */
    fileprivate func consume(bufferList: UnsafeMutablePointer<AudioBufferList>, frames frameCount: Int) {
        guard frameCount > 0, let format = tapFormat else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
        guard let first = buffers.first, let data = first.mData else { return }
        let channels = max(1, Int(format.mChannelsPerFrame))
        let interleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        let stride = interleaved ? channels : 1
        let total = Int(first.mDataByteSize)
        let isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bits = Int(format.mBitsPerChannel)

        os_unfair_lock_lock(&pcmLock)
        defer { os_unfair_lock_unlock(&pcmLock) }
        readable = true
        for index in 0..<frameCount {
            let value: Float
            if isFloat && bits == 32 {
                let pointer = data.assumingMemoryBound(to: Float.self)
                let offset = index * stride
                guard (offset + 1) * 4 <= total else { break }
                value = pointer[offset]
            } else if !isFloat && bits == 16 {
                let pointer = data.assumingMemoryBound(to: Int16.self)
                let offset = index * stride
                guard (offset + 1) * 2 <= total else { break }
                value = Float(pointer[offset]) / 32768
            } else {
                readable = false
                return
            }
            pcm[pcmWrite] = value
            pcmWrite = (pcmWrite + 1) % AudibleSpectrumTap.windowSize
            sinceLastFrame += 1
        }
    }

    /**
     * The analysis half, on `analysisQueue`: take the most recent window of PCM and transform it.
     *
     * Polled rather than signalled, deliberately: posting to a queue from the render thread is an
     * allocation, and the whole point of the hand-off is that the render thread only stores floats.
     * The timer runs every {@link AudibleSpectrumTap.analysisIntervalMs}, which is shorter than the
     * hop, so a window is ready on roughly every second tick and nothing is ever late.
     */
    private func drainAndAnalyze() {
        guard draining, let setup = fftSetup else { return }
        var ready = false
        os_unfair_lock_lock(&pcmLock)
        if sinceLastFrame >= AudibleSpectrumTap.hop {
            sinceLastFrame = 0
            for index in 0..<AudibleSpectrumTap.windowSize {
                analysisWindow[index] = pcm[(pcmWrite + index) % AudibleSpectrumTap.windowSize]
            }
            ready = true
        }
        os_unfair_lock_unlock(&pcmLock)
        guard ready else { return }
        analyze(with: setup)
    }

    private func analyze(with setup: FFTSetup) {
        let n = AudibleSpectrumTap.windowSize
        let half = n / 2
        for index in 0..<n {
            windowed[index] = analysisWindow[index] * window[index]
        }
        windowed.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            base.withMemoryRebound(to: DSPComplex.self, capacity: half) { complex in
                realp.withUnsafeMutableBufferPointer { real in
                    imagp.withUnsafeMutableBufferPointer { imag in
                        var split = DSPSplitComplex(realp: real.baseAddress!, imagp: imag.baseAddress!)
                        vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(half))
                        vDSP_fft_zrip(setup, &split, 1, vDSP_Length(log2(Float(n))), FFTDirection(FFT_FORWARD))
                        vDSP_zvmags(&split, 1, &magnitudesSquared, 1, vDSP_Length(half))
                    }
                }
            }
        }

        // `vDSP_fft_zrip` packs the real transform and returns it scaled by 2, so the squared
        // magnitudes it leaves are 4·|DFT|². For a real tone of amplitude A, |DFT| is A·n/4 with the
        // Hann window's coherent gain of ½ — which is what makes the division below land on the
        // tone's own amplitude, and 0 dB mean full scale, the same mapping the web analyser applies.
        let scale = 1.0 / Float(n * n)
        var frame = [UInt8](repeating: 0, count: AudibleSpectrumTap.bandCount)
        var any = false
        for band in 0..<AudibleSpectrumTap.bandCount {
            let range = bandRanges[band]
            var sum: Float = 0
            let count = max(1, range.to - range.from)
            for bin in range.from..<range.to where bin < half {
                magnitudes[bin] = sqrt(magnitudesSquared[bin] * scale)
                sum += magnitudes[bin]
            }
            let mean = sum / Float(count) * 2
            let decibels = 20 * log10(max(mean, 1e-12))
            let value = Int(((decibels - AudibleSpectrumTap.floorDecibels) / -AudibleSpectrumTap.floorDecibels) * 255)
            let clamped = UInt8(max(0, min(255, value)))
            frame[band] = clamped
            if clamped > 0 { any = true }
        }

        lock.lock()
        bands = frame
        frames += 1
        if any { silentFrames = 0 } else { silentFrames += 1 }
        lastFrameLive = any
        // v1.9.26 — and when: the age the engine compares with this analysis's own `framePeriodMs` is
        // measured from here, so "this item's tap has produced nothing since" is a length of time about
        // this item's own analysis rather than a count of the engine's polls.
        lastFrameUptime = SpectrumAnalysis.uptime()
        lock.unlock()
        /*
         * And the same frame counted for the app process, which is what `frames` has always been:
         * a *silent* item's frames count too, and that is the whole point — a tap that is measuring
         * silence produces frames, a tap that has stopped measuring produces none, and the engine can
         * tell those two apart only if both numbers exist.
         */
        owner?.noteAnalyzedFrame()
    }

    fileprivate func unprepare() {
        stop()
    }

    /**
     * Stop measuring for good (v1.9.25): the plugin has installed a newer item's tap, so this item is
     * no longer the one being heard. A late `prepare` for this analysis does nothing from here on.
     */
    func retire() {
        retired = true
        stop()
    }

    /**
     * Stop the analysis before the setup it uses is destroyed.
     *
     * The timer's handler runs on `analysisQueue`, and a handler may already be queued when this
     * (render-thread) call arrives: cancelling stops future deliveries, the `sync` waits for the queue
     * to be free, and `draining = false` is checked at the top of the handler, so anything that runs
     * after this point returns without touching the FFT setup it can no longer see.
     */
    private func stop() {
        analysisTimer?.cancel()
        analysisTimer = nil
        analysisQueue.sync {
            self.draining = false
            if let setup = self.fftSetup { vDSP_destroy_fftsetup(setup) }
            self.fftSetup = nil
        }
        os_unfair_lock_lock(&pcmLock)
        pcmWrite = 0
        sinceLastFrame = 0
        os_unfair_lock_unlock(&pcmLock)
    }

    fileprivate func finalize() {
        stop()
    }
}

/// One published frame of one item's analysis, as `snapshot` reports it (v1.9.25).
struct PublishedFrame {
    var bands: [UInt8]
    var live: Bool
    var frames: Int
    var silentFrames: Int
    var readable: Bool
    var sampleRate: Double
    /// The period this item's own tap declared for itself, in ms (v1.9.26) — see `framePeriodMs`.
    var framePeriodMs: Double
    /// How long ago this analysis produced its last frame, in ms — `-1` before its first (v1.9.26).
    var sinceLastFrameMs: Double
}

/* --------------------------------------------------------------------- tap callbacks */

private func audibleSpectrumTapInit(tap: MTAudioProcessingTap, clientInfo: UnsafeMutableRawPointer?, tapStorageOut: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Void {
    tapStorageOut.pointee = clientInfo
}

private func audibleSpectrumTapFinalize(tap: MTAudioProcessingTap) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    // The retain taken for `clientInfo` belongs to the tap: this is the only place it is dropped.
    // One tap, one analysis (v1.9.25), so this drops that item's measurement and nothing else's.
    Unmanaged<SpectrumAnalysis>.fromOpaque(storage).release()
}

private func audibleSpectrumTapPrepare(tap: MTAudioProcessingTap, maxFrames: CMItemCount, processingFormat: UnsafePointer<AudioStreamBasicDescription>) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    let analysis = Unmanaged<SpectrumAnalysis>.fromOpaque(storage).takeUnretainedValue()
    analysis.prepare(
        sampleRate: processingFormat.pointee.mSampleRate,
        format: processingFormat.pointee,
        // v1.9.26 — the tap's own declaration of the largest buffer it will hand us. It used to be
        // dropped here, which is how the engine came to be written against "a frame per read".
        maxFrames: maxFrames
    )
}

private func audibleSpectrumTapUnprepare(tap: MTAudioProcessingTap) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    let analysis = Unmanaged<SpectrumAnalysis>.fromOpaque(storage).takeUnretainedValue()
    analysis.unprepare()
}

private func audibleSpectrumTapProcess(
    tap: MTAudioProcessingTap,
    numberFrames: CMItemCount,
    flags: MTAudioProcessingTapFlags,
    bufferListInOut: UnsafeMutablePointer<AudioBufferList>,
    numberFramesOut: UnsafeMutablePointer<CMItemCount>,
    flagsOut: UnsafeMutablePointer<MTAudioProcessingTapFlags>
) -> Void {
    var timeRange = CMTimeRange()
    let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, &timeRange, numberFramesOut)
    if status == noErr {
        let storage = MTAudioProcessingTapGetStorage(tap)
        let analysis = Unmanaged<SpectrumAnalysis>.fromOpaque(storage).takeUnretainedValue()
        analysis.consume(bufferList: bufferListInOut, frames: Int(numberFramesOut.pointee))
    }
    /*
     * And then *nothing*. The v1.7.x tap zeroed these buffers to keep its own player silent; these
     * buffers are the audio the user is hearing, so they are left exactly as the player rendered
     * them. A tap that wrote here would be changing the sound, which is the one thing it must not do.
     */
}

#if canImport(Capacitor)

/**
 * The bridge half of the spectrum: one method, `bands`, answering the frame of the item the queue is
 * playing now.
 *
 * It is a read of `AudibleSpectrumTap` and nothing else. Until v2.0.0-beta.33 this class also carried
 * `start`, `stop`, `configureBuffer` and `warmSlot`, whose whole job was to find a *different* player
 * — the removed native-audio plugin's `AVPlayer` — reflectively and put the tap on its item. There is
 * one player now, `NaviliteRemote`'s queue, and every item it builds carries its own tap from
 * `makeItem`, so there is nothing here to find, start, warm or stop. A method no shipped JS can reach
 * is a method that can only lie about the audio.
 *
 * Registered by hand in `ViewController.capacitorDidLoad()`, because a Swift-only local plugin has no
 * npm package for `cap sync` to discover.
 */
@objc(NaviliteSpectrum)
public class NaviliteSpectrum: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NaviliteSpectrum"
    public let jsName = "NaviliteSpectrum"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "bands", returnType: CAPPluginReturnPromise)
    ]

    private let spectrum = AudibleSpectrumTap.shared

    /// The frame the visualiser draws: the bands of the item the queue is on, that item's own frame
    /// count and pace, and the player's own `positionMs`/`playing`.
    @objc func bands(_ call: CAPPluginCall) {
        call.resolve(spectrum.snapshot())
    }
}

#endif
