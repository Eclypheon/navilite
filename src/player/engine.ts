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
import { createNativeBridge, BRIDGE_BUILD_TIMEOUT_MS, type NativeBridge, type NativeBridgeEvents, type NativeSpectrumFrame, type NativeTrackInfo } from './native.ts';

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
  /**
   * The session was taken away — a call, Siri, another app.
   *
   * There is one phase and it is the arrival. v1.7.3 also carried a `phase: 'ended'` for "given
   * back", and nothing ever sent it: recovery has always arrived as the player's own `engine-state`
   * report of `playing`, which is the door every other resume comes through. A branch for a signal
   * that is never dispatched is a mechanism the file claims and does not have, so it is deleted
   * rather than left to be trusted by the next reader.
   */
  | { type: 'interruption' }
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
      /*
       * The audio stopped and nobody asked. Only a playing engine is interrupted by it — a report
       * that arrives while we are already still is a non-event, exactly like a stale `engine-state`
       * — and the player's own report of `playing` is the way back out, which is the only route
       * that has ever existed.
       */
      return state === 'playing' ? 'interrupted' : state;
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

/**
 * How close to its duration the native player has to be for a *stopped* report to mean "the track
 * finished" rather than "something took the audio away" (v1.9.0).
 *
 * The player reports its position every ~100 ms while it plays, so the last report of a track that
 * ran to its end is within a report of the duration. Just under a second of slack covers a missed
 * report without ever reaching a *paused* player mid-track — and a track shorter than this window is
 * never judged this way at all (`nativeAtEnd`).
 */
const NATIVE_END_SLACK_MS = 900;

/**
 * How long a transport this engine sent itself may still be reporting back (v1.9.1).
 *
 * Reports that arrive inside the window are describing *our* request — a pause we asked for, a
 * play we asked for — rather than contradicting the state. A load is not covered by this: it has its
 * own bracket (`loadInFlight`), which is exact rather than timed.
 *
 * The window used to be a **counter**, incremented before a transport call and decremented in a
 * `finally`, and a counter is what made the seek variant of it permanent instead of momentary.
 */
const TRANSPORT_MUTE_MS = 1500;
/**
 * The same window for a seek, which is short by nature: the player reports a not-playing state for
 * a moment while it repositions, and nothing longer than this is a seek.
 *
 * This is the fix for the owner's *"using the seek bar seems to disable the playlist from advancing
 * to the next song automatically"*: the window is a deadline now, so a seek whose completion never
 * arrives still closes it.
 */
const SEEK_MUTE_MS = 1500;
/**
 * How long a native seek is allowed to take before the engine gives up waiting on the promise (v1.9.3).
 *
 * AVFoundation seeks can fail to settle (e.g. `finished == false` during rapid scrubs),
 * so a deadline is essential to prevent `this.seekInFlight` from hanging forever.
 */
const SEEK_TIMEOUT_MS = 1500;

/**
 * How long a start has to produce sound before the app says, on screen, that it did not (v1.9.2).
 *
 * This is the end of the road that v1.9.1's bounded calls started: a load whose round trips all
 * answered and whose stream never arrived. Until now the engine took its own optimistic `playing`
 * for an answer, the queue cleared its loading state on it, and the screen claimed to be playing a
 * track that was not — for ever, with the clock pinned at zero. The owner's own words for it are
 * *"even after a minute it doesn't load"*, and nothing on the screen ever said so.
 *
 * The conclusion is now the player's, not the promise's: the first position report for this
 * generation is the evidence that sound exists (`concludeStart('player')`). If fifteen seconds pass
 * without one, the app says so, the queue retries once at the next rung down, and the row waits for
 * a tap. Fifteen is deliberately generous — the owner accepts ~15 s for the first track on mobile
 * data — and it is a *ceiling*, not a target: when the sound arrives at two seconds, that is when
 * the app says `playing`.
 */
const START_DEADLINE_MS = 15000;

/**
 * How far from the offset a start asked for a position report may be and still be that start's
 * (v1.9.2).
 *
 * A start asks for the very beginning of a track, and the item it replaces is still reporting its
 * own position — minutes into the track — while the new one is being fetched. Three seconds is
 * wider than any jitter in a fresh item's first report and far narrower than "the outgoing track".
 */
const START_ANCHOR_SLACK_MS = 3000;

/**
 * A promise that resolves to `fallback` if `work` has not answered within `ms` (v1.9.2).
 *
 * Used for the one thing outside the bridge calls that could still hold a start for ever: building
 * the bridge itself. The timer is always cleared, so a fast answer leaves nothing running.
 */
