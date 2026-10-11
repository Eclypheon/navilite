/**
 * The audio engine: **one** engine, one state machine, one clock.
 *
 * v1.7.3 is the collapse. v1.6 and v1.7 ran two playback pipelines — a `<audio>` element in the
 * page and the phone's own AVFoundation/ExoPlayer player — with two clocks, two ideas of what
 * "playing" means, and a hand-off between them at `visibilitychange`. Every report the owner has
 * made since describes that shape, and his latest describes it exactly: *"the native audio player
 * seems to keep incrementing in time when there is no sound when backgrounded for web audio only
 * mode and when i go back, pausing causes the audio to keep repeating … it somehow automatically
 * switches off the spectrum like it's in native only mode"*. Two engines, two clocks, consumers
 * that switch off.
 *
 * What is here now, and what is gone:
 *
 *   - **One engine per platform, chosen by the platform.** Inside the Capacitor shell that is the
 *     native player (ExoPlayer on Android, AVFoundation on iOS); in a browser it is the media
 *     element, which is the only engine a browser has. There is no preference that selects one,
 *     and — this is the part that was deleted — **no fallback that plays**: if a wrapped build
 *     cannot build the native bridge it reports that and plays nothing. It never quietly starts a
 *     second engine in the page.
 *   - **Deleted: the silent second copy of the stream.** v1.7 fed the analyser from a `<audio>`
 *     element playing the same stream a second time, muted, alongside the native player. That was
 *     the second engine: a second connection to the library, a second clock, and a WebKit media
 *     element starting and stopping the `AVAudioSession` under the player the owner was listening
 *     to. It is gone in every form (`startAnalysis`, `analysisRunning`, `syncAnalysis`,
 *     `retryAnalysisWithoutCrossOrigin`, the meter's feed from it, and the on-hide teardown).
 *   - **One state machine** ({@link reduce}), fed by every input there is: a user transport action,
 *     a native player event, an interruption, a remote/lock-screen command, `visibilitychange`.
 *     It is the only thing that decides what the UI shows and what the engine does.
 *   - **One clock**, derived from the active engine, and it advances **only** while the machine
 *     says `playing` *and* the app is on screen to hear about it. Nothing else moves a position.
 *   - **Consumers never switch off.** The spectrum is armed by the state machine entering
 *     `playing` and torn down by it leaving — one place, not five call sites. There is now no code
 *     path that can leave `state === 'playing'` with the visualiser off: whatever arm it, disarms
 *     it, and re-arms it is that one transition, so the two can never disagree.
 *   - **The comments that describe the deleted paths are deleted with them.** Nothing here claims a
 *     mechanism that is not in the file.
 *
 * The honest limit is unchanged and worth repeating: a spectrum only exists when something can
 * hand over real samples. On iOS that is the native tap (`ios/App/App/NaviliteSpectrum.swift`, an
 * FFT of the stream a second silent `AVPlayer` is decoding — a read-only consumer, never a second
 * transport); on the web it is `createMediaElementSource(el) → AnalyserNode`; a build with neither
 * says so in one line and draws the album-art theme rather than animating a lie.
 */
import { platformInfo, type OsName } from '../platform.ts';
import { createNativeBridge, type NativeBridge, type NativeBridgeEvents, type NativeSpectrumFrame, type NativeTrackInfo } from './native.ts';

export type PlaybackBackend = 'web' | 'native';

/** The states of the one machine. `interrupted` is "the sound stopped and nobody asked". */
export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'interrupted' | 'ended' | 'error';

/**
 * Every input, as an event — and there is no other way in.
 *
 * `trackId` where the input comes from a player: an event about a track that is no longer the
 * current one is stale, and the engine drops it rather than queueing it (`dispatch`).
 */
export type PlayerEvent =
  | { type: 'select'; trackId: string }
  /** The audible engine says whether sound is coming out. It is authoritative; we only ask. */
  | { type: 'engine-state'; playing: boolean; stopped?: boolean }
  /** The user, or the lock screen, asked for a transport. The machine decides what that means. */
  | { type: 'transport'; action: 'play' | 'pause' | 'toggle' }
  /** The session was taken away — a call, Siri, another app — or given back. */
  | { type: 'interruption'; phase: 'began' | 'ended' }
  /** The app went out of sight, or came back. */
  | { type: 'lifecycle'; phase: 'hidden' | 'foreground' }
  | { type: 'track-ended'; trackId: string }
  | { type: 'cleared' }
  | { type: 'failure'; message: string };

/**
 * The machine, as a pure function: same state and same event, same answer, every time.
 *
 * Purity is what makes the two properties the owner needs *provable* rather than hoped for.
 * **Idempotence** — `reduce(reduce(s, e), e) === reduce(s, e)` for every transport event, so a
 * double tap, a lock-screen command racing a tap, or a replayed event cannot move the machine
 * twice. **Staleness is a non-event** — an `engine-state` report that disagrees with a state we are
 * already in returns that state unchanged, so an event from before a transition is absorbed, never
 * queued.
 */
