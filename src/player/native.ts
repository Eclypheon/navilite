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
import type { DownloadsBridge, IndexRow } from '../state/offline.ts';

/**
 * Who the Now Playing entry is owned by, as the phone reports it (v2.0-beta.16).
 *
 * The entry `mediaremoted` publishes names a bundle id, and a tap on the card or the island's
 * expanded view is routed back to whatever app that id names. `appId` is the `application-identifier`
 * the embedded provisioning profile was issued for (`TEAMID.bundle.id`) — the entitlement itself is
 * not readable without private API, but a sideloaded build carries that profile in plain text, so a
 * rewritten id shows up here. `container` is where the `.app` runs from; `path` is that path, so a
 * relocated build is identifiable and not inferred. `receipt`/`embeddedProfile` say which install
 * method produced the bundle in the first place.
 */
export interface NativeIdentity {
  bundleId?: string;
  appId?: string;
  teamId?: string;
  appGroups?: string;
  path?: string;
  container?: string;
  signatureMatchesBundleId?: boolean;
  receipt?: string;
  embeddedProfile?: boolean;
}

/**
 * What the system has asked this app's scene to do (v2.0-beta.16): `connects` (a cold start, which
 * is also where an external open's URL arrives), `opens` (`scene(_:openURLContexts:)`), `activations`
 * (`sceneDidBecomeActive` — the warm raise a tap on a suspended app produces), `resignations`.
 *
 * If a tap opened nothing and these are unchanged, the app was never asked; that is a different
 * fault from one that reached the scene and failed, and it is the distinction the row could not make.
 */
export interface NativeSceneEvents {
  connects?: number;
  opens?: number;
  activations?: number;
  resignations?: number;
  last?: string;
  lastUrl?: string;
  lastAt?: number;
}

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
   * Publish the **queue** to the native side (v1.9.9) — **a statement, not an increment**.
   *
   * `list` is the app's resolved play order — every entry, in the order it will be played, each with
   * the asset id that holds it when the app has it warm — and `index` is the entry that is playing.
   * That is the whole difference from v1.9.8's `arm`, which named the two warm slots after the
   * current one and nothing else: off screen the web layer is suspended, so that chain was never
   * refilled and a third boundary had nothing to play. A list the native side owns does not run out.
   *
   * `repeat` is the app's repeat mode, so the native side can take the end of the queue the way the
   * app would; `awake` is whether the web layer is running (the native side may only act on a
   * boundary while it is not); `audibleAssetId` is the slot playing right now, so the native side
   * never mistakes a silent warm slot for the track being heard.
   */
  setQueue(options: {
    list: Array<{ songId: string; url: string; title: string; artist: string; album: string; artworkUrl?: string; assetId?: string }>;
    index: number;
    repeat: 'off' | 'all' | 'one';
    awake: boolean;
    audibleAssetId?: string;
    audibleSongId?: string;
    generation?: number;
  }): Promise<{ queued: number; index: number; awake: boolean; armed: boolean }>;
  /**
   * **The one published snapshot (unreleased).** The whole reading of the one player, in one call:
   * the entry the queue is on, the queue's place, the clock, the transport's word and the spectrum
   * frame the item's own tap produced. `entry.key` and `spectrum.itemKey` are minted per item, so a
   * frame dated to another item is never drawn as this one's. The diagnostics the row shows ride on
   * the same answer, so a return costs one round trip.
   */
  snapshot(): Promise<NativeSnapshotRaw>;
  /**
   * `NaviliteRemote.queueTransport` — the away queue's own transport (unreleased, `t_05775526`):
   * `op` is `play` | `pause` | `resume` | `seek`. `play` carries the entry (`index`, position in the
   * order the queue was given) and where in it to start (`positionMs`); `positionMs` alone is where a
   * seek lands. Answers `ok` when the queue's player took the command, and `why` when this side has
   * no queue to command.
   */
  queueTransport?(next: { op: NativeQueueOp; index?: number; positionMs?: number }): Promise<{ ok?: boolean; why?: string }>;
  /**
   * **One line into the persisted log, for the return (unreleased).**
   *
   * The branch of a return is decided here in the web layer and the file is written by Swift, so
   * the sentence naming the branch never reached the phone's own log: a capture said what the phone
   * did and could not say what the app decided. `record(_:_:)` in `NaviliteRemote.swift` stays the
   * only writer — this asks it for exactly one `return` record, at the end of one foreground return.
   */
  recordReturn?(facts: NativeReturnRecord): Promise<{ recorded?: boolean }>;
  /**
   * The persisted boundary log (v2.0-beta.16): every look-ahead and every boundary, one JSON object
   * per line, so the phone's own numbers can leave the phone instead of being read off a row.
   */
  boundaries(): Promise<{ path?: string; lines?: string[]; count?: number; tail?: string[] }>;
  addListener(eventName: 'next' | 'previous' | 'advanced' | 'advanceFailed', listenerFunc: (event: { songId?: string; assetId?: string; index?: number; reason?: string; positionMs?: number; reading?: boolean }) => void): Promise<PluginListenerHandle>;
}


/** One frame of the native spectrum, plus what the tap thinks about it. */
export interface NativeSpectrumFrame {
  /** 64 band values, 0…255 — the same scale `getByteFrequencyData()` reports. */
  bands: number[];
  bandCount: number;
  /** True when the last frame carried energy: a real measurement of a real sound. */
  live: boolean;
  /**
   * FFT frames the tap has produced **for the life of the app process** — the number it has always
   * been (`NaviliteSpectrum`'s `frames += 1`, reset by nothing). Nothing decides anything from it any
   * more (v1.9.25): it is reported, and `itemFrames` below is the fact about the item.
   */
  frames: number;
  /**
   * FFT frames the tap has produced **for the item it is on now** (v1.9.25) — zero at the install,
   * growing only while that item's analysis measures.
   *
   * `frames` cannot answer "has *this item's* tap answered?" (it counts the whole process's life),
   * and inferring it from deltas needs a baseline and a rule for what a gap means. This is that answer
   * as a plugin fact instead: an item's tap that has stopped measuring keeps this number standing
   * still, while a tap measuring *silence* keeps growing it — which is the difference between "the
   * audio is quiet" and "nothing is being measured" that the engine could not read before. Optional,
   * so a bridge whose plugin predates it reads as "not known" and the engine falls back to the
   * process-lifetime counter's growth.
   */
  itemFrames?: number;
  /**
   * The period **this item's own tap declared for itself**, in ms (v1.9.26) — the pace its frames
   * arrive at, and the fact the drawing rule is judged on.
   *
   * The plugin keeps `maxFrames` from `prepare` (it used to discard it, `NaviliteSpectrum.swift:811`),
   * divides it by the processing format's sample rate and floors the result at the tap's own FFT hop
   * (`NaviliteSpectrum.SpectrumAnalysis.framePeriodMs`): `maxFrames` is the tap's own statement of the
   * largest buffer AVFoundation will hand it, so that ratio bounds how long it can legitimately go
   * without producing a frame, and the hop is the floor below which no second frame can exist.
   *
   * It exists because the v1.9.25 rule rested on an assumption nothing had measured — that a healthy
   * tap produces one frame per 33 ms read. It does not: frame production is quantized to the tap's PCM
   * buffer, and 4096-frame buffers are ~11 frames/s against 30 reads/s, so *two reads in three* would
   * have blanked the bars of a tap that was measuring perfectly. Optional, so a bridge whose plugin
   * predates it reads as "not known" and the v1.9.25 rule (only frames this item's tap produced since
   * the last read) stands rather than being assumed away.
   */
  itemFramePeriodMs?: number;
  /**
   * How old **this item's own last frame** is, in ms (v1.9.26): the plugin's own answer, read on the
   * monotonic clock of the analysis that produced it, and `-1` for an analysis that has produced
   * nothing for its item yet.
   *
   * This is the other half of the pace: drawn while `itemFrameAgeMs <= itemFramePeriodMs` (this item's
   * register, one window of its own tap old), named and not drawn past it. Both numbers are the
   * plugin's, about the item its tap is on, so the engine's rule compares two facts rather than a
   * clock of its own — no constant, no poll count, no timer. With `itemFrames === 0` it reads `-1`,
   * which is the loud-skip state that must stay undrawn.
   */
  itemFrameAgeMs?: number;
  /** Of those, how many were digital silence — what a *flat* audio signal looks like. */
  silentFrames: number;
  positionMs: number;
  playing: boolean;
  /**
   * Whether the tap is on an item at all (v1.9.24, read for the first time).
   *
   * The plugin has always sent it (`NaviliteSpectrum.bands()`: `"attached": item != nil`) and the
   * engine has always dropped it, so *"there is no tap"* and *"the tap is on an item the player has
   * left"* were the same reading — and both were described on screen with the second sentence, which
   * is false in the first case. Optional so a bridge that does not send it reads as "not known".
   */
  attached?: boolean;
  /**
   * Whether the item the tap is installed on is still the player's current item — v1.8.0.
   *
   * The one signal that separates "the tap is broken" from "the player has moved on to another item
   * and left the tap behind": `playing` cannot tell them apart, because the *player* is playing the
   * new track throughout. Optional so that a bridge without it (an older plugin) reads as "not known"
   * and nothing is concluded from it.
   */
  itemIsCurrent?: boolean;
  /**
   * The lifecycle rule as the plugin's own numbers (v1.9.25, read for the first time): how many times
   * a tap was *installed* on an item, and how many times a healthy one was only *verified*.
   *
   * The plugin has always sent both (`NaviliteSpectrum.bands()`), and the app has never shown them —
   * and they are the two numbers that separate "the tap is on the wrong item" from "the tap is on the
   * right item and measures nothing" without another round trip. Optional so an older plugin reads as
   * "not known" rather than as zero of something.
   */
  installs?: number;
  verifies?: number;
  readable: boolean;
  sampleRate: number;
}

