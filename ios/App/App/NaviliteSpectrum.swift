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
 * There is now exactly one `AVPlayer` in the app — the plugin's — and this file taps *it*:
 *
 *   1. the player is found on the bridge (`@capgo/capacitor-native-audio` owns it and exposes no
 *      accessor, so it is read reflectively and read-only — see `AudibleBridgePlayer` below);
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
    private var item: AVPlayerItem?
    private weak var player: AVPlayer?
    private var tap: MTAudioProcessingTap?
    /// The mix this class put on the item — the only one it will ever remove.
    private var installedMix: AVMutableAudioMix?
    private var url: URL?
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
    private var currentAnalysis: SpectrumAnalysis?

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
            self.url = requestedUrl
            return .success(publishedSampleRate)
        }
        detach()
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

        self.tap = tap
        self.installedMix = mix
        self.item = item
        self.player = player
        self.url = requestedUrl
        installCount += 1
        /*
         * **And the item this install replaces stops being measured (v1.9.25).**
         *
         * The analysis that was current belongs to an item the player is no longer on: it is
         * *retired* — its timer cancelled, its FFT destroyed — which is a change to a queue on this
         * side and to nothing the listener can hear, and it is what keeps the process from running a
         * second FFT for a track nobody is listening to. The analysis being installed has no timer at
         * all until AVFoundation prepares *its* tap (`prepare`), so the hand-over itself measures
         * nothing and delays nothing; from the item's first frame on, `snapshot` publishes this
         * analysis and only this one.
         */
        currentAnalysis?.retire()
        currentAnalysis = analysis

        return .success(publishedSampleRate)
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
        guard self.item === item, let tap else { return false }
        guard let processor = item.audioMix?.inputParameters.first?.audioTapProcessor else { return false }
        return processor === tap
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
        if let item, carriesOurTap(item) {
            item.audioMix = nil
        }
        tap = nil
        installedMix = nil
        item = nil
        player = nil
        url = nil
        currentAnalysis?.retire()
        currentAnalysis = nil
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
        let item = self.item
        let itemSeconds = item?.currentTime().seconds ?? 0
        let playerSeconds = player?.currentTime().seconds ?? itemSeconds
        let measurement = currentAnalysis?.published
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
 * The bridge half of the spectrum: finding the player the user is hearing, and handing its item to
 * `AudibleSpectrumTap`.
 *
 * `@capgo/capacitor-native-audio` owns the audible `AVPlayer` and exposes no accessor for it, and a
 * local app plugin cannot add one. So the player is read off the plugin instance the bridge already
 * holds: `NativeAudio`'s own `audioList` (`[assetId: AudioAsset]`) and that asset's `players`. The
 * read is reflective (`Mirror`) and read-only — nothing here writes to the plugin, and nothing here
 * creates, starts or stops a player. If the lookup fails, the plugin rejects with the reason and the
 * visualiser stays on the album-art theme; the audio is unaffected either way.
 *
 * Registered by hand in `ViewController.capacitorDidLoad()`, because a Swift-only local plugin has no
 * npm package for `cap sync` to discover.
 */