export function reduce(state: EngineState, event: PlayerEvent): EngineState {
  switch (event.type) {
    case 'select':
      return 'loading';
    case 'engine-state':
      if (event.playing) return 'playing';
      // Not playing. Which kind of "not playing" it is depends on what we were doing: a report
      // that arrives while we are already still changes nothing at all.
      if (state === 'idle' || state === 'loading') return state;
      if (state === 'playing') return event.stopped ? 'ended' : 'paused';
      return state;
    case 'transport':
      if (event.action === 'pause') return state === 'playing' || state === 'loading' ? 'paused' : state;
      if (event.action === 'play') return state === 'idle' ? 'idle' : 'playing';
      // toggle
      if (state === 'playing' || state === 'loading') return 'paused';
      return state === 'idle' ? 'idle' : 'playing';
    case 'interruption':
      if (event.phase === 'began') return state === 'playing' ? 'interrupted' : state;
      return state === 'interrupted' ? 'paused' : state;
    case 'lifecycle':
      // Deliberately nothing: leaving the screen does not change what the audio is doing, and
      // saying otherwise is what made the app believe a pause nobody had made.
      return state;
    case 'track-ended':
      return state === 'idle' ? 'idle' : 'ended';
    case 'cleared':
      return 'idle';
    case 'failure':
      return 'error';
  }
}

export interface TrackRequest extends NativeTrackInfo {
  id: string;
  durationMs: number;
  /** True when the stream lives on another origin and the element must opt in to CORS. */
  crossOrigin: boolean;
}

export interface EngineStatus {
  state: EngineState;
  backend: PlaybackBackend;
  /** True only when the visualiser is being fed real frames right now. */
  spectrum: boolean;
  modeReason: string;
  positionMs: number;
  durationMs: number;
  error: string | null;
  nativeAvailable: boolean;
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
 * The same, in native-tap polls (every {@link SPECTRUM_POLL_MS}): 12 polls is ~0.4 s, and the tap
 * has its own frame counter — a tap that has produced *frames* that were silent is a different
 * statement from a tap that has produced nothing, and the mode note says which.
 */
const ZERO_POLLS_BEFORE_THEME = 12;
/**
 * How often the native bands are read.
 *
 * 30 Hz, not the canvas's 60: the canvas redraws the last frame every animation frame, and what the
 * owner can see of a bar is its height, so 30 measurements a second is motion, not stepping.
 */
const SPECTRUM_POLL_MS = 33;
/** The clock is reported while playing at this rate, so the display never sits still. */
const CLOCK_TICK_MS = 200;
/** A seek is corrected on the analysis tap once the drift is a real one. */
const SPECTRUM_RESYNC_MS = 5000;
/**
 * How often a tap that has stopped answering is allowed to be rebuilt.
 *
 * v1.7.2 armed the tap on the way in and then never looked at it again: if iOS tore the silent
 * `AVPlayer` down while the app was suspended, the tap stayed dead for the rest of the track and
 * the visualiser never came back on its own. That is the owner's *"it somehow automatically
 * switches off the spectrum like it's in native only mode"*. A consumer that goes quiet while the
 * engine is playing is now rebuilt, no more than once every five seconds, and it is never simply
 * left off.
 */
const SPECTRUM_RESTART_MS = 5000;
/**
 * How many times a dead tap is rebuilt before the app gives up and says so.
 *
 * A tap that will not stay up is not worth a retry every five seconds for the length of a track:
 * the third failure is reported, the bars go to the album-art theme, and nothing polls any more.
 */
const MAX_SPECTRUM_RESTARTS = 3;
/**
 * The same non-zero frame for ~1 s is a frozen buffer, not a measurement.
 *
 * v1.1 lowered this from 25 frames (2.5 s): with the analyser running at a near-zero smoothing
 * constant (below), a genuinely live frame differs every single sample, so a repeat is already
 * strong evidence.
 */
const FROZEN_FRAMES_BEFORE_THEME = 10;
const METER_INTERVAL_MS = 100;

export class AudioEngine {
  private readonly el: HTMLAudioElement;
  private readonly os: OsName;
  /** True inside the Capacitor shell: the native player is then the only engine there is. */
  private readonly nativePlatform: boolean;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * The analyser's output stage, on the web path only. It is connected to the destination at a
   * gain of 1: in a browser the element *is* the audible engine and the analyser is simply in
   * front of it. Nothing in a wrapped build ever builds this graph.
   */
  private analyserGain: GainNode | null = null;
  private graphSource: MediaElementAudioSourceNode | null = null;
  private graphFailedReason: string | null = null;
  private freq: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(1024));

  /* ------------------------------- the honest bookkeeping the visualiser reads */
  private level = 0;
  private zeroFrames = 0;
  private identicalFrames = 0;
  private lastChecksum = -1;
  private spectrumLive = false;
  private modeReason = 'nothing playing yet';
  private nativeBands: Uint8Array | null = null;
  private spectrumPoll: ReturnType<typeof setInterval> | null = null;
  private spectrumZeroPolls = 0;
  private spectrumPolls = 0;
  private lastSpectrumResyncAt = 0;
  private lastSpectrumRestartAt = 0;
  /** Polls in a row where the tap said it was not playing, and how many rebuilds that has cost. */
  private spectrumDeadPolls = 0;
  private spectrumRestarts = 0;