/**
 * **The one published snapshot (unreleased)** — what `NaviliteRemote.snapshot()` answers, as it
 * arrives: every field optional, because a plugin older than the field simply does not send it, and
 * the normaliser below is where that is made definite.
 */
export interface NativeSnapshotRaw {
  generation?: number;
  entry?: { songId?: string; index?: number; url?: string; assetId?: string; key?: string };
  positionMs?: number;
  durationMs?: number;
  rate?: number;
  state?: string;
  queue?: { index?: number; count?: number; repeat?: string };
  spectrum?: {
    bands?: number[];
    itemKey?: string;
    frames?: number;
    lastAnalysisAt?: number;
    framePeriodMs?: number;
    attached?: boolean;
  };
  advances?: number;
  failures?: number;
  ignored?: number;
  reason?: string;
  identity?: NativeIdentity | null;
  scene?: NativeSceneEvents | null;
  timeline?: NativeForegroundBoundary | null;
}

/** The transport's word, from a total map: `timeControlStatus` on the phone, nothing inferred. */
export type NativeSnapshotState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'interrupted' | 'error';

export interface NativeSnapshot {
  /** The queue rebuild this reading belongs to; a reading from a superseded queue is not rendered. */
  generation: number;
  entry: { songId: string; index: number; url: string; assetId: string; key: string };
  positionMs: number;
  durationMs: number;
  rate: number;
  state: NativeSnapshotState;
  queue: { index: number; count: number; repeat: 'off' | 'all' | 'one' };
  /**
   * **That item's own frame, dated to that item.** `itemKey` is the identity the analysis was
   * installed on (`entry.key` when they agree); `bands` is the last frame it produced, `frames` how
   * many it has produced and `lastAnalysisAt` when it produced the last one. Nothing here is a
   * comparator: a tap slower than the poll is still live, and a quiet passage is not absence.
   */
  spectrum: {
    bands: number[];
    itemKey: string;
    frames: number;
    lastAnalysisAt: number;
    framePeriodMs: number;
    attached: boolean;
  };
}

const SNAPSHOT_STATES: NativeSnapshotState[] = ['idle', 'loading', 'playing', 'paused', 'ended', 'interrupted', 'error'];

/**
 * **The wire boundary for the snapshot** (unreleased): every field is validated here, once, so a
 * consumer never reads a `NaN`, a `-1` index or a band outside `0…255`. Answers `null` when the
 * answer is not an object at all — which is "no reading", the honest answer, not a zeroed one.
 */
export const snapshotOf = (raw: unknown): NativeSnapshot | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as NativeSnapshotRaw;
  const entry = o.entry ?? {};
  const queue = o.queue ?? {};
  const frame = o.spectrum ?? {};
  const num = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const repeat = queue.repeat === 'all' || queue.repeat === 'one' ? queue.repeat : 'off';
  const word = SNAPSHOT_STATES.includes(o.state as NativeSnapshotState) ? (o.state as NativeSnapshotState) : 'idle';
  const published = frame.bands;
  const bands = Array.isArray(published)
    ? published.map((n) => Math.max(0, Math.min(255, Math.round(num(n))))).slice(0, 64)
    : [];
  return {
    generation: num(o.generation),
    entry: {
      songId: str(entry.songId),
      index: num(entry.index, -1),
      url: str(entry.url),
      assetId: str(entry.assetId),
      key: str(entry.key),
    },
    positionMs: Math.max(0, num(o.positionMs)),
    durationMs: Math.max(0, num(o.durationMs)),
    rate: num(o.rate),
    state: word,
    queue: { index: num(queue.index, -1), count: Math.max(0, num(queue.count)), repeat },
    spectrum: {
      bands,
      itemKey: str(frame.itemKey),
      frames: Math.max(0, num(frame.frames)),
      lastAnalysisAt: Math.max(0, num(frame.lastAnalysisAt)),
      framePeriodMs: Math.max(0, num(frame.framePeriodMs)),
      attached: frame.attached === true,
    },
  };
};

