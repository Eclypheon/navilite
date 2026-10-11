import Accelerate
import AVFoundation
import Capacitor
import Foundation

/**
 * The native spectrum: an FFT of the audio that is actually playing, taken from a *tap* on a
 * player, and handed to the visualiser as band values.
 *
 * ## Why this file exists
 *
 * The visualiser has now been flat twice on the owner's phone. Both times the fix was in the web
 * layer: keep an `<audio>` element pointed at the same stream, route it through an `AnalyserNode`
 * and draw what the analyser reads. Both times the reasoning was sound and the result was silence:
 *
 *   - v1.7 left the analyser disconnected from the destination. A graph nothing reaches is not
 *     rendered, so `getByteFrequencyData()` returned zeros and raised nothing.
 *   - v1.7.1 connected it and muted with a gain of 0, which does read — *if* the browser hands over
 *     the samples at all. It hands over silence instead whenever the stream is CORS-cross-origin
 *     without `Access-Control-Allow-Origin`, which is a property of the owner's own library server
 *     and entirely out of this app's hands. No assertion in a harness that runs against a mock with
 *     CORS enabled can ever see that.
 *
 * Worse, the web copy was also the thing breaking playback on return: a WKWebView media element
 * starting or stopping is WebKit activating and deactivating the app's `AVAudioSession`, and the
 * app's own `AVPlayer` is what it deactivates. That is the "resuming from the background pauses the
 * song" report.
 *
 * So the samples come from the native side now, where there is no origin, no CORS and no WebKit:
 *
 *   1. a second `AVPlayer` plays the same stream the native engine is playing, silent;
 *   2. an `MTAudioProcessingTap` (post-effects) gives us its decoded PCM and — by zeroing the
 *      output buffers it hands back — *is* what makes it silent, rather than a volume of 0 that
 *      might have stopped the pipeline from running at all;
 *   3. `Accelerate`'s vDSP does a 2048-point FFT with a Hann window on a hop of 1024 samples, and
 *      the magnitudes are folded into the same 64 log-spaced bands the canvas draws;
 *   4. JavaScript polls `bands()` and draws them.
 *
 * The bands are in the same 0…255 scale as `AnalyserNode.getByteFrequencyData()`, over the same
 * 64 bands, so `src/player/visualizer.ts` draws them with the same code and the same rules: the
 * current frame only, no after-image.
 *
 * This is deliberately *not* a second transport. Nothing here pauses, seeks or configures the
 * engine that is heard; `resync` only ever touches this silent copy, and only to line it up with
 * the position the real player reports. If this plugin is missing or fails to start, the app keeps
 * playing exactly as it does today and the visualiser falls back to its album-art theme.
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

@objc(NaviliteSpectrum)
public class NaviliteSpectrum: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NaviliteSpectrum"
    public let jsName = "NaviliteSpectrum"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resync", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bands", returnType: CAPPluginReturnPromise)
    ]

    private let spectrum = NativeSpectrum()

    /// Begin analysing `url`, from `positionMs` into the track.
    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("a stream url is required")
            return
        }
        let positionMs = call.getDouble("positionMs") ?? 0
        spectrum.start(url: url, positionMs: positionMs) { [weak self] result in
            switch result {
            case .success(let sampleRate):
                self?.spectrum.resync(positionMs: positionMs)
                call.resolve(["started": true, "sampleRate": sampleRate, "bandCount": NativeSpectrum.bandCount])
            case .failure(let error):
                call.reject(error.errorDescription ?? "the spectrum could not start")
            }
        }
    }

    /// Stop analysing. The audio that is heard is untouched.
    @objc func stop(_ call: CAPPluginCall) {
        spectrum.stop()
        call.resolve(["stopped": true])
    }

    /// Line the analysis copy up with the position the *audible* player reports.
    @objc func resync(_ call: CAPPluginCall) {
        let positionMs = call.getDouble("positionMs") ?? 0
        let drift = spectrum.resync(positionMs: positionMs)
        call.resolve(["driftMs": drift])
    }

    /// The most recent frame: 64 band values in 0…255, and whether it was a real measurement.
    @objc func bands(_ call: CAPPluginCall) {
        call.resolve(spectrum.snapshot())
    }
}

/**
 * The silent, tapped second player, and the FFT behind it.
 *
 * Everything that can fail here (no audio track, the tap cannot be created, the asset will not
 * load) fails as a *reported* failure: the caller is told, and the visualiser is left to draw its
 * theme. Nothing in this class touches playback the user can hear.
 */
