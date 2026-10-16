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
import { createNativeBridge, BRIDGE_BUILD_TIMEOUT_MS, type NativeBridge, type NativeBridgeEvents, type NativePlaybackFacts, type NativeSpectrumFrame, type NativeTrackInfo } from './native.ts';

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

/** One entry of the queue as the **queue** publishes it to the engine (v1.9.9). */
export interface PublishedTrack {
  songId: string;
  /** The track's own file — never a capped or transcoded variant. */
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

/**
 * The queue, published to the engine and thence to the native side (v1.9.9).
 *
 * This is the whole of the boundary now. v1.9.8 stated "the two warm tracks after the one playing",
 * which was the app's *look-ahead* rather than its queue: a chain built in JavaScript, never
 * refilled while JavaScript is suspended, and therefore something the music could run out of. What
 * is stated here instead is the resolved play order — every entry, in the order it will be played —
 * the position playing now, and the rules. The native side walks it, and an entry it holds no slot
 * for is one it fetches itself.
 */
export interface QueueStatement {
  list: readonly PublishedTrack[];
  /** Position in `list` of the track playing now, or -1 when nothing is. */
  index: number;
  repeat: 'off' | 'all' | 'one';
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
  /**
   * True while a native track is playing and the engine has **no answer from the tap for this item
   * yet** (v1.9.6, narrowed in v1.9.24) — the window in which `spectrum` is false and the spectrum
   * is not lost.
   *
   * The chip needs three words, not two. `spectrum` is false for a fraction of a second at every
   * track change, until the track that was handed over to produces its first live frame, and calling
   * that window *native audio* is the owner's report word for word — the words this release exists to
   * take off the screen. This flag is the fact that tells the two apart: the tap is on the item the
   * player is playing and has not answered for it yet.
   *
   * **v1.9.24 — and it may only be spent on such a fact, about this item.** The writers that ended it
   * on a *clock* are gone (see `ZERO_POLLS_BEFORE_THEME`): what ends it now is this item's tap
   * producing its own frames (live, silent or frozen — the answers a tap can give about this track),
   * or a build with no tap at all. A tap that is late, refused, or still on the item the player has
   * left keeps the third word, with `modeReason` naming that state, because the alternative is the
   * capability claim the owner was reading at every track change.
   */
  spectrumArming: boolean;
  modeReason: string;
  positionMs: number;
  durationMs: number;
  error: string | null;
  nativeAvailable: boolean;
  /**
   * The last `playbackState` the **plugin** reported, verbatim (v1.9.5), as
   * `state · reason · position/duration s` — or null when nothing has reported.
   *
   * `modeReason` is what the *app* decided; this is what the phone said, and the two side by side
   * are what settle a boundary failure on the device instead of in a guess. Three rounds of
   * diagnosis were made without either one reaching the screen.
   */
  pluginState: string | null;
  /** What the boundary's adoption did: 'adopted', 'nothing prepared', 'play refused (…)', 'timed out' (v1.9.5). */
  adoptOutcome: string;
  /** Events the bridge discarded itself, by reason (v1.9.5) — filtered as inaudible, or inside a slot write. */
  droppedEvents: { inaudible: number; slotGrace: number };
  /**
   * The tracks the player is holding warm, oldest first (v1.9.5).
   *
   * The previous song and the next two, by id. On the screen because "instant" is a claim about this
   * list: a boundary that paid a cold fetch is a boundary where the track it moved to was not on it,
   * and three rounds of diagnosis were made without that fact ever being visible.
   */
  warmedIds: string[];
  /**
   * The native player's own boundary, as the bridge reports it (v1.9.8).
   *
   * `armed` is how many slots the native side is ready to play **by itself** — zero whenever the
   * app is on screen (the web layer owns the boundary then, see `armBoundary`), whenever nothing is
   * warm ahead, and whenever the platform has no such plugin. `advances` counts the tracks it
   * actually took, `failures` the ones it could not, and `ignored` the item-ends that were not
   * about the slot the app told it was playing. `reason` names, in one sentence, which of those
   * states it is in — the clearing path for every one of them.
   */
  nativeBoundary: { armed: number; advances: number; failures: number; ignored: number; reason: string };
  /**
   * The tap's own numbers, for the reason line (v1.9.25).
   *
   * This defect has been diagnosed from source three times and reproduced on the owner's phone every
   * time, and until now the app has never rendered a single fact about the tap itself: the chip says
   * *spectrum…* or *native audio*, and the sentence behind it was written by the engine's own reading
   * of a register. These are the four numbers that separate the states, all of them already computed
   * somewhere — how many frames this item's tap has produced, how many frames the plugin has produced
   * for that item, how often it installed versus verified a tap, and which slot it says the tap is on
   * against the slot this bridge is playing. Nothing here is a decision; the screen is where they are
   * read, and it is the only place the difference between *"the tap is on another player"* and *"the
   * tap is on this one and measures nothing"* has ever been visible.
   */
  tap: {
    /** Frames this item's tap has produced, as the engine could attribute them — see `noteTapFrames`. */
    framesForItem: number;
    /** The plugin's process-lifetime frame counter, as of the last frame read (null before any). */
    pluginFrames: number | null;
    /** The plugin's counter **for the item its tap is on** — what `framesForItem` reads when present. */
    pluginItemFrames: number | null;
    /** Taps *installed* and taps *verified*, as the plugin counts them (null if it does not say). */
    installs: number | null;
    verifies: number | null;
    /** The slot the plugin says the tap is on, and the slot this bridge is playing. */
    tapped: string | null;
    audible: string | null;
    /**
     * The pace the drawing rule is judged on, as the plugin declares it for this item (v1.9.26):
     * `maxFrames` from `prepare` over the sample rate, floored by the tap's own FFT hop — and how old
     * the frame it is holding is, on the plugin's clock.
     *
     * This is the pair the SEND BACK of `2e1eb9d` was about: the rule blanked the bars whenever the
     * counter had not moved since the previous read, which is true on two reads in three of a healthy
     * tap if AVFoundation hands it 4096-frame buffers. Printed here because the *real* number is a
     * fact about his phone and no build has ever shown it — and null on a bridge that does not publish
     * the pace, which is the state the v1.9.25 rule still governs.
     */
    framePeriodMs: number | null;
    frameAgeMs: number | null;
  };
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
 * How long the engine waits, after a seek, for the **player's own word** on where it is now
 * (v1.9.13).
 *
 * A seek is two statements, and until v1.9.13 the engine only ever made the first one: it asked the
 * player to move and then wrote the position it had asked for into the clock as if the move had
 * happened. The bar therefore carried the request — *"on the seek line it shows as if it's playing
 * from where i released it"* — while the item went wherever it actually went. This is the deadline on
 * the second statement (`sync()`), which is three plugin calls the player answers immediately or not
 * at all; a second is more than they take, and a read that does not answer must not be able to hold
 * `seekInFlight` open, because that is what would take the seek bar away from the listener.
 */
const SEEK_VERIFY_TIMEOUT_MS = 1000;
/**
 * How far from the position that was asked for the player's own answer may sit and still be *that*
 * seek (v1.9.13).
 *
 * AVFoundation lands on the nearest frame it can render, and the app asks in whole tenths of a
 * second, so a seek that worked comes back within a frame or two of the request. Anything further
 * than this is a different statement — the sound is somewhere else and the bar must say so rather
 * than the request.
 */
const SEEK_VERIFY_SLACK_MS = 1500;

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
 *
 * **v1.9.24 — the input this is judged on is this item's frames, not the process's.** `frames` as
 * the plugin sends it counts for the life of the app process, so on every track after the first
 * one that ever produced a frame, a tap that has produced *nothing* for the item playing now used
 * to be read as "this item is digitally silent" (see {@link AudioEngine.noteTapFrames}).
 *
 * **And the rule that replaced the budget that stood here.** This file used to bound its own
 * patience (`MAX_SPECTRUM_RECHECKS = 3`, `SPECTRUM_SLOW_POLL_MS`) and spend that budget as a
 * *verdict*: three failed re-checks, a 5 s slow poll, and the chip said *native audio* for the rest
 * of the track. That is a capability claim made out of a clock, and it is the defect this release
 * removes — a track whose audio can be analysed must not lose its bars because a stopwatch ran out.
 *
 * What may end the chip's third word while a native track is playing is a fact about the tap that
 * is on the item playing **now**: this item's own frames, or a build with no tap at all. A tap that
 * is late, refused or on an item the player has left is re-asked — on the player's own item,
 * rate-limited — and the engine keeps saying the spectrum is coming, with the reason line naming
 * the state it is in.
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
 * How recently a player report has to have arrived for the clock tick to skip its own redraw (v1.9.7).
 *
 * The player reports its position roughly every 100 ms, and every one of those reports already
 * redraws the screen through `emit()`. The tick is there so the clock keeps moving when nothing else
 * is arriving — it is not a second repaint on top of reports that are. A tick that lands within this
 * window of the player's own word does nothing but the end-of-track check.
 */
const CLOCK_TICK_QUIET_MS = 250;
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
 * How close to the item's own end the clock has to sit to count as *pinned* there (v1.9.5).
 *
 * Much narrower than {@link NATIVE_END_SLACK_MS}: this is not "the last second of a track", it is
 * "the clock has stopped moving because the player stopped playing", and the position it has
 * stopped at is the end of the item because `nativeClock` clamps there while `playing`.
 */
const PINNED_END_SLACK_MS = 250;
/**
 * How long the clock has to sit pinned at the end, with no live frame, before the app calls the
 * track over by itself (v1.9.5).
 *
 * This is the last door onto the end of a track, and it exists because every other one is a
 * message from the plugin: the vendored player's own completion fires only on an exact
 * `currentTime == duration` (see the tap's own notes), and a message that is never sent cannot be
 * waited for. Two seconds of a clock that has stopped at the end of the item, while the tap is
 * producing nothing, is not a track that is playing.
 */
const PINNED_END_HOLD_MS = 2000;
/**
 * v1.9.24 — **the slow poll that stood here is deleted, with the budget that drove it.**
 *
 * `SPECTRUM_SLOW_POLL_MS` (5 s) was the second half of `MAX_SPECTRUM_RECHECKS`: once three re-checks
 * had failed, the reads slowed down and the chip said *native audio* for the rest of the track. The
 * counts it was spent on were real facts — a tap on the wrong item, a tap reporting a player that is
 * not playing — but spending them as a *capability* verdict is the defect this release removes, and
 * a read that drops to one every five seconds is also five seconds of dark bars after a tap that
 * recovers. Both states are now re-asked, on the player's own item, with the reads left where they
 * are (one at a time, at {@link SPECTRUM_POLL_MS}) so a tap that comes back is drawn on the next
 * frame rather than up to five seconds later.
 */
/**
 * How many tracks are warm on the player at once (v1.9.5): the previous song and the next two.
 *
 * The owner's own rule (*"after any selection the app must commence prefetching/caching the previous
 * song and the NEXT TWO songs, so stepping back or forward is instant"*), and it is three because
 * the bridge has exactly three slots that are not the one being heard — the bound is structural, not
 * a budget that a long session can spend. This is only the engine's side of it (the claims); the
 * number that matters on the device is the bridge's slot pool, and the two are the same number by
 * construction.
 */
const MAX_WARM_TRACKS = 3;
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
 * The bitrate a stream URL asks Navidrome for, as a word (v1.9.8).
 *
 * Used in one sentence only — the boundary's account of a warm asset that is not the stream the
 * play request asks for — and it exists because "a different stream" was not enough to tell a rung
 * move from a re-created client, which is what the sentence has to distinguish.
 */
function askedRate(url: string): string {
  const match = /[?&]maxBitRate=(\d+)/.exec(url);
  return match ? `${match[1]} kbps` : 'the original file';
}

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
  /**
   * The other half of {@link spectrumLive} (v1.9.6): see {@link EngineStatus.spectrumArming}.
   */
  private spectrumArming = false;
  private modeReason = 'nothing playing yet';
  private nativeBands: Uint8Array | null = null;
  private spectrumPoll: ReturnType<typeof setInterval> | null = null;
  /**
   * True while one poll's read of the tap is still in flight (v1.9.22) — see {@link pollSpectrum}.
   *
   * The poll is a `setInterval`, so a bridge that answers more slowly than {@link SPECTRUM_POLL_MS}
   * used to have several reads out at once and no order between their answers: a frame about the
   * item the player had just left could be applied *after* one about the item it moved to, clear
   * `spectrumLive`, rewind the zero-poll budget and hand the visualiser nothing — `spectrum off`
   * with audio playing. One read at a time is the whole fix for that class.
   */
  private spectrumReadInFlight = false;
  /**
   * The track the tap has already been re-attached for after the plugin reported it was on an item
   * the player had left (v1.9.22) — see the orphan branch of {@link pollSpectrum}.
   *
   * The first sighting of an orphan *for a track* is a transition that landed while the previous
   * attach was still in flight, and it is answered immediately; the repeats are rate-limited, as
   * they always were.
   */
  private orphanReattachedFor: string | null = null;
  /** The serial of the newest install request, so a superseded one cannot answer for this track. */
  private spectrumInstallSerial = 0;
  /** What the newest install request has answered, and whether it has answered at all (v1.9.22). */
  private spectrumInstall: { track: TrackRequest; serial: number; answered: boolean; ok: boolean } | null = null;
  private spectrumZeroPolls = 0;
  /**
   * **Frames the tap has produced for the item playing now (v1.9.24) — the per-item fact.**
   *
   * `NativeSpectrumFrame.frames` is the tap's own counter *since it started* (`NaviliteSpectrum`'s
   * `frames += 1` in `analyze()`, reset by nothing: `detach()` and `unprepare()` both leave it), so
   * it describes the app process's life rather than the track's. Reading it as "this item's tap has
   * answered" is the defect this release fixes: from the second track onward a tap that has produced
   * **nothing** for the new item is judged to have answered *digital silence* 12 polls in, and the
   * chip goes to *native audio* while the attach is still in flight.
   *
   * **v1.9.25 — and the plugin now sends the count itself (`itemFrames`), so this is that number when
   * the build has one** (see {@link noteTapFrames}): the same reading, taken from a counter that is
   * per item by construction rather than inferred from deltas of a process-wide one. Either way it
   * can only ever *under*-count; it cannot make another item's frames look like this item's.
   */
  private tapFramesForItem = 0;
  /**
   * The counter's value at the last read that could be attributed to this item, or null when there is
   * no baseline yet (v1.9.24).
   *
   * Which counter it watches depends on the bridge (v1.9.25): the plugin's own per-item count when it
   * sends one, and the process-lifetime counter otherwise — see {@link noteTapFrames}.
   */
  private tapFramesAtLastRead: number | null = null;
  private spectrumPolls = 0;
  private lastSpectrumRecheckAt = 0;
  /** The last native frame's fingerprint, and how many polls in a row have repeated it. */
  private lastNativeChecksum = -1;
  private identicalNativeFrames = 0;
  /**
   * The last frame the poll read, kept so the reason line can print the **plugin's own numbers**
   * (v1.9.25).
   *
   * The banner has carried a sentence about the app's own state since v1.9.5 and, for this defect,
   * the facts that settle it are the plugin's: how many frames it has produced for this item, how
   * many times it has installed a tap versus verified one, and which slot it says it is on. Three of
   * those four were already computed and dropped on the floor at the bridge; this is where they are
   * kept until {@link status} reads them. It is never a decision input.
   */
  private lastNativeFrame: NativeSpectrumFrame | null = null;
  /** Polls in a row where the tap said it was not playing (v1.9.5) — re-checked, never a verdict. */
  private spectrumDeadPolls = 0;
  /** When the tap last produced a live frame (v1.9.5) — the watchdog's other half. */
  private lastLiveFrameAt = 0;
  /** Since when the clock has been sitting at the end of the item (v1.9.5), or null. */
  private pinnedAtEndSince: number | null = null;
  /** The last `playbackState` the plugin reported, kept verbatim for the reason line (v1.9.5). */
  private lastPluginState: { state: string; reason: string; currentTimeMs: number; durationMs: number } | null = null;
  /** What the boundary's adoption did (v1.9.5). */
  private adoptOutcome = 'not attempted';

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
   * When the player last reported anything — a position or a state (v1.9.7).
   *
   * The player reports its own position about every 100 ms while it plays, and each of those reports
   * already redraws the screen. {@link startClockTick} reads this so its own tick does not do the
   * same work again a fraction of a second later: the tick exists to keep the clock moving when
   * nothing else is, not to repaint on top of the reports that are arriving anyway.
   */
  private lastPlayerReportAt = 0;
  /**
   * The generation of the load that is in flight, or `null` when no load is (v1.9.7).
   *
   * A load is an unload + preload: the outgoing asset stops **on purpose**, and the plugin reports
   * that stop. Throughout the load the player is still holding the outgoing item, so a report
   * arriving now is describing our own work, and a question about the tap is a question about the
   * wrong item. This is a bracket rather than a deadline because the load's own length is what the
   * window is, and because a deadline that outlived the load would swallow the *next* honest report —
   * which is exactly what a six-second window did to a track ending a moment after a tap.
   *
   * v1.9.7 — **and the bracket is one start's, not the engine's.** It was a single boolean, so two
   * overlapping starts (two taps on two rows, which this file's own notes say race) shared it: the
   * first one's `finally` cleared it while the second was still loading, and the outgoing item's own
   * reports then reached the machine unfiltered — including the one that concludes a start. Holding
   * the generation it was opened under makes it exact per start, exactly as the load's own
   * staleness check already is (`this.track`, below).
   */
  private loadInFlight: number | null = null;
  /**
   * The generation whose **audible item is still the outgoing one** — no play has been asked for
   * yet (v1.9.7).
   *
   * A load is an unload + a preload, and from the moment it opens until the player has been asked
   * to make *this* start's item audible (`bridge.play` on a cold load, `bridge.adopt` on one that
   * was warm) the slot the listener is hearing still holds the item being replaced — so the
   * plugin's own 100 ms `currentTime` timer goes on reporting **that** item's position under the
   * audible asset id. A report from a track that is on its way out is not evidence about the item
   * being started, and it is exactly what concluded a start that had fetched nothing (see the
   * anchor test in `onPosition`): the bar said `playing`, `startFailed` stayed false, and a load
   * that then failed was neither shown nor retried.
   *
   * **Deliberately narrower than {@link loadInFlight}, and the difference is load-bearing.** The
   * load bracket also covers the play call itself, but the report that *does* conclude a start —
   * the player's own word about the item just started — arrives from inside that call: that is the
   * whole of v1.9.2's start proof (`awaitStart`, below), and the engine's `test/engine-native.test.ts`
   * drives exactly that ordering in twenty-odd tests. Gating this branch on the whole bracket would
   * therefore swallow the start it exists to protect, and every cold start would sit in `loading`
   * until {@link START_DEADLINE_MS} ran out and then be reported as a failure — a track that *did*
   * start, called a failure on screen, which is worse than the report this release is fixing.
   *
   * Held per start, like `loadInFlight`: two overlapping starts share neither.
   */
  private audibleIsOutgoing: number | null = null;
  /**
   * The tracks the bridge is holding warm: `songId -> the exact URL it was warmed under` (v1.9.5,
   * one prepared slot since v1.9.1).
   *
   * The player holds them buffered and silent, each under its own asset id — so when one of them is
   * played from the start there is nothing to load: the warmed asset is adopted and the first audio
   * arrives in a seek's time instead of after a cold fetch. The URL is kept beside the id because
   * the stream URL is the bitrate the link had been measured at when the track was warmed, and the
   * play request must carry **exactly that string** for the adoption to be of the same bytes
   * (`startNative` refuses to adopt unless the two agree).
   *
   * Insertion order is the drop order, exactly as in the bridge. Every way an entry leaves this map
   * is named: the track is started and adopted (deleted), a warm that did not happen (deleted in
   * `prepareNext`), the pool is full (the oldest is dropped by {@link trimWarmed}), the queue knows
   * the chain has moved ({@link pruneWarmed}), the engine is stopped or the track list cleared
   * (`discardPrepared`), and a cold load (a track the pool did not hold) clears it outright.
   */
  private readonly warmed = new Map<string, string>();
  /**
   * The queue as the **queue** published it (v1.9.9): the resolved play order, the position playing
   * now, and the repeat mode.
   *
   * The engine keeps it only long enough to state it to the native side (`syncQueue`), which is what
   * decides what a track that ends with the app away advances to. Every statement is re-made from
   * this picture, and the picture is replaced whole by the queue — there is no increment here that a
   * lost message could leave half-applied.
   */
  private statement: QueueStatement = { list: [], index: -1, repeat: 'off' };
  /**
   * Whether the **native side** is holding a boundary it will take by itself, i.e. whether the app
   * may stop worrying about the end of this track (v1.9.8).
   *
   * True only while the app is off screen *and* the bridge has been given a published queue with a
   * position playing in it: with the app on screen the web layer owns the boundary exactly as it
   * always has, and with nothing published there is nothing for the native side to walk. Every write
   * is a fresh statement (`syncQueue`), so a lost message cannot leave it stuck on — and it is read
   * in one place, `boundaryOwnedByNative`.
   */
  private boundaryArmed = false;
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
   * How the last start ended, and the only thing the ladder is allowed to be fed (v1.9.8).
   *
   * `player` is the one ending that is a measurement: the player itself reported sound for this
   * track, so the time from the request to that report is a number about this link. `background` is
   * the app leaving the screen mid-load, `timeout` is a start that produced nothing, and
   * `superseded` is a start the listener replaced — none of those say anything about the link, and
   * charging them to it is how the previous release's own work (the transcode spawn and the stalled
   * start) came to be measured as the link's fault. Cleared by the next start, which is the only
   * thing that writes it.
   */
  private startOutcome: 'player' | 'background' | 'timeout' | 'superseded' | null = null;
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
  /**
   * The native player took a track boundary **by itself** (v1.9.8), and this is the track it moved
   * to — with the **index** it moved to inside the queue the app published (v1.9.9). The queue owns
   * what "next" means, so it owns this too: it is an *adoption* — the audio is already playing — and
   * the handler is awaited where the answer matters (the return to the foreground reads the player's
   * record and hands it over before anything else is read).
   */
  onAdvancedNatively: ((songId: string, index: number) => void | Promise<void>) | null = null;

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