export interface NativeTrackInfo {
  /**
   * The song's own id (v1.9.5), when the caller knows it.
   *
   * The warm pool is keyed on the track rather than on the slot it sits in — three tracks are
   * warmed at once, so "the prepared asset" is no longer one thing — and `load` is told which
   * track is being started rather than whatever happens to be in a fixed slot. Optional
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

/**
 * The JS-side (foreground) boundary's own clock, ms (v2.0-beta.15).
 *
 * The native timeline covers only the boundaries the native player takes while the app is away. A
 * boundary the web layer takes — the app on screen, the item ending — had no number at all, so a
 * foreground gap was an absence in the row. This is its counterpart on the same axis: when this
 * layer began the boundary (the incoming load, or the play itself when the slot was already warm),
 * when it issued the play, and the first read of a player that was actually sounding.
 *
 * It is kept as its own reading rather than folded into the away one: neither overwrites the other,
 * and `pending`/`ageMs` say whether these numbers are a finished measurement and how old it is — an
 * old number standing in for the current one is the blind round this row exists to prevent.
 */
export interface NativeForegroundBoundary {
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
  /** Now − the moment the reading was made, ms, so a stale one is identifiable; `-1` when nothing is timed. */
  ageMs: number;
  /** True while the boundary has been begun and no sound has been reported for it yet. */
  pending: boolean;
}

/**
 * One entry of the queue as the native side is given it (v1.9.9).
 *
 * `url` is the entry's **own file**, never a capped or transcoded variant: this side fetches an
 * unwarmed entry itself at a boundary, and the owner's rule is that a track being played is played
 * as the file sits on the server. There is no `warmUrl` beside it any more (unreleased): nothing in
 * the app holds an entry warm under a second URL, so every entry is one the player fetches or
 * already has in its own queue.
 */
export interface NativeQueueEntry {
  songId: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

/**
 * The ops `queueTransport` takes on the one surviving player: `play` starts entry `index` at
 * `positionMs`, and `pause`/`resume`/`seek` are the presses (unreleased, `t_fa149147`).
 */
export type NativeQueueOp = 'play' | 'pause' | 'resume' | 'seek';

/**
 * **A reading the bridge could not take, named** (unreleased, design §5).
 *
 * The three ways the one snapshot comes back empty, and each is a different step:
 *   - `no_plugin` — this build has no `snapshot()` at all (an older plugin, a browser, a fake);
 *   - `no_answer` — the call was made and did not answer inside its deadline;
 *   - `not_a_snapshot` — it answered, and the answer is not the shape {@link NativeSnapshot} states.
 *
 * It is a value rather than a `null` because a `null` is an absence no surface can paint: the chip
 * kept whatever word it had a moment ago, which is the capability claim this release exists to
 * remove. `boundaryReason` carries the one sentence naming the step.
 */
export type SnapshotRefusal = 'no_plugin' | 'no_answer' | 'not_a_snapshot';

/** The snapshot's own "I could not read the player, and here is which step failed". */
export interface UnavailableSnapshot {
  unavailable: SnapshotRefusal;
}

/** What `snapshot()` answers: the reading, or the named reason there is none. */
export type SnapshotAnswer = NativeSnapshot | UnavailableSnapshot;

/** True for the refusal half of {@link SnapshotAnswer} — the only safe way to tell the two apart. */
export const isUnavailableSnapshot = (answer: SnapshotAnswer): answer is UnavailableSnapshot =>
  (answer as UnavailableSnapshot).unavailable !== undefined;

/**
 * **A transport press the player did not take, named** (unreleased, design §5).
 *
 *   - `not_ready` — there is no queue transport in this build, or it did not answer in time;
 *   - `post_end` — it answered and declined: no queue to take it, an unknown op, or an entry the
 *     published order no longer holds;
 *   - `superseded` — it declined a `play` for an entry the queue has already moved past, which is a
 *     press that arrived after its own moment.
 */
export type TransportRefusal = 'not_ready' | 'post_end' | 'superseded';

/** The queue's refusal, with the plugin's own sentence when it gave one. */
export interface RefusedTransport {
  refused: TransportRefusal;
  why: string;
}

/** What `queueTransport()` answers: it was taken, or the named reason it was not. */
export type TransportAnswer = { ok: true } | RefusedTransport;

/** The app's statement of the queue: the resolved play order, the entry playing, and the rules. */
export interface NativeQueueStatement {
  list: readonly NativeQueueEntry[];
  /** Position in `list` of the entry playing now, or -1 when nothing is. */
  index: number;
  repeat: 'off' | 'all' | 'one';
  /** Whether the web layer is running. Only `false` lets the native side take a boundary. */
  awake: boolean;
}

export interface NativeBridge {
  load(info: NativeTrackInfo): Promise<void>;
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
   * Publish the **queue** the native player is to walk (v1.9.9), and whether it may act on it.
   *
   * `list` is the app's resolved play order — one entry per track, in the order it will be played,
   * each carrying the asset id that holds it when the app has it warm — and `index` is the entry
   * playing now. The bridge turns the warm entries into the slots holding them; an entry the app
   * has nothing warm for goes **without a slot**, and the native side then fetches that entry itself
   * at the boundary. That is the structural half of this release: the list cannot run out, so no
   * number of track ends with the app away can silence the music, and every boundary that cannot be
   * refusal is reported with its reason.
   *
   * `awake` is whether the web layer is running: with the app on screen the JS side owns the
   * boundary exactly as it always has, and the native side is only told what follows.
   *
   * Answers whether the native side holds the boundary (there is no native boundary on Android, and
   * none in a build without our iOS plugin, where the JS side keeps owning it).
   */
  setQueue?(statement: NativeQueueStatement): Promise<boolean>;
  /**
   * **A transport press, sent to the away queue's own player (unreleased, `t_05775526`).**
   *
   * The queue is the sound on a return the app could not take back, and the app's own player is silent
   * there: `pause()`/`resume()`/`seek()` on this bridge reach only that silent player, which is a write
   * nobody can hear. This is the one call that reaches the player actually making the sound, so a
   * press on the row stops, restarts or moves what the owner is listening to. Optional: a build
   * without it answers nothing, and the engine keeps its old route.
   */
  /**
   * **The one read of the one player (unreleased).** Entry, clock, transport word and that item's own
   * spectrum frame, in one answer. Optional so a bridge older than it is a bridge with no reading
   * rather than a crash.
   *
   * A read that cannot be taken answers {@link UnavailableSnapshot} — a named reason, never a bare
   * `null`: an absence with no word is the state the chip cannot paint, and a chip that keeps its
   * last word through it is claiming a measurement nobody took (design §5).
   */
  snapshot?(): Promise<SnapshotAnswer>;
  queueTransport?(op: NativeQueueOp, positionMs?: number, index?: number): Promise<TransportAnswer>;
  /**
   * **Write the return's own line into the phone's log (unreleased).**
   *
   * Called once, at the end of one foreground return, by the branch that decided it — never off a
   * status or report stream, so a return that emits two records is a defect this contract makes
   * visible. Optional: a bridge without it (an older plugin, the fake bridge) still returns, it just
   * cannot date or name the return in the file.
   */
  recordReturn?(facts: NativeReturnRecord): Promise<boolean>;
  /** What the native boundary has done, as numbers and a sentence — for the reason line (v1.9.8). */
  nativeAdvance?(): {
    armed: number;
    advances: number;
    failures: number;
    ignored: number;
    reason: string;
    /** The last boundary's five moments in ms from the item end, as one sentence (v2.0-beta.14). */
    timeline: string;
    /**
     * Who the Now Playing entry is owned by and what the system asked this app's scene to do, as one
     * sentence (v2.0-beta.16) — see `identitySentence`. Empty until the plugin has answered a
     * `now()`; it is the only place the bundle id and the scene counts reach the row.
     */
    identity: string;
    /** When that (away) boundary began, epoch ms; `0` when none has been made (v2.0-beta.15). */
    startedAt: number;
    /**
     * The last JS-side (foreground) boundary's clock — the counterpart of `timeline`/`startedAt`,
     * kept separately so neither boundary overwrites the other (v2.0-beta.15). `null` until one has
     * been begun; `pending` marks a boundary that has not produced sound yet.
     */
    foreground: NativeForegroundBoundary | null;
  };
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
   * Which slot the tap landed on, and which slot this bridge is playing (v1.9.25).
   *
   * `tapped` is the plugin's own answer to the install request — it resolves with the asset id it put
   * (or kept) the tap on — and `audible` is the slot this bridge last made the audible one
   * (`startSpectrum` names it in every request). Two strings the app has always held and never shown,
   * and the pair that separates *"the tap is on another player"* from *"the tap is on this one and is
   * measuring nothing"* — a distinction that otherwise costs another diagnosis round on the device.
   * Optional, so a bridge without it reports nothing rather than a made-up identity.
   */
  spectrumEvidence?(): { tapped: string | null; audible: string | null };
  /** Whether this platform can produce the spectrum from the native player at all. */
  readonly hasNativeSpectrum: boolean;
  /**
   * What the last `load` did, when it was not simply a fetch (v1.9.11).
   *
   * A load is the engine's one way to put an entry on the player: there is nothing warm to
   * claimed pool, and until v1.9.11 it always took the audible slot over (unload + preload), so the
   * player held nothing at all for as long as the new stream took to appear — the owner's *"it
   * clears out all songs from the native player ... a couple of seconds with no songs loaded in"*.
   * The load now hands over to a slot the player already holds the same track in, or writes the
   * incoming track into a slot that is **not** the one being heard and only frees that one once the
   * new item has been asked to play — and this is the account of which of those happened, for the
   * engine's reason line.
   */
  loadOutcome?(): string;
  /**
   * How many events the bridge itself discarded since it was built (v1.9.5), by reason: events for
   * an asset that is not the audible one, and completions swallowed by the slot-write grace. Both
   * are deliberate filters; both were also silent, so a report that never arrived could not be
   * told from one that never existed.
   */
  droppedEvents?(): { inaudible: number; slotGrace: number };
}






/**
 * **One foreground return, as the log must be able to say it (unreleased).**
 *
 * Written by the side that *decided*, once per return: which branch the return took (`path`), the
 * reading the branch was decided from (`songId`, the route that owned the sound, position and
 * duration), whether a start was issued this return, and the state the machine settled on. `awake`
 * is added by the native side's `record(_:_:)`, which knows it; `index` and `generation` ride along
 * with it for the same reason.
 */
export interface NativeReturnRecord {
  /** Which branch the return took. Never `none` — this record only exists once a branch ran. */
  path: 'read';
  /** The entry the reading named (or the visible one when the player named nothing). */
  songId: string;
  /** The route that owned the sound when the return decided: `queue` / `fetch` / `plugin` / `none`. */
  route: string;
  /** The reading's live position, ms — `-1` when there was no reading. */
  positionMs: number;
  /** The track's duration, ms, as the return ended — `-1` when unknown. */
  durationMs: number;
  /** Whether a start was issued through `play` during this return. `true` means this return started something. */
  started: boolean;
  /** The state the return settled on — `playing`, `paused`, `interrupted`, `loading`. */
  state: string;
  /** The engine's own sentence naming the branch (`modeReason`), so the file carries it too. */
  why?: string;
}

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
   * to — with the **index** it moved to inside the queue the app published (v1.9.9), because a play
   * order is not a list of slot names and an index is the only thing that survives a shuffle.
   * See {@link NativeBridge.setQueue}: while the app is off screen nothing else can take a boundary.
   *
   * It is a *read*: the audio is already playing, so the listener to this must move onto that
   * track rather than start it. Optional so a bridge without it (an older build, the fake bridges in
   * the tests) is a bridge that simply never reports one.
   *
   * **And a position rides with it when the native side is ANSWERING a refusal (unreleased).** A
   * refusal that names the entry the queue is sounding is an answer, and the answer
   * carries where that entry is now (`positionMs`) plus `reading: true`: the app renders that
   * reading instead of leaving the row on `loading` and asking again every three seconds.
   */
  onAdvanced?(songId: string, index: number, positionMs?: number): void;
}

const BACKGROUND_AUDIO_SERVICE = 'BackgroundAudio';
const NAVILITE_REMOTE = 'NaviliteRemote';

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
 * Run a bridge call under a deadline: it resolves with `fallback` if the plugin does not answer.
 *
 * A rejected call is not an error the listener should see either — it is reported and the fallback
 * stands, exactly as the plugin's own `missing-plugin` path does.
 *
 * v1.9.2 — **the result says whether the plugin answered at all.** A call that timed out and a call
 * that answered `undefined` used to be the same value, and for the prepared slot that difference is
 * the whole bug: a prepare that timed out was recorded as a prepared track, so the next boundary
 * did nothing and nothing said so. Callers that care about the distinction use this; callers
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
 * How long a warm job may wait for the audible lane to go quiet before it gives up and issues
 * nothing (v1.9.9). Short on purpose: the point is that warm work never sits in front of a tap, and
 * a warm that cannot happen now is warmed again by the next look-ahead.
 */
const WARM_YIELD_MS = 3000;
const WARM_YIELD_STEP_MS = 100;

/**
 * The two lanes every write to the player runs on (v1.9.9) — **and the rule that the audible one is
 * never behind warm work**.
 *
 * This is one release's worth of the owner's second mandatory invariant, in a shape that can be
 * tested without a phone: `audible` carries what the listener is waiting for, `warm` carries what he
 * is not, and a warm job can ask `yieldToAudible` whether it is polite to issue anything at all yet.
 * Both lanes serialise their own work (two writes to one asset slot must never be in flight at
 * once), and neither waits for the other.
 */
export interface AssetLanes {
  /** Run work on the audible lane: a start, a read, the play of a start, a slot's unload. */
  audible<T>(work: () => Promise<T>): Promise<T>;
  /** Run work on the warm lane: a warm, its proof, a replaced slot's unload, a discard. */
  warm<T>(work: () => Promise<T>): Promise<T>;
  /** True while an audible job is actually running — what warm work stands aside for. */
  readonly busy: boolean;
  /** Wait for the audible lane to go quiet, bounded. `false` means it never did. */
  yieldToAudible(ms?: number): Promise<boolean>;
}

/**
 * The native boundary log, for the settings screen's copy-out (v2.0-beta.16).
 *
 * The row can say the seam was warm and still leave the owner with a ten-second silence he has to
 * describe in words. This hands the phone's own lines over — every look-ahead (`ahead`), every track
 * end (`end`, with whether the native side was allowed to take it), every boundary (`boundary`, with
 * the five moments, the path, the slot and why-not-warm) and every first sound (`audible`,
 * `audible-gave-up`) — so the next round starts from a measurement instead of from source. `null`
 * on any build without the plugin, and on any failure: it is a diagnostic, never a feature.
 */
export async function boundaryLog(): Promise<{ path: string; lines: string[]; count: number } | null> {
  if (!Capacitor.isPluginAvailable(NAVILITE_REMOTE)) return null;
  try {
    const remote = registerPlugin<NaviliteRemotePlugin>(NAVILITE_REMOTE);
    const answer = await remote.boundaries();
    return {
      path: typeof answer.path === 'string' ? answer.path : '',
      lines: Array.isArray(answer.lines) ? answer.lines : [],
      count: Number.isFinite(answer.count) ? Number(answer.count) : 0,
    };
  } catch (cause) {
    /*
     * A diagnostic, never a feature: no plugin, no log, and the row simply has no file to show. The
     * absence is rendered as an absent row, so there is no state to invent; the cause is bound so a
     * support report can see why (design §5).
     */
    void cause;
    return null;
  }
}

/**
 * One sentence for the row (v2.0-beta.16): who the Now Playing entry is owned by, and what the
 * system has asked this app's scene to do since it started.
 *
 * This is the tap investigation's whole reading. Two things can make a card tap open nothing, and
 * they look identical from the app: the id the media remote holds does not resolve to an installed,
 * activatable app (a rewritten bundle id, which the signed `application-identifier` exposes), or the
 * system activated the app and the scene did nothing with it. The counts separate them — a tap whose
 * numbers are unchanged never arrived, which is a fact about the install, not about this code.
 */
export function identitySentence(identity: NativeIdentity | null, scene: NativeSceneEvents | null): string {
  if (!identity && !scene) return 'identity: this build reports none';
  const id = identity ?? {};
  const count = (n?: number) => (Number.isFinite(n) ? String(n) : '—');
  const team = id.teamId && id.teamId !== 'unknown' ? `team ${id.teamId}` : 'no team entitlement';
  const signature = !id.appId
    ? 'no application-identifier'
    : id.signatureMatchesBundleId
      ? 'signed id matches'
      : 'signed id DIFFERS';
  const s = scene ?? {};
  const asked = s.last && s.last !== 'none' ? `last ${s.last}${s.lastUrl ? ` ${s.lastUrl}` : ''}` : 'never asked';
  return (
    `id ${id.bundleId || 'unknown'} (${team}, ${id.container ?? 'unknown location'}, ${signature}) · ` +
    `scene ${count(s.connects)} connect / ${count(s.opens)} open-url / ${count(s.activations)} active, ${asked}`
  );
}

/**
 * Resolves an artwork URL to an absolute URL against the stream or current origin so native image loaders can fetch it (v2.0-beta.12).
 */
export function toAbsoluteArtworkUrl(artworkUrl?: string | null, streamUrl?: string): string | undefined {
  if (!artworkUrl) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(artworkUrl)) {
    return artworkUrl;
  }
  if (streamUrl && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(streamUrl)) {
    try {
      return new URL(artworkUrl, streamUrl).toString();
    } catch (cause) {
      /*
       * Not an error path with a state of its own: an artwork URL that will not resolve is drawn as
       * the raw string, and "no art" is already a rendered state (the palette falls back). The cause
       * is bound rather than dropped so the reason is not invisible in a debugger (design §5).
       */
      void cause;
    }
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(artworkUrl, window.location.origin).toString();
    } catch (cause) {
      // Same optional value, same rendered absence — see above.
      void cause;
    }
  }
  return artworkUrl;
}