final class NativeSpectrum {
    static let bandCount = 64
    /// 2048-point FFT (1024 usable bins), a hop of 1024 samples — ~23 ms of audio at 44.1 kHz,
    /// which is a frame for every animation frame the canvas draws.
    private static let windowSize = 2048
    private static let hop = 1024
    /// The dB window the bands are mapped through, matching the web analyser's `minDecibels` of
    /// -95: below this is silence, at 0 dB the band is full scale.
    private static let floorDecibels: Float = -95

    private let lock = NSLock()
    private var player: AVPlayer?
    private var item: AVPlayerItem?
    private var tap: MTAudioProcessingTap?
    private var url: URL?
    private var starting = false

    // The analysis state, written on the tap's thread and read on the main thread.
    private var bands = [UInt8](repeating: 0, count: NativeSpectrum.bandCount)
    private var frames = 0
    private var silentFrames = 0
    private var lastFrameLive = false

    // FFT, built once, on the tap's own thread.
    private var fftSetup: FFTSetup?
    private var sampleRate: Double = 0
    /// The format of the buffers the tap hands us, as reported by the tap itself at `prepare`.
    private var tapFormat: AudioStreamBasicDescription?
    private var window = [Float](repeating: 0, count: NativeSpectrum.windowSize)
    private var ring = [Float](repeating: 0, count: NativeSpectrum.windowSize)
    private var ringIndex = 0
    private var sinceLastFrame = 0
    private var windowed = [Float](repeating: 0, count: NativeSpectrum.windowSize)
    private var realp = [Float](repeating: 0, count: NativeSpectrum.windowSize / 2)
    private var imagp = [Float](repeating: 0, count: NativeSpectrum.windowSize / 2)
    private var magnitudes = [Float](repeating: 0, count: NativeSpectrum.windowSize / 2)
    private var magnitudesSquared = [Float](repeating: 0, count: NativeSpectrum.windowSize / 2)
    /// `[from, to)` bin ranges, one per band — the same log spacing `visualizer.ts` uses.
    private var bandRanges: [(from: Int, to: Int)] = []
    /// False only when the buffers we were handed are a format we cannot read.
    private var readable = true

    /* ------------------------------------------------------------------ transport */

    func start(url: URL, positionMs: Double, completion: @escaping (Result<Double, NativeSpectrumError>) -> Void) {
        stop()
        self.url = url
        starting = true
        let asset = AVURLAsset(url: url)
        // The track list has to be loaded before an audio mix can be built for it, and on a remote
        // asset that is asynchronous. The player item exists first; the tap is installed as soon
        // as the track is known, and only then does the silent copy start.
        asset.loadTracks(withMediaType: .audio) { [weak self] tracks, error in
            guard let self else { return }
            guard let track = tracks?.first else {
                self.starting = false
                completion(.failure(NativeSpectrumError.failure("the stream has no audio track (\(error?.localizedDescription ?? "no track"))")))
                return
            }
            DispatchQueue.main.async {
                self.install(track: track, asset: asset, positionMs: positionMs, completion: completion)
            }
        }
    }

