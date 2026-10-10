/**
 * The audio engine: one <audio> element, one Web Audio graph, plus the native engine
 * when we are wrapped.
 *
 * The honest part is `spectrum`. A spectrum only exists when the browser hands us
 * real samples: `createMediaElementSource(el) → AnalyserNode`. When it cannot (a
 * tainted cross-origin stream with no ACAO, a suspended AudioContext, or native
 * playback with no buffer access), the analyser returns *zeros with no error* — the
 * classic silent flatline. Rather than animate a lie, the engine watches for that and
 * reports `spectrum: false` with a reason, and the UI switches to the album-art theme
 * and says which mode it is in.
 */
import { platformInfo, type OsName } from '../platform.ts';
import type { PlaybackPreference } from '../storage/settings.ts';
import { createNativeBridge, type NativeBridge, type NativeTrackInfo } from './native.ts';

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
  private nativePositionMs = 0;
  private crossOriginRetry = false;
  private handoffInFlight = false;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(status: EngineStatus) => void>();

  /** Set by the queue: called when a track finishes on its own. */
  onEnded: (() => void) | null = null;
  /** Called on every position update, for play reporting. */
  onProgress: ((positionMs: number, durationMs: number) => void) | null = null;

  constructor() {
    const info = platformInfo();
    this.os = info.os;
    this.nativePlatform = info.native;

    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('play', () => {
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

  status(): EngineStatus {
    const durationMs = this.backend === 'native' ? this.track?.durationMs ?? 0 : (this.el.duration || 0) * 1000;
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
    if (!this.spectrumLive || !this.analyser || this.backend !== 'web') return null;
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
    this.emit();
  }

  get currentTrack(): TrackRequest | null {
    return this.track;
  }

  /** Native bridge is created once, lazily, and only inside a wrapped build. */
  private async ensureNative(): Promise<NativeBridge | null> {
    if (!this.nativePlatform) return null;
    if (!this.nativeReady) {
      this.nativeReady = createNativeBridge(this.os, {
        onPosition: (seconds) => {
          this.nativePositionMs = seconds * 1000;
          this.emit();
          this.onProgress?.(this.nativePositionMs, this.track?.durationMs ?? 0);
        },
        onState: (state, isPlaying) => {
          if (this.backend !== 'native') return;
          this.state = isPlaying ? 'playing' : state === 'stopped' ? 'idle' : 'paused';
          this.emit();
        },
        onComplete: () => {
          if (this.backend !== 'native') return;
          this.state = 'paused';
          this.emit();
          this.onEnded?.();
        },
      });
    }
    this.native = await this.nativeReady;
    return this.native;
  }

  /** True when native playback is the right backend right now. */
  private async wantNative(): Promise<boolean> {
    if (this.preference === 'web') return false;
    if (!this.nativePlatform) return false;
    if (this.preference === 'native') return (await this.ensureNative()) !== null;
    // auto: native only once the app is out of sight, where Web Audio on iOS dies.
    if (typeof document === 'undefined' || !document.hidden) return false;
    return (await this.ensureNative()) !== null;
  }

  async play(track: TrackRequest, startMs = 0): Promise<void> {
    this.track = track;
    this.error = null;
    this.state = 'loading';
    this.crossOriginRetry = false;
    this.emit();
    if (await this.wantNative()) await this.startNative(track, startMs);
    else await this.startWeb(track, startMs);
  }

  async toggle(): Promise<void> {
    if (this.state === 'playing') await this.pause();
    else await this.resume();
  }

  async pause(): Promise<void> {
    if (this.backend === 'native') {
      await this.native?.pause();
      this.state = 'paused';
      this.emit();
      return;
    }
    this.el.pause();
  }

  async resume(): Promise<void> {
    if (this.backend === 'native') {
      await this.native?.resume();
      this.state = 'playing';
      this.emit();
      return;
    }
    await this.resumeContext();
    await this.el.play().catch((cause: unknown) => this.fail(cause));
    this.startMeter();
  }

  async seek(positionMs: number): Promise<void> {
    if (this.backend === 'native') {
      await this.native?.seek(positionMs / 1000);
      this.nativePositionMs = positionMs;
      this.emit();
      return;
    }
    if (Number.isFinite(this.el.duration)) this.el.currentTime = Math.max(0, positionMs / 1000);
    this.emit();
  }

  async stop(): Promise<void> {
    this.el.pause();
    this.el.removeAttribute('src');
    this.native?.stop();
    this.stopMeter();
    this.state = 'idle';
    this.track = null;
    this.spectrumLive = false;
    this.modeReason = 'nothing playing';
    this.emit();
  }

  /**
   * Entering/leaving the background on a wrapped build: hand the stream to the native
   * engine (keeps playing when iOS suspends Web Audio) and back again for the real
   * spectrum. Deliberately a hand-off at the same position, not a second stream.
   */
  async handleVisibility(hidden: boolean): Promise<void> {
    if (!this.track || this.handoffInFlight) return;
    if (this.preference === 'web') return;
    if (hidden && this.backend === 'web' && this.state === 'playing') {
      const bridge = await this.ensureNative();
      if (!bridge) return;
      this.handoffInFlight = true;
      try {
        const positionMs = this.el.currentTime * 1000;
        this.el.pause();
        await this.startNative(this.track, positionMs);
      } finally {
        this.handoffInFlight = false;
      }
    } else if (!hidden && this.backend === 'native' && this.track) {
      this.handoffInFlight = true;
      try {
        const positionMs = this.nativePositionMs;
        await this.native?.stop();
        await this.startWeb(this.track, positionMs);
      } finally {
        this.handoffInFlight = false;
      }
    }
  }

  private async startWeb(track: TrackRequest, startMs: number): Promise<void> {
    this.backend = 'web';
    this.el.pause();
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

  private async startNative(track: TrackRequest, startMs: number): Promise<void> {
    const bridge = await this.ensureNative();
    if (!bridge) {
      await this.startWeb(track, startMs);
      return;
    }
    this.backend = 'native';
    this.nativePositionMs = startMs;
    this.spectrumLive = false;
    this.modeReason =
      'native playback (ExoPlayer / AVFoundation) — real background audio and lock-screen controls, but the plugin exposes no audio buffer to JavaScript, so this screen shows the album-art theme';
    this.state = 'loading';
    this.emit();
    try {
      await bridge.load(track);
      await bridge.play(startMs / 1000);
      this.state = 'playing';
    } catch (cause) {
      this.fail(cause);
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
      source.connect(analyser);
      analyser.connect(ctx.destination);
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
    if (this.backend !== 'web') return;
    if (this.el.crossOrigin === 'anonymous' && !this.crossOriginRetry && this.track?.crossOrigin) {
      this.modeReason =
        'the library refused cross-origin sample access for this stream, so the analyser cannot see the audio — playing it anyway, with the album-art theme';
      void this.retryWithoutCrossOrigin();
      return;
    }
    const media = this.el.error;
    this.fail(new Error(media ? `${media.message} (code ${media.code})` : 'the audio element failed to load the stream'));
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
    if (!this.analyser || this.backend !== 'web') return;
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