export function createAssetLanes(yieldStepMs = WARM_YIELD_STEP_MS): AssetLanes {
  const chain = <T>(current: Promise<unknown>, work: () => Promise<T>): { next: Promise<T>; settled: Promise<unknown> } => {
    const next = current.then(work, work);
    return { next, settled: next.then(() => undefined, () => undefined) };
  };
  let audibleLane: Promise<unknown> = Promise.resolve();
  let warmLane: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    audible<T>(work: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        // Counted from the moment the job actually runs, not from the moment it is queued: what a
        // warm job must stand aside for is a start that is really in flight.
        inFlight += 1;
        try {
          return await work();
        } finally {
          inFlight = Math.max(0, inFlight - 1);
        }
      };
      const { next, settled } = chain(audibleLane, run);
      audibleLane = settled;
      return next;
    },
    warm<T>(work: () => Promise<T>): Promise<T> {
      const { next, settled } = chain(warmLane, work);
      warmLane = settled;
      return next;
    },
    get busy(): boolean {
      return inFlight > 0;
    },
    async yieldToAudible(ms = WARM_YIELD_MS): Promise<boolean> {
      for (let waited = 0; waited < ms && inFlight > 0; waited += yieldStepMs) await sleep(yieldStepMs);
      return inFlight === 0;
    },
  };
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




