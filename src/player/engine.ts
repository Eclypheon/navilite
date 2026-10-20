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
import { createNativeBridge, BRIDGE_BUILD_TIMEOUT_MS, type NativeBridge, type NativeBridgeEvents, type NativePlaybackFacts, type NativeSnapshot } from './native.ts';
import { STOPPED_WORD, reduce } from './engine-contract.ts';
import type { EngineOptions, EngineState, EngineStatus, PlaybackBackend, PlayerEvent, QueueStatement, TrackRequest, VisualiserTone, VisualiserWord } from './engine-contract.ts';
import { measuredDurationIsBelievable, withDeadline } from './engine-helpers.ts';
import { WarmPool } from './warm-pool.ts';

/**
 * How long a `resume()` is given to turn into actual playback before the engine stops believing it.
 *
 * A resume on the queue's own transport is a request, not a fact: AVPlayer can decline to come back
 * after an interruption or a route change, and the plugin answers the *call*, not the state. Asking the
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


/** ~1.8 s of silence from the analyser while audio is definitely playing = not real samples. */
const ZERO_FRAMES_BEFORE_THEME = 18;
/**
 * The same, in native-tap polls (every {@link SNAPSHOT_POLL_MS}): 12 polls is ~0.4 s, and the tap
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
/**
 * How often the native bands are read.
 *
 * 30 Hz, not the canvas's 60: the canvas redraws the last frame every animation frame, and what the
 * owner can see of a bar is its height, so 30 measurements a second is motion, not stepping.
 */
const SNAPSHOT_POLL_MS = 33;
/** The clock is reported while playing at this rate, so the display never sits still. */
/**
 * How recently a player report has to have arrived for the clock tick to skip its own redraw (v1.9.7).
 *
 * The player reports its position roughly every 100 ms, and every one of those reports already
 * redraws the screen through `emit()`. The tick is there so the clock keeps moving when nothing else
 * is arriving — it is not a second repaint on top of reports that are. A tick that lands within this
 * window of the player's own word does nothing but the end-of-track check.
 */
