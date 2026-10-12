/**
 * The native audio engine, used inside the Capacitor shell — and since v1.7 it is the engine
 * itself, not a background stand-in.
 *
 * @capgo/capacitor-native-audio gives us AVFoundation (iOS) / ExoPlayer (Android): one
 * `AVAudioSession` in the `.playback` category, activated, with the Now Playing card and the
 * remote command centre (the plugin's own iOS sources do exactly that — `Plugin.swift` sets
 * `.playback` and `setActive(true)` when `showNotification` is on, and targets
 * `MPRemoteCommandCenter`), which is what makes the lock-screen controls and background playback
 * possible at all.
 *
 * What it does *not* give us: samples. Its API is transport + metadata only — no PCM and no
 * spectrum callback — so the spectrum is read from `ios/App/App/NaviliteSpectrum.swift`'s tap on
 * the audio the player is playing (our own local plugin, iOS only). A build without that tap has
 * no spectrum and says so; v1.7 answered it by playing a second, silent copy of the stream in the
 * page, which is the second engine v1.7.3 deleted. The web `<audio>` element is built by
 * `src/player/engine.ts` only in a browser, where it *is* the audible engine.
 *
 * §NaviliteRemote: the plugin targets play/pause/stop/toggle/skip-15s and the playback-position
 * scrub, but it does **not** enable `nextTrackCommand` / `previousTrackCommand`, so a lock screen
 * driven by it alone has no next/previous buttons. `ios/App/App/NaviliteRemotePlugin.swift` (our
 * own, tiny, local Capacitor plugin — registered in `ViewController.capacitorDidLoad`) adds exactly
 * those two commands and forwards them here; nothing else about the session is touched twice.
 *
 * Android also needs a foreground service of its own: the plugin declares no service and its docs
 * say starting one is the app's job. `android/app/.../BackgroundAudioPlugin.java` is that service;
 * the bridge starts and stops it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { OsName } from '../platform.ts';

interface BackgroundAudioPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Our own iOS plugin: the two remote commands the native-audio plugin leaves unwired. */
interface NaviliteRemotePlugin {
  attach(): Promise<void>;
  detach(): Promise<void>;
  /** Bring the audio session back up after a foreground return (idempotent). */
  activateSession(): Promise<{ active: boolean }>;
  /**
   * State the boundary the native side is to own (v1.9.8) — **a statement, not an increment**.
   *
   * `assetId` is the slot that is playing and `chain` the slots to play after it, in order, each
   * with the track's own id so the app can be told which track the native player moved to. Sending
   * the whole picture every time is deliberate: the app re-states it after every start, every warm
   * and every visibility change, so there is no incremental state on the native side that a lost
   * message could leave half-applied.
   *
   * `awake` is whether the web layer is running (the app is on screen). While it is, the JS side
   * owns the boundary and the native one must not act — the two would otherwise both advance and
   * skip a track.
   */
  arm(options: {
    assetId?: string;
    songId?: string;
    chain?: Array<{ assetId: string; songId: string }>;
    previous?: { assetId: string; songId: string } | null;
    awake?: boolean;
  }): Promise<{ armed: number; previous: boolean; awake: boolean }>;
  /** Give the chain back — nothing is to be advanced to any more. */
  disarm(): Promise<{ armed: number }>;
  /**
   * The native side's own account of the boundary: the slot it believes is playing, the track that
   * slot holds, the chain it is holding, and what it has done — `advances` it took itself,
   * `failures` where it could not, and `ignored`, the completions that were not about the item it
   * was told is playing. This is the reconciliation the return to the foreground reads (v1.9.8): a
   * track that advanced while the app was away is a fact the web layer never heard, and asking is
   * the only way it learns.
   */
  now(): Promise<{
    assetId?: string;
    songId?: string;
    armedSongIds?: string[];
    advances?: number;
    failures?: number;
    ignored?: number;
    reason?: string;
  }>;
  addListener(eventName: 'next' | 'previous' | 'advanced' | 'advanceFailed', listenerFunc: (event: { songId?: string; assetId?: string; reason?: string }) => void): Promise<PluginListenerHandle>;
}

/**
 * Our own iOS plugin, second job: the spectrum, taken from a tap (`MTAudioProcessingTap`) on the
 * **audible** player's own item — the same `AVPlayer` that makes the sound, borrowed read-only for
 * its samples. See `ios/App/App/NaviliteSpectrum.swift`: the web layer cannot read this stream's
 * samples (a CORS-cross-origin media element hands over silence, by spec, and WebKit's session
 * handling was what paused playback on return), so the FFT is done natively with vDSP and handed
 * over as the 64 bands the canvas draws. Until v1.7.6 the tap was on a *second*, silent player
 * playing the same stream; that copy is deleted, so there is one decode and one clock.
 */
interface NaviliteSpectrumPlugin {
  /**
   * `assetId` is the slot **this bridge** is playing (v1.9.5), and it is the only asset the tap is
   * allowed to land on. The plugin used to pick a player for itself and would fall back to any
   * asset it found — the prepared, silent slot included — and report `started: true` while tapping
   * a player nobody is hearing. See `ios/App/App/NaviliteSpectrum.swift`.
   */
  start(options: { url: string; positionMs: number; assetId?: string }): Promise<{ started: boolean; sampleRate: number; bandCount: number }>;
  stop(): Promise<{ stopped: boolean }>;
  bands(): Promise<NativeSpectrumFrame>;
  /**
   * Aim the audible item at a forward buffer of `seconds` (v1.9.2) — and start it eagerly (v1.9.8).
   *
   * Ours to reach because our plugin holds the audible `AVPlayer` already (the same reflective
   * lookup the tap uses); the vendor plugin has no API for it. The same call also tells the item it
   * must **not** wait for a comfortable buffer before it makes a sound
   * (`automaticallyWaitsToMinimizeStalling = false`), which is the owner's own wording: start as
   * soon as the first seconds are there and keep filling behind the playback. Optional in the type
   * so a build whose plugin predates it degrades to "no forward-buffer target", which is what every
   * build before this one had.
   */
  configureBuffer(options: { seconds: number; assetId?: string }): Promise<{ buffered: boolean; seconds?: number; eager?: boolean }>;
  /**
   * Make a **warm** slot demonstrably able to start (v1.9.8), and report the bytes it holds.
   *
   * `preload` resolving only ever meant "an `AVPlayerItem` and an `AVPlayer` were created"; a
   * player nobody has asked for anything does not necessarily hold a byte, which is why the next
   * two tracks could be "prepared" and still take a full fetch to start. This aims that slot at a
   * forward buffer of `seconds` and asks AVFoundation to load the media data needed to start
   * (`preroll`) — it makes no sound, it is not the audible engine, and it answers with the seconds
   * of media the slot actually holds. Optional in the type so a build whose plugin predates it
   * degrades to "warmth cannot be proved here", which is what every build before this one had.
   */
  warmSlot?(options: { assetId: string; seconds: number; minSeconds?: number }): Promise<{ buffered: boolean; seconds?: number; reason?: string }>;
}

