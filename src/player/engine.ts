/**
 * The audio engine: the native AVFoundation/ExoPlayer player when we are wrapped, and one
 * `<audio>` element + Web Audio graph.
 *
 * v1.7 turned this around. Playback is **native** on a wrapped build — chosen when the track
 * starts, never at the moment the app goes out of sight — because a native player is not
 * suspended the way WKWebView's audio is, and because the swap that v1.6 did at `visibilitychange`
 * had to finish before iOS suspended the app, which is exactly the race that made backgrounding
 * work "sometimes". The `<audio>` element did not disappear: it is now the **silent analysis
 * copy** of the same stream (`analysisRunning`), routed into the analyser and never into the
 * speakers, running only while a track plays and the app is on screen, so the spectrum stays real.
 * On the web (the PWA, or `preference: 'web'`) the element is still the audible engine, exactly as
 * it always was.
 *
 * The honest part is `spectrum`. A spectrum only exists when the browser hands us real samples:
 * `createMediaElementSource(el) → AnalyserNode`. When it cannot (a tainted cross-origin stream with
 * no ACAO, a suspended AudioContext, an analysis copy the platform refused to start, or native
 * playback with no second copy running), the analyser returns *zeros with no error* — the classic
 * silent flatline. Rather than animate a lie, the engine watches for that and reports
 * `spectrum: false` with a reason, and the UI switches to the album-art theme and says which mode
 * it is in.
 */
import { platformInfo, type OsName } from '../platform.ts';
import type { PlaybackPreference } from '../storage/settings.ts';
import { createNativeBridge, type NativeBridge, type NativeBridgeEvents, type NativeTrackInfo } from './native.ts';

export type PlaybackBackend = 'web' | 'native';
export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface TrackRequest extends NativeTrackInfo {
  id: string;
  durationMs: number;
  /** True when the stream lives on another origin and the element must opt in to CORS. */
  crossOrigin: boolean;
}

export interface EngineStatus {
  state: EngineState;
  backend: PlaybackBackend;
  /** True only when the analyser is returning real audio data right now. */
  spectrum: boolean;
  modeReason: string;
  positionMs: number;
  durationMs: number;
  error: string | null;
  nativeAvailable: boolean;
  preference: PlaybackPreference;
}

/**
 * What the engine needs from its own environment, injectable so the native paths can be driven
 * without a phone. Production passes nothing: the platform is `platformInfo()` and the bridge is
 * `createNativeBridge`. `test/engine-native.test.ts` passes a fake bridge whose calls take a
 * measurable amount of time, which is how the press-to-play latency is quoted.
 */
export interface EngineOptions {
  platform?: { os: OsName; native: boolean };
  nativeFactory?: (os: OsName, events: NativeBridgeEvents) => Promise<NativeBridge | null>;
}

/**
 * How long a `resume()` is given to turn into actual playback before the engine stops believing it.
 *
 * `NativeAudio.resume()` is a request, not a fact: AVPlayer can decline to come back after an
 * interruption or a route change, and the plugin answers the *call*, not the state. Asking the
 * player 300 ms later is what separates "it is playing" from "the promise resolved".
 */
const RESUME_CONFIRM_MS = 300;

/** ~1.8 s of silence from the analyser while audio is definitely playing = not real samples. */
const ZERO_FRAMES_BEFORE_THEME = 18;
/**
 * The same non-zero frame for ~1 s is a frozen buffer, not a measurement.
 *
 * v1.1 lowered this from 25 frames (2.5 s): with the analyser running at a near-zero
 * smoothing constant (below), a genuinely live frame differs every single sample, so a
 * repeat is already strong evidence — and 2.5 s of animation that is not measuring
 * anything is exactly the "draggy" reading the owner reported.
 */
const FROZEN_FRAMES_BEFORE_THEME = 10;
const METER_INTERVAL_MS = 100;