/**
 * How long the engine waits before asking again about a tap that is on the wrong item.
 *
 * v1.8.0 — much shorter than {@link SPECTRUM_RECHECK_MS}, because this is not a tap that is broken,
 * it is a track change: the tap has to be moved onto the item that is now playing, and the bars are
 * dark for exactly as long as that takes. One second is the backstop; the load's own install is the
 * path that gets it right on the first try.
 */
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
/**
 * How close to the item's own end the clock has to sit to count as *pinned* there (v1.9.5).
 *
 * Much narrower than {@link NATIVE_END_SLACK_MS}: this is not "the last second of a track", it is
 * "the clock has stopped moving because the player stopped playing", and the position it has
 * stopped at is the end of the item because `nativeClock` clamps there while `playing`.
 */
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
 * are (one at a time, at {@link SNAPSHOT_POLL_MS}) so a tap that comes back is drawn on the next
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
  /**
   * **The bars are drawn from the last snapshot** (unreleased) — one register, written by the one
   * poll and read by the canvas, which never calls the bridge itself.
   */
  private spectrumLive = false;
  /**
   * The chip's third word: the transport is playing and this item's tap has not answered yet. It is
   * derived from the snapshot now, not from a verdict the engine took.
   */
  private spectrumArming = false;
  private nativeBands: Uint8Array | null = null;
  /** **The published state of the one player**, exactly as the phone answered it. */
  private lastSnapshot: NativeSnapshot | null = null;
  /** The one interval in the snapshot path (unreleased): {@link SNAPSHOT_POLL_MS}. */
  private snapshotPoll: ReturnType<typeof setInterval> | null = null;
  /** One read in flight at a time: a bridge slower than the tick must not answer out of order. */
  private snapshotReadInFlight = false;
  /** When this item's tap last produced a frame — the snapshot's own stamp, not a poll count. */
  /** The watchdog's pin (v1.9.5): the last live frame arrived at the end of the track. */
  /** The plugin's own last report, verbatim, for the reason line — never acted on. */
  private lastPluginState: { state: string; reason: string; currentTimeMs: number; durationMs: number } | null = null;
  /** The app's own account of why the row says what it says — one sentence, written where it is known. */
  private modeReason = 'nothing playing yet';
  /** Every start `play` has issued this session — the return record reads it. */
  private startsIssued = 0;
  /** Which player holds the sound: the app's own, or the queue that is making it. */
  private soundOwner: 'app' | 'queue' | 'none' = 'none';
  private soundOwnerSongId = '';

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
   * to make *this* start's item audible (`bridge.play` on a cold load, `bridge.load` on one that
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
   * The tracks the bridge is holding warm: `songId -> the exact URL it was warmed under` (v1.9.5).
   *
   * The pool's rules — its capacity, the drop order, which read means what, and the difference
   * between giving a claim back and dropping one — live in {@link WarmPool}. What stays here is who
   * is allowed to claim and every path a claim leaves by, each named at its site: the track is
   * started and answered (`startNative`), a warm that did not happen (`prepareNext`), the
   * pool is full ({@link WarmPool.trim} from `prepareNext`), the queue knows the chain has moved
   * (`pruneWarmed`), the engine is stopped or the track list cleared (`discardPrepared`), and a cold
   * load clears it outright.
   */
  private readonly warm = new WarmPool(MAX_WARM_TRACKS);
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
   * including the boundary's load — has to wait behind. One at a time, coalesced to the newest
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
  /**
   * Whether the track was playing when the app went out of sight.
   *
   * The invariant the owner asked for, in his words: *"resuming from background is still causing
   * the song to pause i want it to continue playing seamlessly"*. A hand-off, an interruption or a
   * session another app took can all leave the player stopped; if it *was* playing when it left,
   * coming back puts it back to playing rather than reporting a pause nobody asked for.
   */
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
   * what "next" means, so it owns this too: it is a *read* — the audio is already playing — and
   * the handler is awaited where the answer matters (the return to the foreground reads the player's
   * record and hands it over before anything else is read).
   */
  onAdvancedNatively: ((songId: string, index: number, positionMs?: number) => void | Promise<void>) | null = null;

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
      /* The element's own numbers, and the duration the rest of the app would show (`durationMs`):
       * a ticker that hands an estimate the library contradicts to the lock screen's position state
       * would be the same 70:01 through a second door (`t_972b8fc5`). */
      this.onProgress?.(this.el.currentTime * 1000, this.durationMs());
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
      this.startSnapshotPoll();
      this.startConsumers();
      return;
    }
    const reason =
      next === 'paused'
        ? 'paused — the spectrum is a picture of what is being heard'
        : next === 'ended'
          ? 'the track ended'
          : next === 'interrupted'
            ? 'the audio stopped without being asked (a call, another app, or the session being interrupted) — one tap on play restarts it here'
            : next === 'loading'
              ? 'loading'
              : 'nothing playing';
    this.stopSnapshotPoll();
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
   *
   * **And a report that contradicts the track's own duration is not evidence about this item
   * (`t_644f6085`).** The pair of numbers in the facts describes whatever the *transport* believes
   * the item to be, and on the iOS build the transport's duration is an estimate AVFoundation makes
   * about a container it was told not to read (`AVURLAssetPreferPreciseDurationAndTimingKey: false`):
   * 4201.84 s for this 210.35 s Opus track. Compared against that, a real end never lands — so the
   * not-playing report at the end of every Opus track was read as an *interruption*, and the queue
   * never moved on. A measurement the track's own duration contradicts is therefore dropped here, and
   * the app's own reading (`nativeAtEnd`) decides instead, exactly as it does when the plugin sent no
   * duration at all.
   */
  private reportIsAtEnd(facts: NativePlaybackFacts | undefined): boolean {
    const durationMs = this.believableMeasuredMs(this.factsDurationMs(facts));
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
    /*
     * **A start that has already ended is not waited on a second time (unreleased).**
     *
     * `concludeStart` records the ending even when no caller is waiting yet — the app leaving the
     * screen in the middle of a load is exactly that, and it is not a failure: the reports stop
     * arriving and the return path reads the player. Without this line the start was waited on again
     * afterwards, ran its whole deadline, and turned that harmless ending into `failure`/`error`
     * fifteen seconds later, over a row that was only ever waiting for a read.
     */
    if (this.startOutcome !== null) return Promise.resolve(this.startOutcome);
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

  /**
   * **The one cadence (unreleased).** {@link SNAPSHOT_POLL_MS}: one bridge call, one snapshot, and
   * every consumer renders from it. It replaces the 200 ms clock tick, the 33 ms spectrum poll and
   * the return's own reading — there is one interval in this path, and it is this one.
   */
  /** The web path's meter: the same samples the canvas reads, at the analyser's own pace. */
  private startMeter(): void {
    if (this.meterTimer !== null) return;
    this.meterTimer = setInterval(() => this.sample(), METER_INTERVAL_MS);
    this.sample();
  }

  /**
   * Start the one poll. `immediate` is false at the one site that has just made the read itself —
   * the return to the app (`handleVisibility(false)`) — because a return is *one* read: a second one
   * 0 ms after it would be the same answer twice and a second bridge call the card counts.
   */
  private startSnapshotPoll(immediate = true): void {
    if (this.snapshotPoll !== null) return;
    this.snapshotPoll = setInterval(() => void this.pollSnapshot(), SNAPSHOT_POLL_MS);
    if (immediate) void this.pollSnapshot();
  }

  private stopSnapshotPoll(): void {
    if (this.snapshotPoll === null) return;
    clearInterval(this.snapshotPoll);
    this.snapshotPoll = null;
  }

  /**
   * **One read of the one player, applied (unreleased).** The row's entry, the clock and the bars
   * come out of the same answer, dated to the same item: a frame whose `itemKey` is not the entry's
   * key is never drawn, and a frame from a tap slower than this tick is still live because nothing
   * here compares it to the tick — the drawing rule is the producer's own `framePeriodMs`.
   */
  private async pollSnapshot(): Promise<void> {
    const bridge = this.native;
    if (!bridge?.snapshot || this.backend !== 'native') return;
    if (this.snapshotReadInFlight) return;
    this.snapshotReadInFlight = true;
    let snap = null;
    try {
      snap = await bridge.snapshot();
    } finally {
      this.snapshotReadInFlight = false;
    }
    if (!snap) return;
    if (snap.generation !== 0 && snap.generation !== this.generation) return;
    this.lastSnapshot = snap;
    this.applySnapshot(snap);
  }

  /// What one snapshot says, applied to the engine's own registers.
  private applySnapshot(snap: NativeSnapshot): void {
    if (this.track) {
      this.setNativePosition(snap.positionMs);
      if (snap.durationMs > 0) this.nativeDurationMs = snap.durationMs;
    }
    const frame = snap.spectrum;
    const dated = frame.attached && frame.itemKey !== '' && frame.itemKey === snap.entry.key;
    if (dated) {
      const bands = frame.bands;
      if (!this.nativeBands || this.nativeBands.length !== bands.length) this.nativeBands = new Uint8Array(bands.length);
      for (let i = 0; i < bands.length; i += 1) this.nativeBands[i] = bands[i];
      this.spectrumArming = false;
      if (!this.spectrumLive) {
        this.spectrumLive = true;
        this.modeReason = 'real spectrum — an FFT of the stream this player is playing, read from the item’s own tap';
        this.emit();
      }
      return;
    }
    this.nativeBands = null;
    this.spectrumArming = this.state === 'playing';
    if (this.spectrumLive) {
      this.spectrumLive = false;
      this.modeReason = snap.spectrum.attached
        ? 'the frame the tap is holding belongs to another item — the bars wait for this item’s own'
        : 'nothing is attached to the item that is playing — the bars follow the audio';
      this.emit();
    }
  }

  private clockNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Is the away queue's player the one making the sound? (unreleased, `t_05775526`) */
  private queueOwnsSound(): boolean {
    return this.backend === 'native' && this.soundOwner === 'queue';
  }

  /**
   * State the sound's owner, and say so on the reason line — because the next capture has to be able
   * to read which player the row believed without guessing. Called only from a fact about a player,
   * never from a state this side would like to be true.
   */
  private claimSound(owner: 'app' | 'queue' | 'none', songId = '', why = ''): void {
    if (this.soundOwner === owner && this.soundOwnerSongId === (owner === 'none' ? '' : songId)) return;
    this.soundOwner = owner;
    this.soundOwnerSongId = owner === 'none' ? '' : songId;
    if (why) this.modeReason = why;
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

  /**
   * The transport's own measurement of this item, as far as the app will take it (`t_644f6085`,
   * `t_972b8fc5`).
   *
   * One spelling of the rule for the checks that judge a measurement — {@link measuredDurationIsBelievable}
   * carries the whole of it and the files it was measured on — so a number the library contradicts
   * reads 0 here whichever transport reported it, and the caller falls back to the track's own
   * duration. Zero is not a duration, it is the absence of a believable measurement.
   */
  private believableMeasuredMs(measuredMs: number): number {
    return measuredDurationIsBelievable(this.track?.durationMs ?? 0, measuredMs) ? measuredMs : 0;
  }

  /**
   * Duration in ms: the transport's own when it reports one **the track's own duration does not
   * contradict**, the track metadata otherwise.
   *
   * `t_644f6085` — the measurement is not automatically the better number, and on the iOS transport
   * it is the worse one: see {@link measuredDurationIsBelievable}, which carries the whole of the rule
   * and the four files it was measured on. What this function adds is that the rule is applied *where
   * the number is read*, so the bar's label, the clock's clamp, the end-of-item tests and the
   * spectrum's near-end window all get the same answer from the same place.
   *
   * **And the web path is gated by the same rule (`t_972b8fc5`), because its transport lies too.**
   * `t_d3de2a88` measured the shipped bytes over HTTP on the three real Opus files: Chrome reads the
   * container exactly (210.3475 s for `Tank!.opus`), but WebKit-on-iOS answers **4201.84 s** for that
   * same file, 296.08 s and 190.14 s for the other two, MP3/FLAC within 30 ms — *digit for digit the
   * three numbers the AVFoundation transport returns on the native path* — and the app painted 70:01
   * on the bar and on the now screen. `el.duration` is therefore not the container's own last-granule
   * answer as a rule; it is a measurement, and it is checked like one. Chrome's exact readings, and any
   * track whose own duration is unknown (a stream, a blank row), keep the element's number unchanged.
   */
  private durationMs(): number {
    if (this.backend === 'native') {
      return this.believableMeasuredMs(this.nativeDurationMs) || (this.track?.durationMs ?? 0);
    }
    return this.believableMeasuredMs(this.el.duration * 1000) || (this.track?.durationMs ?? 0);
  }

  status(): EngineStatus {
    const durationMs = this.durationMs();
    const positionMs = this.backend === 'native' ? this.nativeClock() : this.el.currentTime * 1000;
    const plugin = this.lastPluginState;
    const snap = this.lastSnapshot;
    const frame = snap?.spectrum ?? null;
    /*
     * The chip's third word (v1.9.6), and it is a fact about the *whole* state, not just the tap:
     * only a track that is playing can be waiting for its bars. A paused, ended or loading item has
     * no frames coming — and what it says about that is the transport's own word, never
     * *native audio* (v1.9.26; see {@link VisualiserWord}). Computed once, here, and handed to both
     * the field and the word below so the two cannot disagree.
     *
     * The window is `spectrumArming`, and the snapshot is what writes it: the tap is attached and
     * has produced no frame for this item yet. Nothing is inferred from a poll count any more.
     */
    const arming = this.state === 'playing' && (this.spectrumArming || this.analyserArming());
    return {
      state: this.state,
      backend: this.backend,
      spectrum: this.spectrumLive,
      spectrumArming: arming,
      /*
       * The chip's word, from the facts and nothing else (v1.9.26) — one place, so the mini-player
       * and anything else that shows the mode read the same one.
       */
      visualiser: this.visualiser(arming),
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
      droppedEvents: this.native?.droppedEvents?.() ?? { inaudible: 0, slotGrace: 0 },
      warmedIds: this.warm.ids(),
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
        identity: 'identity: this build has no native boundary to report',
        timeline: 'gap: this build has no native boundary to time',
        startedAt: 0,
        foreground: null,
      },
      positionMs: Number.isFinite(positionMs) ? positionMs : 0,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      error: this.error,
      nativeAvailable: this.native !== null,
      /*
       * The snapshot the row is rendering, verbatim: which item the frame is dated to, how many frames
       * that item's tap has produced, and the pace it declared for itself. Numbers the phone
       * measured — this side decides nothing from them beyond "same item or not".
       */
      tap: {
        itemKey: frame?.itemKey ?? null,
        entryKey: snap?.entry.key ?? null,
        framesForItem: frame?.frames ?? 0,
        attached: frame?.attached ?? false,
        framePeriodMs: frame?.framePeriodMs ?? null,
        lastAnalysisAt: frame?.lastAnalysisAt ?? null,
      },
    };
  }

  /**
   * **The chip's word, and the tone it wears** (v1.9.26) — the answer to *"what is the visualiser
   * doing for the item in hand, and why"*, in one place, from the engine's own facts.
   *
   * Two reasons produce "nothing is being measured", and before this they were one word:
   *
   *   - **the item cannot be measured** — this build has no tap on its native player, or (on the web)
   *     no Web Audio, or a verdict about *this* item's samples while it plays. The capability words
   *     (`native audio`, `theme`) are licensed *only* here.
   *   - **the transport is not playing** — nothing is heard, so the bars are a picture of nothing
   *     (`disarmConsumers`). The word is the transport's own state.
   *
   * Reaching the first by *elimination* — the expression this replaces — is the defect: on the
   * owner's phone every paused track on a playlist page read `NATIVE AUDIO`. What the words may not
   * do is claim a capability the app has not lost, and a stopped transport is not evidence about a
   * capability at all.
   *
   * @param arming the engine's own third-word fact, computed once in `status()` so this and the
   * field it is derived from cannot disagree.
   */
  private visualiser(arming: boolean): { word: VisualiserWord; tone: VisualiserTone } {
    const word = this.visualiserWord(arming);
    /*
     * v2.0-beta — **the tone is computed from the fact, not read off the word.**
     *
     * The word is `spectrum` both while the bars are being fed and while this item's answer is still
     * coming, so the distinction has to be made here, from `arming`: it can no longer be inferred
     * from the string, because the string is the same one in both cases. (Until v2.0-beta this was
     * `word === 'spectrum…' ? 'arming' : 'live'`, and the window was a second word.)
     */
    const tone: VisualiserTone =
      word === 'spectrum'
        ? arming
          ? 'arming'
          : 'live'
        : word === 'native audio' || word === 'theme'
          ? 'fallback'
          : // Neither a measurement nor a fallback: the transport, doing what it is doing. It is
            // not a failure state and must not wear the amber of one (v1.9.6 made the same
            // argument for `arming`, and the same reasoning applies to a pause).
            'stopped';
    return { word, tone };
  }

  /** The word alone — see {@link VisualiserWord} for what each one claims. */
  private visualiserWord(arming: boolean): VisualiserWord {
    if (this.spectrumLive) return 'spectrum';
    /*
     * v2.0-beta — **the arming window wears `spectrum` now, and it must still short-circuit the
     * capability branch below.** The window itself is untouched (a playing item whose measurement
     * has not answered yet — a tap in flight, an analyser without this item's first frame, and every
     * way into `playing` that is not a start); only the word it wears changed, when the owner
     * reversed §515.4 and asked for one word per capability. What tells the two apart is the tone
     * (`visualiser`). Deleting this branch instead of re-wording it would put the window back on
     * `theme` / `native audio`, which is precisely the defect v1.9.27 exists to fix.
     */
    if (arming) return 'spectrum';
    /*
     * Nothing is being measured, and there are two different reasons — the whole of this fix. First
     * the question the UI could not ask: **can this build measure this item at all?** An evidenced
     * `none` is the only thing the capability words are allowed to mean, and a build with no tap
     * wears `native audio` in every transport state, because that is true in every one.
     */
    if (this.measuringPathForTheItem() === 'none') return this.backend === 'native' ? 'native audio' : 'theme';
    /*
     * There is a path (or the load has not answered for one yet), and it is not feeding the bars:
     *   - the transport is not playing — nothing is heard, so there is nothing to be a picture of.
     *     The word is the transport's own, whatever the last verdict was: a pause is not evidence
     *     about the samples, and this is the state the owner was reading a capability claim in;
     *   - the transport *is* playing, and this item's own measurement has given its verdict: this
     *     item's tap reading silence, the same frozen frame over and over, or samples the browser
     *     will not hand over. (A path that is still `unknown` while the transport plays is not
     *     reachable — both starts build their path before the player is asked to play — and if it
     *     ever were, this line is the honest word.)
     *
     * **v1.9.27 — the window that is neither of those is above this line, not here** (cards
     * `t_71dc787e` and `t_c8cc01c6`). A playing item whose measurement has not answered *yet* — a
     * native tap in flight, an analyser that has not produced this item's first frame, and now
     * **every way into `playing` that is not a start** (a resume, a return from the background) — is
     * `spectrum…`, which is what `arming` says and what this branch used to be reached by instead: on
     * a browser it spent `theme` for ~128 ms at the start of every track, and on the native path it
     * spent `native audio` at every resume. What is left here is only the item's own verdict — the
     * tap's silence or frozen frame for this item (or no tap at all, above), the analyser's own
     * `ZERO_FRAMES_BEFORE_THEME` of unusable samples on the web path.
     */
    if (this.state === 'playing') return this.backend === 'native' ? 'native audio' : 'theme';
    return STOPPED_WORD[this.state];
  }

  /**
   * **Can this build measure the item in hand at all?** (v1.9.26) — the fact the UI could not read,
   * and the one that separates *"nothing is being measured because nothing is playing"* from *"the
   * spectrum cannot run here"*.
   *
   *   - `tap` / `analyser` — the path exists: the bridge's native tap (`hasNativeSpectrum`, the iOS
   *     plugin), or the web path's own samples (`createMediaElementSource → AnalyserNode`, v1.7's one
   *     copy of the stream).
   *   - `none` — the absence is **evidenced**: a bridge that is built and says it has no tap
   *     (Android today), a browser whose Web Audio graph could not be built.
   *   - `unknown` — nothing has answered yet. A bridge still being built is a *load in progress*
   *     (`startNative` builds it inside the start, and a build that fails reports `error`), and a
   *     graph that has not been reached yet is the same; neither is a fact about what this build can
   *     do, so neither may spend a capability word — the transport's own word is what is happening.
   *
   * Two things are deliberately *not* read as `none`: a suspended audio context (a lifecycle fact —
   * the browser suspends Web Audio when the page is hidden, and the visualiser re-arms on the way
   * back in) and a cross-origin stream the library will not hand over (a verdict about *this* item's
   * samples, which is spoken while it plays).
   */
  private measuringPathForTheItem(): 'tap' | 'analyser' | 'unknown' | 'none' {
    // No item in hand: there is nothing to make a capability claim *about*, and the transport's own
    // word ("idle") is what is happening. The bar is hidden in this state — this is the engine's own
    // fact being right rather than a screen being read.
    if (this.track === null) return 'unknown';
    if (this.backend !== 'native') {
      if (this.graphFailedReason !== null) return 'none';
      return this.analyser === null ? 'unknown' : 'analyser';
    }
    const bridge = this.native;
    if (bridge === null) return 'unknown';
    return this.hasSpectrumTap() ? 'tap' : 'none';
  }

  /**
   * **The web path's own arming window** (v1.9.27, card `t_71dc787e`) — §515.4's word, on the
   * analyser: the item in hand is playing, the graph exists and the analyser has **not answered for
   * this item yet**, because it has not been given
   * {@link ZERO_FRAMES_BEFORE_THEME} frames it could use.
   *
   * The defect it closes, measured in Chrome at 393x852 over the mock library (`d769fd4`, read off
   * `test/chip-word-browser.test.ts`'s own word list):
   *
   * ```
   * 384 ms  "theme"    (the chip changed, state playing)
   * 512 ms  "spectrum" (the chip changed, state playing)
   * ```
   *
   * The amber capability word for 128 ms at the start of a track, on a browser whose Web Audio graph
   * was built and working: the licence `visualiserWord` reached it by said *"if the transport is
   * playing and the bars are not being fed, the spectrum cannot run on this item"*, and the window
   * between `createMediaElementSource` and the analyser's first real frame was inside that. On this
   * path there are two very different reasons for "no frames", and the register that separates them
   * is the one the meter already keeps for the verdict:
   *
   *   - **no frame for this item yet** (`zeroFrames` below the verdict) — the spectrum is coming.
   *     This method, and the chip's `spectrum…`.
   *   - **frames for this item that are not real** (the verdict passed: `ZERO_FRAMES_BEFORE_THEME`
   *     analyser frames of silence, or one frozen frame over and over) — a genuinely unmeasurable
   *     item, which is the *only* thing `theme` may mean (`sample()` writes that verdict, and
   *     `silenceReason` names the case).
   *
   * The register is **per item** — `startWeb` clears it for the item that is starting, exactly as
   * `forgetTapFrames` clears the native tap's count (v1.9.24) — so an item that has just started an
   * unmeasurable stream wears its own `spectrum…` before its own verdict, and never the verdict the
   * previous item's samples left behind. A graph that could not be built is not this window and is
   * not asked about here: that is an evidenced `none` (`measuringPathForTheItem`), which spends the
   * capability word from the first paint.
   *
   * **`spectrumLive` is half the question, and it is the first half.** A register that has counted
   * nothing because a real frame keeps arriving is not a window — it is the bars being drawn (the
   * counter is reset by every frame the analyser answers with, so `zeroFrames === 0` is true in both
   * states). As a *field* on the status this has to be exact: `EngineStatus.spectrumArming` means
   * "`spectrum` is false and the spectrum is not lost", and a status that said both `spectrum: true`
   * and `spectrumArming: true` would be the debug line contradicting itself.
   */
  private analyserArming(): boolean {
    if (this.backend !== 'web' || this.analyser === null) return false;
    if (this.spectrumLive) return false;
    return this.zeroFrames < ZERO_FRAMES_BEFORE_THEME;
  }

  /**
   * Whether this build's native bridge has the spectrum tap at all — the one question, asked in one
   * place, by both the consumers' arming and the chip's word.
   */
  private hasSpectrumTap(): boolean {
    const bridge = this.native;
    return bridge?.hasNativeSpectrum === true;
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
           *
           * **Except where that answer is not about this item at all (`t_644f6085`).** The number is
           * still kept here, verbatim, because `pluginState` is the phone's own account and the
           * account is what makes a device-only failure readable — but a measurement the track's own
           * duration contradicts never reaches the screen: `durationMs()` reads the same rule
           * (`measuredDurationIsBelievable`) when it decides what to show, and says so here while it
           * is doing it, which is what tells a reader of the reason line that the 70:01 beside the
           * 3:30 came from the transport and not from the library.
           */
          if (factDurationMs > 0) {
            const knownMs = this.track?.durationMs ?? 0;
            if (!measuredDurationIsBelievable(knownMs, factDurationMs) && knownMs > 0) {
              this.modeReason =
                `the player measures this item at ${(factDurationMs / 1000).toFixed(1)} s and the track's own ` +
                `duration is ${(knownMs / 1000).toFixed(1)} s — the track's is the number shown, the player's is an ` +
                `estimate about a container its transport never read`;
            }
            this.nativeDurationMs = factDurationMs;
          }
          /*
           * **A report from the player that is not the sound does not move the clock either
           * (unreleased, `t_05775526`).** This wrote the app's own position whatever was sounding, so
           * the row over the away queue's four-minute sound snapped to the silent player's `0` on the
           * first report after the return — the seekbar frozen at the top of the track beside a track
           * that was four minutes in. The position belongs to the owner, as the state does.
           */
          if (Number.isFinite(facts?.currentTime) && !this.queueOwnsSound()) {
            this.setNativePosition(Math.max(0, (facts?.currentTime as number) * 1000));
          }
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
            /* A player that is playing is making a sound: it owns the row (unreleased). */
            this.claimSound('app', this.track?.id ?? '');
            return;
          }
          /*
           * **The app's own player going quiet is not news about a sound it is not making
           * (unreleased, `t_05775526`).**
           *
           * This is the steady-state writer of the owner's report: the away queue holds the sound,
           * the app's player holds the same entry loaded and paused, and its state report arrived
           * every few hundred milliseconds as an `interruption` — so even a return that had rendered
           * the queue's reading (playing, at the right second) was flipped back to a play icon
           * within the second, and the clock and the spectrum went with it. The queue's own reading
           * (`renderReading`) is the row's truth for as long as it owns the sound.
           */
          if (this.queueOwnsSound()) return;
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
         * already audible, and `nativeMovedTo` is the single account of that.
         */
        onAdvanced: (songId, index, positionMs) => {
          if (this.backend !== 'native' || !songId) return;
          void this.onAdvancedNatively?.(songId, index, positionMs);
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

  async play(track: TrackRequest, startMs = 0, force = false): Promise<void> {
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
    /*
     * `force` is the one way past the idempotence rule: a caller that knows the player has to be
     * asked for this entry again (a row press after the queue stopped on it) says so.
     */
    if (!force && this.track?.id === track.id && this.state === 'playing') {
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
    /*
     * The counter a return that ADOPTS must leave alone (unreleased). Counted here, past the two
     * early returns above, because those issue nothing: this is the point past which a start is real.
     */
    this.startsIssued += 1;
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
      /*
       * **And only now does the queue let go (v2.0-beta.18).** The app’s own row has the entry
       * at the position it read; until this line the paused items were the only thing that knew where
       * the track was. A failed start keeps the reading, so the next attempt still starts there.
       */

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
    if (this.warm.matches(track.id, track.url)) return true;
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
    this.warm.claim(track.id, track.url);
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
      this.warm.release(track.id, track.url);
      return false;
    }
    this.warm.trim();
    // A new warm slot is a new candidate for the native side to play itself (v1.9.9).
    void this.syncQueue();
    return true;
  }


  /**
   * Drop the claims for tracks the queue is no longer around (v1.9.5).
   *
   * Called when a selection moves the queue: a claim for a track nobody is going to hear is a claim
   * that would make a later start use an asset the player no longer holds. The bridge's own
   * slots are not touched — they are reused by the next warm, and the pool is fixed, so dropping a
   * claim costs nothing and removes a whole class of stale state.
   */
  pruneWarmed(keep: readonly string[]): void {
    this.warm.prune(keep);
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
    return this.warm.urlOf(songId);
  }

  /**
   * Throw the warmed tracks away — the queue is not going where they were warmed for.
   */
  async discardPrepared(): Promise<void> {
    this.warm.clear();
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
    const list = this.statement.list.map((entry) => ({ ...entry, warmUrl: this.warm.urlOf(entry.songId) }));
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
   * **Render a reading the native side has answered with (unreleased).**
   *
   * The row sat on `loading` because the return's own start was issued and never committed, while
   * the sound it was waiting for was already there — the away queue's. The refusal that names the
   * entry, and where it is, is the answer: this writes that position, settles the machine on
   * `playing`, and starts nothing. The app's own player stays silent, and the reading the queue
   * read is still in hand, so one tap starts that entry at that position.
   */
  renderReading(positionMs: number): void {
    if (this.backend !== 'native') return;
    const at = Number.isFinite(positionMs) ? Math.max(0, Math.round(positionMs)) : 0;
    this.setNativePosition(at, true);
    this.loadInFlight = null;
    this.concludeStart('player');
    /*
     * **And the queue is named as the sound's owner (unreleased, `t_05775526`).** This reading *is*
     * the queue saying it holds the sound: from here the row's playing state, clock and seekbar are
     * that reading's, and the app's own player going quiet cannot take them away (see
     * {@link queueOwnsSound} and the three readers gated on it).
     */
    this.claimSound('queue', this.track?.id ?? '');
    this.dispatch({ type: 'engine-state', playing: true });
    this.modeReason = `the return was answered with ${this.track?.id ?? 'the visible entry'} at ${Math.round(at / 1000)} s — the queue holds that sound, so the row renders the reading and the app's own player stays silent; nothing is loaded, started, paused or seeked`;
    /*
     * **The bars say nothing rather than lying flat (unreleased, `t_05775526`).** The spectrum tap is
     * on the app's own player, which is not the sound here; a tap that renders "playing" over a silent
     * player is the dead spectrum in the owner's report. The visualiser therefore goes to its
     * album-art theme, and the reason line says why instead of leaving a flat row unexplained.
     */
    this.spectrumLive = false;
    this.setSpectrumReason(
      'the sound is the away queue’s, and the tap is on the app’s own player — the bars show the album-art theme rather than a flat “playing” spectrum',
    );
    this.startSnapshotPoll();
    this.emit();
    this.onProgress?.(this.nativePositionMs, this.durationMs());
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
      /*
       * **The press stops the sound the listener can hear (unreleased, `t_05775526`).** When the away
       * queue owns the sound, the app's own player is silent, and pausing it would be a write nobody
       * can hear — the music would play on under a pair of bars that had just stopped. So the pause
       * goes to the queue's player, through the one call that reaches it (`queueTransport`).
       */
      if (this.queueOwnsSound()) {
        this.dispatch({ type: 'transport', action: 'pause' });
        this.muteReports(TRANSPORT_MUTE_MS);
        this.setNativePosition(this.nativePositionMs, false);
        await this.native?.queueTransport?.('pause');
        this.modeReason = `the press paused the away queue, which is the player making the sound — the app's own player was not written to, and one more press resumes that same queue at ${Math.round(this.nativePositionMs / 1000)} s`;
        this.emit();
        this.onProgress?.(this.nativePositionMs, this.durationMs());
        return;
      }
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
      /*
       * **A resume of a paused queue resumes the queue (unreleased, `t_05775526`).** Nothing else can
       * make that sound again: `resume()` on the app's own player would start a second player over a
       * paused first one, which is the silent-take defect in its other direction.
       */
      if (this.queueOwnsSound()) {
        this.generation += 1;
        this.dispatch({ type: 'transport', action: 'play' });
        this.muteReports(TRANSPORT_MUTE_MS);
        await this.native?.queueTransport?.('resume');
        this.modeReason = `the press resumed the away queue, which is the player making the sound — at ${Math.round(this.nativePositionMs / 1000)} s, with nothing written to the app's own player`;
        this.startSnapshotPoll();
        this.emit();
        this.onProgress?.(this.nativePositionMs, this.durationMs());
        return;
      }
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
       * **The bar moves the sound, whichever player is making it (unreleased, `t_05775526`).** A seek
       * written to the app's own silent player left the audible queue exactly where it was, so the
       * owner's drag did nothing he could hear and the bar snapped back on the next reading. The
       * queue's own player is the one that is asked when it owns the sound.
       */
      if (this.queueOwnsSound()) {
        const at = Math.max(0, Math.round(positionMs));
        this.generation += 1;
        this.setNativePosition(at, false);
        await this.native?.queueTransport?.('seek', at);
        this.modeReason = `the bar moved the away queue, which is the player making the sound, to ${Math.round(at / 1000)} s — nothing was written to the app's own player`;
        this.muteReports(TRANSPORT_MUTE_MS);
        this.emit();
        this.onProgress?.(this.nativePositionMs, this.durationMs());
        return;
      }
      /*
       * **One seek in flight, and the newest target wins (v1.9.2).**
       *
       * A drag writes a value per frame and v1.9.1 sent one seek every 120 ms, all of them
       * overlapping. Each of those is a zero-tolerance seek on the plugin's own audio queue — it
       * settles only when AVFoundation reports the seek finished — so a drag was eight blocking
       * seeks a second on the very queue that every later transport call has to wait behind,
       * including a load at a track boundary. A finger on the bar could therefore stall the
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
    this.warm.clear();
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
   * true — reading that answer rather than overriding it — and re-arms the visualiser, which
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
      this.stopSnapshotPoll();
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
     * **A return is a read (unreleased).** One snapshot of the one player — the entry it is on, its
     * place in the order, the clock, whether it is making a sound, and that item's own spectrum
     * frame. Nothing is started, stopped, restarted or replaced: the app never interrupted the
     * player, so there is nothing to give back. Both halves of the row come out of the same answer,
     * dated to the same item, which is why the bars cannot lag the row.
     */
    const snap = await this.native?.snapshot?.();
    if (snap) {
      this.lastSnapshot = snap;
      this.applySnapshot(snap);
      if (snap.entry.songId && snap.entry.songId !== this.track?.id) {
        await this.onAdvancedNatively?.(snap.entry.songId, snap.entry.index);
      }
      this.modeReason = `the return read ${snap.entry.songId || 'nothing'} at ${Math.round(snap.positionMs / 1000)} s, ${snap.state} — one snapshot, nothing loaded, started, paused or seeked`;
      if (snap.state === 'paused' && this.state !== 'paused') this.applyState('paused');
      if (snap.state === 'playing' && this.state !== 'playing') this.applyState('playing');
    }
    /*
     * `syncQueue` is not a write to the player: `awake: this.foreground` inside it is the only thing
     * that tells the phone the app is back on screen, which hands the boundary to the web layer again.
     */
    await this.syncQueue();
    this.startSnapshotPoll(false);
  }

    /* ------------------------------------------------------------------ the engines */

  /** The browser's engine — the only one a browser has, and never a substitute for a native one. */
  private async startWeb(track: TrackRequest, startMs: number): Promise<void> {
    this.backend = 'web';
    this.el.pause();
    /*
     * **v1.9.27 (card `t_71dc787e`) — the analyser's register is this item's, and it starts empty.**
     *
     * `zeroFrames`, `identicalFrames` and `lastChecksum` are the web path's judgement about the
     * samples: how many frames in a row came back unusable (the verdict), how many were the same
     * frame (the frozen rule), and which frame was last seen. They are per item for exactly the
     * reason the native tap's frame count is (v1.9.24, `forgetTapFrames`): a count left over from
     * the item that just ended is **the previous item's answer**, and reading it as this one's is
     * how a new item could be spent a verdict before a single sample of it had been read. Cleared
     * here — before the element plays, so the first sample of the new item is the first one counted
     * — the new item wears its own `spectrum…` until its own samples answer.
     */
    this.zeroFrames = 0;
    this.identicalFrames = 0;
    this.lastChecksum = -1;
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
     * `spectrumLive` is cleared here for the item that is starting, ahead of its first frame, and
     * it comes back on *this* item's first live frame — which, for a track the queue already holds, is a
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
    // The register this item's frame is drawn from starts empty: the previous item's last frame is
    // not a measurement of this one. The snapshot's own `itemKey` is what keeps them apart.
    this.nativeBands = null;
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
     * **One statement, one load (unreleased).** There is no warm pool on this bridge and nothing to
     * take over: `load` names the entry the queue is to play, and the queue switches to the item it
     * already built for it.
     */
    try {
      {
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
        this.warm.clear();
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
       * **The snapshot is what answers for the tap, at the close of every load (v1.9.22).**
       *
       * v1.9.5 confirmed the tap here for one path only and left the other to `startConsumers`,
       * which is right only while the cold load is still `loading` when this bracket closes. A
       * player that reports sound *inside* the load — the thing `bridge.play` has just asked it for,
       * and what the owner's phone does — makes that false: the `playing` transition runs
       * `startConsumers` *while* this bracket is still open, `startConsumers` refuses to verify
       * there (`loadInFlight`), and the only install the track ever gets is the single
       * fire-and-forget request three lines above. An install the plugin superseded, or one that
       * answered `false`, then leaves the engine at `spectrum off` with audio playing — the state
       * the owner reported, and the one this release makes unreachable. One plugin call, and it is
       * a read of the item in hand, and the item keeps exactly the
       * verify it had.
       */
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
  /**
   * **The consumers of the published snapshot (unreleased).** One poll, at {@link SNAPSHOT_POLL_MS};
   * the canvas draws the last snapshot on its own `requestAnimationFrame` and never asks the bridge
   * for anything. Nothing is installed, re-installed or verified from here.
   */
  private startConsumers(): void {
    if (this.backend === 'web') {
      // The browser's own analyser is the measurement there: the meter samples it on its own pace.
      this.startMeter();
      return;
    }
    if (this.backend !== 'native') return;
    if (this.queueOwnsSound()) {
      this.spectrumLive = false;
      this.spectrumArming = false;
      this.setSpectrumReason(
        'the sound is the away queue’s, so the bars are drawn from the snapshot it publishes — nothing is installed or re-installed here',
      );
    } else if (!this.hasSpectrumTap()) {
      // No tap in this build (Android today, and the browser): the honest statement, and the
      // album-art theme.
      this.spectrumLive = false;
      this.spectrumArming = false;
      this.modeReason = 'this build has no spectrum tap on its native player, so the bars are on the album-art theme — the audio itself is unaffected';
    }
    this.startSnapshotPoll();
  }

  /**
   * **The queue moved to another entry by itself (unreleased).** The row follows the player: the
   * entry it is on is rendered from the reading, and nothing is loaded, started or re-attached.
   */
  nativeMovedTo(track: TrackRequest, positionMs = 0): void {
    if (this.track?.id !== track.id) this.track = track;
    this.renderReading(Math.max(0, positionMs));
  }

  /** The last snapshot the phone published, for the debug panel — never a second reading. */
  currentSnapshot(): NativeSnapshot | null {
    return this.lastSnapshot;
  }

  private disarmConsumers(reason: string): void {
    this.stopSnapshotPoll();
    this.stopMeter();
    this.nativeBands = null;
    if (this.spectrumLive) {
      this.spectrumLive = false;
      this.modeReason = reason;
    }
  }

  /**
   * Say why the bars are what they are, once per distinct sentence (v1.9.24).
   *
   * The poll runs at {@link SNAPSHOT_POLL_MS}, and several of the states it reports persist for the
   * length of a transition or a track — so a sentence written straight from the poll would repaint
   * the screen thirty times a second with the same words. Same output, one write.
   */
  private setSpectrumReason(reason: string): void {
    if (this.modeReason === reason) return;
    this.modeReason = reason;
    this.emit();
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
   * `source → analyser → gain → destination`, written once and never dismantled: the analyser is
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

    // Bands above ~10 kHz are usually empty on lossy streams, so loudness is measured over the range
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