  /* ------------------------------------------------------------- the machine */
  private state: EngineState = 'idle';
  /**
   * A counter that makes every in-flight callback stale the moment the user does something.
   *
   * A tap, a new track, a seek: the generation is bumped, and any bridge round trip, confirmation
   * or event that was started under the old generation is dropped when it lands. That is how a
   * resume's own confirmation cannot land on top of the pause the user made a moment later — the
   * class of bug behind *"pausing causes the audio to keep repeating"*, killed at the door rather
   * than patched at the instance.
   */
  private generation = 0;
  /**
   * Non-zero while an explicit transport round trip is in flight.
   *
   * A load is an unload + preload: the outgoing asset stops on purpose, and the plugin reports
   * that stop. It is not a pause the user asked for, and it must not be read as one. The same
   * window covers our own play/pause/resume, whose reports are describing the request rather than
   * contradicting it.
   */
  private inTransition = 0;
  private backend: PlaybackBackend = 'web';
  private track: TrackRequest | null = null;
  private error: string | null = null;
  private native: NativeBridge | null = null;
  private nativeReady: Promise<NativeBridge | null> | null = null;
  /** How the native bridge is built — real in production, fake in `test/engine-native.test.ts`. */
  private readonly nativeFactory: (os: OsName, events: NativeBridgeEvents) => Promise<NativeBridge | null>;
  private nativePositionMs = 0;
  /**
   * When `nativePositionMs` was last true.
   *
   * Re-anchored on every transition *into* `playing`, which is what makes the clock incapable of
   * spanning a pause, a hand-off or a hidden window: the extrapolation always starts from the
   * instant the engine says sound began.
   */
  private nativePositionAt = 0;
  private nativeDurationMs = 0;
  /** True while the app is on screen — the only time the clock is allowed to extrapolate. */
  private foreground = true;
  /** True while the clock ticker is running, so only one ever runs. */
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether the track was playing when the app went out of sight.
   *
   * The invariant the owner asked for, in his words: *"resuming from background is still causing
   * the song to pause i want it to continue playing seamlessly"*. A hand-off, an interruption or a
   * session another app took can all leave the player stopped; if it *was* playing when it left,
   * coming back puts it back to playing rather than reporting a pause nobody asked for.
   */
  private wasPlayingBeforeHide = false;
  /** True while the native tap is armed. The web path's equivalent is the meter. */
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