  /** The item's own duration as the plugin reported it, in ms — 0 when it did not (v1.9.5). */
  private factsDurationMs(facts: NativePlaybackFacts | undefined): number {
    const seconds = facts?.duration;
    return Number.isFinite(seconds) && (seconds as number) > 0 ? (seconds as number) * 1000 : 0;
  }

  /**
   * Is the item the player just reported on sitting at its own end? (v1.9.5)
   *
   * The facts decide it when the plugin sent them — its own `currentTime` against its own
   * `duration`, which is the only pair of numbers that describe the item actually being held.
   * Without them the app falls back to what it has (`nativeAtEnd`: its own position reading
   * against its own duration), which is the reading v1.9.0 introduced.
   */
  private reportIsAtEnd(facts: NativePlaybackFacts | undefined): boolean {
    const durationMs = this.factsDurationMs(facts);
    if (durationMs <= 0) return this.nativeAtEnd();
    // A track shorter than the slack cannot be judged this way, and says so rather than guessing.
    if (durationMs <= NATIVE_END_SLACK_MS) return false;
    const positionMs = Number.isFinite(facts?.currentTime) ? Math.max(0, (facts?.currentTime as number) * 1000) : this.nativePositionMs;
    return positionMs >= durationMs - NATIVE_END_SLACK_MS;
  }