@objc(NaviliteSpectrum)
public class NaviliteSpectrum: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NaviliteSpectrum"
    public let jsName = "NaviliteSpectrum"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bands", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configureBuffer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "warmSlot", returnType: CAPPluginReturnPromise)
    ]

    /// How long `warmSlot` waits for a slot's item to appear, and for AVFoundation to answer — the
    /// same 100 ms steps the spectrum's own install waits in, and a deadline it cannot exceed.
    static let warmStep = 0.1
    static let warmDeadline = 6.0

    /// The asset id `src/player/native.ts` loads every track under.
    static let audibleAssetId = "navilite-current"

    private let spectrum = AudibleSpectrumTap()
    /// Bumped by every `start` and `stop`, so a `start` that is still waiting for the player's item
    /// to load cannot install itself over a newer one.
    private var generation = 0

    /// Whether work that captured the generation `token` still belongs to the current request
    /// (v1.9.10) — the test a `warmSlot` in flight makes before it asks the player for anything.
    func isCurrent(generation token: Int) -> Bool {
        token == generation
    }

    /**
     * Begin analysing the audio the player is playing.
     *
     * `url` and `positionMs` are still in the caller's contract, and neither opens anything any more:
     * the samples come from the player that is *already* playing, and its clock is the clock. `url` is
     * passed on only so a mismatch can be logged.
     */
    @objc func start(_ call: CAPPluginCall) {
        let requested = call.getString("url").flatMap { URL(string: $0) }
        /*
         * v1.9.5 — **the caller says which slot it is playing, and that slot is the only one this may
         * tap.**
         *
         * The lookup below used to be this plugin's own guess (`AudibleBridgePlayer.find`), and with
         * the pool holding a silent, buffered track per neighbour it could land on a player nobody is
         * hearing — the vendor plugin clears its own `currentlyPlayingAssetId` at the moment an item
         * is unloaded, and the guess then fell through to any asset holding an item and reported
         * `started: true`. The bars were then a picture of a silent player: real frames of the wrong
         * audio, or none at all, while the app believed the tap was healthy.
         *
         * A named slot that is not on the bridge is now a **refusal**, not a licence to guess: the
         * app is told the bars are on the album-art theme instead of being told a lie. A caller that
         * names nothing (an older JS bundle) still gets the plugin's own answer.
         */
        let requestedAssetId = call.getString("assetId")
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("the spectrum plugin is gone")
                return
            }
            let named = requestedAssetId.flatMap { $0.isEmpty ? nil : $0 }
            if let named {
                guard let found = AudibleBridgePlayer.player(named, from: self.bridge) else {
                    call.reject("the player this app is playing (\(named)) is not loaded on the bridge, so there is nothing to tap — the bars stay on the album-art theme")
                    return
                }
                self.begin(call: call, player: found.player, assetId: found.assetId, requested: requested)
                return
            }
            if let remote = self.bridge?.plugin(withName: "NaviliteRemote") as? NaviliteRemote,
               remote.currentAwayOwnsAudible,
               let queue = remote.currentAwayQueue, queue.currentItem != nil {
                self.begin(call: call, player: queue, assetId: NaviliteRemote.awaySlotName, requested: requested)
                return
            }
            guard let audible = AudibleBridgePlayer.find(from: self.bridge) else {
                call.reject("the audible player was not found on the bridge, so there is nothing to tap — the bars stay on the album-art theme")
                return
            }
            self.begin(call: call, player: audible.player, assetId: audible.assetId, requested: requested)
        }
    }

    /// Start the tap on one named player. Split out so both lookups above land here identically.
    private func begin(call: CAPPluginCall, player: AVPlayer, assetId: String, requested: URL?) {
        self.generation += 1
        let generation = self.generation
        /*
         * v1.9.1: the wait for the item's audio track is *awaited* off the main thread rather
         * than retried on it, and the readiness test is asynchronous with it. The retry loop is
         * kept — an item that has just been created genuinely has no track list for a moment —
         * but every step of it yields the main thread instead of holding it, which is what put
         * the new stream's cold fetch in front of the play call that was waiting on it.
         *
         * v1.9.11 — **and the executor is deliberately left exactly as it was.** The synchronous
         * accessor above is gone, so there is no longer any call on this path that blocks the thread
         * it runs on: the install now awaits an async property load and nothing else. Moving this hop
         * (`Task` -> `Task.detached`) would change *which* thread writes `item.audioMix`, and a second
         * writer of that property is a race this app has already diagnosed once — the install writing
         * the mix while `stop`/`detach` clears it. The rule the owner set is that nothing may block the
         * main thread, and the way it is kept here is by removing the blocking call rather than by
         * relocating the code around it.
         */
        Task { [weak self] in
            await self?.install(call: call, player: player, assetId: assetId, requested: requested, generation: generation, waited: 0)
        }
    }

    /// Attach as soon as the player's item has an audio track, giving up after a few attempts.
    private func install(call: CAPPluginCall, player: AVPlayer, assetId: String, requested: URL?, generation: Int, waited: Double) async {
        guard generation == self.generation else {
            call.reject("a newer spectrum request superseded this one")
            return
        }
        if let item = player.currentItem {
            let track = await AudibleSpectrumTap.audioTrack(of: item)
            /*
             * v1.9.22 — **both questions are asked again once the wait is over.**
             *
             * The read above happens *before* the await, and the await is where this install spends
             * its time: `audioTrack(of:)` resolves the item's own track list, and for a stream being
             * replaced that can take a second or more (the loop below waits up to
             * `trackWaitSeconds` for it). A track change during that window used to leave this
             * install attaching to the item it had read — the item the player had just left — while
             * a newer request had already installed the tap on the item that is playing. `attach`
             * begins with `detach()`, so the tap came *off* the item being heard and went onto a
             * dead one: `itemIsCurrent` false, no frames, and the canvas handed nothing while the
             * song played. That is the owner's *"while the song is playing the spectrum is just
             * zero"*, and it is a race, which is why it only showed up when he moved through songs
             * quickly.
             *
             * The generation guard above is not enough on its own: it is checked before the read,
             * and nothing after the await used to re-check it. So: a request that has been overtaken,
             * or whose item is no longer the player's current item, does not attach. It re-reads and
             * tries again instead — the same bounded retry as an item whose track list is not built
             * yet — and a request that cannot find the player on its own item within the budget
             * reports that, rather than taking the tap off the audio the listener is hearing.
             */
            if generation == self.generation, player.currentItem === item {
                if track != nil || spectrum.isTapped(item) {
                    switch spectrum.attach(to: item, track: track, player: player, requestedUrl: requested) {
                    case .success(let sampleRate):
                        call.resolve([
                            "started": true,
                            "sampleRate": sampleRate,
                            "bandCount": AudibleSpectrumTap.bandCount,
                            "tapped": assetId
                        ])
                    case .failure(let error):
                        call.reject(error.errorDescription ?? "the spectrum could not be tapped onto the audible player")
                    }
                    return
                }
            }
        }
        guard waited < AudibleSpectrumTap.trackWaitSeconds else {
            call.reject(player.currentItem == nil
                ? "the audible player has no item loaded yet, so there is nothing to tap"
                : "the audible player's item was replaced while this request was waiting for its audio track, so there is nothing to tap")
            return
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
        await install(call: call, player: player, assetId: assetId, requested: requested, generation: generation, waited: waited + 0.1)
    }

    /// Stop analysing. The audio that is heard is untouched — this has never owned it.
    ///
    /// v1.7.7: the engine no longer sends this on a pause, a resume, a seek, a return from the
    /// background or an interruption — every one of those used to arrive here as a detach followed by
    /// a re-install on a playing item, which is the audible gap. It is kept for a genuine teardown
    /// (nothing left to measure) and for a caller that explicitly wants the tap gone.
    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.generation += 1
            self?.spectrum.detach()
            call.resolve(["stopped": true])
        }
    }

    /**
     * Nothing is left to line up — v1.8.0, and now there is no method here at all.
     *
     * The tap is *on* the player that is heard, so its position and the player's are the same clock,
     * not two clocks to keep together; `resync` answered `driftMs: 0` unconditionally, which the
     * engine called twelve times a minute. The plugin method and the JS call that reached it are both
     * deleted rather than kept as a no-op: a bridge round trip per five seconds that corrects nothing
     * is the kind of thing that gets mistaken for a working feature.
     */

    /// The most recent frame: 64 band values in 0…255, and whether it was a real measurement.
    @objc func bands(_ call: CAPPluginCall) {
        call.resolve(spectrum.snapshot())
    }

    /**
     * Aim the audible item at a forward buffer of `seconds` (v1.9.2).
     *
     * *"play as soon as ~5 seconds of audio are buffered, then keep filling behind it"* is the
     * owner's request, and `AVPlayerItem.preferredForwardBufferDuration` is the only lever
     * AVFoundation gives for it. Nothing set it anywhere: the player was left to fill as much as it
     * could and to decide for itself when it had enough, which is why a track could take a minute
     * on his link before a note was heard.
     *
     * It is here rather than in the audio vendor's plugin because it is *our* plugin that can reach
     * the audible player (see `AudibleBridgePlayer`, the same reflective, read-only lookup the tap
     * uses) — the vendor exposes no API for buffer policy. This changes a number on an item that is
     * already playing; it does not start, stop, seek or reconfigure anything, so it cannot make a
     * sound. Called after every load's play and after every adoption, because the item that is
     * audible changes at both.
     */
    @objc func configureBuffer(_ call: CAPPluginCall) {
        let seconds = call.getDouble("seconds") ?? 5
        /*
         * The slot the app says it is playing goes with this too (v1.9.5), for the same reason the tap
         * takes it: the property is written on *one* item, and the app is the side that knows which
         * one is being heard. No name (an older JS bundle) keeps the plugin's own lookup.
         */
        let requestedAssetId = call.getString("assetId").flatMap { $0.isEmpty ? nil : $0 }
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("the spectrum plugin is gone")
                return
            }
            let named = requestedAssetId.flatMap { AudibleBridgePlayer.player($0, from: self.bridge) }
            guard let audible = named ?? AudibleBridgePlayer.find(from: self.bridge), let item = audible.player.currentItem else {
                // No audible item yet (a cold start, or the lookup failed): the player keeps its
                // own policy, which is exactly what every build before this one had.
                call.resolve(["buffered": false])
                return
            }
            item.preferredForwardBufferDuration = max(1, seconds)
            /*
             * **And it starts on the first seconds that arrive, not on a comfortable buffer
             * (v1.9.8).**
             *
             * The owner's own wording: *"play as soon as ~5 seconds of audio are buffered, then keep
             * filling behind it"*. Until this release nothing anywhere set
             * `automaticallyWaitsToMinimizeStalling`, whose default `true` lets AVFoundation decide
             * for itself that it has "enough" — which on a relayed mobile link is the whole of the
             * silence before a cold tap produces a note. False is what makes the forward-buffer
             * target above mean something: start now, fill behind. It is a property of the item,
             * written on an item that is already the right one, and it makes no sound.
             */
            audible.player.automaticallyWaitsToMinimizeStalling = false
            call.resolve([
                "buffered": true,
                "seconds": item.preferredForwardBufferDuration,
                "eager": !audible.player.automaticallyWaitsToMinimizeStalling,
                "assetId": audible.assetId
            ])
        }
    }

    /**
     * Make a **warm** slot demonstrably able to start, and answer with the media it holds (v1.9.8).
     *
     * `preload` resolving only ever meant that an `AVPlayerItem` and an `AVPlayer` were created: the
     * player nobody has asked for anything does not necessarily hold a byte, which is exactly why
     * the owner's *"it should already have prefetched the next song but it still doesn't load and
     * play instantly"* was right — the "next two songs" were prepared in name only.
     *
     * So this does the two things that make a slot real, and it does them on the slot the app names:
     * it aims the item at a forward buffer, and it asks AVFoundation for the media data required to
     * start it (`preroll`), which loads without making a sound. Then it reports the seconds the item
     * actually holds. The audio being heard is not touched, not started and not seeked: this slot
     * has never been played and is not the audible one.
     */
    @objc func warmSlot(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId"), !assetId.isEmpty else {
            call.reject("warmSlot needs the id of the slot to make warm")
            return
        }
        let seconds = max(1, call.getDouble("seconds") ?? 5)
        let minSeconds = max(0.5, call.getDouble("minSeconds") ?? 1.5)
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("the spectrum plugin is gone")
                return
            }
            /*
             * The generation goes with the attempt (v1.9.10): `start` and `stop` both bump it, and a
             * warm that predates either is a warm for a slot nobody is on any more.
             */
            WarmAttempt(call: call, assetId: assetId, minSeconds: minSeconds, generation: self.generation).start(plugin: self, seconds: seconds)
        }
    }

    /// The media a slot's item holds right now, in seconds — the longest loaded range it reports.
    static func bufferedSeconds(_ item: AVPlayerItem) -> Double {
        var most = 0.0
        for value in item.loadedTimeRanges {
            let seconds = value.timeRangeValue.duration.seconds
            if seconds.isFinite, seconds > most { most = seconds }
        }
        return most
    }

    /// The player's and the item's own state, in one word each (v1.9.9) — for the reason line.
    ///
    /// `preroll` is only legal in `.readyToPlay`, so which of the three states a slot is sitting in
    /// is the fact that decides whether it may be asked to start. Naming it makes a slot that was
    /// not ready readable on the screen, instead of a warm that silently did not happen.
    static func statusName(_ status: AVPlayer.Status) -> String {
        switch status {
        case .readyToPlay: return "ready to play"
        case .failed: return "failed"
        default: return "not ready yet"
        }
    }

    static func statusName(_ status: AVPlayerItem.Status) -> String {
        switch status {
        case .readyToPlay: return "ready to play"
        case .failed: return "failed"
        default: return "not ready yet"
        }
    }

    /// How close to its own duration an item's clock has to be before it counts as finished (v1.9.10).
    static let endEpsilon = 0.05

    /**
     * Whether an item has already played to its end (v1.9.10).
     *
     * This is the precondition `status` cannot express. AVFoundation leaves an item at `.readyToPlay`
     * for the whole of its life, so by status alone an item that finished an hour ago and an item that
     * has not loaded a byte look the same — and both take the same code path into `preroll` or into a
     * start, which is the class of call that took the app down twice for the owner. The two facts that
     * do describe the end are the item's own clock and its own duration: a duration that is known, and
     * a clock that has reached it. An item whose duration is not known yet cannot have ended.
     *
     * Every caller uses it the same way: as a refusal, in the same turn as the call it guards, never
     * as a promise about the future.
     */
    static func hasEnded(_ item: AVPlayerItem) -> Bool {
        /*
         * **And it is only asked of an item that has already been inspected (v1.9.11).**
         *
         * `item.duration` is not a stored number: on an item whose asset has not been loaded it is a
         * question put to the media server, and on a remote item that question is asked
         * *synchronously* — the same `remoteXPCAsset_CopyProperty` round trip over XPC that the
         * track list costs, in the crash report the owner sent. This function is called from the
         * main thread by `WarmAttempt` and by `NaviliteRemote.playSlot`, on items that may have only
         * just been created, so it was the app asking that question on the main thread at every
         * boundary and every skip.
         *
         * `.readyToPlay` is the fact that says the question has already been answered: an item is not
         * ready until AVFoundation has inspected its asset. So an item that is not ready is answered
         * here without touching the asset at all — and it is the right answer, because an item that
         * cannot be started cannot have ended. Every caller keeps its own ready-to-play precondition
         * as well, so this changes nothing about which items are refused.
         */
        guard item.status == .readyToPlay else { return false }
        let duration = item.duration.seconds
        guard duration.isFinite, duration > 0 else { return false }
        let position = item.currentTime().seconds
        return position.isFinite && position >= duration - endEpsilon
    }
}

