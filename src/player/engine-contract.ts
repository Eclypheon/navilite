/*
 * v2.0-beta slice E1 — the engine's contract, out of `engine.ts`.
 *
 * Everything here is a fact *about* the engine that other modules need and the engine does not own
 * the reading of: the state machine's states and events (`EngineState`, `PlayerEvent`, `reduce`),
 * what a caller is handed back (`PublishedTrack`, `QueueStatement`, `TrackRequest`), what the bar
 * prints (`VisualiserWord`, `VisualiserTone`, `STOPPED_WORD`, `EngineStatus`) and how the engine is
 * told about its environment (`EngineOptions`, `PlaybackBackend`).
 *
 * This is the seam that keeps a change to the pill's word cheap: the word table and the status
 * shape are ~340 lines here, rather than the first 400 of a 3,850-line file, and nothing in this
 * file reads the engine — the dependency edge only ever points this way.
 */
import { type OsName } from '../platform.ts';
import { type NativeBridge, type NativeBridgeEvents, type NativeTrackInfo } from './native.ts';

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

/**
 * The word the chip wears: **the mode the visualiser is in for the item in hand**, and never a
 * statement about the transport wearing the clothes of one (v1.9.26).
 *
 * The owner, on the v1.9.24 build he had just installed, looking at the playlist page for `Jap`
 * with a track loaded and *paused* at 1:28 / 4:55 — the screenshot reads `NATIVE AUDIO` on the
 * mini-player while the line under it reads `paused · native · spectrum off · player: paused`:
 *
 * > *"the spectrum always works but on the playlist pages, the bottom bar seems to keep flashing to
 * > native audio spectrum off even though the spectrum is working fine"*
 *
 * The word was built in the UI out of three fields (`spectrum`, `spectrumArming`, `backend`), and
 * its third branch — *native audio* — is a **capability claim reached by elimination**:
 * `spectrumArming` is only ever reported while a native track is *playing*, so every state that is
 * not playing (paused, ended, interrupted, between two tracks, nothing loaded) fell through to it.
 * On a playlist page that flips at every pause and every change, which is the flashing he describes.
 *
 * So the word is one fact about the item in hand, computed here, once:
 *
 *   - `spectrum` — the bars are being fed by that item, now. **v2.0-beta: and the same word for the
 *     window before they are.** The item in hand is playing and the thing that measures it has not
 *     answered for it yet — a native tap that is installed and to give its first frame, a web
 *     analyser that is attached and has not produced this item's first frame (v1.9.27, card
 *     `t_71dc787e`), and **every way into `playing` that is not a start** (card `t_c8cc01c6`) — a
 *     resume, a return from the background — until the tap's own answer arrives.
 *
 *     What tells that window apart from a live reading is **the tone and not a second word**
 *     (v2.0-beta): `arming` (the mid colour between the live green and the fallback amber) while no
 *     answer for this item is in hand, `live` from this item's first real frame — see
 *     {@link AudioEngine.visualiser}, which computes it from the fact rather than from the word,
 *     because the word is now the same one in both. `spectrum…` was that second word until
 *     v2.0-beta deleted it: the owner reads it as a second capability claim and wants one word for
 *     one capability (his call of 2026-10-17, `DECISIONS.md`, which supersedes §515.4). The window
 *     itself is unchanged, and the chip's tooltip still names it (`status.spectrumArming`).
 *   - the transport's own words — `idle`, `loading`, `paused`, `ended`, `interrupted`, `error` —
 *     worn when **the only reason nothing is being measured is that nothing is playing**. This is
 *     the state he was reading a capability claim in, and it is stated as what it is.
 *   - `native audio` — this build has no spectrum tap on its native player (Android today), or the
 *     tap's own verdict *while it plays* has ruled this item out (a tap reading silence for
 *     `ZERO_POLLS_BEFORE_THEME`, or returning the same frozen frame). **The one thing it may ever
 *     mean is that the spectrum cannot run on the item in hand.** A build without a tap wears it in
 *     every transport state, because that is a fact about the build and not about a moment.
 *   - `theme` — the same statement on the web path: this browser has no Web Audio, or this stream's
 *     own verdict says the samples are not real (`ZERO_FRAMES_BEFORE_THEME` analyser frames of
 *     silence, or one frozen frame over and over — `silenceReason` names which).
 *
 * What a *stopped* transport must never do is reach the capability words, and that is the whole of
 * this type: the same rule for `native audio` and for `theme`, because they are the same claim.
 */
export type VisualiserWord =
  | 'spectrum'
  | 'idle'
  | 'loading'
  | 'paused'
  | 'ended'
  | 'interrupted'
  | 'error'
  | 'native audio'
  | 'theme';

/**
 * Every state the machine can be in that is not `playing`, and the chip's word for it — **the
 * transport's own word** (v1.9.26).
 *
 * A total `Record` rather than a chain of comparisons on purpose: a state added to {@link EngineState}
 * does not compile until its word is written here, so "every transport state has a defined word" is
 * a property of the compiler rather than of this comment.
 */
export const STOPPED_WORD: Record<Exclude<EngineState, 'playing'>, VisualiserWord> = {
  idle: 'idle',
  loading: 'loading',
  paused: 'paused',
  ended: 'ended',
  interrupted: 'interrupted',
  error: 'error',
};

/**
 * The colour the word wears, which is the chip's class: `live` (green — measuring now), `arming`
 * (between the two, v1.9.6 — the spectrum is coming), `stopped` (neither a measurement nor a
 * fallback: the transport is not playing, v1.9.26) and `fallback` (amber — there is no measurement
 * and none is coming).
 */
export type VisualiserTone = 'live' | 'arming' | 'stopped' | 'fallback';