    private func install(track: AVAssetTrack, asset: AVURLAsset, positionMs: Double, completion: @escaping (Result<Double, NativeSpectrumError>) -> Void) {
        guard starting, url != nil else { return }
        let item = AVPlayerItem(asset: asset)
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: Unmanaged.passRetained(self).toOpaque(),
            init: nativeSpectrumTapInit,
            finalize: nativeSpectrumTapFinalize,
            prepare: nativeSpectrumTapPrepare,
            unprepare: nativeSpectrumTapUnprepare,
            process: nativeSpectrumTapProcess
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
                Unmanaged<NativeSpectrum>.fromOpaque(info).release()
            }
            starting = false
            completion(.failure(NativeSpectrumError.failure("the audio tap could not be created (OSStatus \(status))")))
            return
        }
        let parameters = AVMutableAudioMixInputParameters(track: track)
        parameters.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [parameters]
        item.audioMix = mix
        self.tap = tap
        self.item = item

        let player = AVPlayer(playerItem: item)
        // Silent twice over: the tap zeroes what it hands back, and the player is at zero as well.
        player.volume = 0
        player.actionAtItemEnd = .pause
        self.player = player
        starting = false

        let begin = { [weak self] in
            guard let self, self.player === player else { return }
            player.play()
        }
        if positionMs > 0 {
            player.seek(to: CMTime(seconds: positionMs / 1000, preferredTimescale: 600)) { _ in begin() }
        } else {
            begin()
        }
        completion(.success(sampleRate))
    }

    /**
     * Line the silent copy up with the audible player.
     *
     * Only a real drift is corrected (over 400 ms): a seek on this player is audibly nothing but
     * costs a fresh network round trip, and the two players run off the same file at the same rate,
     * so they drift by milliseconds over a track, not by seconds.
     */
    @discardableResult
    func resync(positionMs: Double) -> Double {
        guard let player else { return 0 }
        let current = player.currentTime().seconds * 1000
        guard current.isFinite else { return 0 }
        let drift = positionMs - current
        if abs(drift) > 400 {
            player.seek(to: CMTime(seconds: max(0, positionMs) / 1000, preferredTimescale: 600))
        }
        return drift
    }

    func stop() {
        starting = false
        player?.pause()
        if let item { item.audioMix = nil }
        // The tap holds the item; dropping both is what finalizes it (and releases our retain).
        tap = nil
        item = nil
        player = nil
        url = nil
        lock.lock()
        bands = [UInt8](repeating: 0, count: NativeSpectrum.bandCount)
        lastFrameLive = false
        lock.unlock()
    }

    /// The frame the canvas should draw now, plus the honesty bookkeeping around it.
    func snapshot() -> [String: Any] {
        lock.lock()
        let frame = bands
        let frameFrames = frames
        let silent = silentFrames
        let live = lastFrameLive
        lock.unlock()
        let positionMs = (player?.currentTime().seconds ?? 0) * 1000
        return [
            "bands": frame.map { Int($0) },
            "bandCount": NativeSpectrum.bandCount,
            "live": live,
            "frames": frameFrames,
            // Frames the FFT has produced from digital silence — what "flat" looks like when it is
            // the *audio* that is flat rather than the measurement that is broken.
            "silentFrames": silent,
            "positionMs": positionMs.isFinite ? positionMs : 0,
            "playing": player?.timeControlStatus == .playing,
            "readable": readable,
            "sampleRate": sampleRate
        ]
    }

    /* ---------------------------------------------------------------- the tap */

    fileprivate func prepare(sampleRate: Double, format: AudioStreamBasicDescription) {
        self.sampleRate = sampleRate
        self.tapFormat = format
        guard fftSetup == nil else { return }
        let log2n = vDSP_Length(log2(Float(NativeSpectrum.windowSize)))
        fftSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))
        vDSP_hann_window(&window, vDSP_Length(NativeSpectrum.windowSize), Int32(vDSP_HANN_NORM))
        buildBandRanges()
    }

    /// The same log spacing the canvas uses: 64 bands over bins 2 … 60% of the spectrum, geometrically.
    private func buildBandRanges() {
        let binCount = NativeSpectrum.windowSize / 2
        let end = max(8, Int(Double(binCount) * 0.6))
        let minLog = log(2.0)
        let maxLog = log(Double(end))
        var edges: [Int] = []
        for index in 0...NativeSpectrum.bandCount {
            let value = Int(floor(exp(minLog + (maxLog - minLog) * (Double(index) / Double(NativeSpectrum.bandCount))))) - 1
            edges.append(value)
        }
        bandRanges = (0..<NativeSpectrum.bandCount).map { band in
            let from = max(0, min(binCount - 1, edges[band]))
            let to = max(from + 1, min(binCount, edges[band + 1]))
            return (from, to)
        }
    }

    /**
     * One tap callback's worth of PCM.
     *
     * `bufferList` is what the tap was handed to fill: reading it gives us the decoded audio, and
     * the caller zeroes it afterwards — this method never touches it.
     */
    fileprivate func consume(bufferList: UnsafeMutablePointer<AudioBufferList>, frames frameCount: Int) {
        guard frameCount > 0, let setup = fftSetup, let format = tapFormat else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
        guard let first = buffers.first, let data = first.mData else { return }
        readable = true
        let channels = max(1, Int(format.mChannelsPerFrame))
        let interleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        let stride = interleaved ? channels : 1
        let total = Int(first.mDataByteSize)
        let isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bits = Int(format.mBitsPerChannel)

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
            ring[ringIndex] = value
            ringIndex = (ringIndex + 1) % NativeSpectrum.windowSize
            sinceLastFrame += 1
            if sinceLastFrame >= NativeSpectrum.hop {
                sinceLastFrame = 0
                analyze(with: setup)
            }
        }
    }

    private func analyze(with setup: FFTSetup) {
        let n = NativeSpectrum.windowSize
        let half = n / 2
        for index in 0..<n {
            windowed[index] = ring[(ringIndex + index) % n] * window[index]
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
        var frame = [UInt8](repeating: 0, count: NativeSpectrum.bandCount)
        var any = false
        for band in 0..<NativeSpectrum.bandCount {
            let range = bandRanges[band]
            var sum: Float = 0
            let count = max(1, range.to - range.from)
            for bin in range.from..<range.to where bin < half {
                magnitudes[bin] = sqrt(magnitudesSquared[bin] * scale)
                sum += magnitudes[bin]
            }
            let mean = sum / Float(count) * 2
            let decibels = 20 * log10(max(mean, 1e-12))
            let value = Int(((decibels - NativeSpectrum.floorDecibels) / -NativeSpectrum.floorDecibels) * 255)
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
        if let setup = fftSetup { vDSP_destroy_fftsetup(setup) }
        fftSetup = nil
    }

    fileprivate func finalize() {
        unprepare()
    }
}

/* --------------------------------------------------------------- tap callbacks */

private func nativeSpectrumTapInit(tap: MTAudioProcessingTap, clientInfo: UnsafeMutableRawPointer?, tapStorageOut: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Void {
    tapStorageOut.pointee = clientInfo
}

private func nativeSpectrumTapFinalize(tap: MTAudioProcessingTap) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    // The retain taken for `clientInfo` belongs to the tap: this is the only place it is dropped.
    Unmanaged<NativeSpectrum>.fromOpaque(storage).release()
}

private func nativeSpectrumTapPrepare(tap: MTAudioProcessingTap, maxFrames: CMItemCount, processingFormat: UnsafePointer<AudioStreamBasicDescription>) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    let spectrum = Unmanaged<NativeSpectrum>.fromOpaque(storage).takeUnretainedValue()
    spectrum.prepare(sampleRate: processingFormat.pointee.mSampleRate, format: processingFormat.pointee)
}