/** One frame of the native spectrum, plus what the tap thinks about it. */
export interface NativeSpectrumFrame {
  /** 64 band values, 0…255 — the same scale `getByteFrequencyData()` reports. */
  bands: number[];
  bandCount: number;
  /** True when the last frame carried energy: a real measurement of a real sound. */
  live: boolean;
  /** FFT frames the tap has produced since it started. */
  frames: number;
  /** Of those, how many were digital silence — what a *flat* audio signal looks like. */
  silentFrames: number;
  positionMs: number;
  playing: boolean;
  /**
   * Whether the item the tap is installed on is still the player's current item — v1.8.0.
   *
   * The one signal that separates "the tap is broken" from "the player has moved on to another item
   * and left the tap behind": `playing` cannot tell them apart, because the *player* is playing the
   * new track throughout. Optional so that a bridge without it (an older plugin) reads as "not known"
   * and nothing is concluded from it.
   */
  itemIsCurrent?: boolean;
  readable: boolean;
  sampleRate: number;
}

export interface NativeTrackInfo {
  /**
   * The song's own id (v1.9.5), when the caller knows it.
   *
   * The warm pool is keyed on the track rather than on the slot it sits in — three tracks are
   * warmed at once, so "the prepared asset" is no longer one thing — and `adopt` is told which
   * track is being started rather than adopting whatever happens to be in a fixed slot. Optional
   * so an older caller (and the fake bridges in the tests) still works: the URL is the fallback key.
   */
  id?: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

/** What the native player says it is doing — the truth after a foreground return. */
export interface NativeTruth {
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

export interface NativeBridge {
  load(info: NativeTrackInfo): Promise<void>;
  /**
   * Put a track on the player, warmed and silent (v1.9.1, pooled in v1.9.5).
   *
   * Its own asset id, its own `AVPlayerItem`, its own `AVPlayer` — and nothing ever sends that
   * player `play`. It is not a second engine: it makes no sound, it is not tapped for the spectrum,
   * and it is not in the engine's state machine. What it is, is buffered: adopted at a boundary, a
   * step forward or a step back, the track starts within a seek's time instead of paying for a cold
   * fetch after the previous track has already stopped.
   *
   * Up to three tracks are held warm at once (the previous song and the next two); the slot for a
   * fourth is taken from the oldest, whose asset is unloaded as the new one is written. Optional, so
   * a bridge without it (an older plugin, the fake bridge in the tests) is a bridge that still
   * plays — with a cold fetch, which is where v1.9.0 left it.
   */
  prepare?(info: NativeTrackInfo): Promise<boolean>;
  /**
   * Make a warmed track the audible one and free the slot it came from (v1.9.1; keyed on the track
   * since v1.9.5).
   *
   * `songId` is the track being started, and the slot holding exactly that track is the one played —
   * with three tracks warm there is no single "prepared slot" to adopt. A bridge call without an id
   * adopts the most recently warmed slot. Answers `false` when there is nothing warm to adopt, and
   * the caller then loads normally.
   */
  adopt?(songId?: string): Promise<boolean>;
  /** Throw the prepared track away — the queue is not going where it was prepared for. */
  discard?(): Promise<void>;
  /**
   * A prepare the listener did not ask for must issue nothing (v1.9.2).
   *
   * The queue prepares the track that *follows* the one playing, which is a bet on the listener
   * staying where he is. When he moves — a tap far down the list, a next he pressed — that bet is
   * off, and the prepare for the abandoned chain must not touch the player: on a phone holding two
   * slots on a link with room for one stream, an unasked-for preload is competing with the very
   * track he is waiting for. Bumped by the bridge itself whenever a load or a discard takes the
   * slot, and safely callable from anywhere.
   */
  invalidatePrepared?(): void;
  /**
   * State the boundary the **native player** is to own, and whether it may act on it (v1.9.8).
   *
   * `next` is the tracks warm ahead of the one playing, in the order they would be played; the
   * bridge turns each into the slot holding it — a track that is not warm is not named to the
   * native side at all. `previous` is the one behind, for the lock screen's back button. `awake`
   * is whether the web layer is running.
   *
   * This is the structural half of the release. Off screen there is no web layer: the plugin's own
   * completion is delivered to a frozen view, `watchForPinnedEnd` is driven by a clock tick that
   * has been stopped, and every path that could have moved the queue is in the suspended process.
   * So the native side is given its own next — and it plays it itself, from its own observation of
   * the audible item's end. Answers whether the platform took it (there is no native boundary on
   * Android, and none in a build without our iOS plugin, where the JS side keeps owning it).
   */
  armBoundary?(boundary: { next: readonly string[]; previous: string | null; awake: boolean }): Promise<boolean>;
  /**
   * Ask the native side which slot it is playing now, and adopt its answer (v1.9.8).
   *
   * A track that advanced while the app was away is a fact the web layer never received, and this
   * is the only way it learns: on the way back, before anything is read from the player, the
   * bridge compares the native side's own record with the slot it believes is audible and moves
   * onto it. `changed` true means the app was following the wrong slot, and `songId` is the track
   * that is actually sounding — never guessed, and never silent.
   */
  reconcile?(): Promise<{ changed: boolean; songId: string | null } | null>;
  /** What the native boundary has done, as numbers and a sentence — for the reason line (v1.9.8). */
  nativeAdvance?(): { armed: number; advances: number; failures: number; ignored: number; reason: string };
  play(startSeconds: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number): Promise<void>;
  /** Last position the native engine reported, in milliseconds. */
  positionMs(): number;
  /**
   * Ask the player itself, rather than trusting our copy of the state. Used on every return to
   * the foreground: if the app was suspended (or the session was interrupted by a call), the JS
   * side's idea of "playing" and the player's can disagree, and the player is right.
   */
  sync(): Promise<NativeTruth | null>;
  /** Re-arm the audio session without changing what is playing. */
  activateSession(): Promise<boolean>;
  /** Lock-screen next/previous, when the platform can deliver them. */
  listenRemoteCommands(handlers: { next(): void; previous(): void }): () => void;
  /**
   * The native spectrum tap, when the platform has one. Optional: a build without our iOS plugin
   * (an older APK, the PWA) simply has no `startSpectrum`, and the visualiser falls back to its
   * album-art theme exactly as it does when there are no samples for any other reason.
   */
  startSpectrum?(url: string, positionMs: number): Promise<boolean>;
  stopSpectrum?(): Promise<void>;
  spectrumFrame?(): Promise<NativeSpectrumFrame | null>;
  /** Whether this platform can produce the spectrum from the native player at all. */
  readonly hasNativeSpectrum: boolean;
  /**
   * What the last `adopt()` did, in the words the screen can show (v1.9.5).
   *
   * The boundary's adoption used to answer `boolean`, and every way it could fail — nothing
   * prepared, the player refusing the play, the call not answering at all — folded into the same
   * `false`, which the engine then treated as "load it cold". The one event that is supposed to
   * make a track change instant was therefore the one event with no account of itself, and three
   * rounds of diagnosis were made without knowing which of those had happened.
   */
  adoptOutcome?(): string;
  /**
   * How many events the bridge itself discarded since it was built (v1.9.5), by reason: events for
   * an asset that is not the audible one, and completions swallowed by the slot-write grace. Both
   * are deliberate filters; both were also silent, so a report that never arrived could not be
   * told from one that never existed.
   */
  droppedEvents?(): { inaudible: number; slotGrace: number };
}

/**
 * The facts the plugin puts in a `playbackState` event, forwarded verbatim (v1.9.5).
 *
 * `Plugin.swift`'s `notifyPlaybackState` sends four things about the item it is reporting on —
 * `state`, `reason`, `currentTime` and `duration` — and until this release the bridge dropped
 * three of them and handed the engine a bare `state`/`isPlaying`. That is why "the track ended"
 * had to be spelled as one exact state (`stopped`), and why the app could not tell an item
 * sitting at its end from an item that had been paused in the middle: the two facts that separate
 * them (where it is, how long it is) were thrown away at the door.
 */
export interface NativePlaybackFacts {
  /** The item's own position, in seconds, as the plugin reported it. */
  currentTime?: number;
  /** The item's own duration, in seconds, as the plugin reported it. */
  duration?: number;
  /** Why the plugin says this state is what it is (the plugin's own word). */
  reason?: string;
}

export interface NativeBridgeEvents {
  onPosition(seconds: number): void;
  onState(state: 'playing' | 'paused' | 'stopped', isPlaying: boolean, facts?: NativePlaybackFacts): void;
  onComplete(): void;
  /**
   * The native player **could not** take a boundary it was armed for (v1.9.8) — so the end of that
   * track is the web layer's again, whoever else thinks it owns it.
   *
   * This is the one door onto the end of a track that the native boundary must never close: while
   * the app is away the app's own end-of-track doors are shut on purpose (`boundaryOwnedByNative`),
   * and if the native side then reports that it could not advance, nothing else would ever move the
   * queue. Optional, with `onComplete` as the fallback, so a bridge without it behaves exactly as
   * it did before.
   */
  onBoundaryRefused?(): void;
  /**
   * The native player took a track boundary **by itself** (v1.9.8), and this is the track it moved
   * to. See {@link NativeBridge.armBoundary}: while the app is off screen nothing else can.
   *
   * It is an *adoption*: the audio is already playing, so the listener to this must move onto that
   * track rather than start it. Optional so a bridge without it (an older build, the fake bridges in
   * the tests) is a bridge that simply never reports one.
   */
  onAdvanced?(songId: string): void;
}

const BACKGROUND_AUDIO_SERVICE = 'BackgroundAudio';
const NAVILITE_REMOTE = 'NaviliteRemote';
const NAVILITE_SPECTRUM = 'NaviliteSpectrum';

/**
 * How long a bridge call may hold a JS `await` before the engine is told to carry on without it.
 *
 * Every transport call is bounded (v1.9.1). A plugin call that never settles used to leave the
 * engine's `await` pending for the rest of the session — which is one half of the owner's *"using
 * the seek bar seems to disable the playlist from advancing"*: `setCurrentTime` resolves only from
 * AVFoundation's own seek completion, and a zero-tolerance seek on a transcoded remote item can
 * report `finished == false`, which the plugin turns into a promise that never settles. Nothing in
 * this app's state machine may depend on a bridge call coming back.
 */
const BRIDGE_TIMEOUT_MS = 5000;
/** A seek is short by nature, and the position the UI shows is written optimistically. */
const SEEK_TIMEOUT_MS = 1500;
/**
 * How long after a slot is written a completion for it is still the plugin's own doing (v1.9.1).
 *
 * `unload` stops the asset it holds, and the plugin reports a **completion** for it — on its own
 * audio queue, so the report can land after the call has already resolved. With two slots in the
 * player, one of them prepared and silent, that is a completion nobody asked for arriving at the
 * exact moment the listener has changed track: the engine's one event that moves the queue would act
 * on it and skip a track. A real completion inside this window is not music.
 */
const SLOT_WRITE_GRACE_MS = 800;

/**
 * Run a bridge call under a deadline: it resolves with `fallback` if the plugin does not answer.
 *
 * A rejected call is not an error the listener should see either — it is reported and the fallback
 * stands, exactly as the plugin's own `missing-plugin` path does.
 *
 * v1.9.2 — **the result says whether the plugin answered at all.** A call that timed out and a call
 * that answered `undefined` used to be the same value, and for the prepared slot that difference is
 * the whole bug: a prepare that timed out was recorded as a prepared track, so the next boundary
 * adopted nothing and nothing said so. Callers that care about the distinction use this; callers
 * that only need the answer use {@link bounded}.
 */
async function boundedSettled<T>(
  work: Promise<T>,
  fallback: T,
  what: string,
  ms = BRIDGE_TIMEOUT_MS,
): Promise<{ value: T; settled: boolean }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const value = await Promise.race([
      work.then((answer) => ({ value: answer, settled: true })),
      new Promise<{ value: T; settled: false }>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[navilite] the native bridge call "${what}" did not answer within ${ms} ms`);
          resolve({ value: fallback, settled: false });
        }, ms);
      }),
    ]);
    return value;
  } catch (error) {
    console.warn(`[navilite] the native bridge call "${what}" failed`, error);
    return { value: fallback, settled: false };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** The same, for the calls where the answer is all that matters. */
async function bounded<T>(work: Promise<T>, fallback: T, what: string, ms = BRIDGE_TIMEOUT_MS): Promise<T> {
  return (await boundedSettled(work, fallback, what, ms)).value;
}

/**
 * How long the native bridge itself may take to build before a start gives up on it (v1.9.2).
 *
 * Building it is a dynamic import plus `configure` plus three `addListener` round trips — three
 * more round trips through the same bridge that every transport call queues on, and none of them
 * was bounded. A plugin that never answers them left the first tap of a session waiting on a
 * promise that would never settle: the app fetched nothing, played nothing and said nothing. Ten
 * seconds is longer than any healthy build (it is measured in tens of milliseconds) and it is the
 * whole of the first tap's budget.
 */
const BRIDGE_BUILD_TIMEOUT_MS = 10000;

export { BRIDGE_BUILD_TIMEOUT_MS };

/**
 * How far ahead of the play position the audible item is asked to fill, in seconds (v1.9.2).
 *
 * This is the owner's own request — *"play as soon as ~5 seconds of audio are buffered, then keep
 * filling behind it"* — and it is the one lever AVFoundation exposes for it. Unset, the player
 * fills as much as it can and playback begins when it decides it has enough; set, it is the target
 * the player starts on and keeps filling behind.
 */
const BUFFER_AHEAD_SECONDS = 5;

/**
 * How much media a **warm** slot has to hold before the app will call it warm (v1.9.8).
 *
 * The slot is prepared ahead of the track that is playing, and what it is for is starting without a
 * fetch: a slot with less than this much media ahead of it is a slot that will stall at the
 * boundary. The proof is asked of the plugin, which reads it from the item's own loaded ranges.
 */
const WARM_MIN_SECONDS = 1.5;

/**
 * How long the whole of `prepare` may take (v1.9.8) — creating the slot *and* proving it holds
 * media. Longer than the default bridge deadline because a warm now waits for real bytes: the
 * track is one the listener is not waiting for, so its preparation is allowed to take as long as a
 * fetch takes, and the answer it gives back has to be about the bytes that arrived.
 */
const PREPARE_TIMEOUT_MS = 8000;

export async function createNativeBridge(os: OsName, events: NativeBridgeEvents): Promise<NativeBridge | null> {
  if (os === 'web') return null;
  try {
    const { NativeAudio } = await import('@capgo/capacitor-native-audio');
    await NativeAudio.configure({
      // We are the primary audio source: take focus, take the `.playback` session, show the
      // lock-screen card and accept its transport commands.
      showNotification: true,
      background: true,
      backgroundPlayback: os === 'android',
      focus: true,
    });

    /*
     * **Four slots and a pool, not two names that swap** (v1.9.5).
     *
     * One slot is what the listener hears. The other three hold tracks warmed on the same plugin
     * and never sent `play` — the previous song and the next two, which is what the owner asked for
     * (*"after any selection the app must commence prefetching/caching the previous song and the
     * next two songs, so stepping back or forward is instant"*). Warming the next track is what
     * makes a track boundary instant; warming the one after it and the one behind it is what makes
     * a step forward or back instant.
     *
     * The pool is **fixed and small on purpose**: at most four assets exist on the player at any
     * moment, whatever the listener does, which is the bound the whole "no leaks" rule needs. A
     * warm target goes into a free slot, or — when all three are taken — into the oldest one, whose
     * asset `fillSlot` unloads as it writes (so a replaced track's bytes are released the moment
     * its slot is reused, and never accumulate).
     *
     * The audible slot is **never** a warm target, and every call in this file is keyed on
     * `audibleId` and never on a literal: the audible name moves to whichever slot was adopted.
     */
    const SLOTS: readonly string[] = ['navilite-slot-0', 'navilite-slot-1', 'navilite-slot-2', 'navilite-slot-3'];
    let audibleId = SLOTS[0] ?? 'navilite-slot-0';
    /**
     * What each non-audible slot is holding warm: `slot -> { songId, url }`, in warming order.
     *
     * Insertion order *is* the eviction order (the oldest goes first), so a slot is re-inserted
     * whenever it is warmed again. The map is the bridge's own claim of what it holds, and every
     * way an entry leaves it is named: the slot is adopted (deleted, the asset becomes audible), it
     * is evicted because all three slots were taken (deleted by `pickWarmSlot`, the asset is
     * replaced by `fillSlot`), the same track is re-warmed under a different URL (deleted and
     * unloaded — one stream per track), or the listener moves the chain (`load`/`discard` clear it).
     */
    const warm = new Map<string, { songId: string; url: string }>();
    /**
     * When each slot was last written, by slot. See {@link SLOT_WRITE_GRACE_MS}.
     *
     * v1.9.7 — **per slot, not one engine-wide timestamp.** The grace exists to swallow the
     * completion the plugin emits for the asset `unload` just stopped; as one timestamp it was set by
     * a write to *any* slot, including the silent ones, and a warm to a silent slot therefore
     * suppressed the AUDIBLE item's real completion for 800 ms. Every start fires up to three warms
     * on the slots that are not audible, so that was the common case rather than a corner. A slot's
     * own stamp can only ever be about that slot's own unload.
     */
    const slotWrittenAt = new Map<string, number>();
    /**
     * The prepare epoch (v1.9.2). See {@link NativeBridge.invalidatePrepared}.
     *
     * A prepared job captures the epoch when it is asked for, and checks it again when its turn on
     * the lane comes: a prepare for a chain the listener has left is not merely late, it is a
     * request nobody made, so it issues nothing at all. Bumped here, by the two things that take
     * the slot over — a load and a discard.
     */
    let preparedEpoch = 0;
    /** What the last `adopt()` did, in the words the reason line shows (v1.9.5). */
    let adoptOutcome = 'not attempted';
    /** The track the audible slot holds (v1.9.8) — what the native boundary is told is playing. */
    let audibleSongId: string | null = null;
    /**
     * The boundary the native player is to own (v1.9.8), as the app last stated it, and what came of
     * it. Every entry has one clearing path: `armBoundary` replaces the whole picture, `armBoundary`
     * with an empty chain clears it, and the engine states an empty one whenever a selection moves
     * the queue, the warm pool is thrown away, or the app is stopped.
     */
    let boundary: { next: readonly string[]; previous: string | null; awake: boolean } = { next: [], previous: null, awake: true };
    let boundarySlots = 0;
    let boundaryArmed = false;
    let boundaryReason = 'nothing stated yet';
    /** What the native side has done by itself, and where it would not (v1.9.8). */
    let nativeAdvances = 0;
    let nativeFailures = 0;
    let nativeIgnored = 0;

    /**
     * Whether an event is about the asset the listener is hearing.
     *
     * With a prepared asset in the player, *its* events are not the engine's business: unloading a
     * slot makes the plugin emit a completion for it (so a stale slot would otherwise advance the
     * queue), and a playback state belonging to a silent item says nothing about what is playing.
     * An event with no `assetId` (an older plugin) is passed through, as it always was.
     *
     * v1.9.5 — and it is **counted**. Both filters below are deliberate, and both were silent: a
     * completion that never reached the engine could not be told from one the plugin never sent,
     * which is a third of the reason the boundary has been diagnosed three times without an
     * answer. The counters ride to the screen in `status.droppedEvents`.
     *
     * v1.9.6 — and the counter no longer ticks at a boundary that *worked*: the slot being adopted is
     * named as audible before its play call (see `adopt`), because the plugin reports `.playing`
     * before it resolves that call. `inaudible` is a count of real losses again — events about an
     * asset the listener is genuinely not hearing.
     */
    let droppedInaudible = 0;
    let droppedSlotGrace = 0;
    const isAudible = (event: { assetId?: string } | undefined): boolean => {
      const audible = !event?.assetId || event.assetId === audibleId;
      if (!audible) droppedInaudible += 1;
      return audible;
    };

    await NativeAudio.addListener('currentTime', (event) => {
      if (!isAudible(event)) return;
      events.onPosition(event.currentTime);
    });
    await NativeAudio.addListener('playbackState', (event) => {
      if (!isAudible(event)) return;
      /*
       * The plugin's own four facts, forwarded whole (v1.9.5). `reason`, `currentTime` and
       * `duration` are what let the engine decide "this item is at its end" from measurement
       * instead of from one spelling of one state.
       */
      events.onState(event.state, event.isPlaying, {
        currentTime: Number.isFinite(event.currentTime) ? event.currentTime : undefined,
        duration: Number.isFinite(event.duration) ? event.duration : undefined,
        reason: typeof event.reason === 'string' ? event.reason : undefined,
      });
    });
    await NativeAudio.addListener('complete', (event) => {
      if (!isAudible(event)) return;
      /*
       * A slot we wrote a moment ago: this completion is the plugin stopping the asset we replaced.
       * v1.9.7 — the stamp is the *audible* slot's, so a warm that was just written into a silent
       * slot can no longer swallow the item the listener is hearing.
       */
      if (Date.now() - (slotWrittenAt.get(audibleId) ?? 0) < SLOT_WRITE_GRACE_MS) {
        droppedSlotGrace += 1;
        return;
      }
      events.onComplete();
    });

    const service = Capacitor.isPluginAvailable(BACKGROUND_AUDIO_SERVICE)
      ? registerPlugin<BackgroundAudioPlugin>(BACKGROUND_AUDIO_SERVICE)
      : null;
    const remote = Capacitor.isPluginAvailable(NAVILITE_REMOTE) ? registerPlugin<NaviliteRemotePlugin>(NAVILITE_REMOTE) : null;
    // iOS only, and only from v1.7.2: the FFT tap on the audio the player is playing.
    const spectrum = Capacitor.isPluginAvailable(NAVILITE_SPECTRUM)
      ? registerPlugin<NaviliteSpectrumPlugin>(NAVILITE_SPECTRUM)
      : null;

    let lastPositionMs = 0;

    /*
     * One lane for the two asset slots, so two writes to a slot can never be in flight at once.
     *
     * A track is loaded with `unload`+`preload` under its slot's name, which makes an unfinished
     * `preload` and the next track's `unload`+`preload` two writers on one slot: the older one can
     * finish last and leave the plugin holding the wrong stream. The engine already refuses to
     * *play* a superseded load (`startNative`); this is the other half — the loads themselves run in
     * the order the taps were made, so the last preload to complete is the last one asked for. The
     * prepared slot goes through the same lane, so an adopt at a boundary cannot be overtaken by the
     * preload for the track after it.
     */
    let assetLane: Promise<unknown> = Promise.resolve();
    const inAssetLane = <T>(work: () => Promise<T>): Promise<T> => {
      const next = assetLane.then(work, work);
      assetLane = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    /** What the lock-screen card shows for a track, in one place — the audible and prepared alike. */
    const metadata = (info: NativeTrackInfo) => ({
      title: info.title,
      artist: info.artist,
      album: info.album,
      artworkUrl: info.artworkUrl ?? undefined,
    });

    /** Put `info` into `slot`, replacing whatever it held. Best-effort: the plugin rejects both on an empty slot. */
    const fillSlot = async (slot: string, info: NativeTrackInfo): Promise<void> => {
      slotWrittenAt.set(slot, Date.now());
      try {
        await NativeAudio.unload({ assetId: slot });
      } catch {
        // Nothing loaded under that name yet — unload is best-effort.
      }
      await NativeAudio.preload({ assetId: slot, assetPath: info.url, isUrl: true, notificationMetadata: metadata(info) });
    };

    /** Give a slot's asset back to the player. Best-effort: an empty slot rejects. */
    const unloadSlot = async (slot: string): Promise<void> => {
      slotWrittenAt.set(slot, Date.now());
      try {
        await NativeAudio.unload({ assetId: slot });
      } catch {
        // Nothing loaded under that name — nothing to free.
      }
    };

    /**
     * Where a new warm target goes: a free slot, or the oldest warm one (v1.9.5).
     *
     * The audible slot is never a candidate. When all three warm slots are taken, the oldest is
     * chosen — its claim is dropped here and `fillSlot` unloads its asset as it writes the new one,
     * so the pool cannot grow and a replaced track's bytes do not linger behind it.
     */
    const pickWarmSlot = (): string => {
      for (const slot of SLOTS) if (slot !== audibleId && !warm.has(slot)) return slot;
      const oldest = warm.keys().next();
      const evicted = oldest.done ? null : oldest.value;
      if (evicted !== null) warm.delete(evicted);
      return evicted ?? SLOTS.find((slot) => slot !== audibleId) ?? audibleId;
    };

    /**
     * Tell the player how far ahead to fill the item the listener is hearing (v1.9.2).
     *
     * This is ours to do because the audible item is reachable from our own iOS plugin, which
     * already finds the audible `AVPlayer` reflectively for the spectrum tap (see
     * `ios/App/App/NaviliteSpectrum.swift`); the vendor plugin exposes no API for it. It runs
     * *after* the item is in place — a load, or an adoption at a boundary — so it is a property
     * written on an item that is already the right one, and it makes no sound.
     *
     * Android has no equivalent call: the vendor's player builds stock `DefaultLoadControl`, which
     * fills 50 s of media before it will start. That one is patched at the source by
     * `tools/patch-native-audio.mjs`, which is the only way to reach it.
     */
    const configureBuffer = async (): Promise<void> => {
      if (!spectrum) return;
      try {
        // The audible slot is named (v1.9.5): the buffer target belongs on the item being heard, and
        // with a pool of four assets the plugin cannot work out which one that is by itself.
        await spectrum.configureBuffer({ seconds: BUFFER_AHEAD_SECONDS, assetId: audibleId });
      } catch (error) {
        console.warn('[navilite] the player would not take a forward-buffer target', error);
      }
    };

    /**
     * Make one **warm** slot demonstrably able to start, and say whether it is (v1.9.8).
     *
     * `preload` resolving only ever meant "an `AVPlayerItem` and an `AVPlayer` exist"; nothing had
     * been asked of them, so the "next two songs" could be prepared in name only — which is the
     * owner's *"it should already have prefetched the next song but it still doesn't load and play
     * instantly"*. This aims the slot at a forward buffer and asks AVFoundation for the media data
     * needed to start it; the seconds it reports back are what the slot actually holds.
     *
     * `null` means **warmth cannot be proved here** — Android has no spectrum plugin, and it is our
     * plugin that reaches the vendor's players — and the caller then keeps the old behaviour rather
     * than failing a warm it cannot judge. `false` means the slot was asked and has no bytes: it is
     * not a warm slot, and the caller gives it back.
     */
    const proveWarm = async (slot: string): Promise<boolean | null> => {
      if (!spectrum?.warmSlot) return null;
      try {
        const answer = await spectrum.warmSlot({ assetId: slot, seconds: BUFFER_AHEAD_SECONDS, minSeconds: WARM_MIN_SECONDS });
        if (answer.buffered === true) return true;
        const held = Number.isFinite(answer.seconds) ? Number(answer.seconds).toFixed(1) : '0';
        console.warn(`[navilite] a warm slot holds ${held} s of media (${answer.reason ?? 'no reason given'})`);
        return false;
      } catch (error) {
        // A plugin that does not implement this call at all is not a slot that failed to load.
        console.warn('[navilite] a warm slot could not be asked whether it can start', error);
        return null;
      }
    };

    /**
     * State the whole boundary to the native side, and take its answer (v1.9.8).
     *
     * The chain is built from the warm pool here rather than by the caller, because the caller
     * (the engine) tracks tracks by id and the native side needs *slots* — and the only thing that
     * knows which slot holds which track is this file. A track that is not warm is not named: the
     * native side must never be handed a slot that holds something else.
     */
    const stateBoundary = async (): Promise<boolean> => {
      if (!remote?.arm) {
        boundaryArmed = false;
        boundarySlots = 0;
        boundaryReason = 'this build has no native boundary plugin, so the web layer owns the boundary as it always did';
        return false;
      }
      const chain: Array<{ assetId: string; songId: string }> = [];
      for (const songId of boundary.next) {
        for (const [slot, held] of warm) {
          if (held.songId !== songId) continue;
          chain.push({ assetId: slot, songId });
          break;
        }
      }
      let previous: { assetId: string; songId: string } | null = null;
      if (boundary.previous !== null) {
        for (const [slot, held] of warm) {
          if (held.songId !== boundary.previous) continue;
          previous = { assetId: slot, songId: boundary.previous };
          break;
        }
      }
      const answer = await bounded(
        remote.arm({ assetId: audibleId, songId: audibleSongId ?? undefined, chain, previous, awake: boundary.awake }),
        null,
        'arm',
      );
      boundarySlots = chain.length + (previous === null ? 0 : 1);
      /*
       * **The native side may act on this only while the web layer is not running.** With the app
       * on screen the JS side takes the boundary exactly as it always has — which is what keeps the
       * two from both advancing a track, and keeps `repeat one`, the end of the queue and the
       * on-screen `next` on the one path that implements them.
       */
      boundaryArmed = answer !== null && boundary.awake === false && chain.length > 0;
      boundaryReason =
        answer === null
          ? 'the native boundary plugin did not answer, so the web layer keeps the boundary'
          : boundaryArmed
            ? `the native player will play the next slot itself if this track ends with the app away (${chain.length} ahead, ${previous === null ? 'none' : 'one'} behind)`
            : boundary.awake
              ? 'the app is on screen, so the web layer takes the track boundary and the native side is only told what follows'
              : chain.length === 0
                ? 'nothing is warm ahead of this track, so nothing could advance while the app is away'
                : 'the native boundary plugin took the statement';
      return boundaryArmed;
    };

    const startService = async () => {
      if (!service) return;
      try {
        await service.start();
      } catch (error) {
        console.warn('[navilite] could not start the Android foreground service', error);
      }
    };
    const stopService = async () => {
      if (!service) return;
      try {
        await service.stop();
      } catch (error) {
        console.warn('[navilite] could not stop the Android foreground service', error);
      }
    };

    return {
      async load(info) {
        /*
         * A load is the listener's own request, and it takes the audible slot over (v1.9.2): any
         * prepare still on the lane for the chain he has left is refused rather than performed.
         *
         * v1.9.5 — **and it drops every warm claim**, which is the "state is reset on every
         * selection" half of the owner's third rule. The slots it drops are not unloaded here: the
         * only thing the load may not do is spend the listener's wait on freeing bytes he is not
         * waiting for, and the queue re-warms around the new track a moment after it starts, which
         * writes those same slots (`fillSlot` unloads as it writes). The pool is fixed at four
         * either way, so nothing accumulates meanwhile.
         */
        preparedEpoch += 1;
        warm.clear();
        audibleSongId = info.id ?? audibleSongId;
        await bounded(inAssetLane(() => fillSlot(audibleId, info)), undefined, 'load');
      },
      async prepare(info) {
        /*
         * One warm target, into **its own slot**, and nothing here touches what is playing: it is a
         * preload on the same plugin under a free slot's asset id, and the player it creates is
         * never sent `play` — which is the whole difference between this and the second engine
         * v1.7.6 deleted. Three of these can be held at once (the previous track and the next two);
         * the slot for a fourth is taken from the oldest.
         *
         * v1.9.2 — **it answers whether it happened, and it performs nothing if the listener has
         * moved on.** Two halves of one fix: the epoch, checked on the lane rather than at the call,
         * so a prepare the listener did not ask for issues nothing even when it was queued; and the
         * boolean, so the queue records a warm track only when there is one. A prepare that timed
         * out used to be indistinguishable from a successful one, and the slot it claimed was never
         * given back.
         *
         * v1.9.5 — **keyed on the track, not on the slot.** The same track under the same URL is
         * already warm and a second preload of it is nothing (the answer is `true` without asking
         * the plugin); the same track under a *different* URL loses its old asset first, so one
         * track never holds two streams.
         */
        const epoch = preparedEpoch;
        const key = info.id ?? info.url;
        for (const held of warm.values()) if (held.songId === key && held.url === info.url) return true;
        const result = await boundedSettled(
          inAssetLane(async () => {
            if (epoch !== preparedEpoch) return false;
            for (const [slot, held] of [...warm]) {
              if (held.songId !== key) continue;
              warm.delete(slot);
              await unloadSlot(slot);
            }
            const slot = pickWarmSlot();
            await fillSlot(slot, info);
            /*
             * **And the slot has to be able to start, or it is not a warm slot (v1.9.8).**
             *
             * Creating a player was never the claim this call makes; holding the bytes is. A slot
             * that was asked for media and did not get any is given straight back — the engine drops
             * its claim with this answer, so the next boundary reports an honest cold fetch instead
             * of a "warm" track that still has to be downloaded.
             */
            if ((await proveWarm(slot)) === false) {
              await unloadSlot(slot);
              return false;
            }
            // Re-inserted so the warming order stays the eviction order.
            warm.delete(slot);
            warm.set(slot, { songId: key, url: info.url });
            return true;
          }),
          false,
          'prepare',
          PREPARE_TIMEOUT_MS,
        );
        return result.settled && result.value;
      },
      invalidatePrepared() {
        // A caller that knows the chain is abandoned can say so without touching the player; the
        // lane job that is already waiting for its turn reads this and issues nothing.
        preparedEpoch += 1;
      },
      async adopt(songId) {
        /*
         * The slot holding `songId`, when the engine names the track it is starting — the boundary
         * case, and the only one where the app knows exactly what it is adopting. Without an id
         * (an older caller) the most recently warmed slot is used, which is the track after the
         * current one.
         */
        let from: string | null = null;
        if (typeof songId === 'string') {
          for (const [slot, held] of warm) {
            if (held.songId !== songId) continue;
            from = slot;
            break;
          }
        } else {
          for (const slot of warm.keys()) from = slot;
        }
        const to = audibleId;
        /*
         * Order matters, and it is the order the plugin's own bookkeeping needs.
         *
         * The prepared asset is played first: from that instant it is what the listener hears, so
         * the *next* thing — freeing the slot the old track held — fires the plugin's synthetic
         * completion for an asset id that is no longer the audible one, reports nothing to the
         * engine's transport state, and leaves the now-playing card alone. Unloading first would
         * take the audio session and the card down between the two tracks, audibly.
         *
         * v1.9.5 — **and it says what happened.** Every way this can end is now named: nothing in
         * the slot, the player refusing the play, the call not answering inside its deadline, or
         * the adoption itself. `false` used to be all four at once, and the engine turned all four
         * into "load it cold" with no word anywhere.
         */
        let refusal: string | null = null;
        if (from === null || from === to) {
          adoptOutcome = 'nothing prepared';
          return false;
        }
        const slotName = from;
        /*
         * **The slot is named before the play call, not after it (v1.9.6).**
         *
         * The plugin notifies the state change *before* it resolves the call it was given:
         * `notifyPlaybackState(assetId:…, reason: "play", state: .playing)` and then `call.resolve()`
         * (`Plugin.swift`, in the play block). So the adopted slot's own "playing" report — the one
         * event that says this boundary worked, and the first thing that tells the engine sound
         * exists — arrived while `audibleId` still named the outgoing slot, and `isAudible` threw it
         * away as an event about an asset nobody is hearing. The engine then learned "playing" from
         * the plugin's 100 ms current-time timer instead, and `droppedEvents.inaudible` — the counter
         * built to explain a boundary *failure* — ticked at every successful boundary, which is a
         * counter pointing at a loss that did not happen.
         *
         * Naming the slot here is not a guess about what the plugin will do: it is the claim this
         * bridge is making anyway — the play has been issued for this slot and nothing else can be
         * audible — and the failure paths below put it back, because then the outgoing asset really
         * is still the one playing.
         */
        audibleId = slotName;
        audibleSongId = songId ?? audibleSongId;
        const attempt = inAssetLane(async () => {
          try {
            await NativeAudio.play({ assetId: slotName, time: 0 });
          } catch (error) {
            refusal = `play refused (${error instanceof Error ? error.message : String(error)})`;
            return false;
          }
          return true;
        });
        const result = await boundedSettled(attempt, false, 'adopt');
        if (!result.settled) {
          // Nothing is known to be playing on this slot, and the engine is about to load the track
          // into the audible one: give the name back so the outgoing asset's events are its again.
          audibleId = to;
          adoptOutcome = 'timed out';
          return false;
        }
        if (!result.value) {
          audibleId = to;
          adoptOutcome = refusal ?? 'play refused';
          return false;
        }
        adoptOutcome = 'adopted';
        warm.delete(slotName);
        // `audibleId` already names this slot — it was named before the play call, above, so that the
        // plugin's own report of this boundary could reach the engine.
        // The adopted item is the audible one now: the forward-buffer target belongs on it, and
        // the item it was prepared as is a different one by the time it is heard (v1.9.2).
        await configureBuffer();
        await startService();
        // The slot that was just emptied is the one written here (v1.9.7: the stamp is per slot).
        slotWrittenAt.set(to, Date.now());
        await bounded(
          inAssetLane(async () => {
            try {
              await NativeAudio.unload({ assetId: to });
            } catch {
              // The slot may already be empty (a cold first track) — nothing to free.
            }
          }),
          undefined,
          'adopt-unload',
        );
        lastPositionMs = 0;
        return true;
      },
      /*
       * ---------------------------------------------------------- the native boundary (v1.9.8)
       *
       * Three methods, and they are the whole of "the app is not the only owner of the boundary
       * any more": `armBoundary` states what to play next and whether the native side may act,
       * `reconcile` reads back which slot the native side is playing, and `nativeAdvance` is the
       * account for the reason line.
       */
      async armBoundary(next) {
        boundary = { next: [...next.next], previous: next.previous, awake: next.awake };
        return stateBoundary();
      },
      async reconcile() {
        if (!remote?.now) return null;
        const state = await bounded(remote.now(), null, 'reconcile');
        if (!state) {
          boundaryReason = 'the native boundary plugin did not answer, so the app cannot ask it which slot it is playing';
          return null;
        }
        if (Number.isFinite(state.advances)) nativeAdvances = Number(state.advances);
        if (Number.isFinite(state.failures)) nativeFailures = Number(state.failures);
        if (Number.isFinite(state.ignored)) nativeIgnored = Number(state.ignored);
        if (typeof state.reason === 'string' && state.reason) boundaryReason = state.reason;
        const slot = typeof state.assetId === 'string' && state.assetId ? state.assetId : null;
        if (slot === null || slot === audibleId) return { changed: false, songId: state.songId ?? null };
        /*
         * The native player is on another slot than the app believed. That is a track the app
         * advanced to without being told, and the answer is to move onto it — never to play
         * anything: the audio is already coming out of that slot.
         */
        warm.delete(slot);
        audibleId = slot;
        audibleSongId = typeof state.songId === 'string' && state.songId ? state.songId : null;
        return { changed: true, songId: audibleSongId };
      },
      nativeAdvance() {
        return {
          armed: boundaryArmed ? boundarySlots : 0,
          advances: nativeAdvances,
          failures: nativeFailures,
          ignored: nativeIgnored,
          reason: boundaryReason,
        };
      },
      async discard() {
        /*
         * Every warm target goes back (v1.9.5). The queue calls this when the chain it was warming
         * for is not the chain the listener is on any more, so all three slots are freed here —
         * bounded by the pool, and with each claim deleted as its slot is unloaded, so nothing is
         * left claiming a track the player no longer holds.
         */
        preparedEpoch += 1;
        const slots = [...warm.keys()];
        warm.clear();
        if (slots.length === 0) return;
        await bounded(
          inAssetLane(async () => {
            for (const slot of slots) await unloadSlot(slot);
          }),
          undefined,
          'discard',
        );
      },
      async play(startSeconds) {
        await startService();
        // Behind the same lane: the play for a track whose preload is still running must not
        // overtake it, and it must not start the previous track's asset either.
        await bounded(inAssetLane(() => NativeAudio.play({ assetId: audibleId, time: Math.max(0, startSeconds) })), undefined, 'play');
        /*
         * The forward-buffer target, written **after** the play call (v1.9.2).
         *
         * The plugin sets its `currentlyPlayingAssetId` when it is asked to play, and that is what
         * our own plugin finds the audible player by; asking before this point would aim the target
         * at the outgoing item. Setting it after the play is still in time — the player fills
         * towards this target for as long as the item plays.
         */
        await configureBuffer();
      },
      async pause() {
        await bounded(NativeAudio.pause({ assetId: audibleId }), undefined, 'pause');
      },
      async resume() {
        await bounded(NativeAudio.resume({ assetId: audibleId }), undefined, 'resume');
      },
      async stop() {
        await bounded(NativeAudio.stop({ assetId: audibleId }), undefined, 'stop');
        await stopService();
        lastPositionMs = 0;
      },
      async seek(seconds) {
        /*
         * The one call with a short deadline, and the one that has been proved to hang: the plugin
         * settles `setCurrentTime` only from AVFoundation's own seek completion, and a zero-tolerance
         * seek reports `finished == false` on a transcoded remote item — the completion is never
         * called, the promise never settles, and everything that waited on it waited for ever. The
         * position the UI shows is written on the engine's side, so nothing is lost by giving up on
         * the answer.
         */
        await bounded(NativeAudio.setCurrentTime({ assetId: audibleId, time: Math.max(0, seconds) }), undefined, 'seek', SEEK_TIMEOUT_MS);
      },
      positionMs() {
        return lastPositionMs;
      },
      async sync() {
        try {
          const [playing, current, duration] = await Promise.all([
            NativeAudio.isPlaying({ assetId: audibleId }),
            NativeAudio.getCurrentTime({ assetId: audibleId }),
            NativeAudio.getDuration({ assetId: audibleId }),
          ]);
          lastPositionMs = Number.isFinite(current.currentTime) ? current.currentTime * 1000 : lastPositionMs;
          return {
            playing: playing.isPlaying === true,
            positionMs: lastPositionMs,
            durationMs: Number.isFinite(duration.duration) ? duration.duration * 1000 : 0,
          };
        } catch (error) {
          console.warn('[navilite] could not read the native transport state', error);
          return null;
        }
      },
      async activateSession() {
        if (!remote) return false;
        try {
          const result = await remote.activateSession();
          return result.active;
        } catch (error) {
          console.warn('[navilite] could not re-arm the audio session', error);
          return false;
        }
      },
      /*
       * The native spectrum. `hasNativeSpectrum` is what the engine asks before it decides how to
       * feed the visualiser: with the tap it never starts a second player in the web layer at all,
       * which is what removes the double-engine handoff the owner described.
       */
      hasNativeSpectrum: spectrum !== null,
      adoptOutcome() {
        // What the last adopt did — 'adopted', 'nothing prepared', 'play refused (…)', 'timed out'
        // (v1.9.5). Read by the engine's reason line; nothing here acts on it.
        return adoptOutcome;
      },
      droppedEvents() {
        return { inaudible: droppedInaudible, slotGrace: droppedSlotGrace };
      },
      async startSpectrum(url, positionMs) {
        if (!spectrum) return false;
        try {
          /*
           * The slot **this bridge** is playing goes with the request (v1.9.5): the plugin looks the
           * player up by that id and taps that one, or refuses. It used to choose for itself and
           * could land on the prepared, silent asset and report `started: true` while the bars read
           * a player nobody is hearing.
           */
          const result = await spectrum.start({ url, positionMs, assetId: audibleId });
          return result.started === true;
        } catch (error) {
          console.warn('[navilite] the native spectrum tap did not start', error);
          return false;
        }
      },
      async stopSpectrum() {
        if (!spectrum) return;
        try {
          await spectrum.stop();
        } catch (error) {
          console.warn('[navilite] the native spectrum tap did not stop', error);
        }
      },
      async spectrumFrame() {
        if (!spectrum) return null;
        try {
          const frame = await spectrum.bands();
          if (!frame || !Array.isArray(frame.bands)) return null;
          return frame;
        } catch {
          return null;
        }
      },
      listenRemoteCommands(handlers) {
        if (!remote) return () => undefined;
        const handles: PluginListenerHandle[] = [];
        let detached = false;
        void remote
          .attach()
          .then(() =>
            Promise.all([
              remote.addListener('next', () => handlers.next()),
              remote.addListener('previous', () => handlers.previous()),
              /*
               * **The boundary the native player took by itself (v1.9.8).**
               *
               * The slot it moved to is the one that is playing from that instant, so this bridge's
               * own state moves with it *before* the engine hears anything: an event about the slot
               * the app believed was audible would be dropped by `isAudible` as a message about an
               * asset nobody is hearing, and the app would go on reading — and reporting — a player
               * that is no longer making the sound.
               */
              remote.addListener('advanced', (event) => {
                const songId = typeof event?.songId === 'string' ? event.songId : '';
                const slot = typeof event?.assetId === 'string' ? event.assetId : '';
                nativeAdvances += 1;
                /*
                 * The slot the native side says it played is the audible one from that instant, and
                 * it is taken from the message rather than looked up: it is the one thing that knows
                 * which slot it made the sound come out of. The warm map is cleaned with it — a slot
                 * it has played is not a slot held ready — and only if the name is missing does this
                 * fall back to finding the track in the pool.
                 */
                if (slot) {
                  warm.delete(slot);
                  audibleId = slot;
                } else if (songId) {
                  for (const [held, entry] of [...warm]) {
                    if (entry.songId !== songId) continue;
                    warm.delete(held);
                    audibleId = held;
                  }
                }
                if (songId) audibleSongId = songId;
                boundaryReason = `the native player took the boundary itself and is playing ${songId || 'the next slot'}`;
                events.onAdvanced?.(songId);
              }),
              /*
               * And where it could not. The app is told the track ended after all — which is what it
               * would have heard had the native side not been armed for it — so the ordinary path
               * advances the track (and, with the app away, does so the moment it comes back).
               */
              remote.addListener('advanceFailed', (event) => {
                const why = typeof event?.reason === 'string' && event.reason ? event.reason : 'no reason given';
                nativeFailures += 1;
                boundaryReason = `the native player could not take the boundary itself (${why})`;
                /*
                 * The end of that track is the web layer's again: while the app is away its own
                 * doors are shut on purpose, and the only thing that may reopen them is this — the
                 * native side saying it did not take the boundary. `onComplete` is the fallback for
                 * an engine that predates the distinction.
                 */
                if (events.onBoundaryRefused) events.onBoundaryRefused();
                else events.onComplete();
              }),
            ]),
          )
          .then((added) => {
            if (detached) {
              void remote.detach().catch(() => undefined);
              return;
            }
            handles.push(...added);
          })
          .catch((error: unknown) => {
            console.warn('[navilite] lock-screen next/previous unavailable', error);
          });
        return () => {
          detached = true;
          for (const handle of handles) void handle.remove().catch(() => undefined);
          handles.length = 0;
          void remote.detach().catch(() => undefined);
        };
      },
    };
  } catch (error) {
    console.warn('[navilite] native audio plugin unavailable; staying on Web Audio', error);
    return null;
  }
}