export interface EngineStatus {
  state: EngineState;
  backend: PlaybackBackend;
  /** True only when the visualiser is being fed real frames right now. */
  spectrum: boolean;
  /**
   * True while a track is playing and the engine has **no answer from the thing that measures it
   * for this item yet** (v1.9.6, narrowed in v1.9.24, both paths since v1.9.27) — the window in
   * which `spectrum` is false and the spectrum is not lost.
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
   *
   * **v1.9.27 (card `t_71dc787e`) — and the web path has the same window, from its own register.**
   * `analyserArming` reads it there (`zeroFrames` below the verdict, per item since that card), and
   * `status()` reports this field as the OR of the two, because it is the same question — *has the
   * thing that measures this item answered for it yet?* — asked of the two ways of measuring. Before
   * it, a browser's first-frame window had no word of its own and spent the amber `theme` for ~128 ms
   * at the start of every track, on a build whose graph was built and working.
   *
   * **v1.9.27 (card `t_c8cc01c6`) — and on the native path the flag is not the whole of it.**
   * `spectrumArming` is written only by a start, an adoption and a poll that has found a problem, so
   * the ways into `playing` that are none of those — **a resume**, a return from the background —
   * reached the capability word with this flag still false, on an item whose tap was measuring a
   * moment ago. `tapArming` reads the native path's own per-item verdict register, the mirror of
   * `analyserArming`, and `status()` ORs that in too; a track whose tap has *answered* — silence, or
   * one frozen frame — keeps `native audio` across a pause and a resume, because that verdict is
   * about the item and not about the moment.
   */
  spectrumArming: boolean;
  /**
   * **The chip's word and tone, computed here, once (v1.9.26)** — one source, so every surface that
   * shows the mode reads one fact and no two of them can disagree (see {@link VisualiserWord} for
   * what each word means and the report that made this its own field).
   *
   * It is on the status because every input it has is the engine's: the state, the backend, whether
   * the bars are being fed, whether the tap is being asked, and — the fact the UI could not read at
   * all, and the one the defect turned on — **whether this build has a way to measure the item in
   * hand**. Without it a surface can only *infer* a capability from the absence of a measurement,
   * which is exactly how the wrong word was reached.
   */
  visualiser: { word: VisualiserWord; tone: VisualiserTone };
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
  nativeBoundary: {
    armed: number;
    advances: number;
    failures: number;
    ignored: number;
    reason: string;
    /**
     * The last away boundary's five moments in ms, and the last foreground start, as one sentence
     * (v2.0-beta.14; the foreground half in v2.0-beta.15).
     */
    timeline: string;
    /**
     * Who the Now Playing entry is owned by, and what the system has asked this app's scene to do,
     * as one sentence (v2.0-beta.16) — see `identitySentence` in `src/player/native.ts`. The bundle
     * id (and the signed `application-identifier`) is the id SpringBoard routes a card tap to, and
     * the scene counts say whether anything arrived at all.
     */
    identity: string;
    /** When that away boundary began, epoch ms; `0` when none has been timed (v2.0-beta.15). */
    startedAt: number;
    /**
     * The JS-side (foreground) boundary's own clock, ms (v2.0-beta.15).
     *
     * The away boundary is timed natively and only exists when the app was away; a boundary the web
     * layer takes — the app on screen, the item ending — had no number at all, so a foreground gap was
     * an absence in the row. This is its counterpart, on the same axis: the boundary's start (the
     * incoming load, or the play itself when the slot was already warm), the play issued, and the
     * first read of a player that was actually sounding.
     *
     * The two are deliberately separate objects: a foreground reading never overwrites the away one,
     * and `pending`/`ageMs` say whether the numbers are a finished reading and how old it is — an old
     * number standing in for the current one is the blind round this row exists to prevent.
     */
    foreground: {
      /** When this layer began the boundary, epoch ms; `0` when none has been begun. */
      startedAt: number;
      /** When the play for it was issued, epoch ms; `0` when it has not been issued yet. */
      playedAt: number;
      /** When the player first reported sound, epoch ms; `0` while it has not. */
      audibleAt: number;
      /** `startedAt` → `playedAt`, ms; `-1` when no play was issued. */
      playMs: number;
      /** `startedAt` → `audibleAt` — **the foreground gap**, ms; `-1` while pending. */
      audibleMs: number;
      /** Now − the moment the reading was taken, ms, so a stale one is identifiable; `-1` when nothing is timed. */
      ageMs: number;
      /** True while the boundary has been begun and no sound has been reported for it yet. */
      pending: boolean;
    } | null;
  };
  /**
   * **Which branch the last return to the foreground took, and the number that proves it read rather
   * than wrote (unreleased).**
   *
   * `path: 'adopt'` is a return whose first question — asked of the player — was answered "I am
   * already sounding the entry the queue is on", so the return read the position, the duration and the
   * playing state and wrote nothing. `path: 'handover'` is the other half: the player was not holding
   * that entry, so the away queue's reading was taken and the app's own player started at it.
   * `'none'` is an engine that has not returned yet.
   *
   * `starts` is every start `play` has issued in the session. A return that adopts must not move it,
   * and `loading` is the state only `play` dispatches — so the two facts are the same claim, readable
   * from the row without a screen recording.
   */
  returnPath: {
    path: 'none' | 'adopt' | 'handover';
    /** Returns that adopted a player already sounding the visible entry. */
    adoptions: number;
    /** Starts issued through `play` since this engine was built. */
    starts: number;
  };
  /**
   * The tap's own numbers, for the reason line (v1.9.25).
   *
   * This defect has been diagnosed from source three times and reproduced on the owner's phone every
   * time, and until now the app has never rendered a single fact about the tap itself: the chip says
   * *spectrum* (v2.0-beta; *spectrum…* until then) or *native audio*, and the sentence behind it was written by the engine's own reading
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