function withDeadline<T>(work: Promise<T>, fallback: T, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[navilite] ${what} did not answer within ${ms} ms`);
        resolve(fallback);
      }, ms);
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

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
/**
 * How long the engine waits before asking again about a tap that is on the wrong item.
 *
 * v1.8.0 — much shorter than {@link SPECTRUM_RECHECK_MS}, because this is not a tap that is broken,
 * it is a track change: the tap has to be moved onto the item that is now playing, and the bars are
 * dark for exactly as long as that takes. One second is the backstop; the load's own install is the
 * path that gets it right on the first try.
 */
const SPECTRUM_ORPHAN_RECHECK_MS = 1000;
/**
 * How often a tap that has stopped answering is allowed to be *checked* against the player.
 *
 * v1.7.2 armed the tap on the way in and then never looked at it again: if iOS tore the silent
 * `AVPlayer` down while the app was suspended, the tap stayed dead for the rest of the track and the
 * visualiser never came back on its own. That is the owner's *"it somehow automatically switches off
 * the spectrum like it's in native only mode"*. A consumer that goes quiet while the engine is
 * playing is now looked at again, no more than once every five seconds, and it is never simply left
 * off.
 *
 * v1.7.7 — what that look *is* matters, and it is why this is no longer a "restart". It is a verify:
 * one read of the plugin, which finds the audible item and, if that item already carries this tap,
 * writes nothing at all. It only installs when the item is genuinely a different one (the plugin
 * replaced it), which is not a mid-song reconfiguration of audio the listener is hearing.
 */
const SPECTRUM_RECHECK_MS = 5000;
/**
 * How close to the end of a track the tap may report "not playing" without being rebuilt.
 *
 * Kept from v1.7.5, when the tap read a *silent copy* of the stream that finished a beat before the
 * audible player did, so at the end of every track the tap reported `playing: false` while sound was
 * still coming out. v1.7.6 deleted that copy — the tap is on the audible item now, so the two cannot
 * disagree — but the guard stays: the last seconds of a track are still not a dead tap, and treating
 * them as one tore the tap down and emptied the bars to the theme for the last seconds of every song.
 */
const SPECTRUM_NEAR_END_MS = 4000;
/**
 * How many times a dead tap is checked against the player before the app gives up and says so.
 *
 * A tap that will not stay up is not worth a check every five seconds for the length of a track:
 * the third failure is reported, the bars go to the album-art theme, and nothing polls any more.
 * Note that giving up is now *only* a statement about the bars — v1.7.7 leaves the tap installed
 * either way, so the next track starts from a working tap rather than from a rebuilt one.
 */
const MAX_SPECTRUM_RECHECKS = 3;
/**
 * The same non-zero frame for ~1 s is a frozen buffer, not a measurement.
 *
 * v1.1 lowered this from 25 frames (2.5 s): with the analyser running at a near-zero smoothing
 * constant (below), a genuinely live frame differs every single sample, so a repeat is already
 * strong evidence.
 */
const FROZEN_FRAMES_BEFORE_THEME = 10;
const METER_INTERVAL_MS = 100;

/**
 * A cheap fingerprint of one frame of bands.
 *
 * Zero only for a frame that is entirely silent, which is the case the "is it frozen?" question must
 * not confuse with "has it changed?" — silence is already its own answer (the zero-frame counter).
 */
function spectrumChecksum(bands: readonly number[]): number {
  let checksum = 0;
  for (let index = 0; index < bands.length; index += 1) {
    checksum = (checksum + (bands[index] ?? 0) * (index + 1)) % 2147483647;
  }
  return checksum;
}

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
  private lastSpectrumRecheckAt = 0;
  /** The last native frame's fingerprint, and how many polls in a row have repeated it. */
  private lastNativeChecksum = -1;
  private identicalNativeFrames = 0;
  /** Polls in a row where the tap said it was not playing, and how many re-checks that has cost. */
  private spectrumDeadPolls = 0;
  private spectrumRechecks = 0;

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
   * Until when the native player's own reports are *ours* rather than news (v1.9.1).
   *
   * A load is an unload + preload: the outgoing asset stops on purpose, and the plugin reports that
   * stop. It is not a pause the user asked for, and it must not be read as one. The same window
   * covers our own play/pause/resume, whose reports describe the request rather than contradict it.
   *
   * It used to be a **counter**, incremented before a transport call and decremented in a `finally`,
   * and that is what made *"using the seek bar seems to disable the playlist from advancing"*
   * permanent rather than momentary: the plugin resolves `setCurrentTime` only from AVFoundation's
   * own seek completion, so on a seek that reports `finished == false` the `finally` never ran, the
   * counter never returned to zero, and both doors that end a track — the stopped-at-the-end report
   * and the completion — stayed shut for the rest of the session. A deadline cannot leak: it expires
   * whether or not the call ever comes back.
   */
  private reportsMutedUntil = 0;
  /**
   * True from just before a load until it has returned (v1.9.1).
   *
   * A load is an unload + preload: the outgoing asset stops **on purpose**, and the plugin reports
   * that stop. Throughout the load the player is still holding the outgoing item, so a report
   * arriving now is describing our own work, and a question about the tap is a question about the
   * wrong item. This is a bracket rather than a deadline because the load's own length is what the
   * window is, and because a deadline that outlived the load would swallow the *next* honest report —
   * which is exactly what a six-second window did to a track ending a moment after a tap.
   */
  private loadInFlight = false;
  /**
   * The song id sitting in the native **prepared slot**, if any (v1.9.1).
   *
   * The player holds the next track, buffered and silent, under its own asset id — so when that
   * exact track is played from the start, there is nothing to load: the prepared asset is adopted
   * and the first audio arrives in a seek's time instead of after a cold fetch.
   */
  private preparedSongId: string | null = null;
  /**
   * The start in flight, and how it ends (v1.9.2). See {@link START_DEADLINE_MS}.
   *
   * While this is set, `play()` has not resolved: the caller is waiting for the player to say that
   * sound exists. Exactly one of three things resolves it — the player's own first report
   * (`player`), the app leaving the screen with the load still running (`background`: the reports
   * stop arriving, and the return path reads the player rather than guessing), or the deadline
   * (`timeout`, the case the screen has to report).
   */
  private startWait: {
    resolve: (source: 'player' | 'background' | 'timeout' | 'superseded') => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /**
   * Whether the last start ended without sound (v1.9.2).
   *
   * The queue reads this once `play()` has returned: it is the difference between "the stream is
   * playing" and "we asked, and nothing came". A start that failed is retried once at the next rung
   * down by the queue, and if that fails too the screen says so and waits for a tap.
   */
  private startFailed = false;
  /**
   * The offset **this start** was asked for — what tells this track's reports from the outgoing
   * item's.
   *
   * It belongs to the start and to nothing else (v1.9.4): written by `startNative` when the start
   * begins, replaced by the player's own word if that word lands outside the window, and written by
   * no other path — `seek` used to write it, which is a start's own gate being moved by an unrelated
   * transport.
   */
  private startAnchorMs = 0;
  /**
   * The seek in flight, and the newest target that arrived while it was (v1.9.2).
   *
   * A drag writes a value per frame; v1.9.1 sent one seek every 120 ms and let them all overlap, and
   * every one of those is a **zero-tolerance** seek on the plugin's own audio queue
   * (`RemoteAudioAsset.swift`: it settles only when AVFoundation reports the seek finished). Eight
   * overlapping seeks a second is how this app jams the queue that every later transport call —
   * including the boundary's adopt — has to wait behind. One at a time, coalesced to the newest
   * target: the finger's last position is the one that matters and the queue stays free.
   */
  private seekInFlight: Promise<void> | null = null;
  private seekTarget: number | null = null;
  /**
   * Whether the player has actually reported a position for the load in flight.
   *
   * False from the moment a load starts until the player's first `currentTime` report (or a
   * `sync()` read) arrives. Between those two instants nothing is audible — the asset is still
   * being fetched — so the clock shows the offset the load was asked for and stays on it. Without
   * this the displayed position ran from the tap to the first sound, which is the one thing "the
   * clock follows the sound and only the sound" does not allow.
   */
  private positionReported = true;
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

  /**
   * v1.9.0 — whether the track that is playing has already been reported as *finished*.
   *
   * The owner: *"it doesn't seem to automatically go to the next song on my playlist anymore once
   * one song is done. both on mobile and on wifi."* The end of a track has two doors onto it: the
   * player's own event (the bridge's `complete`, the element's `ended`) and — since v1.9.0 — the
   * player's own position when it reports itself *stopped at the end of the item*, which is the
   * reading that survives the event being lost. Whichever arrives first closes this latch, so the
   * queue advances exactly once; it is reopened by the next transition into `playing`, which is
   * what lets `repeat one` hear the same track end again.
   */
  private endedReported = false;

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
      this.reportEnded('the element reached the end of the stream');
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
      /*
       * v1.9.0 — a fresh track (or the same one started again) has not been reported as finished
       * yet. Opening the latch on the transition into `playing` rather than on a load is what keeps
       * `repeat one` honest: the repeat is a seek and a resume of the *same* track, so a latch
       * keyed on the track's identity would swallow the second end of it.
       */
      this.endedReported = false;
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
    this.disarmConsumers(reason);
  }

  /**
   * The track that is playing reached its end — reported once, whichever door it arrives by.
   *
   * The queue is the only thing that may act on this: it owns what "next" means (the play order,
   * the repeat mode, the end of the queue). The engine's whole job here is to say the one true
   * thing exactly once, which is what {@link endedReported} is for.
   */
  private reportEnded(why: string): void {
    const track = this.track;
    if (!track || this.endedReported) return;
    this.endedReported = true;
    this.modeReason = `the track ended — ${why}`;
    this.dispatch({ type: 'track-ended', trackId: track.id });
    this.onEnded?.();
  }

  /**
   * Is the native player sitting at the very end of the item it was given?
   *
   * The player reports its position every ~100 ms while it is playing, so the last report before an
   * item finishes lands within a report of its duration; the slack is a little under two reports and
   * well under a second, so a track shorter than that cannot be judged this way and says so.
   */
  private nativeAtEnd(): boolean {
    const duration = this.durationMs();
    if (duration <= NATIVE_END_SLACK_MS) return false;
    return this.nativePositionMs >= duration - NATIVE_END_SLACK_MS;
  }

  /**
   * The player has said there is sound — and this is the only place a start may be called started
   * (v1.9.2).
   *
   * Two things happen here, and both are the same statement: if the machine is still at `loading`,
   * the player's own report is what moves it to `playing` (nothing else does — the optimistic
   * dispatch that used to be at the top of a load is deleted); and if a caller is waiting on this
   * start, it is released. `background` is not a claim that sound exists: it is the app leaving the
   * screen with the load still running, where the reports stop arriving and the return path reads
   * the player rather than guessing. `timeout` is the only ending that is a failure, and it is the
   * one the screen is told about.
   */
  private concludeStart(source: 'player' | 'background' | 'timeout' | 'superseded'): void {
    if (source === 'player') {
      if (this.state === 'loading') this.dispatch({ type: 'engine-state', playing: true });
      this.startFailed = false;
    }
    const wait = this.startWait;
    if (!wait) return;
    this.startWait = null;
    clearTimeout(wait.timer);
    wait.resolve(source);
  }

  /**
   * Wait for the player's own word that this start has produced sound, or for
   * {@link START_DEADLINE_MS} to run out. Resolved by {@link concludeStart} from anywhere.
   */
  private awaitStart(): Promise<'player' | 'background' | 'timeout' | 'superseded'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.startWait = null;
        resolve('timeout');
      }, START_DEADLINE_MS);
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
      this.startWait = { resolve, timer };
    });
  }

  /**
   * Whether the last start ended without sound (v1.9.2).
   *
   * The queue reads this the moment `play()` returns; it is the difference between "it is playing"
   * and "we asked, and nothing came", which is the difference between a track and a screen that
   * claims one for ever.
   */
  startDidFail(): boolean {
    return this.startFailed;
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

  /**
   * Whether a report arriving from the native player now is likely to be *ours* (v1.9.1).
   *
   * True means: a not-playing report, a pause, or an interruption arriving now is the player
   * describing our own request — a load's unload, a seek's reposition, our own play — and is not news
   * about what the listener asked for. Two sources, and only one of them is timed: a load in flight
   * (a bracket, as long as the load is), and a deadline from a pause, a resume or a seek. The
   * deadline is what the counter used to be — and what could leak.
   */
  private inTransition(): boolean {
    return this.loadInFlight || this.clockNow() < this.reportsMutedUntil;
  }

  /** Open that window for `ms` from now — as far out as any window already running, never shorter. */
  private muteReports(ms: number): void {
    this.reportsMutedUntil = Math.max(this.reportsMutedUntil, this.clockNow() + ms);
  }

  /**
   * Re-base the clock on a position the player actually reported.
   *
   * `reported` is false when the position is one *we* asked for — a load's start offset, or a seek
   * — rather than one the player told us about. Only a real report clears {@link positionReported},
   * so the clock cannot start counting before there is a sound for it to be counting.
   */
  private setNativePosition(ms: number, reported = true): void {
    this.nativePositionMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    this.nativePositionAt = this.clockNow();
    if (reported) this.positionReported = true;
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
    /*
     * Rule 3, added in v1.7.5: it advances only once the player has said where it is. Between the
     * press and that first report the asset is still loading and nothing is audible, so a clock
     * counting from the press counts to no sound — the phantom seconds this invariant exists to
     * forbid. It shows the offset the load was asked for and starts moving on the first report.
     */
    if (this.state !== 'playing' || !this.foreground || !this.positionReported) return this.nativePositionMs;
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
          const ms = seconds * 1000;
          this.setNativePosition(ms);
          /*
           * The player's own position is the evidence that sound exists (v1.9.2) — *this* track's
           * position, that is. The item being replaced keeps reporting for as long as the new stream
           * is still being fetched, and a stale report is not evidence about the item being loaded:
           * what separates them is the offset this start asked for, which no report from a track that
           * is minutes in can be near.
           *
           * **And a report that misses that offset is no longer thrown away (v1.9.4).** This gate was
           * the whole of the owner's *"when a track finishes it switches to native audio mode"*: the
           * anchor is a guess this side makes about where the start begins, the player's report is
           * the fact, and when the fact landed more than {@link START_ANCHOR_SLACK_MS} away from the
           * guess it was discarded — for ever. Nothing re-armed the gate (`awaitStart` was the only
           * other exit and it resolves `timeout` after {@link START_DEADLINE_MS}), so a start whose
           * two paths disagree rested in `loading`: `startConsumers` never ran, the spectrum stayed
           * false, and the bar chip read *native audio* with dead bars while the track was audibly
           * playing. A report arriving while a start is *still waiting* is the player's own word
           * about the item it holds, so the guess is replaced by it and the start is concluded on
           * that report. Outside a wait there is nothing to conclude: the report is an ordinary
           * position report about the item playing, and an anchor can be as stale as it likes.
           */
          if (Math.abs(ms - this.startAnchorMs) <= START_ANCHOR_SLACK_MS) {
            this.concludeStart('player');
          } else if (this.startWait !== null) {
            this.startAnchorMs = ms;
            this.concludeStart('player');
          }
          this.emit();
          this.onProgress?.(this.nativePositionMs, this.durationMs());
        },
        onState: (state, isPlaying) => {
          if (this.backend !== 'native') return;
          /*
           * The end of a track is never "ours" — it is checked *before* the window below (v1.9.1).
           *
           * It used to sit behind the in-transition gate, which was safe only while that gate was a
           * counter that always returned to zero. With the gate decided before the report is read, a
           * track that ran out while a load or a seek was settling was a track whose end was thrown
           * away — and nothing sends that report twice. Reading the end first costs nothing: it is
           * the player saying it stopped with the clock at the end of the item, which no transport of
           * ours produces (`nativeAtEnd`).
           *
           * This is the reading that does not depend on the player's own end event arriving either:
           * the owner's report is *"it doesn't seem to automatically go to the next song on my
           * playlist anymore once one song is done"*, and a queue that only ever hears about the end
           * through one notification is a queue that stops for good the day that notification is
           * late, is dropped by a load in flight, or is never sent. `reportEnded` is idempotent, so
           * if the event does arrive as well, it changes nothing.
           */
          if (state === 'stopped' && this.nativeAtEnd()) {
            this.nativePositionMs = this.durationMs();
            this.reportEnded('the player stopped at the end of the item');
            return;
          }
          // Our own load/play/pause/resume in flight: this report is describing the request.
          if (this.inTransition()) return;
          if (isPlaying) {
            this.dispatch({ type: 'engine-state', playing: true });
            // The audibly-playing item is the player's word that sound exists (v1.9.2).
            this.concludeStart('player');
            return;
          }
          // Not playing and we did not ask it to stop: that is an interruption, not a pause.
          this.dispatch({ type: 'interruption' });
          if (state === 'stopped') this.nativePositionMs = Math.min(this.nativePositionMs, this.durationMs());
        },
        onComplete: () => {
          if (this.backend !== 'native') return;
          /*
           * Never on the back of an asset swap — this is the one event that moves the queue.
           *
           * A completion that arrives while a load is in flight belongs to the asset that is being
           * replaced, so it is still dropped; the derived end above is what covers the case where
           * the *real* completion is the event that goes missing. (The bridge has already dropped
           * every completion belonging to the *prepared* slot, so what reaches here is the audible
           * asset's own.)
           */
          if (this.inTransition()) return;
          this.reportEnded('the player reported the item complete');
        },
      });
      /*
       * The bridge's own build is the one thing outside the bridge calls that could still hold a
       * start for ever (v1.9.2): a plugin that never answers `configure` or an `addListener` left the
       * first tap of a session waiting on a promise that never settled — no fetch, no sound, and no
       * word about either. Ten seconds, and the app carries on without it.
       *
       * `this.nativeReady` keeps the real promise (not the race), so a build that is merely slow is
       * picked up by the next attempt rather than being written off for the session.
       */
      const bridge = await withDeadline(this.nativeReady, null, BRIDGE_BUILD_TIMEOUT_MS, 'the native audio bridge');
      // The lock-screen next/previous are the platform's to deliver; registered as soon as a bridge
      // exists, whether that is this attempt or a later one.
      if (bridge && !this.remoteDetach) {
        this.remoteDetach = bridge.listenRemoteCommands({
          next: () => this.onNextRequested?.(),
          previous: () => this.onPreviousRequested?.(),
        });
      }
      if (!bridge) return null;
      this.native = bridge;
      return bridge;
    }
    const bridge = await withDeadline(this.nativeReady, this.native, BRIDGE_BUILD_TIMEOUT_MS, 'the native audio bridge');
    if (bridge) this.native = bridge;
    return bridge;
  }

  /* ------------------------------------------------------------------- transport */

  async play(track: TrackRequest, startMs = 0): Promise<void> {
    /*
     * The same track, **already playing**, is a second press on the same thing — not a second
     * playback. Nothing is reloaded, nothing is replayed and nothing is re-attached.
     *
     * v1.9.1 — `loading` is no longer part of that condition, and the difference is the owner's
     * *"tapping a row also still does not select it instantly 100% of the time"*. While a load was in
     * flight, a second press on the same row was swallowed here and answered with `emit()` alone: the
     * caller took that as "the engine has it", took its loading state down, and the row settled with
     * no work and no sound. What a press during a load means is "yes, that one" — the load that is
     * already running for that very track, so the play still goes through and the second press
     * changes nothing except that the row stops being drawn as waiting.
     */
    if (this.track?.id === track.id && this.state === 'playing') {
      this.emit();
      return;
    }
    /*
     * Whatever start was waiting for the player is not this one (v1.9.2): its caller is being
     * replaced, and it must not report a failure for a track the listener has already left.
     */
    this.concludeStart('superseded');
    this.startFailed = false;
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

  /**
   * Prepare the track that follows the current one — buffered on the player, silent (v1.9.1).
   *
   * This is the queue's look-ahead, and it is deliberately *data-level*: the same plugin loads it
   * under its own asset id, nobody ever sends that asset `play`, it is not tapped for the spectrum
   * and it is not in this engine's state machine. Nothing here can make a sound, which is what keeps
   * the one-engine rule v1.7.6 set: the second `AVPlayer` that was deleted does not come back, a
   * buffered item that is never played does.
   *
   * A no-op in a browser (where the element's own preload is the whole story) and on a bridge with
   * no prepared slot. It never rejects: a preparation that cannot happen costs a cold fetch at the
   * boundary, which is where v1.9.0 left it — not a failure the listener should see.
   */
  async prepareNext(track: TrackRequest): Promise<boolean> {
    if (!this.nativePlatform) return false;
    if (this.preparedSongId === track.id) return true;
    const bridge = this.native ?? (await this.ensureNative());
    if (!bridge?.prepare) return false;
    /*
     * Claimed before the call, not after: two prepares for the same next track (a tap, then the
     * queue's own start) must not both go out, and the claim is what makes the second one a no-op.
     *
     * v1.9.2 — **and given back when the prepare did not happen.** `bridge.prepare` answers whether
     * the plugin actually took the asset; a prepare that timed out, or that the bridge refused
     * because the listener had already moved on, leaves no prepared track behind, so the claim must
     * not outlive it. That leak is what the owner hit as a track that never came: the slot stayed
     * claimed for a track that was never loaded, the queue then refused to re-prepare it ("already
     * holding exactly this"), and the boundary paid a cold fetch with no word about why.
     */
    this.preparedSongId = track.id;
    const settled = (await bridge.prepare({
      url: track.url,
      title: track.title,
      artist: track.artist,
      album: track.album,
      artworkUrl: track.artworkUrl,
    })) === true;
    if (!settled) this.preparedSongId = null;
    return settled;
  }

  /** Throw the prepared track away — the queue is not going where it was prepared for. */
  async discardPrepared(): Promise<void> {
    this.preparedSongId = null;
    const bridge = this.native;
    if (this.backend !== 'native' || !bridge?.discard) return;
    await bridge.discard();
  }

  /** The song id currently buffered in the player's prepared slot, if any. */
  get preparedId(): string | null {
    return this.preparedSongId;
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
    // A pause the listener asked for is not a start that failed (v1.9.2): the wait ends without a
    // failure being reported for the track he has just stopped.
    this.concludeStart('superseded');
    if (this.backend === 'native') {
      this.dispatch({ type: 'transport', action: 'pause' });
      // A deadline, not a bracket: the window closes whether or not the plugin ever answers.
      this.muteReports(TRANSPORT_MUTE_MS);
      await this.native?.pause();
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
      this.muteReports(TRANSPORT_MUTE_MS);
      await this.native?.resume();
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

  /**
   * Seek — and the one transport that was outside the `inTransition` bracket.
   *
   * `setCurrentTime` repositions the player, and while it does the player reports a not-playing
   * state. That report is *ours* — we asked for the reposition — but nothing said so, so the state
   * listener read it as an interruption: `playing` became `interrupted`, the clock stopped, the
   * spectrum dropped, and the sound needed a tap to come back. A transient report during a seek is
   * the shape of a symptom the owner has reported, and `inTransition` is the bracket load, play,
   * pause and resume are already wrapped in.
   *
   * The position it lands on is one we asked for, not one the player reported, so it does not count
   * as the report that starts the clock (`setNativePosition(…, false)`).
   */
  async seek(positionMs: number): Promise<void> {
    if (this.backend === 'native') {
      /*
       * **One seek in flight, and the newest target wins (v1.9.2).**
       *
       * A drag writes a value per frame and v1.9.1 sent one seek every 120 ms, all of them
       * overlapping. Each of those is a zero-tolerance seek on the plugin's own audio queue — it
       * settles only when AVFoundation reports the seek finished — so a drag was eight blocking
       * seeks a second on the very queue that every later transport call has to wait behind,
       * including the adopt at a track boundary. A finger on the bar could therefore stall the
       * queue's own advance, which is the shape of the owner's *"it took around 40s to load"*.
       *
       * What the listener means is where his finger *is*, not every position on the way there, so a
       * seek that arrives while one is running is remembered and issued when the running one has
       * answered — or when its own deadline (SEEK_TIMEOUT_MS) has, which is what keeps this from
       * becoming a new way to wait for ever.
       */
      if (this.seekInFlight) {
        this.seekTarget = positionMs;
        await this.seekInFlight;
        return;
      }
      const run = (async () => {
        this.generation += 1;
        /*
         * **The anchor belongs to a start, and a seek is not one (v1.9.4).**
         *
         * This line used to write `startAnchorMs` — the field a *start's* own gate reads — so a seek
         * that landed while a start was settling moved the window out from under the report that
         * start was waiting for, and the start was declared failed while the track was audibly
         * playing. Where the player is after a seek is not a starting anchor: no start is waiting on
         * one, and a report that arrives while one *is* waiting now re-anchors itself
         * (`onPosition`).
         */
        this.muteReports(SEEK_MUTE_MS);
        if (this.native) {
          await withDeadline(this.native.seek(positionMs / 1000), undefined, SEEK_TIMEOUT_MS, 'native.seek');
        }
        this.setNativePosition(positionMs, false);
        this.emit();
      })();
      this.seekInFlight = run;
      try {
        await run;
      } finally {
        if (this.seekInFlight === run) this.seekInFlight = null;
      }
      const newest = this.seekTarget;
      this.seekTarget = null;
      if (newest !== null && newest !== positionMs) await this.seek(newest);
      return;
    }
    if (Number.isFinite(this.el.duration)) this.el.currentTime = Math.max(0, positionMs / 1000);
    this.emit();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.concludeStart('superseded');
    this.seekInFlight = null;
    this.seekTarget = null;
    this.el.pause();
    this.el.removeAttribute('src');
    this.track = null;
    // Nothing is playing, so nothing is prepared for it either (v1.9.1).
    this.preparedSongId = null;
    this.setNativePosition(0);
    this.nativeDurationMs = 0;
    this.dispatch({ type: 'cleared' });
    void this.native?.stop();
    void this.native?.discard?.();
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
      /*
       * A start that was still waiting for the player's word ends here (v1.9.2) — but not as a
       * failure. Off screen the reports stop arriving, so the wait could only ever end in a timeout
       * the listener would be told about on the way back for a track that may be playing perfectly;
       * the return path reads the player itself (`sync`) and settles it from the truth.
       */
      this.concludeStart('background');
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
      if (truth.playing) {
        this.dispatch({ type: 'engine-state', playing: true });
        // The player's own answer for the audible item: sound exists (v1.9.2).
        this.concludeStart('player');
      } else if (this.state === 'playing') {
        this.dispatch({ type: 'interruption' });
        this.modeReason = this.wasPlayingBeforeHide
          ? 'the track was playing when the app left the screen and the player is not playing now — one tap on play starts it again from here, and nothing was written to the player to get there'
          : 'the player is not playing';
      } else this.dispatch({ type: 'engine-state', playing: false });
    } else if (this.state === 'playing') {
      // The player would not answer. Never leave a "playing" on screen that no tap can act on.
      this.dispatch({ type: 'interruption' });
    }
    if (this.state === 'playing') {
      /*
       * The state did not change (the player was playing all along), but the web view was suspended
       * and its timers went with it: the clock ticker is re-armed unconditionally. The spectrum is
       * *verified*, not rebuilt — v1.7.6 detached and re-installed here, on a player that had been
       * rendering the whole time the app was away, and that reconfiguration is audible. The tap
       * outlived the suspension just as it outlives a pause, so all this needs is one read that
       * confirms it is still on the item (see {@link verifySpectrum}).
       */
      this.startClockTick();
      if (truth?.playing && stateBefore === 'playing' && this.backend === 'native') this.verifySpectrum();
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
    // A new track is a fresh budget for a tap that will not answer. (v1.7.7: a *budget*, not a
    // rebuild — the tap on the previous item is left where it is and the new item gets its own.)
    this.spectrumRechecks = 0;
    this.modeReason =
      'native playback (AVFoundation / ExoPlayer) — this is the engine that keeps going when you leave the app and the one the lock screen drives; the spectrum is an FFT of the same stream, read from the native audio tap';
    // A load is an unload + preload: the outgoing asset's stop must not be read as a track ending,
    // and until the load has returned the player is still on the outgoing item — so both the
    // report gate and the tap's verify are closed for exactly that long, and no longer.
    this.loadInFlight = true;
    const generation = this.generation;
    // Nothing is audible yet: the clock holds the offset until the player reports a position.
    this.positionReported = false;
    /*
     * **No optimistic `playing` any more (v1.9.2).**
     *
     * This used to dispatch `transport play` here, before a single byte had been fetched — which is
     * how the screen came to claim a track that was not playing, for ever, with the clock pinned at
     * zero. The state stays `loading` (dispatched by `play`'s own `select`) until the player reports
     * sound, and that report is what moves it (`concludeStart('player')`).
     */
    this.startAnchorMs = Math.max(0, startMs);
    /*
     * **The boundary: this track was already prepared, so there is nothing to load (v1.9.1).**
     *
     * The queue keeps the track after the current one in the player's *other* asset — buffered,
     * silent, never played. When that track is the one being started, and from its start, the
     * prepared asset is adopted: it is already the audible asset, with an item AVFoundation has been
     * filling since the previous track began. That is the whole of "autoplay after a track ends is
     * instant": at a track boundary the app is not fetching anything, it is switching a pointer,
     * because the whole length of the previous track was available to get ready.
     *
     * Deliberately narrow: only when the id matches and the position is the very start. A resume
     * mid-track, a different track, or a bridge with no prepared slot all fall through to the load
     * below, which is exactly v1.9.0's behaviour.
     */
    const adoptable = startMs === 0 && this.preparedSongId === track.id && typeof bridge.adopt === 'function';
    let adopted = false;
    try {
      if (adoptable) {
        adopted = (await bridge.adopt?.()) === true;
        // Whichever way it went, the slot is not this track's to use again: adopted it is audible,
        // not adopted it is unknown, and the next prepare will fill it afresh.
        this.preparedSongId = null;
      }
      if (!adopted) {
        await bridge.load(track);
        /*
         * **The guard the review found missing: two rapid plays of two different tracks race here.**
         *
         * Every track is loaded into the audible slot (`native.ts`), so two loads in flight are two
         * unload/preload/play cycles on the same slot — and the slower one used to send its `play`
         * *after* the faster one's, leaving the older track audible while the UI showed the newer
         * one. A load is tens of milliseconds of round trips in the fake bridge and a network fetch
         * on a phone: long enough to tap a second row inside it.
         *
         * The check is `this.track`, not the raw generation. `generation` is bumped by a seek and by
         * a pause as well, and neither of those means "this load is stale" — a seek during a load
         * must not cancel the play that is coming. What makes a load stale is that the *selection*
         * has moved on, and then the play is dropped, so the player is left playing exactly the track
         * the app says is playing.
         */
        if (this.track !== track) return;
        await bridge.play(startMs / 1000);
      }
      /*
       * v1.8.0 — the tap is installed **now**, on the item the player is on.
       *
       * v1.7.7 installed it from the `playing` transition instead, which fires *before* this load:
       * `bridge.load` is what unloads the old asset and preloads the new one, so at that moment the
       * player still held the *outgoing* item and the plugin's `attach` — which verifies against the
       * item it is already on — reported success without touching anything. The tap then stayed on
       * the item the player had left, and nothing re-armed it on the new one: the bars froze on the
       * previous song until a pause/resume.
       *
       * v1.9.1 — **after** the play call, not before it. The plugin's install runs on the main
       * thread, and on an item whose track list is not built yet it has to learn the track from the
       * network; putting that in front of `bridge.play` held the very call that makes the sound
       * behind it. So: the track starts, and the tap follows it — the time from "the item is the new
       * one" to "the new item is playing" is now nothing at all.
       */
      this.attachSpectrum(track);
    } catch (cause) {
      this.fail(cause);
    } finally {
      // The load is over: reports arriving from here on are news again, and the tap can be checked.
      this.loadInFlight = false;
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
    /*
     * **And now the start has to be *proved*, or the app says it did not happen (v1.9.2).**
     *
     * Every round trip above can have answered perfectly and the stream still not be coming: what
     * that produces, without this wait, is a screen that says `playing`, a clock at zero and no
     * sound — for ever, and with nothing to tell the listener why. The evidence is the player's own
     * first report for this track (`concludeStart('player')`, from `onPosition`/`onState`), and the
     * end of the wait is either that or {@link START_DEADLINE_MS}.
     *
     * A start that ran out of time is reported, not hidden: the queue sees it (`startDidFail`),
     * retries once at the next rung down, and if that fails too the screen carries the failure until
     * a tap. Never a transport that says playing while nothing sounds.
     */
    if (this.state !== 'loading') return;
    const outcome = await this.awaitStart();
    if (this.track !== track) return;
    if (outcome === 'timeout') {
      this.startFailed = true;
      this.modeReason = 'the track did not start in time — tap it again to try once more, and the app will ask for a smaller stream';
      this.dispatch({ type: 'failure', message: 'the track did not start in time' });
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
    this.nativeBands = null;
    this.spectrumZeroPolls = 0;
    this.spectrumPolls = 0;
    this.spectrumLive = false;
    this.lastNativeChecksum = -1;
    this.identicalNativeFrames = 0;
    /*
     * Start reading **now**, not when the plugin says it has started.
     *
     * A frame that is not live yet is exactly what the zero-poll counter is for, and it costs nothing
     * to start reading first: it is what makes the first real frame appear the moment the tap has one,
     * rather than one poll later.
     */
    this.spectrumPoll = setInterval(() => void this.pollSpectrum(), SPECTRUM_POLL_MS);
    this.lastSpectrumRecheckAt = this.clockNow();
    /*
     * v1.8.0 — no install from here.
     *
     * v1.7.7 called `startSpectrum` from this transition, which fires *before* `bridge.load`: the
     * plugin's `attach` was then asked about the item the player still had — the outgoing one — and,
     * because it verifies an item that already carries this tap, it answered "yes" without touching
     * anything. The new item was left untapped. The install now happens in `startNative` once the load
     * has resolved (`attachSpectrum`). What is left here is the *verify* a resume and a return from
     * the foreground need — and the gate is the load itself, not the report window: a pause or a
     * resume has nothing to do with which item the player is on, and gating this on their window
     * meant a resume a moment after a pause could not confirm the tap it already had (v1.9.1).
     */
    if (!this.loadInFlight) this.verifySpectrum();
    void this.pollSpectrum();
  }

  /**
   * Disarm the visualiser, because the engine is not playing any more.
   *
   * `paused`, `ended`, `interrupted`, `error`, `idle`: the spectrum is a picture of what is being
   * heard, and nothing is. Note what is *not* here — there is no call to the native tap at all, and
   * that absence is v1.7.7's whole point.
   *
   * v1.7.6 called `stopSpectrum` from here, so leaving `playing` took the audio mix off the player's
   * item; the resume then put a new mix back on a player that was already rendering, which is an
   * audible reconfiguration of the audio pipeline — the owner's *"a short pause"* in the middle of a
   * song, immediately before the bars came back. The tap is now installed for the life of the item and
   * outlives every one of these states. The bars settle to zero because the engine has no frame to
   * hand the canvas (the visualiser's own release envelope), not because anything was taken apart.
   */
  private disarmConsumers(reason: string): void {
    if (this.spectrumPoll !== null) {
      clearInterval(this.spectrumPoll);
      this.spectrumPoll = null;
    }
    this.stopMeter();
    this.nativeBands = null;
    this.spectrumZeroPolls = 0;
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
    /*
     * The tap is on an item the player has moved off — v1.8.0.
     *
     * The plugin reports which item it is tapped on (`itemIsCurrent`: the item the tap holds against
     * `player.currentItem`), and that is the signal the v1.7.7 recheck was *trying* to read: it was
     * gated on `frame.playing`, which is the **player's** answer, and the player is playing the new
     * track throughout the swap — so the orphan it was written for could never fire. A track change
     * left the bars frozen on the previous song's last frame (or on the theme) until a pause/resume.
     *
     * Nothing is drawn while this is true: the previous song's last frame is not a measurement of
     * this one. The tap is re-attached to the item the player is on now, no more often than
     * {@link SPECTRUM_ORPHAN_RECHECK_MS} — and, in the normal case, the load has already installed it
     * (see `attachSpectrum`), so this is only ever the backstop.
     */
    if (frame.itemIsCurrent === false) {
      this.nativeBands = null;
      this.spectrumDeadPolls = 0;
      if (this.spectrumLive) {
        this.spectrumLive = false;
        this.modeReason = 'the tap is on the item the player has moved off — re-attaching it to the track that is playing';
        this.emit();
      }
      if (this.clockNow() - this.lastSpectrumRecheckAt >= SPECTRUM_ORPHAN_RECHECK_MS) this.verifySpectrum();
      return;
    }
    const playing = this.state === 'playing' && frame.playing;
    if (!playing) {
      /*
       * The last seconds of a track are not a dead tap: the silent copy ends slightly before the
       * audible one, and rebuilding on that report is what dropped the bars exactly when the song
       * was finishing. Near the end the last real frame is held — no rebuild, no theme, no flicker.
       */
      if (this.nearTrackEnd()) {
        this.spectrumDeadPolls = 0;
        return;
      }
      this.spectrumLive = false;
      /*
       * The tap has gone quiet while the engine is playing. There is no silent copy to be torn down
       * any more; the honest causes are a tap that was never installed on *this* item (the plugin
       * replaced its item and the mix went with the old one) and a stream that is genuinely silent.
       * So the tap is *verified* — one read of the plugin, which writes nothing when the item already
       * carries this tap — rather than detached and rebuilt, which is what put an audible gap in the
       * middle of a song. A tap that will not stay up is not re-checked for ever:
       * {@link MAX_SPECTRUM_RECHECKS} checks, then the theme and one honest sentence.
       */
      if (this.state !== 'playing') {
        this.spectrumDeadPolls = 0;
        return;
      }
      this.spectrumDeadPolls += 1;
      if (this.spectrumDeadPolls < ZERO_POLLS_BEFORE_THEME) return;
      if (this.clockNow() - this.lastSpectrumRecheckAt < SPECTRUM_RECHECK_MS) return;
      if (this.spectrumRechecks >= MAX_SPECTRUM_RECHECKS) {
        this.spectrumDeadPolls = 0;
        this.disarmConsumers('the spectrum tap would not stay up on this stream — the bars are on the album-art theme, and the audio is untouched');
        this.emit();
        return;
      }
      this.spectrumRechecks += 1;
      this.verifySpectrum();
      return;
    }
    this.spectrumDeadPolls = 0;
    this.nativeBands = Uint8Array.from(frame.bands);
    if (frame.live) {
      this.spectrumZeroPolls = 0;
      // A tap that has produced real frames has proved itself: the re-check budget starts again.
      this.spectrumRechecks = 0;
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
    /*
     * The same frame over and over is not a measurement — v1.8.0, and the same rule the web path has
     * had since v1.1 (see `sample()`).
     *
     * The native path trusted `frame.live`, which is the *tap's* own opinion that it is producing
     * something. A tap that is alive but stuck on one buffer — the shape an orphaned one produces
     * when the player it is listening to has moved on — would otherwise be drawn as if it were the
     * new song, which is the owner's "it is not showing... it is showing the last song" family. An
     * identical, non-silent frame ten polls in a row is a frozen buffer, not an audio signal.
     */
    const checksum = spectrumChecksum(frame.bands);
    const identical = checksum !== 0 && checksum === this.lastNativeChecksum;
    this.lastNativeChecksum = checksum;
    this.identicalNativeFrames = identical ? this.identicalNativeFrames + 1 : 0;
    if (this.identicalNativeFrames >= FROZEN_FRAMES_BEFORE_THEME && this.spectrumLive) {
      this.spectrumLive = false;
      this.modeReason = 'the native tap kept returning the same frame, which is not a measurement — showing the album-art theme';
      this.emit();
    }
  }

  /**
   * True when the audible player is within {@link SPECTRUM_NEAR_END_MS} of the end of its track.
   *
   * Judged on the displayed position, which is the player's own position: the question is whether
   * the *listener* is at the end of the song, not whether some other clock has run out.
   */
  private nearTrackEnd(): boolean {
    const duration = this.durationMs();
    if (duration <= 0) return false;
    return this.nativeClock() >= duration - SPECTRUM_NEAR_END_MS;
  }

  /**
   * Confirm the tap is still on the player, and re-arm the poll if the web view let it die.
   *
   * v1.7.7 — this replaces v1.7.6's `restartSpectrum`, which disarmed and then re-armed, i.e. called
   * `stopSpectrum` (mix off the item) and then `startSpectrum` (a new mix on a playing item). That
   * detach-then-install pair is the family of path the card names as the bug: it is what made the
   * bars vanish until a whole new track was loaded, and the reconfiguration it performed on a
   * rendering item is what the owner heard as *"a short pause"*.
   *
   * Nothing here detaches. `startSpectrum` reaches the plugin's `start`, which finds the audible
   * player and calls `attach`, which **verifies** an item that already carries this tap — no mix
   * written, no tap created — and only installs when the item is genuinely a different one, i.e. a
   * new load, which is the one moment a tap can be installed without touching audio being rendered.
   * So a resume, a return from the background and a dead-poll retry are all cheap reads that cannot
   * make a sound. Idempotent, and safe while the tap is already healthy.
   */
  private verifySpectrum(): void {
    if (this.backend !== 'native' || this.state !== 'playing') return;
    const bridge = this.native;
    const track = this.track;
    if (!bridge?.startSpectrum || !track) return;
    this.lastSpectrumRecheckAt = this.clockNow();
    if (this.spectrumPoll === null) {
      /*
       * The poll itself died — the web view was suspended long enough that its timers went with it.
       * Arming it again is the recovery, and it reaches the plugin's verify on its own.
       */
      this.startConsumers();
      return;
    }
    /*
     * The poll is alive, so what needs confirming is the *tap*: exactly one call, which is a read
     * unless the item has been replaced under us.
     */
    void bridge.startSpectrum(track.url, this.nativePositionMs).catch(() => undefined);
  }

  /**
   * Put the tap on the item a load has just put in place, and say so if it will not go.
   *
   * v1.8.0 — this is the install, and it is the only place a load installs. `bridge.load` has
   * resolved, so the player's current item is the new one and the plugin's `attach` — which verifies
   * an item that already carries this tap and installs on any other — lands on the item that is
   * about to be heard. Called after a load and nowhere else; a resume reaches the same plugin method
   * through {@link verifySpectrum}, where it is a verify.
   */
  private attachSpectrum(track: TrackRequest): void {
    const bridge = this.native;
    if (this.backend !== 'native' || !bridge?.startSpectrum) return;
    void bridge
      .startSpectrum(track.url, this.nativePositionMs)
      .then((started) => {
        if (this.track !== track || this.backend !== 'native') return;
        if (started) return;
        this.modeReason = 'the native spectrum tap did not start, so the bars are on the album-art theme';
        this.emit();
      })
      .catch((error: unknown) => {
        if (this.track !== track) return;
        this.spectrumLive = false;
        this.modeReason = `the native spectrum tap failed (${error instanceof Error ? error.message : String(error)})`;
        this.emit();
      });
  }

  /**
   * Line the tap up with the position the audible player reports.
   *
   * v1.8.0 — deleted, with the `resync` plugin method behind it. The tap is *on* the player that is
   * heard, so its clock and the player's are one clock: `driftMs` was answered `0` unconditionally,
   * which made this a bridge round trip twelve times a minute that corrected nothing.
   */
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