/**
 * One `warmSlot` call in flight (v1.9.8).
 *
 * A class because three things race here and exactly one of them may answer: the slot's item
 * appearing (a preload that is still resolving), AVFoundation's own answer to `preroll`, and the
 * deadline. Whichever speaks first wins, the others are no-ops, and the answer always carries the
 * seconds of media the slot actually holds — never a claim about a player that was merely created.
 *
 * Since v1.9.10 it also carries the **generation** of the spectrum request it belongs to, and asks
 * the plugin whether that is still the current one before it issues anything: `preroll` raises an
 * exception rather than reporting an error, and the one thing that must never happen here is asking a
 * player something on behalf of a request that has been superseded.
 */
private final class WarmAttempt {
    private let call: CAPPluginCall
    private let assetId: String
    private let minSeconds: Double
    /// The spectrum generation this attempt belongs to — see `NaviliteSpectrum.isCurrent(generation:)`.
    private let generation: Int
    private var answered = false
    private var waited = 0.0

    init(call: CAPPluginCall, assetId: String, minSeconds: Double, generation: Int) {
        self.call = call
        self.assetId = assetId
        self.minSeconds = minSeconds
        self.generation = generation
    }

    func start(plugin: NaviliteSpectrum, seconds: Double) {
        guard !answered else { return }
        guard let found = AudibleBridgePlayer.player(assetId, from: plugin.bridge), let item = found.player.currentItem else {
            guard waited < NaviliteSpectrum.warmDeadline else {
                answer(buffered: false, seconds: 0, ready: false, reason: "the slot holds no item on the player")
                return
            }
            waited += NaviliteSpectrum.warmStep
            DispatchQueue.main.asyncAfter(deadline: .now() + NaviliteSpectrum.warmStep) { [weak self] in
                self?.start(plugin: plugin, seconds: seconds)
            }
            return
        }
        /*
         * **The statement check comes first (v1.9.10)**, before a single property is written or a
         * single call is made: `start` and `stop` both bump the generation, and a warm that belongs to
         * a request the app has already superseded is a warm for a slot nobody is on any more. Answered
         * rather than dropped, so the caller is told instead of waiting out its own timeout.
         */
        guard plugin.isCurrent(generation: generation) else {
            answer(
                buffered: false,
                seconds: NaviliteSpectrum.bufferedSeconds(item),
                ready: false,
                reason: "a newer spectrum request superseded this warm, so nothing was asked of the player"
            )
            return
        }
        /*
         * **And the item this attempt is holding must still be the slot's own item (v1.9.10).** A slot
         * is replaced under a warm — a new track is loaded into it, or the app unloads it — and an item
         * that has been replaced is not the item any of this is about: the player would be asked about
         * one item and judged on another. Not an answer, a wait: the slot is re-read next rung and the
         * item that is there now is judged then, under the same deadline as everything else here.
         */
        guard found.player.currentItem === item else {
            guard waited < NaviliteSpectrum.warmDeadline else {
                answer(
                    buffered: false,
                    seconds: NaviliteSpectrum.bufferedSeconds(item),
                    ready: false,
                    reason: "the slot's item was replaced while it was being warmed, so it was never asked to start"
                )
                return
            }
            waited += NaviliteSpectrum.warmStep
            DispatchQueue.main.asyncAfter(deadline: .now() + NaviliteSpectrum.warmStep) { [weak self] in
                self?.start(plugin: plugin, seconds: seconds)
            }
            return
        }
        /*
         * **And it must not have finished already (v1.9.10).** `.readyToPlay` does not describe this at
         * all — it stays true for the whole life of an item, so an item whose track played to its end
         * an hour ago reads exactly like a fresh one — and asking `preroll` of a player whose item has
         * already reached its end is asking for something it cannot give: the same class of call that
         * took 1.9.8 down. Answered, never asked.
         */
        guard !NaviliteSpectrum.hasEnded(item) else {
            answer(
                buffered: false,
                seconds: NaviliteSpectrum.bufferedSeconds(item),
                ready: false,
                reason: "the slot's item has already played to its end, so it was never asked to start"
            )
            return
        }
        item.preferredForwardBufferDuration = max(1, seconds)
        /*
         * **The gate this call shipped without (v1.9.9), and the crash it caused.**
         *
         * `preroll(atRate:)` raises an Objective-C exception — not an error a completion handler can
         * report — when the player is not `readyToPlay`. On v1.9.8 this ran on the *first* slot the
         * app prepared, which on a cold launch is an item that has only just been created: the
         * exception takes the process down, and the next launch restores the same track and does it
         * again, which is the crash loop the owner was in. A design review read this line; running it
         * is what found it.
         *
         * So the call is now *conditional on the state AVFoundation requires*, and nothing is issued
         * while that state is unknown:
         *
         *   - `.readyToPlay` on **both** the player and its item: the one state `preroll` may be
         *     called in. Everything below is unchanged from v1.9.8;
         *   - `.failed`: answered as a slot that cannot start, naming the failure, rather than asked;
         *   - `.unknown` (the item exists and has not resolved yet): nothing is issued, and the same
         *     wait that covers "the slot has no item yet" covers this — `waited`/`warmStep` until
         *     `warmDeadline`, then the honest answer that the slot does not hold media.
         *
         * This is the same shape as the rest of this plugin: a measurement, or a reason, never a
         * crash and never a silence.
         *
         * v1.9.10 adds the three refusals above this one — the request this warm belongs to, an item
         * that has already played to its end, and an item that is no longer the slot's own — because
         * this state is not the whole of the precondition. All four are asked in the same turn as the
         * `preroll` below, so there is no instant between the check and the call for any of them to
         * change.
         */
        guard found.player.status == .readyToPlay, item.status == .readyToPlay else {
            if item.status == .failed || found.player.status == .failed {
                answer(
                    buffered: false,
                    seconds: NaviliteSpectrum.bufferedSeconds(item),
                    ready: false,
                    reason: "the slot's item could not be loaded (\(item.error?.localizedDescription ?? found.player.error?.localizedDescription ?? "no reason given by the player"))"
                )
                return
            }
            guard waited < NaviliteSpectrum.warmDeadline else {
                let held = NaviliteSpectrum.bufferedSeconds(item)
                answer(
                    buffered: held >= minSeconds,
                    seconds: held,
                    ready: false,
                    reason: "the player was not ready to start this slot within \(NaviliteSpectrum.warmDeadline) s (player \(NaviliteSpectrum.statusName(found.player.status)), item \(NaviliteSpectrum.statusName(item.status)))"
                )
                return
            }
            waited += NaviliteSpectrum.warmStep
            DispatchQueue.main.asyncAfter(deadline: .now() + NaviliteSpectrum.warmStep) { [weak self] in
                self?.start(plugin: plugin, seconds: seconds)
            }
            return
        }
        found.player.preroll(atRate: 1.0) { [weak self] ready in
            guard let self, !self.answered else { return }
            let held = NaviliteSpectrum.bufferedSeconds(item)
            self.answer(
                buffered: held >= self.minSeconds,
                seconds: held,
                ready: ready,
                reason: ready ? "asked for the media data needed to start" : "the player did not answer that it is ready to start"
            )
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + NaviliteSpectrum.warmDeadline) { [weak self] in
            guard let self, !self.answered else { return }
            let held = NaviliteSpectrum.bufferedSeconds(item)
            self.answer(
                buffered: held >= self.minSeconds,
                seconds: held,
                ready: false,
                reason: "the player did not answer within \(NaviliteSpectrum.warmDeadline) s"
            )
        }
    }