export class AudioEngine {
  private readonly el: HTMLAudioElement;
  private readonly os: OsName;
  private readonly nativePlatform: boolean;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * The analyser's output stage. It is *always* connected to the destination — at a gain of 0
   * while the native engine is the one being heard.
   *
   * v1.7 connected `source → analyser` and left it there for the native case, on the theory that
   * an unconnected analyser is a silent one. A graph with no path to the destination is not
   * rendered at all: both engines prune it, `getByteFrequencyData()` fills the array with zeros and
   * raises nothing, and the visualiser drops through to the album-art theme. That is the dead
   * spectrum the owner reported. Silence has to be a gain of zero on a live graph, never a missing
   * edge — so the edge is written once, here, and only the gain ever changes.
   */
  private analyserGain: GainNode | null = null;
  private graphSource: MediaElementAudioSourceNode | null = null;
  private graphFailedReason: string | null = null;
  private freq: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(1024));
  private level = 0;
  private zeroFrames = 0;
  private identicalFrames = 0;
  private lastChecksum = -1;
  private spectrumLive = false;
  private modeReason = 'nothing playing yet';
  private state: EngineState = 'idle';
  private backend: PlaybackBackend = 'web';
  private track: TrackRequest | null = null;
  private error: string | null = null;
  private preference: PlaybackPreference = 'auto';
  private native: NativeBridge | null = null;
  private nativeReady: Promise<NativeBridge | null> | null = null;
  /** How the native bridge is built — real in production, fake in `test/engine-native.test.ts`. */
  private readonly nativeFactory: (os: OsName, events: NativeBridgeEvents) => Promise<NativeBridge | null>;
  /** True while a `confirmPlaying` check is in flight, so two taps cannot both restart a track. */
  private confirming = false;
  private nativePositionMs = 0;
  private nativeDurationMs = 0;
  private crossOriginRetry = false;
  /**
   * True while the native engine is swapping its asset (unload + preload of the next track).
   *
   * v1.6 found this: a swap stops the previous asset, and the plugin reports that stop — a
   * `stopped` state or a `complete` — while `backend` is still `'native'`, which is indistinguishable
   * from the song ending. v1.7 keeps the guard: the swap is the one path that runs a stop the user
   * never asked for.
   */
  private assetSwap = false;
  /** True while the silent analyser copy of the stream is running. */
  private analysisRunning = false;
  /** The platform refused to start the silent copy (no user gesture yet) — say so, do not flatline. */
  private analysisBlocked = false;
  private remoteDetach: (() => void) | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(status: EngineStatus) => void>();

  /** Set by the queue: called when a track finishes on its own. */
  onEnded: (() => void) | null = null;
  /** Called on every position update, for play reporting. */
  onProgress: ((positionMs: number, durationMs: number) => void) | null = null;
  /** Lock-screen next / previous, when the platform delivers them. */
  onNextRequested: (() => void) | null = null;
  onPreviousRequested: (() => void) | null = null;

  constructor(options: EngineOptions = {}) {
    const info = options.platform ?? platformInfo();
    this.os = info.os;
    this.nativePlatform = info.native;
    this.nativeFactory = options.nativeFactory ?? createNativeBridge;

    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('play', () => {
      // In native mode the element is the silent analysis copy; it must not be allowed to speak for
      // the transport (a user pause would be undone by it starting to measure).
      if (this.backend !== 'web') return;
      this.state = 'playing';
      this.error = null;
      this.startMeter();
      this.emit();
    });
    el.addEventListener('playing', () => {
      if (this.backend !== 'web') return;
      this.state = 'playing';
      this.emit();
    });
    el.addEventListener('pause', () => {
      if (this.backend !== 'web') return;
      if (this.state !== 'idle' && this.state !== 'error') this.state = 'paused';
      this.emit();
    });
    el.addEventListener('timeupdate', () => {
      if (this.backend !== 'web') return;
      this.emit();
      this.onProgress?.(this.el.currentTime * 1000, this.el.duration * 1000);
    });
    el.addEventListener('ended', () => {
      if (this.backend !== 'web') return;
      this.state = 'paused';
      this.emit();
      this.onEnded?.();
    });
    el.addEventListener('error', () => this.handleMediaError());
    this.el = el;
  }

  subscribe(listener: (status: EngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  /** Duration in ms: the native player's own when it reports one, the track metadata otherwise. */
  private durationMs(): number {
    if (this.backend === 'native') return this.nativeDurationMs || this.track?.durationMs || 0;
    if (Number.isFinite(this.el.duration) && this.el.duration > 0) return this.el.duration * 1000;
    return this.track?.durationMs ?? 0;
  }

  status(): EngineStatus {
    const durationMs = this.durationMs();
    const positionMs = this.backend === 'native' ? this.nativePositionMs : this.el.currentTime * 1000;
    return {
      state: this.state,
      backend: this.backend,
      spectrum: this.spectrumLive,
      modeReason: this.modeReason,
      positionMs: Number.isFinite(positionMs) ? positionMs : 0,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      error: this.error,
      nativeAvailable: this.native !== null,
      preference: this.preference,
    };
  }

  /** The live frequency data, or null when there is nothing real to show. */
  spectrumData(): Uint8Array | null {
    return this.spectrumLive && this.analyser ? this.freq : null;
  }

  /**
   * A fresh analyser frame, for the visualiser to call once per animation frame.
   *
   * This is the v1.1 fix for the "draggy" spectrum: the meter below only samples every
   * 100 ms (it is doing the honesty bookkeeping, which does not need to run at 60 Hz), so
   * a canvas that drew from that buffer was redrawing the same 10 Hz measurement fifteen
   * times a second — visibly stepped, however smooth the drawing looked. Pulling the frame
   * per paint costs one `getByteFrequencyData()` call and makes the bars move with the
   * audio instead of with the timer.
   *
   * Returns null when the analyser is not a real measurement, so the theme animation takes
   * over exactly as before.
   */
  readSpectrum(): Uint8Array | null {
    if (!this.spectrumLive || !this.analyser || !this.analysisRunning) return null;
    if (this.ctx?.state === 'suspended') return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  /** Analyser sample rate, so a spectrum can be interpreted in Hz (0 when no graph). */
  sampleRate(): number {
    return this.analyser && this.ctx ? this.ctx.sampleRate : 0;
  }

  /** Analyser FFT size, the other half of bin → Hz. */
  get fftSize(): number {
    return this.analyser?.fftSize ?? 0;
  }

  /** 0..1 overall loudness of the analyser frame, handy for the fallback animation. */
  get meanLevel(): number {
    return this.level;
  }

  setPreference(preference: PlaybackPreference): void {
    this.preference = preference;
    this.prewarm();
    this.emit();
  }

  /**
   * Build the native bridge now, and throw the result away — the press must not pay for it.
   *
   * v1.7 built the bridge *inside* the first `play()`: a dynamic import of the plugin, a
   * `configure()` round trip, three `addListener` round trips, and only then the unload/preload of
   * the asset and the `play`. All of it sat between the tap and the first sound, and that is the
   * "noticeable delay when pressing play" the owner reported. The plugin costs nothing while idle
   * (it activates the session when it is asked to play), so it is built at launch instead, and the
   * tap only has the asset left to load.
   */
  prewarm(): void {
    if (!this.nativePlatform || this.preference === 'web') return;
    void this.ensureNative();
  }

  get currentTrack(): TrackRequest | null {
    return this.track;
  }

  /** Native bridge is created once, lazily, and only inside a wrapped build. */
  private async ensureNative(): Promise<NativeBridge | null> {
    if (!this.nativePlatform) return null;
    if (!this.nativeReady) {
      this.nativeReady = this.nativeFactory(this.os, {
        onPosition: (seconds) => {
          this.nativePositionMs = seconds * 1000;
          this.emit();
          this.onProgress?.(this.nativePositionMs, this.durationMs());
        },
        onState: (state, isPlaying) => {
          if (this.backend !== 'native') return;
          // v1.6/v1.7: an asset swap stops the outgoing asset on purpose; that stop is not a pause
          // the user asked for and it must not be read out as one (a `stopped` state would otherwise
          // leave the transport showing "idle" behind a track that is about to be playing).
          if (this.assetSwap) return;
          this.state = isPlaying ? 'playing' : state === 'stopped' ? 'idle' : 'paused';
          this.emit();
        },
        onComplete: () => {
          if (this.backend !== 'native') return;
          // v1.6/v1.7: never on the back of an asset swap — this is the one event that moves the queue.
          if (this.assetSwap) return;
          this.state = 'paused';
          this.emit();
          this.onEnded?.();
        },
      });
      const bridge = await this.nativeReady;
      // The lock-screen next/previous are the platform's to deliver; register once, at the same
      // moment the engine exists, so a lock-screen button works before the screen is ever opened.
      if (bridge && !this.remoteDetach) {
        this.remoteDetach = bridge.listenRemoteCommands({
          next: () => this.onNextRequested?.(),
          previous: () => this.onPreviousRequested?.(),
        });
      }
    }
    this.native = await this.nativeReady;
    return this.native;
  }

  /**
   * True when native playback is the right backend right now.
   *
   * v1.7 changed the answer, and that change *is* the fix for the owner's report ("sending it to
   * background … most times it just stops playing"): on a wrapped build the native engine is the
   * default engine, chosen when a track starts, **not** at the moment the app goes out of sight.
   *
   * v1.6 tried to be clever and started on Web Audio, then swapped to native inside the
   * `visibilitychange` handler. That swap has to finish — unload, preload a fresh AVPlayer item over
   * the network, then play — inside the window iOS leaves the app between "hidden" and "suspended",
   * and when it does not finish, the audio simply stops. Choosing the engine up front removes the
   * race instead of narrowing it: nothing has to happen at hide time any more.
   *
   * `preference: 'web'` is still honoured — it is the escape hatch for the PWA and for debugging,
   * and it now means "no native engine at all", not "later".
   */
  private wantsNative(): boolean {
    return this.preference !== 'web' && this.nativePlatform;
  }

  async play(track: TrackRequest, startMs = 0): Promise<void> {
    this.track = track;
    this.error = null;
    this.state = 'loading';
    this.crossOriginRetry = false;
    this.emit();
    /*
     * The bridge is taken as it already is (`this.native`, which the pre-warm has usually built)
     * rather than awaited first: awaiting it — even a promise that has already resolved — puts the
     * optimistic state of `startNative` one microtask behind every press for no reason. Only a
     * cold, un-pre-warmed engine pays for the bridge here.
     */
    if (this.wantsNative()) {
      const ready = this.native ?? (await this.ensureNative());
      if (ready) {
        await this.startNative(track, startMs, ready);
        return;
      }
    }
    await this.startWeb(track, startMs);
  }

  async toggle(): Promise<void> {
    if (this.state === 'playing') await this.pause();
    else await this.resume();
  }

  async pause(): Promise<void> {
    if (this.backend === 'native') {
      await this.native?.pause();
      this.state = 'paused';
      // The silent copy exists only to feed a spectrum of what is being heard. Nothing is being
      // heard, so it is dropped rather than left decoding a stream for a canvas that will not draw.
      this.stopAnalysis();
      this.emit();
      return;
    }
    this.el.pause();
  }

  /**
   * Play, from a paused native player.
   *
   * Two things changed in v1.7.1, and both of them come from the owner's own report.
   *
   * **It is optimistic.** The state and the icon flip here, on the tap, rather than after a bridge
   * round trip — that ordering *was* the "noticeable delay when pressing play". Nothing is claimed
   * that is not checked immediately afterwards (`confirmPlaying`).
   *
   * **It is confirmed.** `NativeAudio.resume()` resolving does not mean sound came out: after an
   * interruption, a route change, or an item iOS stopped while the app was suspended, AVPlayer
   * simply does not come back — and v1.7 then sat showing "playing" over a silent player. That is
   * exactly the state the owner was stuck in: the tap did nothing, and only nudging the seek bar and
   * toggling pause/play unstuck it. So the tap is checked against the player, and if the player did
   * not come up, the track is started again from where it stopped — inside the same tap.
   */
  async resume(): Promise<void> {
    if (this.backend === 'native') {
      this.state = 'playing';
      this.emit();
      this.restartAnalysis();
      await this.native?.resume();
      this.onProgress?.(this.nativePositionMs, this.durationMs());
      void this.confirmPlaying();
      return;
    }
    await this.resumeContext();
    await this.el.play().catch((cause: unknown) => this.fail(cause));
    this.startMeter();
  }

  /**
   * The second half of a native `resume()`: ask the player what it is *actually* doing, and if the
   * answer is "not playing", start the track again from the position it stopped at.
   *
   * This is the rule the owner asked for in his own words — one tap on play must restart it, with
   * no seek-bar nudge and no pause/play dance. A resume that resolves and leaves the player stopped
   * is the one case that would otherwise still need the dance, so it is caught here.
   */
  private async confirmPlaying(): Promise<void> {
    const bridge = this.native;
    const track = this.track;
    if (!bridge || !track || this.backend !== 'native' || this.confirming) return;
    this.confirming = true;
    try {
      // A resumed AVPlayer is not instantaneous; asking immediately would restart healthy tracks.
      await new Promise((resolve) => setTimeout(resolve, RESUME_CONFIRM_MS));
      // The user may have moved on inside that window — a different track, or a pause.
      if (this.state !== 'playing' || this.track !== track) return;
      const truth = await bridge.sync();
      if (!truth) return; // The player could not be read; the optimistic state stands.
      if (truth.playing) {
        this.nativePositionMs = truth.positionMs;
        this.emit();
        return;
      }
      // Stopped (or the queue cleared) while the player was being asked: the restart is off.
      if (this.track !== track || this.state !== 'playing') return;
      const from = truth.positionMs > 0 ? truth.positionMs : this.nativePositionMs;
      this.nativePositionMs = from;
      await this.startNative(track, from);
    } finally {
      this.confirming = false;
    }
  }

  async seek(positionMs: number): Promise<void> {
    if (this.backend === 'native') {
      await this.native?.seek(positionMs / 1000);
      this.nativePositionMs = positionMs;
      this.syncAnalysis(positionMs);
      this.emit();
      return;
    }
    if (Number.isFinite(this.el.duration)) this.el.currentTime = Math.max(0, positionMs / 1000);
    this.emit();
  }

  async stop(): Promise<void> {
    this.el.pause();
    this.el.removeAttribute('src');
    this.analysisRunning = false;
    void this.native?.stop();
    this.stopMeter();
    this.state = 'idle';
    this.track = null;
    this.nativePositionMs = 0;
    this.nativeDurationMs = 0;
    this.spectrumLive = false;
    this.modeReason = 'nothing playing';
    this.emit();
  }

  /* ------------------------------------------------------ the silent analysis copy */

  /**
   * Start the *silent* copy of the stream that feeds the analyser — the whole trick of v1.7.
   *
   * The native player hands JavaScript no samples (transport and metadata only), so a real spectrum
   * cannot be read from it. The spectrum stays real by playing the same stream a second time in the
   * web layer, routed `source → analyser` with the analyser **not** connected to the destination:
   * it is inaudible, and what you hear is the native engine. Because it is only a measurement, it
   * runs only while a track is playing *and* the app is on screen — the app drawing it is the only
   * time it is worth a second connection to the library, and it stops itself in the background where
   * the native engine is the one that must keep going.
   */
  private async startAnalysis(track: TrackRequest, startMs: number): Promise<void> {
    if (typeof document === 'undefined' || document.hidden) return;
    this.analysisRunning = true;
    this.analysisBlocked = false;
    this.crossOriginRetry = false;
    // A new load invalidates any previous frame: forget it so the honesty checks start from a clean
    // slate instead of comparing against the last track.
    this.lastChecksum = -1;
    this.identicalFrames = 0;
    this.zeroFrames = 0;
    // crossOrigin must be set before src, otherwise the request is already in flight and the element
    // stays tainted for the life of the load.
    this.el.crossOrigin = track.crossOrigin ? 'anonymous' : null;
    this.el.src = track.url;
    await this.ensureGraph();
    this.setGraphOutput(false);
    if (this.graphFailedReason) {
      this.spectrumLive = false;
      this.modeReason = this.graphFailedReason;
    }
    await this.resumeContext();
    try {
      await this.el.play();
    } catch {
      this.analysisRunning = false;
      this.analysisBlocked = true;
      this.spectrumLive = false;
      this.modeReason = 'the silent copy of the stream needs a tap before the platform will start it — the audio is native and playing, the spectrum comes back on the next tap';
      this.emit();
      return;
    }
    if (startMs > 0) {
      try {
        this.el.currentTime = startMs / 1000;
      } catch {
        // Not seekable yet; `syncAnalysis` lines it up on the next seek.
      }
    }
    this.startMeter();
  }

  /**
   * Whether the analyser's output is heard (the web path) or muted (the native path).
   *
   * The mute is a **gain of zero on a live graph**, never a disconnect. See `analyserGain`: a graph
   * with no path to the destination is pruned by the engine and reads as a flatline, which is why
   * v1.7's silent copy produced no spectrum at all.
   */
  private setGraphOutput(audible: boolean): void {
    if (!this.analyserGain) return;
    this.analyserGain.gain.value = audible ? 1 : 0;
  }

  private stopAnalysis(): void {
    this.analysisRunning = false;
    this.el.pause();
    this.stopMeter();
    if (this.track) {
      this.spectrumLive = false;
      this.modeReason =
        'the spectrum reads the stream in the foreground only; playback itself is native, which is what keeps it going when you leave the app';
      this.emit();
    }
  }

  /** Re-align the silent copy with the native player after a seek, so the bars match what is heard. */
  private syncAnalysis(positionMs: number): void {
    if (!this.analysisRunning) return;
    try {
      this.el.currentTime = Math.max(0, positionMs / 1000);
    } catch {
      // Not seekable yet.
    }
  }

  private restartAnalysis(): void {
    if (!this.analysisRunning || !this.track) return;
    this.analysisRunning = false;
    void this.startAnalysis(this.track, this.nativePositionMs);
  }

  /**
   * Entering and leaving the background, on a wrapped build.
   *
   * v1.7: **nothing has to happen here for the audio to survive** — it is native, and native playback
   * is not suspended the way WebKit's is. What this does is (a) drop the silent analysis copy on the
   * way out, because a suspended WebKit must not be left holding a stream, and (b) on the way back in,
   * re-arm the audio session and *ask the player* what it is doing rather than trusting our own copy
   * of the state.
   *
   * (b) is the second half of the owner's report — *"when going back into the app from the background
   * i seem to have issues playing and pausing the song"*. A call, Siri, another app taking the
   * session, or the OS pausing us are all invisible from JavaScript; a `sync()` after the return is
   * the only way the transport can be right without the user touching anything.
   */
  async handleVisibility(hidden: boolean): Promise<void> {
    if (!this.track) return;
    if (this.backend !== 'native') {
      // The web path (the PWA, or `preference: 'web'`): no native engine is carrying it, so there is
      // nothing to hand over to. Re-resume the audio context on the way in; that is all that helps.
      if (!hidden && this.state === 'playing') await this.resumeContext();
      return;
    }
    if (hidden) {
      this.stopAnalysis();
      return;
    }
    await this.native?.activateSession();
    const truth = await this.native?.sync();
    if (truth) {
      this.nativePositionMs = truth.positionMs;
      if (truth.durationMs > 0) this.nativeDurationMs = truth.durationMs;
      this.state = truth.playing ? 'playing' : this.state === 'idle' ? 'idle' : 'paused';
    } else if (this.state === 'playing') {
      /*
       * The player would not answer — an unloaded asset, a bridge that threw, a session another app
       * took. Never leave a "playing" on screen that the tap cannot act on (the owner's stuck
       * transport: the tap resolved to a pause on a player that was already stopped). Showing
       * "paused" is the safe half of an unknown: the next tap re-reads the truth before it decides,
       * and if the player turns out to be playing after all, `confirmPlaying` says so.
       */
      this.state = 'paused';
    }
    if (this.state === 'playing') await this.startAnalysis(this.track, this.nativePositionMs);
    this.emit();
    this.onProgress?.(this.nativePositionMs, this.durationMs());
  }

  private async startWeb(track: TrackRequest, startMs: number): Promise<void> {
    this.backend = 'web';
    this.el.pause();
    // The element is the audible engine here, and it is the analyser source: one flag for both paths.
    this.analysisRunning = true;
    // A new load invalidates any previous frame: forget it so the honesty checks below
    // start from a clean slate instead of comparing against the last track.
    this.lastChecksum = -1;
    this.identicalFrames = 0;
    this.zeroFrames = 0;
    // crossOrigin must be set before src, otherwise the request is already in flight
    // and the element stays tainted for the life of the load.
    this.el.crossOrigin = track.crossOrigin ? 'anonymous' : null;
    this.el.src = track.url;
    await this.ensureGraph();
    // The web path is audible: the analyser feeds the speakers, as it always has.
    this.setGraphOutput(true);
    if (this.graphFailedReason) {
      this.spectrumLive = false;
      this.modeReason = this.graphFailedReason;
    }
    await this.resumeContext();
    try {
      await this.el.play();
    } catch (cause) {
      this.fail(cause);
      return;
    }
    if (startMs > 0) {
      try {
        this.el.currentTime = startMs / 1000;
      } catch {
        // Not seekable yet; the next play will land at the start.
      }
    }
    this.startMeter();
  }

  private async startNative(track: TrackRequest, startMs: number, ready?: NativeBridge): Promise<void> {
    const bridge = ready ?? (await this.ensureNative());
    if (!bridge) {
      await this.startWeb(track, startMs);
      return;
    }
    this.backend = 'native';
    this.nativePositionMs = startMs;
    this.nativeDurationMs = track.durationMs;
    this.spectrumLive = false;
    this.modeReason =
      'native playback (AVFoundation / ExoPlayer) — this is the engine that keeps going when you leave the app and the one the lock screen drives; the spectrum is read from a silent second copy of the stream while the app is on screen';
    this.state = 'loading';
    this.emit();
    // A load is an unload + preload: the outgoing asset's stop must not be read as a track ending.
    this.assetSwap = true;
    /*
     * v1.7.1: the transport is put into "playing" *before* the round trips, not after them.
     *
     * `load()` unloads, preloads the asset over the network and `play()` starts it — three bridge
     * round trips and an AVPlayer item preparation, all of which v1.7 sat in front of the icon
     * flipping, which is the delay the owner felt on pressing play. The state is now optimistic and
     * the reconciliation is the honest half: a failure sets `error` below, and a track that the
     * player refuses to start is caught by `confirmPlaying`.
     */
    this.state = 'playing';
    this.emit();
    /*
     * The silent analysis copy starts *here* — on the tap, in parallel with the native load — and
     * not after it. v1.7 asked for it once `load()` and `play()` had both resolved, i.e. a few
     * hundred milliseconds after the gesture that started the track; on iOS a Web Audio graph is
     * only allowed to start while the gesture that asked for it is still live, so the ordering was
     * one way for the spectrum to come back dead on the phone while every harness here is green.
     * Running it concurrently costs nothing: the copy is silent and reads the same stream.
     */
    void this.startAnalysis(track, startMs);
    try {
      await bridge.load(track);
      await bridge.play(startMs / 1000);
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.assetSwap = false;
    }
    this.emit();
  }

  private async ensureGraph(): Promise<void> {
    if (this.graphSource || this.graphFailedReason) return;
    const ctor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctor) {
      this.graphFailedReason = 'this browser has no Web Audio API, so there are no samples to analyse';
      return;
    }
    try {
      const ctx = new ctor();
      const source = ctx.createMediaElementSource(this.el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // v1.1 dropped this from 0.8 to 0.15 (each frame was carrying 80% of the last one, which
      // read as the bars gliding behind the music). v1.2 finishes the job: 0.15 is still a
      // memory of the previous frame *inside the analyser*, and the owner's complaint about the
      // spectrum is precisely that a bar should show the current frame and nothing else. Every
      // frame is now an independent measurement; the visualiser adds no ballistics of its own
      // either, so a bar's height is exactly this frame's magnitude.
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -95;
      /*
       * source → analyser → gain → destination, written once and never taken apart.
       *
       * The last hop is the v1.7.1 fix: the analyser is always reachable from the destination, and
       * the *gain* is what makes the analysis copy silent (0) on the native path. v1.7 disconnected
       * the analyser instead, and a graph nothing reaches is not rendered — the analyser returned
       * zeros with no error, the honesty check called it silence, and the visualiser showed the
       * album-art theme. This is the difference between "inaudible" and "not running".
       */
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'suspended') {
          this.spectrumLive = false;
          this.modeReason =
            'the audio context is suspended — iOS suspends Web Audio when the app is backgrounded, which is why the foreground spectrum is a foreground feature';
          this.emit();
        }
      });
      this.ctx = ctx;
      this.analyser = analyser;
      this.analyserGain = gain;
      this.graphSource = source;
      this.freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } catch (error) {
      this.graphFailedReason = `Web Audio graph unavailable (${String(error)})`;
    }
  }

  private async resumeContext(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        this.spectrumLive = false;
        this.modeReason = 'the audio context could not be resumed (the browser wants a user gesture first)';
      }
    }
  }

  /**
   * A cross-origin element with crossOrigin="anonymous" fails *entirely* when the
   * server sends no ACAO — playback included, not just sample access. Retry without
   * the flag: audio works, the analyser flatlines, and the UI says why.
   */
  private async retryWithoutCrossOrigin(): Promise<void> {
    const track = this.track;
    if (!track) return;
    const positionMs = this.el.currentTime * 1000;
    this.crossOriginRetry = true;
    this.el.crossOrigin = null;
    this.el.src = track.url;
    try {
      await this.el.play();
      if (positionMs > 0) this.el.currentTime = positionMs / 1000;
      this.startMeter();
    } catch (cause) {
      this.fail(cause);
    }
  }

  private handleMediaError(): void {
    if (this.backend !== 'web') {
      // Native playback is untouched by this: the element that failed is the silent analysis copy.
      if (this.el.crossOrigin === 'anonymous' && !this.crossOriginRetry && this.track?.crossOrigin) {
        this.modeReason =
          'the library refused cross-origin sample access for this stream, so the analyser cannot see the audio — playing it natively anyway, with the album-art theme';
        void this.retryAnalysisWithoutCrossOrigin();
        return;
      }
      this.analysisRunning = false;
      this.analysisBlocked = true;
      this.spectrumLive = false;
      this.modeReason = 'the silent copy of the stream could not be read, so the spectrum is on the album-art theme — the audio itself is native and playing';
      this.emit();
      return;
    }
    if (this.el.crossOrigin === 'anonymous' && !this.crossOriginRetry && this.track?.crossOrigin) {
      this.modeReason =
        'the library refused cross-origin sample access for this stream, so the analyser cannot see the audio — playing it anyway, with the album-art theme';
      void this.retryWithoutCrossOrigin();
      return;
    }
    const media = this.el.error;
    this.fail(new Error(media ? `${media.message} (code ${media.code})` : 'the audio element failed to load the stream'));
  }

  /**
   * The native-mode twin of `retryWithoutCrossOrigin`: only the analyser is at stake, so a failure
   * here leaves the audio alone and just stops claiming to have samples.
   */
  private async retryAnalysisWithoutCrossOrigin(): Promise<void> {
    const track = this.track;
    if (!track) return;
    const positionMs = this.nativePositionMs;
    this.crossOriginRetry = true;
    this.el.crossOrigin = null;
    this.el.src = track.url;
    try {
      await this.el.play();
      if (positionMs > 0) this.el.currentTime = positionMs / 1000;
      this.analysisRunning = true;
      this.startMeter();
    } catch {
      this.analysisRunning = false;
      this.analysisBlocked = true;
      this.spectrumLive = false;
      this.modeReason = 'the silent copy of the stream could not be read, so the spectrum is on the album-art theme — the audio itself is native and playing';
      this.emit();
    }
  }

  private startMeter(): void {
    if (this.meterTimer !== null) return;
    this.meterTimer = setInterval(() => this.sample(), METER_INTERVAL_MS);
    this.sample();
  }

  private stopMeter(): void {
    if (this.meterTimer === null) return;
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.level = 0;
  }

  /** One analyser frame, and the honesty check on top of it. */
  private sample(): void {
    if (!this.analyser || !this.analysisRunning) return;
    const freq = this.freq;
    // Clear first. A tainted (cross-origin, no ACAO) analyser has been observed to leave
    // the destination array untouched rather than zeroing it — which would display the
    // previous track's spectrum as if it were live. Clearing makes silence unambiguous.
    freq.fill(0);
    this.analyser.getByteFrequencyData(freq);

    let max = 0;
    let checksum = 0;
    for (let i = 0; i < freq.length; i += 1) {
      if (freq[i] > max) max = freq[i];
      checksum = (checksum + freq[i] * (i + 1)) % 2147483647;
    }
    const identical = checksum === this.lastChecksum && max > 0;
    this.lastChecksum = checksum;
    this.identicalFrames = identical ? this.identicalFrames + 1 : 0;
    // A frozen frame is not a measurement either, however convincing it looks.
    const frozen = this.identicalFrames >= FROZEN_FRAMES_BEFORE_THEME;

    // Bands above ~10 kHz are usually empty on lossy streams, so loudness is taken
    // over the range a music signal actually occupies.
    const audibleBins = Math.max(1, Math.floor(freq.length * 0.6));
    let audibleSum = 0;
    for (let i = 0; i < audibleBins; i += 1) audibleSum += freq[i];
    this.level = audibleSum / audibleBins / 255;

    if (this.state === 'playing' && max > 0 && !frozen) {
      this.zeroFrames = 0;
      if (!this.spectrumLive) {
        this.spectrumLive = true;
        this.modeReason = 'real spectrum — AnalyserNode reading the decoded stream as it plays';
      }
    } else if (this.state === 'playing') {
      this.zeroFrames += 1;
      if (this.zeroFrames >= ZERO_FRAMES_BEFORE_THEME) {
        this.spectrumLive = false;
        this.modeReason = frozen
          ? 'the analyser kept returning the same frame, which is not a measurement — showing the album-art theme'
          : this.silenceReason();
      }
    }
    this.emit();
  }

  /** Why there are no real samples, as specifically as we can honestly say. */
  private silenceReason(): string {
    if (this.analysisBlocked) {
      return 'the silent copy of the stream never started (the platform wants a tap first), so there is nothing to analyse — the audio itself is native and playing';
    }
    if (this.crossOriginRetry) {
      return 'the library sent no Access-Control-Allow-Origin for this stream, so the browser will not hand over its samples — it is playing, but the spectrum cannot be real';
    }
    if (this.ctx?.state === 'suspended') {
      return 'the audio context is suspended, so the analyser has no samples (iOS suspends Web Audio in the background)';
    }
    if (this.graphFailedReason) return this.graphFailedReason;
    return 'the analyser returned silence — a tainted cross-origin stream gives zeroes with no error';
  }

  private fail(cause: unknown): void {
    this.error = cause instanceof Error ? cause.message : String(cause);
    this.state = 'error';
    this.spectrumLive = false;
    this.emit();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}