export async function createNativeBridge(os: OsName, events: NativeBridgeEvents): Promise<NativeBridge | null> {
  if (os === 'web') return null;
  try {
    /** What the last `load` did, in the words the reason line shows (v1.9.11). */
    let loadOutcome = 'not attempted';
    /** What the last load did, in the words the reason line shows (v1.9.5). */
    /** The track the audible slot holds (v1.9.8) — what the native boundary is told is playing. */
    let audibleSongId: string | null = null;
    /**
     * The queue the native player is to walk (v1.9.9), as the app last stated it, and what came of
     * it. Every field has one clearing path: `setQueue` replaces the whole statement, an empty list
     * is the app saying "there is no queue", and the engine states one after every start, every warm
     * and every visibility change — so nothing here can be left half-applied by a lost message.
     */
    let statement: NativeQueueStatement = { list: [], index: -1, repeat: 'off', awake: true };
    /** How many entries the native side was given, and how many of them it holds a slot for. */
    let boundaryQueued = 0;
    let boundaryArmed = false;
    let boundaryReason = 'nothing stated yet';
    /**
     * The last **away** boundary's own timeline, in the row's own words (v2.0-beta.14).
     *
     * This is the thing three rounds of "the gap between songs" were diagnosed without: the app could
     * say a boundary happened and not one number about where its seconds went. The native plugin
     * records the five moments and this is the sentence the diagnostics row carries.
     *
     * Only an away boundary is timed natively (v2.0-beta.15), so the sentence names it as that and
     * carries its **age**: these numbers survive the return to the foreground, and an old boundary's
     * milliseconds read exactly like a fresh one unless the row says which boundary it is.
     */
    let lastTimeline = 'last away-boundary: none yet';
    /** When that boundary began, epoch ms — so a foreground boundary measured later can outrank it. */
    let lastTimelineAt = 0;
    /**
     * What the phone says this app is, and what the system has asked its scene to do (v2.0-beta.16).
     *
     * Both come from the plugin's `now()` and neither is otherwise reachable: the bundle id the Now
     * Playing entry is owned by, and the scene callbacks that say whether the system ever asked this
     * app to come to the front. Kept as reported — the sentence is built from them, and an older
     * plugin that answers without them leaves the row saying so instead of inventing a reading.
     */
    let nativeIdentity: NativeIdentity | null = null;
    let nativeScene: NativeSceneEvents | null = null;
    /**
     * The JS-side boundary's own clock (v2.0-beta.15).
     *
     * The native timeline covers only the boundaries the native player takes while the app is away.
     * A boundary the web layer takes — the app on screen, the item ending — had no number at all, so
     * a foreground gap was an absence in the row. `foregroundStartedAt` is stamped when this layer
     * begins the start (the incoming load, or the play when the slot was already warm),
     * `foregroundPlayedAt` when it issues the play, and `foregroundAudibleAt` on the first read of a
     * player that is actually sounding. A new boundary replaces the previous reading rather than
     * letting it stand, which is why `pending` exists: begun and not yet sounding is its own state.
     */
    let foregroundStartedAt = 0;
    let foregroundPlayedAt = 0;
    let foregroundAudibleAt = 0;
        let foregroundRead = false;
    /**
     * The next `load()` is the app moving onto a track the native side is already playing — set by
     * `reconcile()` when it finds the player on another entry, and consumed by that load.
     */
    let nextLoadIsRead = false;
    /** The offset the current start asked for, ms — the gate that tells the incoming item's report
     * from a report the outgoing item is still sending (see `noteForegroundAudible`). */
    let foregroundAskedMs = 0;
    /** How far a report may sit from the asked-for offset and still be about this start, ms. */
    const FOREGROUND_AUDIBLE_SLACK_MS = 2000;
    /** Begin a boundary this layer is about to take: the previous reading stops being the current one. */
    const beginForegroundBoundary = (): void => {
      foregroundStartedAt = Date.now();
      foregroundPlayedAt = 0;
      foregroundAudibleAt = 0;
      foregroundAskedMs = 0;
      foregroundRead = false;
    };
    /**
     * The foreground gap's **end**, from the path that actually observes playback while the app is on
     * screen (v2.0-beta.15).
     *
     * `sync()` is not that path: it runs on resume, after a seek, and on the return from hidden —
     * never at an awake track boundary, which is the boundary this clock exists to measure. The
     * plugin's own `playbackState` report is: it is the same word the clock's redraw is built from
     * (the engine's `onState`, src/player/engine.ts:1486), and it arrives at the boundary because the
     * boundary ends with a `play`. Two conditions keep it honest — the play must have been issued by
     * this layer (before it, the state belongs to the item being replaced), and the position must be
     * near the offset that play asked for (the outgoing item keeps reporting for as long as the
     * incoming stream is fetched; engine.ts:1475 gates its own start the same way).
     */
    const noteForegroundAudible = (isPlaying: boolean | undefined, currentTimeSeconds: unknown): void => {
      if (foregroundStartedAt === 0 || foregroundAudibleAt > 0 || foregroundRead) return;
      if (isPlaying !== true || foregroundPlayedAt === 0) return;
      const at = Number(currentTimeSeconds);
      if (Number.isFinite(at) && Math.abs(at * 1000 - foregroundAskedMs) > FOREGROUND_AUDIBLE_SLACK_MS) return;
      foregroundAudibleAt = Date.now();
    };
    const foregroundBoundary = (): NativeForegroundBoundary | null => {
      if (foregroundStartedAt === 0) return null;
      const measured = foregroundAudibleAt > 0 ? foregroundAudibleAt : foregroundStartedAt;
      return {
        startedAt: foregroundStartedAt,
        playedAt: foregroundPlayedAt,
        audibleAt: foregroundAudibleAt,
        playMs: foregroundPlayedAt > 0 ? foregroundPlayedAt - foregroundStartedAt : -1,
        audibleMs: foregroundAudibleAt > 0 ? foregroundAudibleAt - foregroundStartedAt : -1,
        ageMs: Date.now() - measured,
        pending: foregroundAudibleAt === 0,
      };
    };
    const foregroundText = (): string => {
      const fg = foregroundBoundary();
      if (!fg) return '';
      if (fg.pending) {
        return ` · last foreground boundary: begun ${Math.round(fg.ageMs / 1000)} s ago, ${fg.playedAt > 0 ? 'play issued' : 'no play issued'}, not sounding yet`;
      }
      /*
       * Both halves are named only when both exist (v2.0-beta.15): `start→play` is the wait for the
       * player to take the request, `play→sound` the wait for it to produce audio, and `start→sound`
       * is their sum. A boundary with no play issued has one half, not two — the old branch printed
       * the sound number under both labels (`start→sound 120 ms · start→sound 120 ms`).
       */
      const halves =
        fg.playMs >= 0 ? `start→play ${fg.playMs} ms · play→sound ${fg.audibleMs - fg.playMs} ms · ` : '';
      /*
       * And it says when it is not the newest reading on the row (v2.0-beta.15): `lastTimelineAt` is
       * the start of the last **away** boundary, so a foreground reading that began before it is the
       * older of the two and must not pass for the current one.
       */
      const older =
        lastTimelineAt > 0 && fg.startedAt < lastTimelineAt ? ', older than the away boundary' : '';
      return ` · last foreground boundary: ${halves}start→sound ${fg.audibleMs} ms (${Math.round(fg.ageMs / 1000)} s ago${older})`;
    };
    const timelineText = (t: {
      path?: string;
      cardMs?: number;
      fetchMs?: number;
      readyMs?: number;
      playMs?: number;
      audibleMs?: number;
      ageMs?: number;
      pathDetail?: string;
      whyNotWarm?: string;
      buffered?: number;
      ahead?: string;
    }): string => {
      const at = (value: number | undefined): string =>
        Number.isFinite(value) && Number(value) >= 0 ? `${value} ms` : '—';
      const age =
        Number.isFinite(t.ageMs) && Number(t.ageMs) >= 0
          ? ` (${Math.round(Number(t.ageMs) / 1000)} s ago)`
          : '';
      /*
       * v2.0-beta.16 — the seam's own two facts, on the row. `path` said "warm" for a seam that
       * started from a resolved item with no audio in it, which is the state the owner heard for ten
       * seconds; `buffered` is what the play actually had, and `whyNotWarm` is the sentence that says
       * which slot refused and why. `ahead` is the look-ahead's own account for the *next* boundary.
       */
      const buffer =
        Number.isFinite(t.buffered) && Number(t.buffered) >= 0 ? `, buffered ${t.buffered} s` : '';
      const why = t.whyNotWarm ? ` · why-not-warm: ${t.whyNotWarm}` : '';
      const ahead = t.ahead ? ` · ahead: ${t.ahead}` : '';
      return (
        `last away-boundary${age}: card ${at(t.cardMs)} · fetch ${at(t.fetchMs)} · ready ${at(t.readyMs)} · ` +
        `play ${at(t.playMs)} · audible ${at(t.audibleMs)} (${t.path ?? 'none'} path${buffer})${ahead}${why}`
      );
    };
    /** The number of the statement, so the reason line can name the picture the native side holds. */
    let statementGeneration = 0;
    /** What the native side has done by itself, and where it would not (v1.9.8). */
    let nativeAdvances = 0;
    let nativeFailures = 0;
    let nativeIgnored = 0;


    const service = Capacitor.isPluginAvailable(BACKGROUND_AUDIO_SERVICE)
      ? registerPlugin<BackgroundAudioPlugin>(BACKGROUND_AUDIO_SERVICE)
      : null;
    const remote = Capacitor.isPluginAvailable(NAVILITE_REMOTE) ? registerPlugin<NaviliteRemotePlugin>(NAVILITE_REMOTE) : null;
    // iOS only, and only from v1.7.2: the FFT tap on the audio the player is playing.

    let lastPositionMs = 0;



    
    const stateQueue = async (): Promise<boolean> => {
      if (!remote?.setQueue) {
        boundaryArmed = false;
        boundaryQueued = 0;
        boundaryReason = 'this build has no native boundary plugin, so the web layer owns the boundary as it always did';
        return false;
      }
      /*
       * No entry is named with a slot any more: the queue is the only player and it fetches (or
       * already holds) every entry itself, so the list is the order and nothing else.
       */
      const list = statement.list.map((entry) => ({
        songId: entry.songId,
        url: entry.url,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        artworkUrl: toAbsoluteArtworkUrl(entry.artworkUrl, entry.url),
      }));
      statementGeneration += 1;
      const answer = await bounded(
        remote.setQueue({
          list,
          index: statement.index,
          repeat: statement.repeat,
          awake: statement.awake,
          audibleSongId: audibleSongId ?? undefined,
          generation: statementGeneration,
        }),
        null,
        'setQueue',
      );
      boundaryQueued = answer?.queued ?? list.length;
      /*
       * **The native side may act on this only while the web layer is not running.** With the app
       * on screen the JS side takes the boundary exactly as it always has — which is what keeps the
       * two from both advancing a track, and keeps `repeat one`, the end of the queue and the
       * on-screen `next` on the one path that implements them.
       */
      boundaryArmed = answer !== null && answer.armed === true && statement.awake === false && statement.index >= 0;
      boundaryReason =
        answer === null
          ? 'the native boundary plugin did not answer, so the web layer keeps the boundary'
          : boundaryArmed
            ? `the native player will walk this queue itself if a track ends with the app away (${list.length} entries, every one of them the queue's own to fetch)`
            : statement.awake
              ? 'the app is on screen, so the web layer takes the track boundary and the native side is only told what follows'
              : statement.index < 0
                ? 'no track is playing, so there is nothing for the native side to advance from'
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

    /** Where the entry the app is on sits in the order the phone was given. */
    const entryIndex = (): number => {
      if (audibleSongId !== null) {
        const at = statement.list.findIndex((entry) => entry.songId === audibleSongId);
        if (at >= 0) return at;
      }
      return statement.index;
    };

    /**
     * **The one call that reaches the player making the sound.**
     *
     * `NaviliteRemote.queueTransport` is the away queue's own transport — a lock-screen press takes
     * the same path — so a start, a pause, a resume and a seek all leave the web layer as one intent
     * about the queue: `play` names the entry (`index`) and where in it to start (`positionMs`), and
     * `pause`/`resume`/`seek` are the presses. Bounded like every other call on this bridge: the row
     * has already moved, so a plugin that never answers must not hold a press open.
     */
    const sendTransport = async (
      op: NativeQueueOp,
      positionMs?: number,
      ms = BRIDGE_TIMEOUT_MS,
      index = entryIndex(),
    ): Promise<TransportAnswer> => {
      /*
       * **A refusal is a named result, not a line in the console** (unreleased, design §5). Every
       * exit below writes one sentence into `boundaryReason` — the string the settings row and
       * `nativeAdvance()` hand to the screen — so a press the queue did not take reads as which of
       * the three it was, on the device, without a debugger.
       */
      if (!remote?.queueTransport) {
        boundaryReason = `the queue's own player refused the ${op} (not_ready): this build has no queue transport`;
        return { refused: 'not_ready', why: 'this build has no queue transport' };
      }
      const at = Number.isFinite(positionMs) ? Math.round(positionMs as number) : -1;
      /* `index` travels only with `play`: it names an entry, and the presses name none. */
      const asked: { op: NativeQueueOp; index?: number; positionMs: number } = { op, positionMs: at };
      if (op === 'play') asked.index = index;
      const answer = await bounded(remote.queueTransport(asked), null, `queueTransport-${op}`, ms);
      if (answer === null) {
        boundaryReason = `the queue's own player refused the ${op} (not_ready): it did not answer within ${ms} ms`;
        return { refused: 'not_ready', why: `it did not answer within ${ms} ms` };
      }
      if (!answer?.ok) {
        const why = answer?.why ?? 'the plugin gave no reason';
        /*
         * A `play` for an entry the published order has already left is not a refusal about the
         * player: the press arrived after its own moment. `statement.index` is re-read after the
         * round trip, so this is a fact about the order rather than a guess about the plugin.
         */
        const refused: TransportRefusal =
          op === 'play' && Number.isFinite(index) && statement.index !== index ? 'superseded' : 'post_end';
        boundaryReason =
          refused === 'superseded'
            ? `the play of entry ${index + 1} was superseded before the player answered — the queue is on entry ${statement.index + 1}: ${why}`
            : `the queue's own player refused the ${op} (post_end): ${why}`;
        return { refused, why };
      }
      return { ok: true };
    };

    /**
     * **The one read of the one player (unreleased).** The plugin answers with the whole snapshot and
     * this normalises it; the diagnostics that ride on the same answer are read here, so a return
     * costs one round trip rather than one per fact.
     */
    const readSnapshot = async (): Promise<SnapshotAnswer> => {
      /*
       * **Three named exits, and no `null`** (unreleased, design §5). Each sentence names the step
       * that failed, because the chip paints this string: "the plugin did not answer" and "the
       * plugin answered nonsense" are different defects, and a return used to show neither.
       */
      if (!remote?.snapshot) {
        boundaryReason = 'the player plugin has no snapshot in this build (no_plugin), so the app cannot read what it is holding';
        return { unavailable: 'no_plugin' };
      }
      const state = await bounded(remote.snapshot(), null, 'snapshot');
      if (!state) {
        boundaryReason = 'the player plugin did not answer the snapshot inside its deadline (no_answer), so the app cannot read what it is holding';
        return { unavailable: 'no_answer' };
      }
      if (Number.isFinite(state.advances)) nativeAdvances = Number(state.advances);
      if (Number.isFinite(state.failures)) nativeFailures = Number(state.failures);
      if (Number.isFinite(state.ignored)) nativeIgnored = Number(state.ignored);
      if (typeof state.reason === 'string' && state.reason) boundaryReason = state.reason;
      if (state.timeline) {
        lastTimeline = timelineText(state.timeline);
        const timed = Number(state.timeline.startedAt);
        lastTimelineAt = Number.isFinite(timed) && timed > 0 ? timed : 0;
      }
      if (state.identity) nativeIdentity = state.identity;
      if (state.scene) nativeScene = state.scene;
      const snap = snapshotOf(state);
      if (!snap) {
        boundaryReason = 'the player plugin answered something that is not a snapshot (not_a_snapshot)';
        return { unavailable: 'not_a_snapshot' };
      }
      if (snap.entry.songId) audibleSongId = snap.entry.songId;
      return snap;
    };

    return {
      async load(info) {
        /*
         * The JS-side boundary begins here (v2.0-beta.15): this is the first moment the layer asks
         * for the incoming track, so it is the start the foreground gap is measured from — before
         * the fetch, the same way the native timeline measures from the item end.
         */
        /*
         * A **return reading** is not a boundary (v2.0-beta.15): when the snapshot handed the app a track
         * the native side is already playing, this load is the app moving onto it — the sound began
         * before the app was running, so a clock started here would measure the few ms between the
         * return and this call and call it a gap. The previous reading stands instead, aged.
         */
        if (nextLoadIsRead) {
          nextLoadIsRead = false;
          foregroundRead = true;
        } else {
          beginForegroundBoundary();
        }
        audibleSongId = info.id ?? audibleSongId;
        loadOutcome = 'the queue holds every entry — this selection is the start that follows it';
      },
      invalidatePrepared() {
        // A prepare the listener did not ask for has nothing to refuse: there is no slot job to
        // stand aside. Left as a callable no-op; nothing in the app calls it any more.
      },
      /*
       * ------------------------------------------------------ the published queue (v1.9.9)
       *
       * Three methods, and they are the whole of "the app is not the only owner of the boundary any
       * more": `setQueue` publishes the queue the native side is to walk and whether it may act on
       * it, `reconcile` reads back which entry it is playing, and `nativeAdvance` is the account for
       * the reason line.
       */
      async setQueue(next) {
        statement = {
          list: [...next.list],
          index: Number.isFinite(next.index) ? Number(next.index) : -1,
          repeat: next.repeat,
          awake: next.awake,
        };
        return stateQueue();
      },
      async recordReturn(facts) {
        if (!remote?.recordReturn) return false;
        const answer = await bounded(remote.recordReturn(facts), null, 'recordReturn');
        return answer?.recorded === true;
      },
      /**
       * **The away queue's own transport (unreleased, `t_05775526`).** One round trip, bounded like
       * every other call on this bridge: the row has already moved (the press is optimistic), so a
       * plugin that never answers must not hold a press open. `positionMs` travels in milliseconds —
       * the engine's unit — and the plugin converts.
       */
      async queueTransport(op, positionMs, index) {
        return sendTransport(op, positionMs, BRIDGE_TIMEOUT_MS, index ?? entryIndex());
      },
      /**
       * **One call, one reading (unreleased).** Foreground/visibility events call this and render what
       * it says. Nothing is started, stopped, restarted or replaced on a return.
       */
      async snapshot() {
        return readSnapshot();
      },
      nativeAdvance() {
        return {
          armed: boundaryArmed ? boundaryQueued : 0,
          advances: nativeAdvances,
          failures: nativeFailures,
          ignored: nativeIgnored,
          reason: boundaryReason,
          identity: identitySentence(nativeIdentity, nativeScene),
          timeline: `${lastTimeline}${foregroundText()}`,
          startedAt: lastTimelineAt,
          foreground: foregroundBoundary(),
        };
      },
      async discard() {
        /*
         * Nothing is held warm by this bridge: the look-ahead is the queue's own next items
         * (`armAwayQueue`/`topUpAwayQueue` in `NaviliteRemote.swift`), and an entry leaves that queue
         * by leaving the order, not by being unloaded here.
         */
      },
      async play(startSeconds) {
        await startService();
        /*
         * The JS-side boundary's play moment (v2.0-beta.15) — closed by the first report of sound.
         *
         * Never on a **read** of an entry this layer did not start: that clock is not its boundary, and writing a
         * play into it would print a `play→sound` for a start nothing here made.
         */
        if (!foregroundRead) {
          foregroundPlayedAt = Date.now();
          if (foregroundStartedAt === 0) foregroundStartedAt = foregroundPlayedAt;
          // What this start asked for — the offset its own reports can be near (`noteForegroundAudible`).
          foregroundAskedMs = Math.max(0, startSeconds) * 1000;
        }
        /*
         * **The start is an intent on the one surviving queue.** `op: 'play'` names the entry the
         * app is on and where in it to start, and `NaviliteRemote` rebuilds its queue at that entry
         * and seeks — the same call a lock-screen press takes. Nothing is fetched here first: the
         * queue has held every entry of the order since `setQueue`.
         */
        await sendTransport('play', Math.max(0, startSeconds) * 1000);
      },
      async pause() {
        await sendTransport('pause');
      },
      async resume() {
        await sendTransport('resume');
      },
      async stop() {
        /*
         * A stop was a teardown of a second player. The queue is never torn down per track — it is
         * paused, and it keeps the item, its position and the card. What remains here is the Android
         * foreground service and this side's own last reading.
         */
        await stopService();
        lastPositionMs = 0;
      },
      async seek(seconds) {
        /*
         * The one call with a short deadline. It used to be proved to hang: the plugin settled its
         * seek only from AVFoundation's completion, and a zero-tolerance seek on a transcoded remote
         * item reported `finished == false` — the completion was never called and everything that
         * waited waited for ever. The queue's own seek has the same shape, and the position the UI
         * shows is written on the engine's side, so nothing is lost by giving up on the answer.
         */
        await sendTransport('seek', Math.max(0, seconds) * 1000, SEEK_TIMEOUT_MS);
      },
      positionMs() {
        return lastPositionMs;
      },
      async sync() {
        /*
         * **The truth probe is the snapshot** (unreleased). `state` is the queue's own
         * `timeControlStatus`, `positionMs` is `currentItem`'s own clock and `durationMs` is that
         * item's own duration — one read, the same one the bars are dated to.
         */
        const answer = await readSnapshot();
        if (isUnavailableSnapshot(answer)) return null;
        const snap = answer;
        const playing = snap.state === 'playing';
        lastPositionMs = snap.positionMs;
        noteForegroundAudible(playing, snap.positionMs / 1000);
        return { playing, positionMs: snap.positionMs, durationMs: snap.durationMs };
      },
      async activateSession() {
        if (!remote) return false;
        try {
          const result = await remote.activateSession();
          return result.active;
        } catch (error) {
          /*
           * **`interrupted`, not a silent `paused`** (unreleased, design §5). A session that could
           * not be taken back is a player that is going to stop on its own: the word for that is
           * the machine's `interrupted` (the sound stopped and nobody asked), and it is named here
           * on the boundary's own line so the return path can paint it instead of a pause nobody
           * pressed.
           */
          const why = error instanceof Error ? error.message : String(error);
          boundaryReason = `the audio session could not be activated again (interrupted): ${why}`;
          return false;
        }
      },
      /*
       * The native spectrum. `hasNativeSpectrum` is what the engine asks before it decides how to
       * feed the visualiser: with the tap it never starts a second player in the web layer at all,
       * which is what removes the double-engine handoff the owner described.
       */
      hasNativeSpectrum: true,
      loadOutcome() {
        // What the last load did — a fetch beside the track being heard, a switch to a slot that
        // already held it, or nothing at all because the audible slot already had it (v1.9.11). Read
        // by the engine's reason line, so a boundary that was served from the pool is not reported as
        // a cold fetch and vice versa.
        return loadOutcome;
      },
      droppedEvents() {
        // Two counters about the plugin's events: the inaudible ones and the ones swallowed by a
        // slot's write grace. There are no plugin events and no slots, so neither can tick.
        return { inaudible: 0, slotGrace: 0 };
      },
      /*
       * Which slot the tap is on, and which slot is being heard (v1.9.25). Both are answers this
       * bridge already holds — the plugin's own `tapped` from its last install, and the slot this
       * bridge last made audible — and neither is acted on by anything: the reason line is where they
       * are read, because *"the tap is on another player"* and *"the tap is on this one and measures
       * nothing"* are the same flat bars on the screen.
       */
      spectrumEvidence() {
        /*
         * There is no slot to name (unreleased, `t_fa149147`): one item, one tap, installed when the
         * item was built. The pair is kept in the shape the reason line reads, and answers that
         * neither side has a slot to talk about.
         */
        return { tapped: null, audible: null };
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
               *
               * v1.9.9 — **and the index travels with it.** The track is what the screen needs; the
               * index is what the queue needs, because a play order is not a list of slot names and
               * the app moves by position in the order it published.
               */
              remote.addListener('advanced', (event) => {
                const songId = typeof event?.songId === 'string' ? event.songId : '';
                const moved = Number.isFinite(event?.index) ? Number(event?.index) : -1;
                /*
                 * **A refusal that names the sound is an answer (unreleased).** `positionMs` is
                 * present only when the native side is naming an entry after a refusal — the entry
                 * the queue is sounding, where it is now — and it is what the row renders instead
                 * of staying on `loading` while the queue plays and the app asks again every three
                 * seconds. An ordinary away boundary carries no position and is the read it
                 * always was.
                 */
                const answered = Number.isFinite(event?.positionMs) ? Number(event?.positionMs) : undefined;
                nativeAdvances += 1;
                /*
                 * The entry the native side says it moved to is the one the queue is on from that
                 * instant, and it is read from the message rather than looked up.
                 */
                if (songId) audibleSongId = songId;
                /*
                 * And the index the native side moved to becomes the index the app has published,
                 * so the reconciliation on the way back does not read this same advance a second
                 * time and move the queue again.
                 *
                 * **A reading's index is published BEFORE it is written (unreleased).** When
                 * `positionMs` is present the event is the answer to a refusal — the
                 * entry the QUEUE is sounding and where the queue is — and the reading uses the
                 * same shape for the entry the app's own player took. Neither number is a boundary
                 * this player walked, so neither is trusted as an index: the entry is looked up in
                 * the statement's own `list`, which *is* the published order. The native side now
                 * sends the published index for both (`NavilitePressRules.publishedIndex`); this
                 * gate means an older native build still sending AVPlayer's window index (0..2)
                 * cannot put 0 in the statement beside entry 8 of 269.
                 */
                const reading = event?.reading === true || answered !== undefined;
                if (reading) {
                  /*
                   * The index still moves, but only to one this app has already published: the
                   * statement's own `list` is the published order, so the entry is found in it and
                   * the event's number is never trusted. A stale native build sending AVPlayer's
                   * window index (0..2) therefore cannot write 0 beside entry 8 of 269 — and the
                   * read exit, which names the entry the app's own player is on, still moves the
                   * statement onto that entry.
                   */
                  const at = songId ? statement.list.findIndex((entry) => entry.songId === songId) : -1;
                  if (at >= 0) statement = { ...statement, index: at };
                } else if (moved >= 0) {
                  statement = { ...statement, index: moved };
                }
                boundaryReason = `the native player took the boundary itself and is playing ${songId || 'the next entry'}`;
                events.onAdvanced?.(songId, moved, answered);
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
            /*
             * The lock-screen transport could not be attached: next/previous are the app's own on the
             * row and still work, but the system's buttons are not listening. Named rather than
             * warned (design §5) so the row can say so instead of the press simply doing nothing.
             */
            boundaryReason = `the lock-screen next/previous could not be attached (not_ready): ${String(error)}`;
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

/* ----------------------------------------------------------------- downloads */

const NAVILITE_DOWNLOADS = 'NaviliteDownloads';

/**
 * Our own iOS download plugin (v1.9.12): a background `URLSession` transfer, a staging write, an
 * atomic move and a byte-count check — none of it on the audio bridge or the `AssetLanes` queue.
 * A download may never `yieldToAudible`.
 */
interface NaviliteDownloadsPlugin {
  configure(options: { allowsCellular: boolean; maxConcurrent: number }): Promise<void>;
  enqueue(options: {
    songId: string;
    url: string;
    suffix: string;
    bytes: number;
    refs: string[];
    title: string;
    artist: string;
    album: string;
    durationSec: number;
    /**
     * v1.9.20, the art axis. `coverArt` is the cover this transfer is for (an art job's own
     * `songId` is the same cover id), and `coverOf` names the songs that share it — the rows the
     * finished cover must be attached to, which is what lets a download made by 1.9.19 learn which
     * cover is its own. Optional, both: an audio or lyrics job carries neither.
     */
    coverArt?: string;
    coverOf?: string[];
  }): Promise<void>;
  cancel(options: { songId: string }): Promise<void>;
  remove(options: { songId: string }): Promise<void>;
  list(): Promise<{ rows: IndexRow[] }>;
  freeBytes(): Promise<{ free: number }>;
  readLyrics(options: { songId: string }): Promise<{ body: string }>;
  writeLyrics(options: { songId: string; text: string }): Promise<void>;
  addListener(
    eventName: 'progress' | 'done' | 'failed',
    listener: (event: {
      songId: string;
      path?: string;
      bytes?: number;
      total?: number;
      error?: string;
      status?: number;
      /** `art` events are keyed by **cover id**, not by song (§5.4). */
      kind?: 'audio' | 'lyrics' | 'art';
    }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * A `file://` URL from the app's own container, made readable by the page (v1.9.20).
 *
 * The page's origin is `https://localhost` and the offline files live in
 * `Library/Application Support/navilite-offline/`; a `file://` URL is not fetchable from that
 * origin, and inside a WKWebView an `<img src="file://…">` is blocked — which is why the audio path
 * never needed this (the player reads the file natively, and the path goes to the native side, not
 * into the page). `Capacitor.convertFileSrc` is the bridge that exists for exactly this: on iOS it
 * produces a custom-scheme URL that is **same-origin with the page**, so the cover renders and a
 * `fetch` of it yields an untainted canvas for `paletteFromArtwork` (§5.5).
 *
 * Only `file://` is converted. Anything else is already a URL the page can read, and running it
 * through the platform bridge would name a file that does not exist.
 */
export function localFileSrc(path: string): string {
  if (!path.startsWith('file://')) return path;
  try {
    return Capacitor.convertFileSrc(path);
  } catch (cause) {
    /*
     * The platform bridge is not there: the path goes back unchanged and the image simply does not
     * render — an absence that is already on screen as a missing cover, so there is no state to
     * invent for it. Bound rather than dropped (design §5).
     */
    void cause;
    return path;
  }
}

/**
 * The download lane, built separately from the audio bridge. On a platform without the plugin (the
 * browser, Android in 1.9.12) it returns `null` and offline download is simply absent — playback,
 * the resolver and the queue are all unchanged.
 */
export async function createDownloadsBridge(os: OsName): Promise<DownloadsBridge | null> {
  if (os === 'web') return null;
  try {
    const plugin = Capacitor.isPluginAvailable(NAVILITE_DOWNLOADS)
      ? registerPlugin<NaviliteDownloadsPlugin>(NAVILITE_DOWNLOADS)
      : null;
    if (!plugin) return null;
    return {
      configure: (options) => bounded(plugin.configure(options), undefined, 'downloads-configure'),
      enqueue: (job) => bounded(plugin.enqueue(job), undefined, 'downloads-enqueue'),
      cancel: (songId) => bounded(plugin.cancel({ songId }), undefined, 'downloads-cancel'),
      remove: (songId) => bounded(plugin.remove({ songId }), undefined, 'downloads-remove'),
      list: async () => {
        const answer = await bounded(plugin.list(), null, 'downloads-list');
        return (answer?.rows ?? []).map((row) => ({ ...row }));
      },
      freeBytes: async () => {
        const answer = await bounded(plugin.freeBytes(), null, 'downloads-freeBytes');
        const free = answer?.free;
        return free !== undefined && Number.isFinite(free) ? free : -1;
      },
      readLyrics: async (songId) => {
        const answer = await bounded(plugin.readLyrics({ songId }), null, 'downloads-readLyrics');
        const body = answer?.body;
        return typeof body === 'string' && body !== '' ? body : null;
      },
      writeLyrics: (songId, text) => bounded(plugin.writeLyrics({ songId, text }), undefined, 'downloads-writeLyrics'),
      addListener: (eventName, listener) =>
        plugin
          .addListener(eventName, (event) => listener(event))
          .then((handle) => () => void handle.remove().catch(() => undefined)),
    };
  } catch (error) {
    console.warn('[navilite] downloads plugin unavailable', error);
    return null;
  }
}