    private func answer(buffered: Bool, seconds: Double, ready: Bool, reason: String) {
        guard !answered else { return }
        answered = true
        call.resolve([
            "buffered": buffered,
            "seconds": seconds,
            "ready": ready,
            "reason": reason,
            "assetId": assetId
        ])
    }
}

/**
 * Reading the audible player off the audio plugin, read-only.
 *
 * The plugin keeps its assets in an internal `[assetId: AudioAsset]` and the `AVPlayer`s of a remote
 * asset in an internal `players` array. Neither is `@objc`-visible, so `Mirror` is the way in.
 *
 * **Which asset is audible is the plugin's own answer** (v1.9.1). The queue now holds two assets at
 * once — one audible, one prepared and silent — and the audible one is no longer always the name
 * this app was written against: at a track boundary the prepared asset is adopted and the two names
 * are swapped. Preferring the fixed name would then hand back the *silent* player. So the order is
 * the plugin's `currentlyPlayingAssetId`, then a player that is actually playing, then the fixed
 * name, then any asset holding an item — which keeps the lookup working if the plugin renames or
 * restages its storage.
 */
enum AudibleBridgePlayer {
    /**
     * The player of one **named** asset, and only that one (v1.9.5).
     *
     * This is what `start` uses whenever the caller says which slot it is playing: no guessing, no
     * preference for a player that happens to be playing, and no fallback to another asset. An asset
     * that has no loaded item is `nil` — a refusal the app can state on screen — rather than a
     * different player's frames.
     */
    static func player(_ assetId: String, from bridge: CAPBridgeProtocol?) -> (player: AVPlayer, assetId: String)? {
        if assetId == NaviliteRemote.awaySlotName {
            if let remote = bridge?.plugin(withName: "NaviliteRemote") as? NaviliteRemote,
               let queue = remote.currentAwayQueue, queue.currentItem != nil {
                return (queue, NaviliteRemote.awaySlotName)
            }
            return nil
        }
        guard let plugin = bridge?.plugin(withName: "NativeAudio") else { return nil }
        for child in Mirror(reflecting: plugin).children where child.label == "audioList" {
            guard let assets = child.value as? [String: Any], let value = assets[assetId] else { continue }
            guard let player = players(of: value).first(where: { $0.currentItem != nil }) else { return nil }
            return (player, assetId)
        }
        return nil
    }

