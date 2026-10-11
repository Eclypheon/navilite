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

    // The analysis state, written on the tap's thread and read on the main thread.
    private var bands = [UInt8](repeating: 0, count: AudibleSpectrumTap.bandCount)
    private var frames = 0
    private var silentFrames = 0
    private var lastFrameLive = false

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
    /// The window the analysis queue is working on. Owned by `analysisQueue`, never shared.
    private var analysisWindow = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)

    // FFT, built once, on the analysis queue — never on the render thread.
    private var fftSetup: FFTSetup?
    private var sampleRate: Double = 0
    /// The format of the buffers the tap hands us, as reported by the tap itself at `prepare`.
    private var tapFormat: AudioStreamBasicDescription?
    private var window = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)
    private var windowed = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize)
    private var realp = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    private var imagp = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    private var magnitudes = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    private var magnitudesSquared = [Float](repeating: 0, count: AudibleSpectrumTap.windowSize / 2)
    /// `[from, to)` bin ranges, one per band — the same log spacing `visualizer.ts` uses.
    private var bandRanges: [(from: Int, to: Int)] = []
    /// False only when the buffers we were handed are a format we cannot read.
    private var readable = true

    /* -------------------------------------------------------------------- the track */

    /**
     * The audio track of `item`, **awaited** — never blocking the calling thread (v1.9.1).
     *
     * The item's own track list is the cheap answer and the one used first: it is populated as the
     * item becomes ready, so on a player that is already playing it costs nothing and needs no
     * network round trip of its own. The asset's track list is the fallback for an item that is
     * ready but whose `tracks` has not been built yet.
     *
     * Until v1.9.1 that fallback was `item.asset.tracks(withMediaType:)` — the deprecated
     * **synchronous** accessor, which blocks until AVFoundation has loaded the asset, over the
     * network, on the very stream that is starting. Called from `install` on the main thread, that
     * one line put every JS callback, every tap and the plugin's own `play` call behind a cold fetch
     * of the new track, which is why an autoplay after a finished track was *slower* than a tap from
     * cold and why the bars stayed dark while it was. Nothing in this file blocks any more: the
     * modern `loadTracks` is awaited, so the main thread carries on and the bars arrive when the
     * track is known.
     */
    static func audioTrack(of item: AVPlayerItem) async -> AVAssetTrack? {
        if let track = knownAudioTrack(of: item) { return track }
        let tracks = try? await item.asset.loadTracks(withMediaType: .audio)
        return tracks?.first
    }

    /// The item's own track list, when it has already been built — the free half of the above.
    static func knownAudioTrack(of item: AVPlayerItem) -> AVAssetTrack? {
        item.tracks.compactMap({ $0.assetTrack }).first(where: { $0.mediaType == .audio })
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
         */
        if carriesOurTap(item) {
            verifyCount += 1
            self.player = player
            self.url = requestedUrl
            return .success(sampleRate)
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

        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: Unmanaged.passRetained(self).toOpaque(),
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
                Unmanaged<AudibleSpectrumTap>.fromOpaque(info).release()
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

        return .success(sampleRate)
    }

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
        lock.lock()
        bands = [UInt8](repeating: 0, count: AudibleSpectrumTap.bandCount)
        lastFrameLive = false
        lock.unlock()
    }

    /* -------------------------------------------------------------------- reporting */

    /// The frame the canvas should draw now, plus the honesty bookkeeping around it.
    ///
    /// The keys are the contract `src/player/native.ts` reads; `positionMs` and `playing` are the
    /// *audible* player's own answers now, which is what they always claimed to be.
    func snapshot() -> [String: Any] {
        lock.lock()
        let frame = bands
        let frameFrames = frames
        let silent = silentFrames
        let live = lastFrameLive
        lock.unlock()
        let player = self.player
        let item = self.item
        let itemSeconds = item?.currentTime().seconds ?? 0
        let playerSeconds = player?.currentTime().seconds ?? itemSeconds
        return [
            "bands": frame.map { Int($0) },
            "bandCount": AudibleSpectrumTap.bandCount,
            "live": live,
            "frames": frameFrames,
            // Frames the FFT has produced from digital silence — what "flat" looks like when it is
            // the *audio* that is flat rather than the measurement that is broken.
            "silentFrames": silent,
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
            "readable": readable,
            "sampleRate": sampleRate
        ]
    }

    /* ------------------------------------------------------------------------ the tap */

    fileprivate func prepare(sampleRate: Double, format: AudioStreamBasicDescription) {
        self.sampleRate = sampleRate
        self.tapFormat = format
        /*
         * Everything the analysis needs is built here, on `analysisQueue`, and the timer that drains
         * the PCM ring is started with it. `prepare` is called by the tap before the first `process`,
         * so this is the one moment nothing is being analysed; doing it inside the queue's own
         * `sync` is what makes the FFT setup and the timer's handler mutually exclusive.
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
        lock.unlock()
    }

    fileprivate func unprepare() {
        /*
         * Stop the analysis before the setup it uses is destroyed.
         *
         * The timer's handler runs on `analysisQueue`, and a handler may already be queued when this
         * (render-thread) call arrives: cancelling stops future deliveries, the `sync` waits for the
         * queue to be free, and `draining = false` is checked at the top of the handler, so anything
         * that runs after this point returns without touching the FFT setup it can no longer see.
         */
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
        unprepare()
    }
}

/* --------------------------------------------------------------------- tap callbacks */

private func audibleSpectrumTapInit(tap: MTAudioProcessingTap, clientInfo: UnsafeMutableRawPointer?, tapStorageOut: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Void {
    tapStorageOut.pointee = clientInfo
}

private func audibleSpectrumTapFinalize(tap: MTAudioProcessingTap) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    // The retain taken for `clientInfo` belongs to the tap: this is the only place it is dropped.
    Unmanaged<AudibleSpectrumTap>.fromOpaque(storage).release()
}

private func audibleSpectrumTapPrepare(tap: MTAudioProcessingTap, maxFrames: CMItemCount, processingFormat: UnsafePointer<AudioStreamBasicDescription>) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    let spectrum = Unmanaged<AudibleSpectrumTap>.fromOpaque(storage).takeUnretainedValue()
    spectrum.prepare(sampleRate: processingFormat.pointee.mSampleRate, format: processingFormat.pointee)
}

private func audibleSpectrumTapUnprepare(tap: MTAudioProcessingTap) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    let spectrum = Unmanaged<AudibleSpectrumTap>.fromOpaque(storage).takeUnretainedValue()
    spectrum.unprepare()
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
        let spectrum = Unmanaged<AudibleSpectrumTap>.fromOpaque(storage).takeUnretainedValue()
        spectrum.consume(bufferList: bufferListInOut, frames: Int(numberFramesOut.pointee))
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
        CAPPluginMethod(name: "configureBuffer", returnType: CAPPluginReturnPromise)
    ]

    /// The asset id `src/player/native.ts` loads every track under.
    static let audibleAssetId = "navilite-current"

    private let spectrum = AudibleSpectrumTap()
    /// Bumped by every `start` and `stop`, so a `start` that is still waiting for the player's item
    /// to load cannot install itself over a newer one.
    private var generation = 0

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
        guard waited < AudibleSpectrumTap.trackWaitSeconds else {
            call.reject(player.currentItem == nil
                ? "the audible player has no item loaded yet, so there is nothing to tap"
                : "the audible player has not loaded an audio track yet, so there is nothing to tap")
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
            call.resolve(["buffered": true, "seconds": item.preferredForwardBufferDuration, "assetId": audible.assetId])
        }
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