  /**
   * The last door onto the end of a track: the app's own clock (v1.9.5).
   *
   * Every other way the queue hears that a track is over is a message from the plugin, and the
   * vendored player's messages are one fragile event (an exact `currentTime == duration`) plus a
   * state word it reserves for assets that are not being heard. When that event is missed there is
   * nothing left to wait for — so this reads the two facts the app does have and reports the end
   * itself: the machine says `playing`, the clock is pinned at the end of the item, and the tap is
   * producing no live frame. The clock is pinned exactly because the player stopped reporting: it
   * advances only while playing and clamps at the duration, so a player that has quietly stopped
   * at the end of its item looks like this and nothing else.
   *
   * Held for {@link PINNED_END_HOLD_MS} before it fires, so a momentary report gap in the last
   * quarter-second of a track is not a track ending. `reportEnded` is idempotent, so a real
   * completion arriving during the hold changes nothing.
   */
  private watchForPinnedEnd(): void {
    if (this.backend !== 'native' || this.state !== 'playing' || this.endedReported) {
      this.pinnedAtEndSince = null;
      return;
    }
    const duration = this.durationMs();
    const position = this.nativeClock();
    const pinned = duration > NATIVE_END_SLACK_MS && position >= duration - PINNED_END_SLACK_MS;
    const frameLive = this.spectrumLive && this.clockNow() - this.lastLiveFrameAt <= PINNED_END_HOLD_MS;
    if (!pinned || frameLive) {
      this.pinnedAtEndSince = null;
      return;
    }
    const now = this.clockNow();
    if (this.pinnedAtEndSince === null) {
      this.pinnedAtEndSince = now;
      return;
    }
    if (now - this.pinnedAtEndSince < PINNED_END_HOLD_MS) return;
    this.pinnedAtEndSince = null;
    this.nativePositionMs = duration;
    this.reportEnded('the clock has been sitting at the end of the item with no live frame, so the player is not going to say it');
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
    /*
     * How it ended, kept for the queue (v1.9.8). `play()` clears it as each start begins, so what
     * is read once a start has returned is that start's own ending and nothing older.
     */
    this.startOutcome = source;
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

  /**
   * How the last start ended (v1.9.8) — see {@link startOutcome}.
   *
   * The queue reads this the moment `play()` returns, and feeds the bitrate ladder from it: only a
   * start the player itself concluded is a measurement of this link.
   */
  lastStartOutcome(): 'player' | 'background' | 'timeout' | 'superseded' | null {
    return this.startOutcome;
  }

  private startClockTick(): void {
    if (this.clockTimer !== null) return;
    this.clockTimer = setInterval(() => {
      if (this.state !== 'playing') return;
      // The end the player never announced (v1.9.5) — see {@link watchForPinnedEnd}.
      this.watchForPinnedEnd();
      // v1.9.7 — the tick does not redraw on top of the player's own reports (see
      // {@link CLOCK_TICK_QUIET_MS}). The end-of-track check above still runs on every tick.
      if (this.clockNow() - this.lastPlayerReportAt < CLOCK_TICK_QUIET_MS) return;
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
    return this.loadInFlight !== null || this.clockNow() < this.reportsMutedUntil;
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
    const plugin = this.lastPluginState;
    const evidence = this.native?.spectrumEvidence?.() ?? null;
    const frame = this.lastNativeFrame;
    return {
      state: this.state,
      backend: this.backend,
      spectrum: this.spectrumLive,
      /*
       * The chip's third word (v1.9.6), and it is a fact about the *whole* state, not just the tap:
       * only a track that is playing can be waiting for its bars. A paused, ended or loading item has
       * no frames coming and says "native audio" or "loading…" exactly as it always did.
       */
      spectrumArming: this.spectrumArming && this.backend === 'native' && this.state === 'playing',
      modeReason: this.modeReason,
      /*
       * The phone's own account, as a line (v1.9.5): what it said, why it said it, and where the
       * item it said it about was — the three facts that were dropped at the bridge until this
       * release, and the reason a failure on the device could not be told from a failure in the
       * app.
       */
      pluginState: plugin
        ? `${plugin.state}${plugin.reason ? ` · ${plugin.reason}` : ''} · ${(plugin.currentTimeMs / 1000).toFixed(1)}/${(plugin.durationMs / 1000).toFixed(1)} s`
        : null,
      adoptOutcome: this.adoptOutcome,
      droppedEvents: this.native?.droppedEvents?.() ?? { inaudible: 0, slotGrace: 0 },
      warmedIds: [...this.warmed.keys()],
      /*
       * The native side's own boundary (v1.9.8). Read straight from the bridge, which is the only
       * thing that knows which slots it was given and what it did with them; a build with no such
       * bridge reports the zero state and the sentence that says why.
       */
      nativeBoundary: this.native?.nativeAdvance?.() ?? {
        armed: 0,
        advances: 0,
        failures: 0,
        ignored: 0,
        reason: 'this build has no native boundary to report',
      },
      positionMs: Number.isFinite(positionMs) ? positionMs : 0,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      error: this.error,
      nativeAvailable: this.native !== null,
      /*
       * The tap's own numbers (v1.9.25) — see the field's own doc. Read here, never acted on: a
       * `spectrumFrame` read would be a bridge round trip per status event, which is a dozen a second.
       */
      tap: {
        framesForItem: this.tapFramesForItem,
        pluginFrames: frame?.frames ?? null,
        pluginItemFrames: frame?.itemFrames ?? null,
        installs: frame?.installs ?? null,
        verifies: frame?.verifies ?? null,
        tapped: evidence?.tapped ?? null,
        audible: evidence?.audible ?? null,
        // The pace the drawing rule is judged on (v1.9.26): the tap's own declaration and the age of
        // the frame it is holding, both read from the last frame — never a decision, always the phone's
        // own numbers, and the pair his phone is the only place that can settle.
        framePeriodMs: frame?.itemFramePeriodMs ?? null,
        frameAgeMs: frame?.itemFrameAgeMs ?? null,
      },
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
          this.lastPlayerReportAt = this.clockNow();
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
           *
           * v1.9.7 — **and a report from a track that is on its way out is not evidence about the
           * item being started.** During `bridge.load` the audible slot still holds the OUTGOING
           * item (the plugin's 100 ms timer for it runs with the audible `assetId` until the
           * `unload` is processed) and `startWait` is still null, so a report from the track being
           * replaced reached this same anchor test and concluded a start that had fetched nothing:
           * the bar claimed `playing`, `startFailed` stayed false, and a load that then failed was
           * never retried and never shown. The gate is the window in which that is true —
           * {@link audibleIsOutgoing}, a per-start token like `loadInFlight`, and deliberately
           * narrower than the load bracket itself, which would swallow the item's own report (see
           * that field for why).
           */
          if (this.audibleIsOutgoing === null && Math.abs(ms - this.startAnchorMs) <= START_ANCHOR_SLACK_MS) {
            this.concludeStart('player');
          } else if (this.startWait !== null) {
            this.startAnchorMs = ms;
            this.concludeStart('player');
          }
          this.emit();
          this.onProgress?.(this.nativePositionMs, this.durationMs());
        },
        onState: (state, isPlaying, facts) => {
          if (this.backend !== 'native') return;
          this.lastPlayerReportAt = this.clockNow();
          /*
           * What the plugin said, kept as it said it (v1.9.5).
           *
           * `modeReason` is the app's own account and it is written from a dozen places; this is
           * the phone's. It is on the screen (see `updatePlayerBar`) because the boundary failure
           * that survives three releases reproduces only on the device, and every diagnosis so far
           * has had to guess which of the two — the app or the player — was describing what.
           */
          const factDurationMs = this.factsDurationMs(facts);
          this.lastPluginState = {
            state,
            reason: facts?.reason ?? '',
            currentTimeMs: Number.isFinite(facts?.currentTime) ? Math.max(0, (facts?.currentTime as number) * 1000) : this.nativePositionMs,
            durationMs: factDurationMs > 0 ? factDurationMs : this.durationMs(),
          };
          /*
           * The player's own numbers replace our guesses about them (v1.9.5).
           *
           * `durationMs()` preferred the duration Navidrome advertised for the track — a number
           * that has nothing to do with the item the player actually holds (a re-encode, a
           * different master, a stream that ends early). Everything that asks "are we at the end"
           * asked that question against the wrong number. The player answers it itself now, in
           * every state report, and that answer is the one used from here on.
           */
          if (factDurationMs > 0) this.nativeDurationMs = factDurationMs;
          if (Number.isFinite(facts?.currentTime)) this.setNativePosition(Math.max(0, (facts?.currentTime as number) * 1000));
          /*
           * **The end of a track is decided from the facts, not from one spelling of one state
           * (v1.9.5).**
           *
           * Until this release this read `state === 'stopped' && nativeAtEnd()`, and the vendored
           * player almost never says `stopped` about the audible asset: `Plugin.swift`'s own
           * `resolvePlaybackState` answers `.paused` whenever the asset is the one it is playing,
           * and `.stopped` only when it is not — so the one word this app accepted as "the track
           * ended" was a word reserved for assets that are *not* being heard. The completion event
           * that does say it fires on an exact `currentTime == duration` in `RemoteAudioAsset`
           * (and `play()` registers no end-of-item observer at all), so when it misses, the report
           * that arrives is a `paused` at the end of the item — and the app turned that into an
           * interruption, disarmed the consumers, left the queue parked and the chip reading
           * *native audio*, which is the owner's report word for word.
           *
           * A not-playing report whose own position is the end of its own item is the end of the
           * track, whichever word carries it. It is checked *before* the in-transition gate, as it
           * has been since v1.9.1: nothing we send produces a player we stopped with the clock at
           * the end of the item, and this report is the only one that will ever come.
           */
          if (!isPlaying && this.reportIsAtEnd(facts)) {
            /*
             * **Unless the native player owns this boundary (v1.9.8).** With the app away and a
             * warm slot armed, the native side has already played the next track by the time a
             * report like this can arrive — a report that got out before the web view froze, or one
             * delivered on the way back. Moving the queue on it would skip a track. `boundaryOwnedByNative`
             * says which of the two owns this end, and it is false in every case where the app is
             * on screen.
             */
            if (this.boundaryOwnedByNative()) return;
            this.nativePositionMs = this.durationMs();
            this.reportEnded(
              `the player reported itself not playing (${state}${facts?.reason ? `, ${facts.reason}` : ''}) with its own position at the end of the item`,
            );
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
        onBoundaryRefused: () => {
          if (this.backend !== 'native') return;
          /*
           * **The one door the native boundary may not close (v1.9.8).** While the app is away its own
           * end-of-track doors are held shut (`boundaryOwnedByNative`) because the native player is
           * the only thing that can hear the end there — so if the native side then says it could not
           * take the boundary, this is what reopens them. The end is reported exactly as it would
           * have been reported without any of this, which is what keeps a refused boundary from
           * becoming a track that never moves on.
           */
          this.reportEnded('the native player said it could not take the boundary it was armed for');
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
          // The native player owns this boundary while the app is away (v1.9.8) — see
          // `boundaryOwnedByNative`.
          if (this.boundaryOwnedByNative()) return;
          this.reportEnded('the player reported the item complete');
        },
        /*
         * **The native player took a boundary by itself (v1.9.8).**
         *
         * The queue owns what "next" means, so the message is passed straight to it: it moves its
         * cursor onto the track that is sounding and re-arms the look-ahead around it. Nothing here
         * touches the machine — the track that was playing is over and the one that replaced it is
         * already audible, and `adoptNativeAdvance` is the single account of that.
         */
        onAdvanced: (songId, index) => {
          if (this.backend !== 'native' || !songId) return;
          void this.onAdvancedNatively?.(songId, index);
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
    // Each start owns its own ending (v1.9.8) — see `startOutcome`.
    this.startOutcome = null;
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
    // Already warm under exactly this URL: the same stream, so a second preload is nothing.
    if (this.warmed.get(track.id) === track.url) return true;
    const bridge = this.native ?? (await this.ensureNative());
    if (!bridge?.prepare) return false;
    /*
     * Claimed before the call, not after: two warms for the same track (the queue's own, then a
     * start that reads it back) must not both go out, and the claim is what makes the second one a
     * no-op.
     *
     * v1.9.2 — **and given back when the warm did not happen.** `bridge.prepare` answers whether
     * the plugin actually took the asset; a warm that timed out, or that the bridge refused because
     * the listener had already moved on, leaves no warmed track behind, so the claim must not
     * outlive it. That leak is what the owner hit as a track that never came: the claim stayed for
     * a track that was never loaded, the queue then refused to re-warm it ("already holding exactly
     * this"), and the boundary paid a cold fetch with no word about why.
     */
    this.warmed.set(track.id, track.url);
    const settled =
      (await bridge.prepare({
        id: track.id,
        url: track.url,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artworkUrl,
      })) === true;
    if (!settled) {
      if (this.warmed.get(track.id) === track.url) this.warmed.delete(track.id);
      return false;
    }
    this.trimWarmed();
    // A new warm slot is a new candidate for the native side to play itself (v1.9.9).
    void this.syncQueue();
    return true;
  }

  /**
   * Keep the claims inside the pool the bridge actually has (v1.9.5).
   *
   * Three tracks are warm at once (the previous one and the next two), which is the number of slots
   * the bridge keeps that are not the audible one; a fourth claim would be a claim on a track whose
   * slot has just been reused. The oldest is dropped first, exactly as the bridge drops the oldest
   * slot.
   */
  private trimWarmed(): void {
    while (this.warmed.size > MAX_WARM_TRACKS) {
      const oldest = this.warmed.keys().next();
      if (oldest.done) return;
      this.warmed.delete(oldest.value);
    }
  }

  /**
   * Drop the claims for tracks the queue is no longer around (v1.9.5).
   *
   * Called when a selection moves the queue: a claim for a track nobody is going to hear is a claim
   * that would make a later start try to adopt an asset the player no longer holds. The bridge's own
   * slots are not touched — they are reused by the next warm, and the pool is fixed, so dropping a
   * claim costs nothing and removes a whole class of stale state.
   */
  pruneWarmed(keep: readonly string[]): void {
    for (const songId of [...this.warmed.keys()]) if (!keep.includes(songId)) this.warmed.delete(songId);
    // What is no longer warm is no longer a slot the native side may be given (v1.9.9).
    void this.syncQueue();
  }

  /**
   * The exact URL a track is warm under, or `null` when the pool does not hold it (v1.9.5).
   *
   * This is the queue's single source of truth about warmth, and it is the engine's on purpose: the
   * engine is what drops a claim a cold load invalidated, so a queue keeping its own copy could
   * believe a track was warm that the player had long since forgotten — and would then never warm it
   * again. The string it returns is the one the asset holds, so asking for it again asks for the
   * bytes that are already there rather than for a second transcode.
   */
  warmedUrl(songId: string): string | null {
    return this.warmed.get(songId) ?? null;
  }

  /**
   * Throw the warmed tracks away — the queue is not going where they were warmed for.
   */
  async discardPrepared(): Promise<void> {
    this.warmed.clear();
    // Nothing is warm, so the native side is told that none of these entries can be played from a
    // slot — and a fetch here would be a fetch it has no reason to make.
    void this.syncQueue();
    const bridge = this.native;
    if (this.backend !== 'native' || !bridge?.discard) return;
    await bridge.discard();
  }

  /* ------------------------------------------------- the native boundary (v1.9.8) */

  /**
   * The queue's statement of what the native side is to walk — **the whole queue** (v1.9.9), not the
   * look-ahead it used to send (v1.9.8).
   *
   * The queue is the only thing that knows the resolved play order (the shuffle, the repeat mode,
   * where the cursor is), and the engine is the only thing that knows what is actually *warm*; what
   * is stated to the native side is the two joined (`syncQueue`). Cheap and idempotent: it may be
   * called from anywhere, as often as anyone likes.
   */
  setQueue(statement: QueueStatement): void {
    this.statement = { list: [...statement.list], index: statement.index, repeat: statement.repeat };
    void this.syncQueue();
  }

  /**
   * State the queue to the native side: **what it will play if a track ends while the app is away**,
   * and whether it is allowed to.
   *
   * This is the structural half of the release. Off screen there is no web layer at all — the
   * plugin's completion is delivered to a suspended view, `watchForPinnedEnd` is driven by a clock
   * tick that has been stopped, and every path that could move the queue is in the frozen process —
   * so the native side is given the queue itself here, and walks it from its own observation of the
   * audible item's end. It used to be given the app's warm look-ahead instead, which is a chain
   * JavaScript built and JavaScript could no longer refill; a list does not run out, and an entry
   * with no slot named is one the native side fetches itself.
   *
   * `awake` is what keeps the two owners from both advancing a track: while the app is on screen the
   * native side is told the same queue and does not act on it.
   *
   * The answer is whether the bridge is holding that boundary, and `false` from the bridge (no such
   * plugin, a call that did not answer) is "the web layer keeps the boundary" — never a silent
   * assumption that something else is looking after it.
   */
  private async syncQueue(): Promise<void> {
    const bridge = this.native;
    if (this.backend !== 'native' || !bridge?.setQueue) {
      this.boundaryArmed = false;
      return;
    }
    /*
     * The warm pool goes with each entry, under the exact URL it holds: the bridge names a slot for
     * an entry only when the two agree, so a slot whose bytes are a different stream is never played
     * as if it were this entry. Everything else is stated without a slot, which the native side reads
     * as "fetch this one yourself".
     */
    const list = this.statement.list.map((entry) => ({ ...entry, warmUrl: this.warmed.get(entry.songId) ?? null }));
    const armed = await bridge.setQueue({
      list,
      index: this.statement.index,
      repeat: this.statement.repeat,
      awake: this.foreground,
    });
    this.boundaryArmed = armed === true;
  }

  /**
   * Whether the end of this track belongs to the native player (v1.9.8).
   *
   * Read in exactly two places, both of which are doors onto the end of a track, and both of which
   * must stay shut while the native side is holding a queue to walk: with the app away the native
   * player is the only thing that can hear the end, and the app's own doors — which are driven by a
   * clock tick and by plugin messages that have been stopped and suspended — would either never fire
   * or fire at the wrong moment. When one *does* fire (a `complete` that arrived before the web view
   * froze, say) the native side is already on the next entry, and advancing again would skip one.
   */
  private boundaryOwnedByNative(): boolean {
    return this.backend === 'native' && !this.foreground && this.boundaryArmed;
  }

  /**
   * The item the load left in place is asked for sound **again**, without touching any slot
   * (v1.9.8).
   *
   * This is the whole of "a start that failed must not become a second cold load of the same track
   * at a new URL" — see `PlaybackQueue.startCurrent`. Nothing is unloaded, nothing is preloaded and
   * no URL changes: the player that already holds this track is asked to play it once more, and the
   * answer is whether it produced sound (the same evidence every other start is judged on).
   */
  async retryPlayInPlace(startMs = 0): Promise<boolean> {
    const bridge = this.native;
    const track = this.track;
    if (this.backend !== 'native' || !bridge || !track) return false;
    this.generation += 1;
    this.startFailed = false;
    this.startOutcome = null;
    /*
     * The item is already the player's: the load has returned, so a report from here on is about
     * *this* track and not about one being replaced. No bracket is opened for the same reason — the
     * bracket exists to filter the outgoing item's reports during a load, and there is no load.
     */
    this.loadInFlight = null;
    this.audibleIsOutgoing = null;
    this.positionReported = false;
    this.startAnchorMs = Math.max(0, startMs);
    this.setNativePosition(startMs, false);
    this.dispatch({ type: 'select', trackId: track.id });
    try {
      await bridge.play(startMs / 1000);
    } catch (cause) {
      this.fail(cause);
      this.startFailed = true;
      return false;
    }
    if (this.track !== track) return false;
    const outcome = await this.awaitStart();
    if (this.track !== track) return false;
    if (outcome === 'timeout') {
      this.startFailed = true;
      this.modeReason = 'the track did not start in time even when the player was asked for it a second time — the item is still loaded, so one tap tries again';
      this.dispatch({ type: 'failure', message: 'the track did not start in time' });
      this.emit();
      return false;
    }
    return true;
  }

  /**
   * Adopt a track the **native player started by itself** (v1.9.8) — the audio is already playing.
   *
   * Nothing here loads, plays, adopts from the pool or writes to the player: the native side played
   * the slot the app had armed for it, and all that is left is for the engine's own state to agree
   * with it. The clock is re-based at the start of the new track (the native play is `time: 0`) and
   * marked *unreported*, so the display holds at zero until the player's own report arrives rather
   * than counting up from a position nobody measured.
   *
   * The request is the queue's, and its URL is the one the warmed slot holds: the same string the
   * asset on the player was fetched under, which is what keeps the spectrum's own URL check and the
   * next adoption consistent.
   */
  adoptNativeAdvance(track: TrackRequest): void {
    if (this.backend !== 'native') return;
    this.generation += 1;
    this.track = track;
    this.error = null;
    this.startFailed = false;
    this.startOutcome = 'player';
    this.loadInFlight = null;
    this.audibleIsOutgoing = null;
    this.warmed.delete(track.id);
    this.nativeDurationMs = 0;
    this.spectrumLive = false;
    this.spectrumArming = true;
    this.spectrumZeroPolls = 0;
    // v1.9.24 — the tap's frame count is per item: this track's tap has answered nothing yet, and
    // the frames the *previous* item's tap produced are not this one's answer.
    this.forgetTapFrames();
    /*
     * v1.9.25 — **the frame the item that just ended left behind is not this one's measurement
     * either.** The boundary takes the item over without passing through `startNative`, so the
     * per-item drawing state has to be cleared here as well as there: the register holds the previous
     * item's last frame, and the fingerprint and the run of identical frames that go with it would
     * otherwise be judged against the track the native player has just started.
     */
    this.nativeBands = null;
    this.lastNativeChecksum = -1;
    this.identicalNativeFrames = 0;
    this.orphanReattachedFor = null;
    this.positionReported = false;
    this.setNativePosition(0, false);
    this.modeReason =
      'the native player took the track boundary itself while the app was not listening — the audio never stopped, and this is the app catching up with it';
    this.dispatch({ type: 'engine-state', playing: true });
    this.concludeStart('player');
    this.attachSpectrum(track);
    this.emit();
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
         * **This seek's own token (v1.9.13).**
         *
         * A seek's second statement (`sync`, below) is a round trip that can outlive the seek it was
         * made for: the next seek of a drag, a pause, a new track. Every one of those bumps
         * `generation`, so an answer that comes back under an older token is not this seek's answer
         * and is dropped — which is the *earlier* seek's completion unable to overwrite the later
         * one, the other half of latest-wins.
         */
        const generation = this.generation;
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
        /*
         * **The bar carries the player's own reading, never the request (v1.9.13).**
         *
         * This spot used to write the position that was *asked for* into the clock —
         * `setNativePosition(positionMs, false)` — and the seek bar draws the clock, so a seek the
         * player never performed was painted as if it had landed: the owner's *"seeking anywhere on
         * the seek line seems to make the song play from the beginning even though on the seek line
         * it shows as if it's playing from where i released it."* Two clocks, and the screen was
         * showing the wrong one.
         *
         * So the seek is now a question with an answer. `sync()` reads the **audible** player — the
         * slot the bridge is playing, its own `currentTime`, its own `isPlaying` — and that reading
         * is what the clock and the bar get. It is the same read the return from the background has
         * always used, and it is deliberately *not* the value the caller handed in: a seek that did
         * not move the item leaves the bar on the position the item is really at, and `modeReason`
         * says which of the two happened. If the player will not answer at all, nothing is painted —
         * an unconfirmed position is not the position being heard, and the clock keeps the last
         * position the player itself reported.
         */
        const truth =
          generation === this.generation
            ? await withDeadline(this.native?.sync() ?? Promise.resolve(null), null, SEEK_VERIFY_TIMEOUT_MS, 'the player (after a seek)')
            : null;
        if (generation !== this.generation) return;
        const asked = Math.round(positionMs / 1000);
        if (truth) {
          this.setNativePosition(truth.positionMs);
          if (truth.durationMs > 0) this.nativeDurationMs = truth.durationMs;
          const landed = Math.round(truth.positionMs / 1000);
          this.modeReason =
            Math.abs(truth.positionMs - positionMs) <= SEEK_VERIFY_SLACK_MS
              ? `the seek to ${asked} s landed — the player itself reports ${landed} s`
              : `the seek to ${asked} s was asked for and the player is at ${landed} s — the bar follows the player, not the request`;
        } else {
          this.modeReason = `the seek to ${asked} s was sent and the player would not say where it is — the bar keeps the position the player last reported`;
        }
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
    // Nothing is playing, so nothing is warm for it either (v1.9.1).
    this.warmed.clear();
    // Nothing is playing, so there is no queue for the native side to walk (v1.9.9).
    this.statement = { list: [], index: -1, repeat: 'off' };
    void this.syncQueue();
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
      /*
       * **And this is the moment the boundary changes hands (v1.9.8).** The web layer is about to
       * stop running, so the native player is handed the queue — with `awake: false` — and it is
       * henceforth the owner of every track end until the app is on screen again. The statement is
       * re-made rather than assumed, and it is the same call in both directions, so there is no flag
       * that could stick.
       */
      await this.syncQueue();
      return;
    }
    this.foreground = true;
    /*
     * **The app comes back to a player that may have moved on without it.** Nothing in the web
     * layer heard the track end, so before anything is read from the player the native side is
     * asked which slot it is playing now, and its answer is adopted: the queue moves onto that
     * track (it is already sounding — nothing is started, nothing is re-fetched) and everything
     * else below reads the player that is actually playing. This is the return half of the native
     * boundary, and the reason a track that advanced while the app was away is never lost.
     */
    const moved = await this.native?.reconcile?.();
    if (moved?.changed && moved.songId) {
      this.modeReason = `the native player moved to another track while the app was away (${moved.songId}) — the app is adopting the track that is already playing`;
      // The index travels with the track (v1.9.9): the queue adopts by position in the order it
      // published, which is the only thing that is right when that order is shuffled.
      await this.onAdvancedNatively?.(moved.songId, moved.index);
    }
    // And with the web layer running again, the boundary goes back to it (v1.9.8).
    await this.syncQueue();
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
    /*
     * v1.9.7 — **a bridge that cannot be built is a start that did not happen, and it is said here.**
     *
     * Getting the bridge is the one round trip in this path that sits outside the load's own `try`,
     * and it is the one that can still reject on a device (a plugin that is not there, a build that
     * never answered): the rejection left this method, through `play`, out to the queue's
     * `void ctx.queue.play(...)` — and the machine was left in `loading` with nothing sounding and
     * nothing said, which is the ending this release exists to delete. Both words for it now end the
     * way every other failed start ends: the failure is on the machine (`fail`), the start is marked
     * as one that produced no sound, and the queue takes its own failed branch — the waiting state
     * off, the row free again, one retry a rung down the bitrate ladder, and the look-ahead re-armed.
     */
    let bridge: NativeBridge | null = ready ?? null;
    try {
      bridge ??= await this.ensureNative();
    } catch (cause) {
      this.fail(cause);
      this.startFailed = true;
      return;
    }
    if (!bridge) {
      this.fail(new Error('the native audio engine is not available in this build'));
      this.startFailed = true;
      return;
    }
    this.backend = 'native';
    this.setNativePosition(startMs);
    /*
     * **The metadata duration is a fallback, not the player's number (v1.9.5).**
     *
     * This used to *write* Navidrome's duration for the track into the slot that is supposed to
     * hold the player's own answer, which made every "are we at the end" question in this file a
     * question about the advertised length of a re-encode. `durationMs()` already falls back to the
     * track's metadata when the player has said nothing, so leaving this at zero changes nothing
     * until the player speaks — and from the first state report on, its own duration is what is
     * used.
     */
    this.nativeDurationMs = 0;
    this.spectrumLive = false;
    /*
     * **And the tap has not answered for this item yet (v1.9.6).**
     *
     * `spectrumLive` is cleared here for the item that is starting, ahead of the adoption below, and
     * it comes back on *this* item's first live frame — which, for a warm track that is adopted, is a
     * fraction of a second after the hand-over. That window is the owner's complaint in miniature:
     * `status.spectrum` false with a native backend is precisely what the bar chip prints as *native
     * audio*, so the words he reported came back at every boundary, briefly, instead of for a whole
     * track. Simply not clearing the flag is not an answer either — it drives `readSpectrum()`, and a
     * live flag with `nativeBands === null` behind it is the frozen-buffer lie this file spends its
     * comments on. So the window is *named* instead: arming is true from here until the engine has an
     * answer about the tap for this item (a live frame, or one of the verdicts in `pollSpectrum`), and
     * the chip has a third word for it.
     */
    this.spectrumArming = true;
    /*
     * The tap's budget is per item, and so is the verdict it feeds (v1.9.6): a zero-poll count left
     * over from the track that just ended used to decide, on this item's first poll, that this item's
     * tap was reading silence (see `pollSpectrum`) — which now also means deciding, on the first
     * poll, whether the chip is allowed to say "native audio" about a tap it has not heard from yet.
     */
    this.spectrumZeroPolls = 0;
    /*
     * v1.9.24 — **and the frames counted so far are not this item's answer.**
     *
     * The tap's own counter runs for the life of the app process (`NaviliteSpectrum`'s `frames += 1`
     * is reset by nothing). Reading it as "this item's tap has answered" is what turned the chip to
     * *native audio* 12 polls into every track after the first one — `forgetTapFrames` is that
     * attribution, cleared here for the item that is starting (see `noteTapFrames`).
     */
    this.forgetTapFrames();
    /*
     * v1.9.25 — **and the frame the item that just ended left behind is not evidence about this one.**
     *
     * `nativeBands`, the fingerprint it was compared by and the run of identical frames are per item
     * for the same reason the tap's counter is: the frame in the register is the *previous* item's
     * last measurement, and a run of them would be counted against the track starting now — which is
     * how a frozen register came to spend the chip's third word on a track whose own tap had produced
     * nothing. `startConsumers` resets these when it arms the poll, and a track change does not go
     * through it (the poll is already running), so the reset belongs here too.
     */
    this.nativeBands = null;
    this.lastNativeChecksum = -1;
    this.identicalNativeFrames = 0;
    // v1.7.7's rule is kept — the tap on the previous item is left where it is and this item gets
    // its own — but v1.9.24 removed the *budget* it was paired with: a tap that will not answer is
    // re-asked, and a tap that has answered is judged on this item's frames alone.
    // v1.9.22 — and a fresh "has this track's tap been re-attached yet": the first orphan frame
    // this track produces is answered on the spot (see `pollSpectrum`).
    this.orphanReattachedFor = null;
    this.modeReason =
      'native playback (AVFoundation / ExoPlayer) — this is the engine that keeps going when you leave the app and the one the lock screen drives; the spectrum is an FFT of the same stream, read from the native audio tap';
    // A load is an unload + preload: the outgoing asset's stop must not be read as a track ending,
    // and until the load has returned the player is still on the outgoing item — so both the
    // report gate and the tap's verify are closed for exactly that long, and no longer. (v1.9.7: the
    // gate is this start's generation, not a shared boolean — see `loadInFlight`.)
    const generation = this.generation;
    this.loadInFlight = generation;
    // And the audible slot holds the outgoing item until this start is asked for, out of the same
    // fact and for a shorter window (v1.9.7 — see `audibleIsOutgoing`).
    this.audibleIsOutgoing = generation;
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
     * **The boundary: this track is warm on the player, so there is nothing to load (v1.9.1).**
     *
     * The queue keeps the previous track and the next two buffered on the player's other assets —
     * silent, never played. When one of them is the track being started, and from its start, its
     * asset is adopted: it is already the audible asset, with an item AVFoundation has been filling
     * since before it was asked for. That is the whole of "autoplay after a track ends is instant":
     * at a boundary the app is not fetching anything, it is switching a pointer, because the whole
     * length of the listening that came before it was available to get ready.
     *
     * Deliberately narrow, and the URL is part of the condition (v1.9.5): the warmed asset holds the
     * stream the URL asked for, so the claim must name *this* track **under exactly this string** —
     * a bitrate the ladder has moved since the warm makes the assets different bytes, and adopting
     * one for the other would play something other than what the play request asked for. A resume
     * mid-track, a track that is not warm, a URL that has moved, or a bridge with no warm pool all
     * fall through to the load below, which is exactly v1.9.0's behaviour.
     */
    const warmUrl = this.warmed.get(track.id) ?? null;
    const adoptable = startMs === 0 && warmUrl !== null && warmUrl === track.url && typeof bridge.adopt === 'function';
    /*
     * What the boundary did, named before it is tried (v1.9.5) — see `NativeBridge.adoptOutcome`.
     * A cold load is a legitimate outcome; an *unaccounted* one is what the reason line exists to
     * end.
     */
    this.adoptOutcome =
      startMs !== 0
        ? 'not attempted — this track starts part-way through'
        : warmUrl === null
          ? `nothing warm for this track (holding ${this.warmed.size})`
          : warmUrl !== track.url
            ? /*
               * **The mismatch, named with its two numbers (v1.9.8).** A warm asset the play request
               * does not ask for is an asset of different bytes, so it must not be played — but the
               * reason this deserves a sentence is that it is also *recoverable*: the cold fetch
               * that follows drops every claim, and the queue re-warms around this track the moment
               * it has sound. What it must never be is silent, which is what one fixed sentence for
               * a rung move and for a re-created client made it.
               */
              `not attempted — the warm asset is a different stream than this request (warmed as ${askedRate(warmUrl)}, asked for as ${askedRate(track.url)}), so this start fetches cold and the neighbourhood is re-warmed around it`
            : typeof bridge.adopt !== 'function'
              ? 'not attempted — this build has no warm pool'
              : 'attempting';
    let adopted = false;
    try {
      if (adoptable) {
        // v1.9.7 — this is the call that makes this start's item the audible one, so from here a
        // report about it is news rather than a leftover from the item being replaced (see
        // `audibleIsOutgoing`). Conditional on the token: an older start's adopt must not open the
        // window on a newer start's behalf.
        if (this.audibleIsOutgoing === generation) this.audibleIsOutgoing = null;
        adopted = (await bridge.adopt?.(track.id)) === true;
        // The bridge's own words when it has them ('nothing prepared', 'play refused (…)',
        // 'timed out'), and an honest fallback when it does not.
        this.adoptOutcome = bridge.adoptOutcome?.() ?? (adopted ? 'adopted' : 'refused — the track was loaded instead');
        // Whichever way it went, this track is not warm any more: adopted it is audible, refused it
        // is not on the player at all, and the queue re-warms around the new track after this start.
        this.warmed.delete(track.id);
      }
      if (!adopted) {
        /*
         * A track the pool did not hold is a cold fetch, and a cold fetch is where the old chain
         * ends (v1.9.5): every claim from here on describes a track the player is not holding —
         * `load` clears the bridge's own pool for the same reason — so the claim map is cleared with
         * it. What is left is nothing claiming anything, which is the state a selection has to
         * leave behind; the queue warms the new neighbourhood as soon as this start has sound.
         *
         * v1.9.11 — **and the load is no longer a cold fetch by definition.** It is asked, and then
         * the reason line is written from its own answer: the bridge hands over to a slot that already
         * holds this track (the armed next item becoming current from its own buffered state, which is
         * the boundary this release is about), it writes the incoming track beside the one being heard
         * when it has to fetch, or it finds the track already audible and has nothing to do. The
         * engine's own claim being gone — a timed-out prepare, a prune — is no longer the same thing as
         * the player not holding the track, and reporting it as a fetch was the last place the app
         * still described the boundary as a reload.
         */
        this.warmed.clear();
        await bridge.load(track);
        this.adoptOutcome = bridge.loadOutcome?.() ?? this.adoptOutcome;
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
        // v1.9.7 — the same statement for the cold path: the player is being asked for *this*
        // item, so its next report is about the track being started (see `audibleIsOutgoing`).
        if (this.audibleIsOutgoing === generation) this.audibleIsOutgoing = null;
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
      /*
       * The load is over: reports arriving from here on are news again, and the tap can be checked.
       *
       * v1.9.7 — **only if this start is still the one holding the bracket.** Two starts can overlap
       * (two taps on two rows), and the older one's `finally` runs while the newer one is still
       * loading; clearing unconditionally would open the gate on the newest start's behalf and let a
       * *playing* report from the outgoing item reach `onState` unfiltered.
       */
      if (this.loadInFlight === generation) this.loadInFlight = null;
      // And the audible-item window closes with the load, whatever the load did: a start that
      // returned early, or threw, must not leave it open for a later report to be read under
      // (v1.9.7 — see `audibleIsOutgoing`).
      if (this.audibleIsOutgoing === generation) this.audibleIsOutgoing = null;
      /*
       * **The tap is confirmed at the close of every load, not only an adopted one (v1.9.22).**
       *
       * v1.9.5 gave the adopted item its verify here and left the cold path to `startConsumers`,
       * which is right only while the cold load is still `loading` when this bracket closes. A
       * player that reports sound *inside* the load — the thing `bridge.play` has just asked it for,
       * and what the owner's phone does — makes that false: the `playing` transition runs
       * `startConsumers` *while* this bracket is still open, `startConsumers` refuses to verify
       * there (`loadInFlight`), and the only install the track ever gets is the single
       * fire-and-forget request three lines above. An install the plugin superseded, or one that
       * answered `false`, then leaves the engine at `spectrum off` with audio playing — the state
       * the owner reported, and the one this release makes unreachable. One plugin call, and it is
       * a read unless the item is genuinely a different one; the adopted item keeps exactly the
       * verify it had.
       */
      if (this.track === track && this.state === 'playing') this.confirmSpectrum(track);
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
      // v1.9.6 — nothing is being installed either: this build has no tap to install.
      this.spectrumArming = false;
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
    if (this.loadInFlight === null) this.verifySpectrum();
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
    /*
     * **One read at a time (v1.9.22).**
     *
     * The tick is {@link SPECTRUM_POLL_MS} and a read is a bridge round trip, so on a phone whose
     * plugin answers slower than that there were several reads in the air at once with no order
     * between their answers — and every one of them writes `spectrumLive`, `nativeBands` and the
     * poll budgets. An answer that describes the item the player has just left could therefore be
     * applied *after* one that describes the item it moved to: the engine went back to
     * `spectrum off` while the new track was playing, which is the state the owner reported. A read
     * that is already out is the newest information there is; the tick that arrives while it is
     * still out is skipped, not queued.
     */
    if (this.spectrumReadInFlight) return;
    this.spectrumReadInFlight = true;
    let frame: NativeSpectrumFrame | null = null;
    try {
      frame = await bridge.spectrumFrame();
    } finally {
      this.spectrumReadInFlight = false;
    }
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
      /*
       * Frames seen while the tap is off this item are not this item's answer: the next read that
       * finds the tap back on it re-baselines instead of counting the gap (see `noteTapFrames`).
       */
      this.forgetTapFrames();
      /*
       * **v1.9.24 — and this branch no longer spends the chip's third word.**
       *
       * It used to. Three orphan sightings, one a second, and the reason line said *"the tap is on
       * the item the player has moved off and would not re-attach"* — a capability claim made out of
       * two momentary refusals, and half of what the owner reads as *"it defaults to native audio"*
       * at a track change. The state is real and it is reported; the conclusion was not.
       *
       * There are two ways into that state and the plugin's own `attached` separates them:
       *
       *   - **no tap at all** (`attached === false`) — the request was refused (a named slot with no
       *     loaded item is a real state for the length of a `fillSlot`, `src/player/native.ts:791`)
       *     or has not landed yet. The remedy is another request, against *this* item.
       *   - **the tap is on an item the player has left** (`attached === true`) — the ordinary
       *     transition (the install the new track just issued is still in flight), or an install that
       *     read the outgoing item before its `await` and attached to it after.
       *
       * Both are answered the same way: the plugin is asked again, no more often than
       * {@link SPECTRUM_ORPHAN_RECHECK_MS} — and at once when an install for this track has already
       * answered while the tap is elsewhere (v1.9.22) — while the chip keeps its third word.
       * Nothing in this branch decides that this track cannot have a spectrum.
       */
      this.spectrumLive = false;
      // The tap is off the item that is playing, so the engine has no answer for that item and says
      // so with the chip's third word — a request for this track is what the poll below issues.
      this.spectrumArming = this.state === 'playing';
      this.setSpectrumReason(
        frame.attached !== false
          ? 'the tap is on the item the player has moved off — re-attaching it to the track that is playing'
          : 'nothing is attached to the item that is playing — asking the plugin to put a tap on it; the bars follow the audio',
      );
      const trackId = this.track.id;
      const probe = this.spectrumInstall;
      const orphaned = probe !== null && probe.track === this.track && probe.answered;
      const firstSighting = orphaned && this.orphanReattachedFor !== trackId;
      if (firstSighting || this.clockNow() - this.lastSpectrumRecheckAt >= SPECTRUM_ORPHAN_RECHECK_MS) {
        this.orphanReattachedFor = trackId;
        this.verifySpectrum();
      }
      return;
    }
    /*
     * The tap is on the item the player is playing, so the growth of the plugin's counter from here
     * is **this item's** frames — the only input that may say whether this track's tap has answered
     * (v1.9.24, see `noteTapFrames`), and the fact that decides whether the frame in hand is drawn at
     * all (v1.9.25).
     */
    const measured = this.noteTapFrames(frame);
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
       * The tap has gone quiet while the engine is playing: the plugin is reporting a *player* that
       * is not playing, on the item this app is playing. There is no silent copy to be torn down any
       * more, so the honest causes are an item the plugin has replaced under the tap and a stream
       * that is genuinely stopped — and both are answered by *verifying* the tap (one read of the
       * plugin, which writes nothing at all when the item already carries it) rather than detaching
       * and rebuilding it, which is what put an audible gap in the middle of a song.
       *
       * **v1.9.24 — and the budget that used to end this is gone.** Twelve polls, then the third
       * failure, then the chip said *native audio* and the reads dropped to one every five seconds:
       * a capability verdict made out of a clock, which is the defect this release removes. The
       * re-checks continue for as long as the state does — rate-limited to one every
       * {@link SPECTRUM_RECHECK_MS}, so a tap that will not stay up is still not asked thirty times a
       * second — and the chip keeps saying the spectrum is coming, with the reason line naming what
       * the plugin is reporting.
       */
      if (this.state !== 'playing') {
        this.spectrumDeadPolls = 0;
        return;
      }
      this.spectrumDeadPolls += 1;
      if (this.spectrumDeadPolls < ZERO_POLLS_BEFORE_THEME) return;
      if (this.clockNow() - this.lastSpectrumRecheckAt < SPECTRUM_RECHECK_MS) return;
      this.setSpectrumReason(
        'the plugin reports that the player it is tapping is not playing, while this app is playing this track — checking the tap again; the bars follow the audio',
      );
      this.verifySpectrum();
      return;
    }
    this.spectrumDeadPolls = 0;
    /*
     * **Nothing is drawn, and nothing is judged, from a frame this item's tap did not produce
     * (v1.9.25) — and this item's own last frame is drawn for as long as its own tap's period says
     * it is still the measurement in hand (v1.9.26).**
     *
     * `bands` and `live` are a last-value register: the plugin publishes the last frame its FFT ever
     * produced and zeroes it only in `detach`, so on this path — tap on the item playing now, player
     * playing — a register that has stopped moving is *not* a measurement of this item. It is either
     * the previous item's last frame (the loud skip's shape: the incoming item's analysis was torn
     * down by the outgoing item's `unprepare`, so `bands` still holds a non-zero frame with `live`
     * true and nothing produces another one) or an all-silent frame from a tap that has since gone
     * still. Both are the owner's report — *"the lines stay dead the whole track, the spectrum seems
     * to jump up at the start and then go to zero and remain there"*, and, while the bars are flat,
     * the chip reading *native audio*.
     *
     * **And the counter's movement alone is not the test** (v1.9.26 — §516.1 amended, and the whole
     * of Sage's SEND BACK of `2e1eb9d`). It was: *a frame may only be drawn if this item's tap
     * produced it since the last read*, which silently assumed a healthy tap produces one frame per
     * {@link SPECTRUM_POLL_MS} read. It does not — the plugin's frame production is quantized to the
     * PCM buffer AVFoundation hands the tap (`drainAndAnalyze` resets `sinceLastFrame` per callback
     * instead of subtracting the hop, `NaviliteSpectrum.swift:678`; `maxFrames` from `prepare` was
     * discarded, `:811`), and 4096-frame buffers are ~11 frames/s against 30 reads/s. So the rule
     * blanked the bars — and flapped the chip between *spectrum* and *spectrum…* — on two reads in
     * three, **of a tap that was measuring perfectly**, which weakened exactly the cases that work
     * today: a quiet skip and a cold start.
     *
     * The rule that stands instead rests on two facts the plugin publishes about **this item's own
     * analysis** and on nothing else — no engine constant, no poll count, no timer, no "give up after
     * N s" (`DECISIONS.md` §515.1 deleted that shape): the period that tap declared for itself
     * (`itemFramePeriodMs`) and how old the frame it is holding is (`itemFrameAgeMs`). A frame is
     * drawn when this item's tap produced it since the last read, **or** when it is this item's own
     * last frame and is no older than that tap's own period. Past that the register is named and not
     * drawn — the loud-skip state, and the tap that has stopped, are both still covered: a tap that
     * has produced *nothing* for this item (`itemFrames === 0`) never reaches either half.
     *
     * What a held frame is not: evidence of anything. It is drawn and nothing else — it does not feed
     * the frozen-frame rule (the same frame *not produced again* is not a tap stuck on one buffer, it
     * is the same measurement in hand), it does not count toward the silence verdict (a poll the tap
     * did not answer is not another 33 ms of digital silence), it does not refresh the pinned-end
     * watchdog's live stamp (nothing new was measured) and it does not touch the chip (there is no new
     * fact about this item's tap for the chip to say).
     */
    this.lastNativeFrame = frame;
    const held = !measured && this.holdsThisItemsOwnFrame(frame);
    if (!measured && !held) {
      this.spectrumLive = false;
      this.spectrumZeroPolls = 0;
      /*
       * **And the chip keeps its third word** — the same word §515.4 gives a tap that has never
       * answered at all: a tap on the item playing now that is producing nothing is *the spectrum is
       * coming*, which is a statement about this item's tap and nothing about whether this track can
       * have one. It goes back to *spectrum* on this item's next frame, and it is the word the owner
       * asked for in place of *native audio* while the bars are flat.
       *
       * The sentence names which register is being looked at, and — since v1.9.26 — the pace the
       * judgement is made on: this item's tap has produced something and stood still longer than its
       * own frame period (the register is this item's own, one period old and past it), or this item's
       * tap has produced nothing at all for this track (the register is the previous item's, and it
       * still looks live or it is flat).
       */
      this.spectrumArming = this.state === 'playing';
      this.setSpectrumReason(
        this.tapFramesForItem > 0
          ? 'this item’s tap produced its last frame longer ago than its own frame period — nothing is measuring this track now, so the bars follow the audio until its analysis produces another'
          : frame.live
            ? 'the frame the plugin is holding was not produced by this item’s tap — the bars follow the audio, and this track’s own tap has yet to give one'
            : 'the tap on the item that is playing has produced no frame for this track — nothing is being measured, so the bars follow the audio while the engine keeps waiting on its tap',
      );
      return;
    }
    this.nativeBands = Uint8Array.from(frame.bands);
    if (held) return;
    if (frame.live) {
      this.spectrumZeroPolls = 0;
      // A live frame is what the watchdog waits for before it will call the end of a track by
      // itself (v1.9.5): the tap is measuring sound, so nothing here is over.
      this.lastLiveFrameAt = this.clockNow();
      // And it has answered (v1.9.6): whatever the bars were doing a poll ago, this item's tap is
      // installed and reading sound, so the chip is back on "spectrum".
      this.spectrumArming = false;
      if (!this.spectrumLive) {
        this.spectrumLive = true;
        this.modeReason = 'real spectrum — an FFT of the stream this player is playing, read from the native audio tap';
        this.emit();
      }
    } else {
      this.spectrumZeroPolls += 1;
      /*
       * **A verdict about this item's tap, whether or not it ever fed the bars (v1.9.6).**
       *
       * This used to require `spectrumLive`, which meant a tap that *never* produced a live frame was
       * never judged at all: the engine said nothing, and the chip was left with two words for three
       * states — so "the tap has not answered yet" and "there will be no bars from this item" printed
       * the same sentence. Twelve polls (~0.4 s) of frames from a tap on the item the player is
       * playing is the tap's own answer, and it closes both questions at once: the reason line gets
       * one honest sentence (once, on the transition, not thirty times a second), and the chip stops
       * saying the spectrum is coming.
       *
       * **v1.9.24 — and "frames from a tap on the item the player is playing" is now what `answered`
       * means.** It was `frame.frames > 0`, and that counter belongs to the app *process*
       * (`NaviliteSpectrum.swift:605`, reset by nothing), so on every track after the first one that
       * ever produced a frame this branch said *"the native tap is reading digital silence"* about a
       * tap that had produced **nothing** for the item playing — 12 polls, ~0.4 s, in, while the
       * attach was still in flight. That is the owner's *"it defaults to native audio"*, and it was
       * chosen *because* the attach had not landed yet. `tapFramesForItem` counts this item's frames
       * only (see `noteTapFrames`), so a tap that has answered nothing for this track keeps the chip's
       * third word and the attach is allowed to arrive.
       */
      const answered = this.tapFramesForItem > 0;
      if (this.spectrumZeroPolls >= ZERO_POLLS_BEFORE_THEME && (this.spectrumLive || (this.spectrumArming && answered))) {
        this.spectrumLive = false;
        this.spectrumArming = false;
        this.modeReason =
          answered
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
     *
     * v1.9.25 — **and it only ever sees frames this item's tap produced.** The branch above returns
     * before this point when the counter did not move, so a register that simply stopped is not
     * "frozen" here: it is `the tap has stopped producing`, which is a different state with a
     * different sentence, and it no longer spends the chip's third word. What this rule still catches
     * is the live-but-stuck tap it was written for — one that *is* producing frames, all of them the
     * same.
     */
    const checksum = spectrumChecksum(frame.bands);
    const identical = checksum !== 0 && checksum === this.lastNativeChecksum;
    this.lastNativeChecksum = checksum;
    this.identicalNativeFrames = identical ? this.identicalNativeFrames + 1 : 0;
    if (this.identicalNativeFrames >= FROZEN_FRAMES_BEFORE_THEME && this.spectrumLive) {
      this.spectrumLive = false;
      // v1.9.6 — a frozen buffer is an answer about this item's tap (and not a good one); the chip
      // stops waiting and says so, as the reason line does.
      this.spectrumArming = false;
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
   * True when the frame in hand is **this item's own last measurement, still inside the tap's own
   * frame period** (v1.9.26 — the premise §516.1 was amended for).
   *
   * `bands`/`live` are a last-value register, and on this item the register is not another item's: the
   * plugin's `SpectrumAnalysis` is one per install, so while this item's analysis is between two
   * frames, what it hands over is *this item's* last frame, one window old. The two facts that say so
   * are both the plugin's, and this method reads them and nothing else:
   *
   *   - **`tapFramesForItem > 0`** — this item's tap has produced a frame for this item at some point
   *     (see `noteTapFrames`). A register that has never moved *for this item* is the previous item's
   *     frame, which is the loud skip, and it is deliberately not covered here.
   *   - **`itemFramePeriodMs` / `itemFrameAgeMs`** — the period this item's tap declared for itself at
   *     `prepare` (`maxFrames` over the sample rate, floored by the tap's own FFT hop:
   *     `NaviliteSpectrum.SpectrumAnalysis.framePeriodMs`) and how old the frame it is holding is. A
   *     frame no older than one of the tap's own periods is the measurement in hand; one older than
   *     that is a tap that has stood still longer than its own pace — a state to name, not to draw.
   *
   * What the threshold is **not**: an engine constant, a count of polls, a `setTimeout`, or a "give up
   * after N s" — the shapes `DECISIONS.md` §515.1 deleted, and the reason this is a comparison of two
   * numbers the *plugin* publishes about the item it is tapping.
   *
   * A bridge that does not publish the pace reads as "not known" and the frame is not held: the
   * v1.9.25 rule (only frames this item's tap produced since the last read) then stands, because a
   * fact the engine cannot read is not a fact it may assume.
   */
  private holdsThisItemsOwnFrame(frame: NativeSpectrumFrame): boolean {
    if (this.tapFramesForItem <= 0) return false;
    const period = frame.itemFramePeriodMs;
    const age = frame.itemFrameAgeMs;
    if (typeof period !== 'number' || typeof age !== 'number') return false;
    if (!(period > 0) || !(age >= 0)) return false;
    return age <= period;
  }

  /**
   * Count the tap's frames **for the item playing now**, and say whether this read carries a frame
   * that item's tap actually produced (v1.9.24; the second half is v1.9.25).
   *
   * The rule the engine needs from this is one sentence long: *a frame may only be drawn, and may
   * only spend the chip's third word, if this item's tap produced it since the last read* — plus, since
   * v1.9.26, *unless it is this item's own last frame and is no older than that tap's own declared
   * period* (see `holdsThisItemsOwnFrame`, and §516.1 as amended). A
   * last-value register is not a measurement of the item that is playing — and the register is
   * exactly what the plugin hands over: `bands`/`live` are the last frame *whose* tap ever analyzed,
   * zeroed only by `detach`. So the frame in hand is admitted on the counter moving, and there are
   * two counters it can move on:
   *
   *   - **`itemFrames`** — the plugin's own count **for the item its tap is on** (v1.9.25,
   *     `NaviliteSpectrum.SpectrumAnalysis.frames`). It is zero at the install and grows only while
   *     that item's analysis measures, so growth is the whole test: no baseline to get wrong and no
   *     process-lifetime number to subtract. A tap measuring *silence* keeps growing it, and a tap
   *     whose analysis is gone stands still — which is the difference the engine could not read
   *     before, and the reason this defect looked like the owner's *"there isn't enough silence"*.
   *   - **`frames`** — the tap's process-lifetime counter, for a bridge whose plugin predates
   *     `itemFrames`. Its growth is only attributable while the plugin says the tap is on the item
   *     the player is playing (the caller's `itemIsCurrent` gate), the first attributable read is a
   *     *baseline* rather than a count (growth before it cannot be told apart from the previous
   *     item's), and a read that finds the tap off this item rewinds the baseline
   *     (`forgetTapFrames`). It can only ever under-count, and it cannot state another item's frames
   *     as this one's.
   *
   * It is never reset by a clock: only by a new item, or by the tap leaving this one.
   *
   * @returns true when the counter moved — i.e. when the frame in hand is a measurement of this item
   *   that the engine has not drawn yet.
   */
  private noteTapFrames(frame: NativeSpectrumFrame): boolean {
    if (typeof frame.itemFrames === 'number') {
      const moved = this.tapFramesAtLastRead === null ? frame.itemFrames > 0 : frame.itemFrames > this.tapFramesAtLastRead;
      this.tapFramesForItem = frame.itemFrames;
      this.tapFramesAtLastRead = frame.itemFrames;
      return moved;
    }
    if (this.tapFramesAtLastRead === null) {
      this.tapFramesAtLastRead = frame.frames;
      return false;
    }
    const moved = frame.frames > this.tapFramesAtLastRead;
    this.tapFramesForItem += Math.max(0, frame.frames - this.tapFramesAtLastRead);
    this.tapFramesAtLastRead = frame.frames;
    return moved;
  }

  /**
   * Forget the frames seen so far: a new item is starting, or the tap is no longer on this one.
   *
   * Called at every start and adoption (the item is new) and from the orphan branch of
   * {@link pollSpectrum} (the tap is somewhere else, so the growth in between describes neither item).
   */
  private forgetTapFrames(): void {
    this.tapFramesForItem = 0;
    this.tapFramesAtLastRead = null;
  }

  /**
   * Say why the bars are what they are, once per distinct sentence (v1.9.24).
   *
   * The poll runs at {@link SPECTRUM_POLL_MS}, and several of the states it reports persist for the
   * length of a transition or a track — so a sentence written straight from the poll would repaint
   * the screen thirty times a second with the same words. Same output, one write.
   */
  private setSpectrumReason(reason: string): void {
    if (this.modeReason === reason) return;
    this.modeReason = reason;
    this.emit();
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
     *
     * v1.9.22 — the request takes the install ownership like any other, so a `false` from it is not
     * confused with a `false` from an install that a newer request has overtaken (see
     * {@link claimSpectrumInstall}); a verify's own answer changes nothing else, as it never has.
     */
    const serial = this.claimSpectrumInstall(track);
    void bridge.startSpectrum(track.url, this.nativePositionMs).then(
      (started) => void this.settleSpectrumInstall(serial, started === true),
      () => void this.settleSpectrumInstall(serial, false),
    );
  }

  /**
   * Put the tap on the item a load has just put in place, and say so if it will not go.
   *
   * v1.8.0 — this is the install, and it is the only place a load installs. `bridge.load` has
   * resolved, so the player's current item is the new one and the plugin's `attach` — which verifies
   * an item that already carries this tap and installs on any other — lands on the item that is
   * about to be heard. Called after a load and nowhere else; a resume reaches the same plugin method
   * through {@link verifySpectrum}, where it is a verify.
   *
   * v1.9.22 — **one install request, and only the newest one may answer for this track.** Every
   * request that reaches the plugin is answered (`true`, `false`, or a rejection the bridge turns
   * into `false`), and the plugin itself rejects a request a newer one has overtaken — so a track's
   * install answer arrives out of order with respect to the requests. Writing `spectrum off` and
   * *"the tap did not start"* from a superseded request's answer is a verdict about the wrong
   * request, on the track the listener is hearing; the serial is what keeps the answer with the
   * request that owns it. The newest request's own answer is kept on {@link spectrumInstall}, where
   * {@link confirmSpectrum} reads it.
   *
   * v1.9.24 — **and a `false` is no longer a verdict.** It used to clear `spectrumArming` and start a
   * 5 s timer (`retrySpectrumOnce`), i.e. it stated *native audio* about a track, out of one answered
   * request, and then asked again on a clock. Both halves are the defect this release removes: the
   * ways the plugin refuses are transient by construction — a named slot with no loaded item is a
   * real state for the length of a `fillSlot` (`src/player/native.ts:791`), and a request a newer one
   * overtook says nothing about this track at all — so the answer is reported on the reason line and
   * the *poll* does the asking: a tap that is not on this item is an orphan sighting, and the orphan
   * branch of {@link pollSpectrum} re-verifies on the plugin's own evidence, rate-limited, for as long
   * as the state lasts. Nothing here decides that this track cannot have a spectrum.
   */
  private attachSpectrum(track: TrackRequest): void {
    const bridge = this.native;
    if (this.backend !== 'native' || !bridge?.startSpectrum) return;
    const serial = this.claimSpectrumInstall(track);
    void bridge
      .startSpectrum(track.url, this.nativePositionMs)
      .then((started) => {
        // A request a newer one has overtaken is not a verdict about anything this engine holds.
        if (!this.settleSpectrumInstall(serial, started === true)) return;
        if (this.track !== track || this.backend !== 'native') return;
        if (started) return;
        this.setSpectrumReason(
          'the plugin has no tap on the item that is playing yet — it answered that this request did not start, so the engine keeps asking while the bars follow the audio',
        );
      })
      .catch((error: unknown) => {
        if (!this.settleSpectrumInstall(serial, false)) return;
        if (this.track !== track) return;
        this.spectrumLive = false;
        this.setSpectrumReason(
          `the plugin did not put a tap on the item that is playing (${error instanceof Error ? error.message : String(error)}) — the engine keeps asking while the bars follow the audio`,
        );
      });
  }

  /**
   * Take ownership of the tap's next answer (v1.9.22).
   *
   * Every request the engine makes for the tap — an install after a load, the verify a resume or a
   * re-check makes — is given a serial, and only the newest serial's answer is allowed to describe
   * this engine's state. The plugin answers out of order by construction: it rejects a request a
   * newer one has overtaken, so an *older* request's `false` and a *newer* request's `true` both
   * exist at once, and one of them is a lie about the track that is playing.
   */
  private claimSpectrumInstall(track: TrackRequest): number {
    const serial = (this.spectrumInstallSerial += 1);
    this.spectrumInstall = { track, serial, answered: false, ok: false };
    return serial;
  }

  /** Record what a request answered. False when a newer request has taken the ownership. */
  private settleSpectrumInstall(serial: number, ok: boolean): boolean {
    const install = this.spectrumInstall;
    if (install === null || install.serial !== serial) return false;
    install.answered = true;
    install.ok = ok;
    return true;
  }

  /**
   * Confirm the tap for the track a load has just put in place (v1.9.22) — one plugin call, made
   * unless the install that request made for this track has already answered that it landed.
   */
  private confirmSpectrum(track: TrackRequest): void {
    if (this.backend !== 'native' || this.state !== 'playing') return;
    const install = this.spectrumInstall;
    if (install !== null && install.track === track && install.answered && install.ok) return;
    this.verifySpectrum();
  }

  /**
   * One retry for an install that did not take is **deleted** (v1.9.24).
   *
   * It was a `setTimeout` of {@link SPECTRUM_RECHECK_MS} per failed install, and it existed because
   * the recheck budget in `pollSpectrum` only reached a tap that was *polling* while an orphaned tap
   * was the one case that reported anything. The retry is the poll's now, on the plugin's own
   * evidence: an item with no tap on it reads `itemIsCurrent: false`, the orphan branch of
   * {@link pollSpectrum} sees it and re-verifies, rate-limited — which is the same ask, keyed to the
   * item rather than to a timer, and it is the shape §24.6.2 of the diagnosis requires.
   */

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