private func nativeSpectrumTapUnprepare(tap: MTAudioProcessingTap) {
    let storage = MTAudioProcessingTapGetStorage(tap)
    let spectrum = Unmanaged<NativeSpectrum>.fromOpaque(storage).takeUnretainedValue()
    spectrum.unprepare()
}

private func nativeSpectrumTapProcess(
    tap: MTAudioProcessingTap,
    numberFrames: CMItemCount,
    flags: MTAudioProcessingTapFlags,
    bufferListInOut: UnsafeMutablePointer<AudioBufferList>,
    numberFramesOut: UnsafeMutablePointer<CMItemCount>,
    flagsOut: UnsafeMutablePointer<MTAudioProcessingTapFlags>
) -> Void {
    var timeRange = CMTimeRange()
    let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, &timeRange, numberFramesOut)
    let storage = MTAudioProcessingTapGetStorage(tap)
    let spectrum = Unmanaged<NativeSpectrum>.fromOpaque(storage).takeUnretainedValue()
    if status == noErr {
        spectrum.consume(bufferList: bufferListInOut, frames: Int(numberFramesOut.pointee))
    }
    /*
     * And now the silence. This is the tap's *output*, so zeroing it is what keeps the copy
     * inaudible — the one mechanism that cannot be defeated by the platform deciding an inaudible
     * player has nothing to render (which would take the tap down with it).
     */
    let buffers = UnsafeMutableAudioBufferListPointer(bufferListInOut)
    for index in 0..<buffers.count {
        if let data = buffers[index].mData {
            memset(data, 0, Int(buffers[index].mDataByteSize))
        }
    }
}