    /*
     * The element's own events are inputs into the machine like any other — and they are attached
     * exactly once, here, for the life of the engine. A listener attached per play (or per
     * visibility change) is the other half of "double-attached listeners" that made a track
     * restart or repeat; there is one of each, and this is where they live.
     */
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('play', () => {
      if (this.backend !== 'web') return;
      this.error = null;
      this.dispatch({ type: 'engine-state', playing: true });
    });
    el.addEventListener('playing', () => {
      if (this.backend !== 'web') return;
      this.dispatch({ type: 'engine-state', playing: true });
    });
    el.addEventListener('pause', () => {
      if (this.backend !== 'web') return;
      this.dispatch({ type: 'engine-state', playing: false });
    });
    el.addEventListener('timeupdate', () => {
      if (this.backend !== 'web') return;
      this.emit();
      this.onProgress?.(this.el.currentTime * 1000, this.el.duration * 1000);
    });
    el.addEventListener('ended', () => {
      if (this.backend !== 'web') return;
      this.dispatch({ type: 'track-ended', trackId: this.track?.id ?? '' });
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

  /* ---------------------------------------------------------- the machine's door */

  /**
   * The only way into the machine.
   *
   * Three things happen here and nowhere else: a stale event is dropped, the state is asked of the
   * pure reducer, and the consequences of a transition (the clock, the consumers) are applied. No
   * other method in this file writes `this.state`.
   */
  private dispatch(event: PlayerEvent, generation = this.generation): void {
    if (generation !== this.generation) return;
    const next = reduce(this.state, event);
    if (next === this.state) return;
    /*
     * Freeze the clock *before* the state stops the extrapolation, and only for a real transition
     * out of playing: the position at the instant the sound stopped is the position the rest of
     * the app keeps.
     */
    if (this.state === 'playing' && this.backend === 'native') this.nativePositionMs = this.nativeClock();
    this.state = next;
    this.applyState(next);
    this.emit();
  }

  /**
   * What a state *means*, in one place.
   *
   * This is the whole of "consumers never switch off": entering `playing` arms the clock and the
   * spectrum, leaving it stops them, and there is no third possibility — so a state of `playing`
   * with the visualiser off cannot be reached, because nothing else can turn it off.
   */
  private applyState(next: EngineState): void {
    if (next === 'playing') {
      // Re-anchor: the clock counts from this instant, never across a transition.
      this.nativePositionAt = this.clockNow();
      this.startClockTick();
      this.startConsumers();
      return;
    }
    const reason =
      next === 'paused'
        ? 'paused — the spectrum is a picture of what is being heard'
        : next === 'ended'
          ? 'the track ended'
          : next === 'interrupted'
            ? 'the audio stopped without being asked (a call, another app, or the session being taken) — one tap on play restarts it here'
            : next === 'loading'
              ? 'loading'
              : 'nothing playing';
    this.stopClockTick();
    this.stopConsumers(reason);
  }

  private startClockTick(): void {
    if (this.clockTimer !== null) return;
    this.clockTimer = setInterval(() => {
      if (this.state !== 'playing') return;
      this.emit();
    }, CLOCK_TICK_MS);
  }

  private stopClockTick(): void {
    if (this.clockTimer === null) return;
    clearInterval(this.clockTimer);
    this.clockTimer = null;
  }

  private clockNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Re-base the clock on a position the player actually reported. */
  private setNativePosition(ms: number): void {
    this.nativePositionMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    this.nativePositionAt = this.clockNow();
  }

  /**
   * The position of the native player, between the player's own reports.
   *
   * The one clock, with two rules that between them make every clock report the owner has made
   * impossible:
   *
   *   1. it advances **only** while the machine says `playing` — a pause, an interruption, an end
   *      or an error freezes it exactly where it is;
   *   2. it advances **only while the app is on screen**, because that is the only time the player's
   *      own reports are arriving. Off screen it reports the last position the player actually
   *      gave it — a fact — rather than inventing the wall-clock minutes since (*"the native audio
   *      player seems to keep incrementing in time when there is no sound when backgrounded"*).
   *      Coming back re-reads the player, so the number lands on the truth rather than on a guess.
   */
  private nativeClock(): number {
    if (this.backend !== 'native') return this.el.currentTime * 1000;
    if (this.state !== 'playing' || !this.foreground) return this.nativePositionMs;
    const elapsed = Math.max(0, this.clockNow() - this.nativePositionAt);
    const position = this.nativePositionMs + elapsed;
    const duration = this.durationMs();
    return duration > 0 ? Math.min(position, duration) : position;
  }

  /** Duration in ms: the native player's own when it reports one, the track metadata otherwise. */
  private durationMs(): number {
    if (this.backend === 'native') return this.nativeDurationMs || this.track?.durationMs || 0;
    if (Number.isFinite(this.el.duration) && this.el.duration > 0) return this.el.duration * 1000;
    return this.track?.durationMs ?? 0;
  }

  status(): EngineStatus {
    const durationMs = this.durationMs();
    const positionMs = this.backend === 'native' ? this.nativeClock() : this.el.currentTime * 1000;
    return {
      state: this.state,
      backend: this.backend,
      spectrum: this.spectrumLive,
      modeReason: this.modeReason,
      positionMs: Number.isFinite(positionMs) ? positionMs : 0,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      error: this.error,
      nativeAvailable: this.native !== null,
    };
  }

  /**
   * The live band data, or null when there is nothing real to show.
   *
   * Two sources, one shape: the native tap's own bands when the native player is the audible engine
   * (the iOS path), and the analyser's FFT bins on the web path. The canvas draws both — see
   * `visualizer.ts`, which knows a 64-value frame is already banded.
   */
  spectrumData(): Uint8Array | null {
    if (this.backend === 'native') return this.spectrumLive ? this.nativeBands : null;
    return this.spectrumLive && this.analyser ? this.freq : null;
  }

  /**
   * A fresh read of the native tap, bypassing the poll's own cache.
   *
   * The visualiser draws the polled frame; this is for checks that need the tap's *own* numbers —
   * the frame counter, its position, and whether the frames it is producing are silent — rather
   * than what the app believes about them.
   */
  async readNativeFrame(): Promise<NativeSpectrumFrame | null> {
    const bridge = this.native;
    if (!bridge?.spectrumFrame) return null;
    return bridge.spectrumFrame();
  }

  /**
   * A fresh analyser frame, for the visualiser to call once per animation frame.
   *
   * The meter below samples every 100 ms (it is doing the honesty bookkeeping, which does not need
   * to run at 60 Hz), so a canvas drawing from that buffer would be redrawing the same measurement
   * fifteen times a second — visibly stepped. Pulling the frame per paint makes the bars move with
   * the audio instead of with the timer.
   */
  readSpectrum(): Uint8Array | null {
    if (this.backend === 'native') return this.spectrumLive ? this.nativeBands : null;
    if (!this.spectrumLive || !this.analyser) return null;
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

  /**
   * Build the native bridge now, and throw the result away — the press must not pay for it.
   *
   * v1.7 built the bridge *inside* the first `play()`: a dynamic import of the plugin, a
   * `configure()` round trip, three `addListener` round trips, and only then the unload/preload of
   * the asset and the `play`. All of it sat between the tap and the first sound. The plugin costs
   * nothing while idle, so it is built at launch instead. (This is the bridge being built early,
   * not audio being pre-rolled: nothing here produces sound.)
   */
  prewarm(): void {
    if (!this.nativePlatform) return;
    void this.ensureNative();
  }

  get currentTrack(): TrackRequest | null {
    return this.track;
  }

  /* ------------------------------------------------------------- the native bridge */

  /** Native bridge is created once, lazily, and only inside a wrapped build. */
  private async ensureNative(): Promise<NativeBridge | null> {
    if (!this.nativePlatform) return null;
    if (!this.nativeReady) {
      this.nativeReady = this.nativeFactory(this.os, {
        onPosition: (seconds) => {
          if (this.backend !== 'native') return;
          this.setNativePosition(seconds * 1000);
          this.emit();
          this.onProgress?.(this.nativePositionMs, this.durationMs());
        },
        onState: (state, isPlaying) => {
          if (this.backend !== 'native') return;
          // Our own load/play/pause/resume in flight: this report is describing the request.
          if (this.inTransition > 0) return;
          if (isPlaying) {
            this.dispatch({ type: 'engine-state', playing: true });
            return;
          }
          // Not playing and we did not ask it to stop: that is an interruption, not a pause.
          this.dispatch({ type: 'interruption', phase: 'began' });
          if (state === 'stopped') this.nativePositionMs = Math.min(this.nativePositionMs, this.durationMs());
        },
        onComplete: () => {
          if (this.backend !== 'native') return;
          // Never on the back of an asset swap — this is the one event that moves the queue.
          if (this.inTransition > 0) return;
          this.dispatch({ type: 'track-ended', trackId: this.track?.id ?? '' });
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

  /* ------------------------------------------------------------------- transport */

  async play(track: TrackRequest, startMs = 0): Promise<void> {
    /*
     * The same track, still loading or already playing, is a second press on the same thing — not
     * a second playback. Nothing is reloaded, nothing is replayed and nothing is re-attached.
     */
    if (this.track?.id === track.id && (this.state === 'loading' || this.state === 'playing')) {
      this.emit();
      return;
    }
    this.generation += 1;
    this.track = track;
    this.error = null;
    this.dispatch({ type: 'select', trackId: track.id });

    if (this.nativePlatform) {
      /*
       * The platform decides the engine, once, and it is not re-decided when something fails.
       */
      this.backend = 'native';
      const ready = this.native ?? (await this.ensureNative());
      if (!ready) {
        /*
         * No native player in a wrapped build. v1.7 fell back to the page's own element here,
         * which is how a "native" app came to be playing through WebKit — two engines, chosen by a
         * failure. There is no fallback that plays any more: one engine, or an honest error.
         */
        this.fail(new Error('the native audio engine is not available in this build'));
        return;
      }
      await this.startNative(track, startMs, ready);
      return;
    }
    await this.startWeb(track, startMs);
  }

  async toggle(): Promise<void> {
    if (this.state === 'playing') {
      await this.pause();
      return;
    }
    await this.resume();
  }

  /**
   * Pause. Safe to apply twice, and safe to apply to something that is not playing.
   *
   * v1.7 sent the round trip every time it was called, whatever the state: two taps, or a tap
   * racing a lock-screen command, meant two pauses on a player that was already paused, and the
   * second one could land after a resume. Here a pause that is not a *change* is not sent at all,
   * and the generation bump makes anything already in flight stale.
   */
  async pause(): Promise<void> {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    this.generation += 1;
    if (this.backend === 'native') {
      this.dispatch({ type: 'transport', action: 'pause' });
      this.inTransition += 1;
      try {
        await this.native?.pause();
      } finally {
        this.inTransition -= 1;
      }
      this.emit();
      return;
    }
    this.el.pause();
  }

  /**
   * Play, from a state that is not playing.
   *
   * Two things matter here and both come from the owner's own reports.
   *
   * **It is idempotent.** Already playing means nothing is sent: a double tap cannot mean two
   * resumes, and a lock-screen play arriving while the app is already playing is absorbed.
   *
   * **It is optimistic, and then checked.** The state and the icon flip on the tap rather than
   * after a bridge round trip — that ordering *was* the "noticeable delay when pressing play".
   * Nothing is claimed that is not checked immediately afterwards (`confirmPlaying`): a resume
   * that resolves and leaves the player stopped is restarted, which is the rule he asked for in
   * his own words — one tap on play must restart it, with no seek-bar nudge and no pause/play
   * dance.
   */
  async resume(): Promise<void> {
    if (this.backend === 'native') {
      if (this.state === 'playing') return;
      const track = this.track;
      if (!track) return;
      this.generation += 1;
      this.dispatch({ type: 'transport', action: 'play' });
      this.inTransition += 1;
      try {
        await this.native?.resume();
      } finally {
        this.inTransition -= 1;
      }
      this.onProgress?.(this.nativePositionMs, this.durationMs());
      void this.confirmPlaying();
      return;
    }
    await this.resumeContext();
    await this.el.play().catch((cause: unknown) => this.fail(cause));
  }

  /**
   * The second half of a native `resume()`: ask the player what it is *actually* doing, and if the
   * answer is "not playing", start the track again from the position it stopped at.
   */
  private async confirmPlaying(): Promise<void> {
    const bridge = this.native;
    const track = this.track;
    if (!bridge || !track || this.backend !== 'native') return;
    /*
     * No "one at a time" latch here: two confirmations cannot both act, because the second
     * `resume()` bumps the generation and the first one exits at the first check below. A latch
     * would instead *suppress* the newer check — which is how a swallowed resume went unnoticed.
     */
    const generation = this.generation;
    // A resumed AVPlayer is not instantaneous; asking immediately would restart healthy tracks.
    await new Promise((resolve) => setTimeout(resolve, RESUME_CONFIRM_MS));
    // The user may have moved on inside that window — a different track, or a pause.
    if (generation !== this.generation || this.state !== 'playing' || this.track !== track) return;
    const truth = await bridge.sync();
    if (!truth) return; // The player could not be read; the optimistic state stands.
    if (truth.playing) {
      this.setNativePosition(truth.positionMs);
      this.emit();
      return;
    }
    // Stopped while the player was being asked: the restart is off.
    if (generation !== this.generation || this.track !== track || this.state !== 'playing') return;
    const from = truth.positionMs > 0 ? truth.positionMs : this.nativePositionMs;
    this.setNativePosition(from);
    await this.startNative(track, from);
  }

  async seek(positionMs: number): Promise<void> {
    this.generation += 1;
    if (this.backend === 'native') {
      await this.native?.seek(positionMs / 1000);
      this.setNativePosition(positionMs);
      if (this.native?.hasNativeSpectrum) void this.native?.resyncSpectrum?.(positionMs);
      this.emit();
      return;
    }
    if (Number.isFinite(this.el.duration)) this.el.currentTime = Math.max(0, positionMs / 1000);
    this.emit();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.el.pause();
    this.el.removeAttribute('src');
    this.track = null;
    this.setNativePosition(0);
    this.nativeDurationMs = 0;
    this.dispatch({ type: 'cleared' });
    void this.native?.stop();
    this.emit();
  }

  /**
   * Entering and leaving the background, on a wrapped build.
   *
   * **Nothing here touches the audio.** It is the native engine's, and native playback is not
   * suspended the way WebKit's is — so leaving the screen changes no state, sends no pause and
   * takes no engine away. What this does is exactly two things: it stops the clock from inventing
   * time while nothing is reporting to it, and on the way back in it *asks the player* what is
   * true — adopting that answer rather than overriding it — and re-arms the visualiser, which
   * cannot have been receiving frames while the web view was suspended.
   */
  async handleVisibility(hidden: boolean): Promise<void> {
    this.dispatch({ type: 'lifecycle', phase: hidden ? 'hidden' : 'foreground' });
    if (!this.track) {
      this.foreground = !hidden;
      return;
    }
    if (this.backend !== 'native') {
      // A browser: nothing carries the audio but the element, and iOS suspends it. Re-resume the
      // audio context on the way in; that is all that helps.
      this.foreground = !hidden;
      if (!hidden && this.state === 'playing') await this.resumeContext();
      return;
    }
    if (hidden) {
      this.foreground = false;
      this.wasPlayingBeforeHide = this.state === 'playing';
      // The player keeps playing and keeps reporting *to nobody* — the web view is suspended and
      // no callback arrives. So the clock stops counting here rather than at an unknown later
      // moment; what it shows is the last position the player was known to be at.
      this.stopClockTick();
      return;
    }
    this.foreground = true;
    const stateBefore = this.state;
    await this.native?.activateSession();
    const truth = await this.native?.sync();
    /*
     * The player is the authority, in both directions, and this path **never writes to it**.
     *
     * That is the third invariant of this release and it is the one that "completely breaks
     * playback": if the owner pauses from the lock screen or the control centre while the app is
     * away, coming back must adopt that pause — not send a resume over the top of a decision he
     * made, which is what trying to be helpful here produces. v1.7.1's reconciliation did exactly
     * that (and worse, wrote a *pause* into a player it could not read, because the deleted web
     * copy was holding the audio session under it). So: read, adopt, and leave the writing to the
     * taps. A track that the platform stopped is `interrupted`, which is one tap from playing
     * again; a track the user stopped is `paused`, which is also one tap.
     */
    if (truth) {
      this.setNativePosition(truth.positionMs);
      if (truth.durationMs > 0) this.nativeDurationMs = truth.durationMs;
      if (truth.playing) this.dispatch({ type: 'engine-state', playing: true });
      else if (this.state === 'playing') {
        this.dispatch({ type: 'interruption', phase: 'began' });
        this.modeReason = this.wasPlayingBeforeHide
          ? 'the track was playing when the app left the screen and the player is not playing now — one tap on play starts it again from here, and nothing was written to the player to get there'
          : 'the player is not playing';
      } else this.dispatch({ type: 'engine-state', playing: false });
    } else if (this.state === 'playing') {
      // The player would not answer. Never leave a "playing" on screen that no tap can act on.
      this.dispatch({ type: 'interruption', phase: 'began' });
    }
    if (this.state === 'playing') {
      // The state did not change (the player was playing all along) but the ticker and the tap
      // died with the suspended web view: both are re-armed, unconditionally, whenever the app is
      // playing on the way back in.
      this.startClockTick();
      if (truth?.playing && stateBefore === 'playing' && this.backend === 'native') this.restartSpectrum();
    }
    this.emit();
    this.onProgress?.(this.nativePositionMs, this.durationMs());
  }

  /* ------------------------------------------------------------------ the engines */

  /** The browser's engine — the only one a browser has, and never a substitute for a native one. */
  private async startWeb(track: TrackRequest, startMs: number): Promise<void> {
    this.backend = 'web';
    this.el.pause();
    // crossOrigin must be set before src, otherwise the request is already in flight and the
    // element stays tainted for the life of the load.
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
  }

  /**
   * The native player, and the only engine a wrapped build will ever use.
   *
   * The optimistic state is set — and with it the clock and the visualiser, through `applyState` —
   * *before* the round trips, inside the gesture that asked for them: `load()` unloads, preloads
   * the asset over the network and plays it, which is what the owner felt as "a noticeable delay
   * when pressing play". Arming the tap inside the same gesture is also the only way iOS will let
   * it start at all.
   */
  private async startNative(track: TrackRequest, startMs: number, ready?: NativeBridge): Promise<void> {
    const bridge = ready ?? (await this.ensureNative());
    if (!bridge) {
      this.fail(new Error('the native audio engine is not available in this build'));
      return;
    }
    this.backend = 'native';
    this.setNativePosition(startMs);
    this.nativeDurationMs = track.durationMs;
    this.spectrumLive = false;
    // A new track is a fresh budget for a dead tap.
    this.spectrumRestarts = 0;
    this.modeReason =
      'native playback (AVFoundation / ExoPlayer) — this is the engine that keeps going when you leave the app and the one the lock screen drives; the spectrum is an FFT of the same stream, read from the native audio tap';
    // A load is an unload + preload: the outgoing asset's stop must not be read as a track ending.
    this.inTransition += 1;
    const generation = this.generation;
    this.dispatch({ type: 'transport', action: 'play' });
    try {
      await bridge.load(track);
      await bridge.play(startMs / 1000);
    } catch (cause) {
      this.fail(cause);
    } finally {
      this.inTransition -= 1;
    }
    /*
     * A pause that arrived *while the asset was loading* wins.
     *
     * The load is three round trips long, and a pause sent inside that window reaches the player
     * before the play does — so the asset ends up playing on top of a pause the user asked for,
     * which is a track that will not stop. The generation says whether a transport came after this
     * one; if it did and the machine is not playing, the stop is sent again, now that the player
     * has an asset to stop.
     */
    if (generation !== this.generation && this.state !== 'playing') {
      await bridge.pause();
      this.emit();
    }
  }

  /* ------------------------------------------------ the consumers: the visualiser */

  /**
   * Arm whatever feeds the visualiser for the engine that is now playing.
   *
   * Called from exactly one place — `applyState`, on entering `playing` — and idempotent, because
   * the transitions that call it can be repeated. The native tap is preferred wherever the build
   * has one: it reads the audio the player is playing, so the bars are of the sound being heard
   * rather than of a second copy of the stream.
   */
  private startConsumers(): void {
    if (this.backend === 'web') {
      this.startMeter();
      return;
    }
    const track = this.track;
    const bridge = this.native;
    if (!track) return;
    if (!bridge?.hasNativeSpectrum || !bridge.startSpectrum) {
      /*
       * No tap in this build (Android today, and the browser). v1.7 played a second, silent copy
       * of the stream in the page to get samples here — a second engine, a second clock, and the
       * thing that stopped the owner's playback on return. That is deleted. What is left is the
       * honest statement, and the album-art theme.
       */
      this.spectrumLive = false;
      this.modeReason = 'this build has no spectrum tap on its native player, so the bars are on the album-art theme — the audio itself is unaffected';
      return;
    }
    if (this.spectrumPoll !== null) return;
    const positionMs = this.nativePositionMs;
    this.nativeBands = null;
    this.spectrumZeroPolls = 0;
    this.spectrumPolls = 0;
    this.spectrumLive = false;
    /*
     * Start reading **now**, not when the plugin says it has started.
     *
     * `startSpectrum` resolves only once the second player has loaded the stream's audio track and
     * installed its tap, which on a real library is a network round trip (measured on the
     * simulator at 1.2–1.7 s). Waiting for that promise left the bars flat for that whole window
     * even though the tap was already producing frames. The poll is safe before the tap exists — a
     * frame that is not live yet is exactly what the zero-poll counter is for.
     */
    this.spectrumPoll = setInterval(() => void this.pollSpectrum(), SPECTRUM_POLL_MS);
    this.lastSpectrumRestartAt = this.clockNow();
    void bridge
      .startSpectrum(track.url, positionMs)
      .then((started) => {
        if (!started) {
          this.modeReason = 'the native spectrum tap did not start, so the bars are on the album-art theme';
          this.emit();
          return;
        }
        if (this.track !== track || this.backend !== 'native') return;
        this.lastSpectrumResyncAt = this.clockNow();
      })
      .catch((error: unknown) => {
        this.spectrumLive = false;
        this.modeReason = `the native spectrum tap failed (${error instanceof Error ? error.message : String(error)})`;
        this.emit();
      });
    void this.pollSpectrum();
  }

  /**
   * Disarm the visualiser, because the engine is not playing any more.
   *
   * `paused`, `ended`, `interrupted`, `error`, `idle`: the spectrum is a picture of what is being
   * heard, and nothing is. Note what is *not* here — leaving the app, or handing playback between
   * engines, neither of which exists any more.
   */
  private stopConsumers(reason: string): void {
    if (this.spectrumPoll !== null) {
      clearInterval(this.spectrumPoll);
      this.spectrumPoll = null;
    }
    this.stopMeter();
    this.nativeBands = null;
    this.spectrumZeroPolls = 0;
    void this.native?.stopSpectrum?.();
    if (this.spectrumLive) {
      this.spectrumLive = false;
      this.modeReason = reason;
    }
  }

  /** One poll of the tap: the frame, and the honesty check on top of it. */
  private async pollSpectrum(): Promise<void> {
    const bridge = this.native;
    if (!bridge?.spectrumFrame || this.backend !== 'native' || !this.track) return;
    const frame = await bridge.spectrumFrame();
    if (!frame || !this.track) return;
    this.spectrumPolls += 1;
    const playing = this.state === 'playing' && frame.playing;
    if (!playing) {
      this.spectrumLive = false;
      /*
       * The tap has gone quiet while the engine is playing — iOS tore the silent player down (it
       * happens across a suspension, and it happens quietly). Rebuild it rather than leave the
       * visualiser dark for the rest of the track. A tap that will not stay up is not retried for
       * ever: {@link MAX_SPECTRUM_RESTARTS} rebuilds, then the theme and one honest sentence.
       */
      if (this.state !== 'playing') {
        this.spectrumDeadPolls = 0;
        return;
      }
      this.spectrumDeadPolls += 1;
      if (this.spectrumDeadPolls < ZERO_POLLS_BEFORE_THEME) return;
      if (this.clockNow() - this.lastSpectrumRestartAt < SPECTRUM_RESTART_MS) return;
      if (this.spectrumRestarts >= MAX_SPECTRUM_RESTARTS) {
        this.spectrumDeadPolls = 0;
        this.stopConsumers('the spectrum tap would not stay up on this stream — the bars are on the album-art theme, and the audio is untouched');
        this.emit();
        return;
      }
      this.spectrumRestarts += 1;
      this.restartSpectrum();
      return;
    }
    this.spectrumDeadPolls = 0;
    this.nativeBands = Uint8Array.from(frame.bands);
    if (frame.live) {
      this.spectrumZeroPolls = 0;
      // A tap that has produced real frames has proved itself: the rebuild budget starts again.
      this.spectrumRestarts = 0;
      if (!this.spectrumLive) {
        this.spectrumLive = true;
        this.modeReason = 'real spectrum — an FFT of the stream this player is playing, read from the native audio tap';
        this.emit();
      }
    } else {
      this.spectrumZeroPolls += 1;
      if (this.spectrumZeroPolls >= ZERO_POLLS_BEFORE_THEME && this.spectrumLive) {
        this.spectrumLive = false;
        this.modeReason =
          frame.frames > 0
            ? 'the native tap is reading digital silence — the audio itself is silent, so the bars are flat'
            : 'the native tap is running but has not produced a frame yet';
        this.emit();
      }
    }
    // The tap decodes its own copy on its own clock, so it is re-aligned with the player every few
    // seconds: the frame it shows must be the frame coming out of the speaker.
    if (this.clockNow() - this.lastSpectrumResyncAt >= SPECTRUM_RESYNC_MS) {
      this.lastSpectrumResyncAt = this.clockNow();
      await this.resyncSpectrum();
    }
  }

  /** Tear the tap down and build it again — for a consumer that has gone quiet while playing. */
  private restartSpectrum(): void {
    if (this.backend !== 'native' || this.state !== 'playing') return;
    // Through the one stop, so the poll's interval is cleared rather than orphaned.
    this.stopConsumers('re-arming the spectrum tap on the stream the player is playing');
    this.startConsumers();
  }

  /** Line the tap up with the position the audible player reports. */
  private async resyncSpectrum(): Promise<void> {
    const bridge = this.native;
    if (!bridge?.resyncSpectrum || this.backend !== 'native') return;
    await bridge.resyncSpectrum(this.nativeClock());
  }

  /* --------------------------------------------------------- the web audio path */

  /**
   * The Web Audio graph, built only by the browser path and only for it.
   *
   * `source → analyser → gain → destination`, written once and never taken apart: the analyser is
   * always reachable from the destination, so it is always rendered. A graph with no path to the
   * destination is pruned by the engine, and then `getByteFrequencyData()` returns zeros and
   * raises nothing — the silent flatline of v1.7.
   */
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
      // v1.1 dropped this from 0.8 to 0.15; v1.2 finished the job. Every frame is now an
      // independent measurement, and the visualiser adds no ballistics of its own either, so a
      // bar's height is exactly this frame's magnitude.
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -95;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'suspended') {
          this.spectrumLive = false;
          this.modeReason = 'the audio context is suspended — the browser suspends Web Audio when the page is hidden';
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

  private setGraphOutput(audible: boolean): void {
    if (!this.analyserGain) return;
    this.analyserGain.gain.value = audible ? 1 : 0;
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

  /** One analyser frame, and the honesty check on top of it. The web path only. */
  private sample(): void {
    if (!this.analyser || this.backend !== 'web' || this.state !== 'playing') return;
    const freq = this.freq;
    // Clear first. A tainted (cross-origin, no ACAO) analyser has been observed to leave the
    // destination array untouched rather than zeroing it — which would display the previous
    // track's spectrum as if it were live. Clearing makes silence unambiguous.
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
    const frozen = this.identicalFrames >= FROZEN_FRAMES_BEFORE_THEME;

    // Bands above ~10 kHz are usually empty on lossy streams, so loudness is taken over the range
    // a music signal actually occupies.
    const audibleBins = Math.max(1, Math.floor(freq.length * 0.6));
    let audibleSum = 0;
    for (let i = 0; i < audibleBins; i += 1) audibleSum += freq[i];
    this.level = audibleSum / audibleBins / 255;

    if (max > 0 && !frozen) {
      this.zeroFrames = 0;
      if (!this.spectrumLive) {
        this.spectrumLive = true;
        this.modeReason = 'real spectrum — AnalyserNode reading the decoded stream as it plays';
      }
    } else {
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
    if (this.ctx?.state === 'suspended') {
      return 'the audio context is suspended, so the analyser has no samples';
    }
    if (this.graphFailedReason) return this.graphFailedReason;
    return 'the analyser returned silence — a tainted cross-origin stream gives zeroes with no error';
  }

  /**
   * A cross-origin element with `crossOrigin="anonymous"` fails entirely when the server sends no
   * ACAO — playback included, not just sample access. Retry without the flag: audio works, the
   * analyser flatlines, and the UI says why.
   */
  private async retryWithoutCrossOrigin(): Promise<void> {
    const track = this.track;
    if (!track) return;
    const positionMs = this.el.currentTime * 1000;
    this.el.crossOrigin = null;
    this.el.src = track.url;
    try {
      await this.el.play();
      if (positionMs > 0) this.el.currentTime = positionMs / 1000;
    } catch (cause) {
      this.fail(cause);
    }
  }

  private handleMediaError(): void {
    if (this.backend !== 'web') return;
    if (this.el.crossOrigin === 'anonymous' && this.track?.crossOrigin) {
      this.modeReason =
        'the library refused cross-origin sample access for this stream, so the analyser cannot see the audio — playing it anyway, with the album-art theme';
      void this.retryWithoutCrossOrigin();
      return;
    }
    const media = this.el.error;
    this.fail(new Error(media ? `${media.message} (code ${media.code})` : 'the audio element failed to load the stream'));
  }

  private fail(cause: unknown): void {
    this.error = cause instanceof Error ? cause.message : String(cause);
    this.dispatch({ type: 'failure', message: this.error });
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}