    static func find(from bridge: CAPBridgeProtocol?) -> (player: AVPlayer, assetId: String)? {
        guard let plugin = bridge?.plugin(withName: "NativeAudio") else { return nil }
        var fallback: (player: AVPlayer, assetId: String)?
        for child in Mirror(reflecting: plugin).children where child.label == "audioList" {
            guard let assets = child.value as? [String: Any] else { continue }
            if let named = currentlyPlaying(from: plugin), let value = assets[named], let player = players(of: value).first {
                return (player, named)
            }
            for (assetId, value) in assets {
                for player in players(of: value) where player.currentItem != nil {
                    if player.timeControlStatus == .playing { return (player, assetId) }
                    if fallback == nil { fallback = (player, assetId) }
                }
            }
            if let value = assets[NaviliteSpectrum.audibleAssetId], let player = players(of: value).first {
                return (player, NaviliteSpectrum.audibleAssetId)
            }
        }
        return fallback
    }

    /**
     * The asset id the plugin itself is playing (`NativeAudio.play` sets it), read reflectively.
     *
     * This is the one answer that cannot be confused by the two-slot queue: it is the plugin's own
     * record of which asset it sent to the speakers, not a name this app assumed.
     */
    private static func currentlyPlaying(from plugin: Any) -> String? {
        for child in Mirror(reflecting: plugin).children where child.label == "currentlyPlayingAssetId" {
            if let id = child.value as? String, !id.isEmpty { return id }
        }
        return nil
    }

    /// The `players` array of a remote audio asset, read reflectively.
    private static func players(of asset: Any) -> [AVPlayer] {
        for child in Mirror(reflecting: asset).children where child.label == "players" {
            if let players = child.value as? [AVPlayer] { return players }
        }
        return []
    }
}

#endif
