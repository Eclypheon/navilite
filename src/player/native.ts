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
   * The native side's own account: the entry it believes is playing (asset, track and **index**), the
   * queue it is holding, the repeat mode, and what it has done — `advances` it took itself,
   * `failures` where it could not, and `ignored`, the completions that were not about the item it
   * was told is playing. This is the reconciliation the return to the foreground reads: a track
   * that advanced while the app was away is a fact the web layer never heard, and asking is the only
   * way it learns.
   */
  now(): Promise<{
    assetId?: string;
    songId?: string;
    index?: number;
    queued?: number;
    repeat?: string;
    generation?: number;
    advances?: number;
    failures?: number;
    ignored?: number;
    awake?: boolean;
    /**
     * **What the away queue had reached when it handed the sound back (v2.0-beta.18)** — the entry it
     * was sounding, its index in the published order, and the position in ms.
     *
     * The plugin has published this since the handover became a pause rather than a teardown, and
     * nothing read it: the app's own player then started the entry from *its* last clock reading, so
     * the queue's position was dropped on the floor at every return. It is the reading
     * `NativeBridge.handover()` adopts, and it rides here as well so the row can say what was adopted.
     * Empty (`{}`) once the app's own player has taken it.
     */
    resume?: { songId?: string; index?: number; positionMs?: number };
    /**
     * **What is sounding, said by the player (unreleased)** — `NaviliteRemote.returnReading()`: the
     * entry the owning route is on, its live position, which route that is (`queue` / `fetch` /
     * `plugin`) and whether that route is the away queue.
     *
     * The return reads this **before** it decides anything. It is the difference between the two
     * returns the app has: the player already holds the visible entry (read it, write nothing) and
     * the player does not (something has to be handed over). It arrives on this call rather than on a
     * call of its own, so asking costs nothing.
     */
    return?: { songId?: string; index?: number; positionMs?: number; path?: string; sounding?: boolean };
    reason?: string;
    /**
     * The last away boundary's five moments, in milliseconds from the item end (v2.0-beta.14): the
     * card announced for the incoming entry, a fetch issued (`-1` when the slot was already warm),
     * the item reporting ready, the play call issued, and the first frame the player was running.
     *
     * `startedAt` (epoch ms) and `ageMs` say **when** that boundary was (v2.0-beta.15): only an away
     * boundary is timed natively, and the reading outlives the return to the foreground.
     */
    timeline?: {
      path?: string;
      cardMs?: number;
      fetchMs?: number;
      readyMs?: number;
      playMs?: number;
      audibleMs?: number;
      startedAt?: number;
      ageMs?: number;
      /**
       * v2.0-beta.16 — the two facts `path` could not carry: what the play actually had to render
       * with (`buffered`, in seconds of the audible item) and, when the boundary did not start from
       * the slot that was supposed to be warm, the sentence saying why (`whyNotWarm`). `ahead` is
       * the look-ahead's own state — `native-b 3.2s buffered, startable`, or the reason it is not.
       */
      pathDetail?: string;
      whyNotWarm?: string;
      buffered?: number;
      likely?: boolean;
      ahead?: string;
    };
    /** Where the persisted boundary log is, how many lines this run wrote, and its last lines. */
    logPath?: string;
    logLines?: number;
    logTail?: string[];
    /**
     * Who the Now Playing entry's owner is, as the phone sees it (v2.0-beta.16).
     *
     * `mediaremoted` publishes the entry owned by a bundle id, and SpringBoard routes a tap on the
     * card — or the island's expanded view — back to whatever app that id names. An id that does not
     * resolve to an installed, activatable app is the one failure no setting in this app can fix, so
     * the facts are carried rather than assumed: the id it is running as, the signed
     * `application-identifier` when the process may read its own entitlements, where the `.app` is,
     * and whether that is a package install or a relocated build.
     */
    identity?: NativeIdentity;
    /**
     * What the system has asked this app's scene to do this session (v2.0-beta.16): a connect (cold
     * start), an open-url (an external open carrying a URL), an activation (raised from the
     * background), a resignation. Nothing in this app can be reached by a tap that produced none of
     * them — which is why the counts are on the row.
     */
    scene?: NativeSceneEvents;
  }>;
  /**
   * The away queue's reading, taken back with the sound (v2.0-beta.18): `NaviliteRemote.swift`'s
   * `handover` pauses the queue on the item it was sounding and answers with the entry, its index and
   * the position the app's own player is to start from; `releaseHandover` is the app saying that start
   * has committed, so the paused items can go.
   */
  handover?(): Promise<{ songId?: string; index?: number; positionMs?: number }>;
  releaseHandover?(next?: { songId?: string; positionMs?: number }): Promise<{ released?: boolean }>;
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
   * The adopt/handover branch is decided here in the web layer and the file is written by Swift, so
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
  start(options: { url: string; positionMs: number; assetId?: string }): Promise<{ started: boolean; sampleRate: number; bandCount: number; tapped?: string }>;
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
   * How old **this item's own last frame** is, in ms (v1.9.26): the plugin's own answer, taken on the
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
  /** Now − the moment the reading was taken, ms, so a stale one is identifiable; `-1` when nothing is timed. */
  ageMs: number;
  /** True while the boundary has been begun and no sound has been reported for it yet. */
  pending: boolean;
}

/**
 * One entry of the queue as the native side is given it (v1.9.9).
 *
 * `url` is the entry's **own file**, never a capped or transcoded variant: this side fetches an
 * unwarmed entry itself at a boundary, and the owner's rule is that a track being played is played
 * as the file sits on the server. `warmUrl` is the URL the app holds that entry warm *under*, and it
 * is what the bridge checks before it names a slot — the same string, asked for again, which is what
 * makes the slot's bytes the bytes the play will use.
 */
export interface NativeQueueEntry {
  songId: string;
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
  warmUrl?: string | null;
}

/**
 * The ops `queueTransport` takes on the one surviving player: `play` starts entry `index` at
 * `positionMs`, and `pause`/`resume`/`seek` are the presses (unreleased, `t_fa149147`).
 */
export type NativeQueueOp = 'play' | 'pause' | 'resume' | 'seek';

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
   * Publish the **queue** the native player is to walk (v1.9.9), and whether it may act on it.
   *
   * `list` is the app's resolved play order — one entry per track, in the order it will be played,
   * each carrying the asset id that holds it when the app has it warm — and `index` is the entry
   * playing now. The bridge turns the warm entries into the slots holding them; an entry the app
   * has nothing warm for goes **without a slot**, and the native side then fetches that entry itself
   * at the boundary. That is the structural half of this release: the list cannot run out, so no
   * number of track ends with the app away can silence the music, and every boundary that cannot be
   * taken is reported with its reason.
   *
   * `awake` is whether the web layer is running: with the app on screen the JS side owns the
   * boundary exactly as it always has, and the native side is only told what follows.
   *
   * Answers whether the native side holds the boundary (there is no native boundary on Android, and
   * none in a build without our iOS plugin, where the JS side keeps owning it).
   */
  setQueue?(statement: NativeQueueStatement): Promise<boolean>;
  /**
   * **What the away queue reached, taken back with the sound (v2.0-beta.18).**
   *
   * The one call that performs the handover natively: the queue pauses on the item it was sounding
   * (so exactly one player is sounding from this moment) and answers with the entry, its index and its
   * position. The app's own player is then started at that position, and `releaseHandover` is what lets
   * the paused items go — after the commit, never before.
   *
   * **An empty `songId` is "the sound did not change hands" (unreleased, `t_e56c0413`).** The phone
   * answers this call on every return, and `taken` says whether it performed the transfer; an answer
   * that did not is answered here as no reading at all (`handoverAnswerOf`), because the position it
   * carries is this side's own entry at 0:00 and `adoptHandover` starts whatever track a reading names.
   */
  handover?(): Promise<NativeHandover>;
  /**
   * **The app's own player has started that entry** (v2.0-beta.18) — so the queue stops holding a
   * reading about items that are no longer the sound. Called only after the start has committed.
   */
  releaseHandover?(next?: { songId?: string; positionMs?: number }): Promise<boolean>;
  /**
   * **A transport press, sent to the away queue's own player (unreleased, `t_05775526`).**
   *
   * The queue is the sound on a return the app could not take back, and the app's own player is silent
   * there: `pause()`/`resume()`/`seek()` on this bridge reach only that silent player, which is a write
   * nobody can hear. This is the one call that reaches the player actually making the sound, so a
   * press on the row stops, restarts or moves what the owner is listening to. Optional: a build
   * without it answers nothing, and the engine keeps its old route.
   */
  queueTransport?(op: NativeQueueOp, positionMs?: number, index?: number): Promise<boolean>;
  /**
   * **Write the return's own line into the phone's log (unreleased).**
   *
   * Called once, at the end of one foreground return, by the branch that decided it — never off a
   * status or report stream, so a return that emits two records is a defect this contract makes
   * visible. Optional: a bridge without it (an older plugin, the fake bridge) still returns, it just
   * cannot date or name the return in the file.
   */
  recordReturn?(facts: NativeReturnRecord): Promise<boolean>;
  /**
   * Ask the native side which entry it is playing now, and adopt its answer (v1.9.8, by index since
   * v1.9.9).
   *
   * A track that advanced while the app was away is a fact the web layer never received, and this is
   * the only way it learns: on the way back, before anything is read from the player, the bridge
   * compares what the native side says with what it believes is audible, and reports the **index**
   * as well as the track — an index is what a shuffled play order needs, and the id lookup it used
   * to do was the hole once shuffle was on.
   *
   * **`reading` is the same answer as the player's own reading of what is sounding** (unreleased):
   * the entry the route that owns the sound is on, its live position, and which route that is. It is
   * what the return decides `adopt` versus `handover` from — the player's fact first, never a flag —
   * and it costs nothing extra, because it comes back on the `now()` call this method already makes.
   */
  reconcile?(): Promise<{
    changed: boolean;
    songId: string | null;
    index: number;
    resume?: NativeHandover | null;
    reading?: NativeReturnReading | null;
  } | null>;
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
    /** When that (away) boundary began, epoch ms; `0` when none has been taken (v2.0-beta.15). */
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
   * The native spectrum tap, when the platform has one. Optional: a build without our iOS plugin
   * (an older APK, the PWA) simply has no `startSpectrum`, and the visualiser falls back to its
   * album-art theme exactly as it does when there are no samples for any other reason.
   */
  startSpectrum?(url: string, positionMs: number): Promise<boolean>;
  stopSpectrum?(): Promise<void>;
  spectrumFrame?(): Promise<NativeSpectrumFrame | null>;
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
   * What the last `load` did, when it was not simply a fetch (v1.9.11).
   *
   * A load is the boundary's fallback: the engine takes it when nothing was adoptable from the
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
 * The facts the plugin puts in a `playbackState` event, forwarded verbatim (v1.9.5).
 *
 * `Plugin.swift`'s `notifyPlaybackState` sends four things about the item it is reporting on —
 * `state`, `reason`, `currentTime` and `duration` — and until this release the bridge dropped
 * three of them and handed the engine a bare `state`/`isPlaying`. That is why "the track ended"
 * had to be spelled as one exact state (`stopped`), and why the app could not tell an item
 * sitting at its end from an item that had been paused in the middle: the two facts that separate
 * them (where it is, how long it is) were thrown away at the door.
 */
/**
 * The away queue's own reading at the moment it handed the sound back (v2.0-beta.18).
 *
 * One entry, one index and one position: the app's own player adopts them by starting *that* entry at
 * *that* position, and only once the start has committed does the queue let go of its paused items.
 */
export interface NativeHandover {
  songId: string;
  index: number;
  positionMs: number;
}

/**
 * **What the native player is sounding, read and never written (unreleased).**
 *
 * The plugin's `now()` answer carries `return` — one reading of the entry the *route that owns the
 * sound* is on, its live position and which route that is. The three routes are the ones this app has
 * had since the native boundary: the away queue (`queue`), the app's own fetch player (`fetch`), and
 * the plugin's own player (`plugin`).
 *
 * It exists because the return used to be decided by *shape* rather than by *fact*: every foreground
 * return ran `adoptHandover`, which starts the app's own player at the away queue's reading — so a
 * return to a phone that was already sounding the visible track (the ordinary background→foreground,
 * three times a minute) re-loaded and re-started the very song the listener could hear, dispatching
 * `loading` under the bar until the start committed. This reading is how the return tells "the player
 * already holds this entry" from "something has to be started", before it writes anything.
 */
export interface NativeReturnReading {
  /** The entry the route that owns the sound is on; empty when nothing this side can name is sounding. */
  songId: string;
  /** Its index in the order the app published, derived from the entry (`NavilitePressRules.readingIndex`). */
  index: number;
  /** Its live position, ms — read off the owning player, not off the app's clock. */
  positionMs: number;
  /** Which route owns the sound. */
  path: 'queue' | 'fetch' | 'plugin';
  /**
   * Whether the away queue is **making a sound** right now — the phone's own `queueIsSounding`, read
   * off its player (`NaviliteRemote.queueIsSounding`). Not `path === 'queue'`: a queue the owner
   * paused himself is still the route holding the entry, and it is silent (unreleased,
   * `t_e56c0413`). This field used to be fabricated here as `path === 'queue'`, which made the
   * paused-queue guard in `engine.ts` unreachable.
   */
  sounding: boolean;
}

/**
 * The plugin's handover reading, normalised (v2.0-beta.18): `{}` is "nothing to adopt", and a
 * position that is not a number is a reading with no position rather than `NaN` in the clock.
 *
 * This is the shape of `state.resume` as well, which is why it does **not** gate on `taken` — see
 * {@link handoverAnswerOf}, which does.
 */
export const handoverOf = (raw: unknown): NativeHandover | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { songId?: unknown; index?: unknown; positionMs?: unknown };
  const songId = typeof record.songId === 'string' ? record.songId : '';
  if (!songId) return null;
  const index = Number.isFinite(Number(record.index)) ? Number(record.index) : -1;
  const asked = Number(record.positionMs);
  const positionMs = Number.isFinite(asked) && asked > 0 ? Math.round(asked) : 0;
  return { songId, index, positionMs };
};

/**
 * **An answer to `handover()` is a reading only when the phone says it performed the transfer
 * (unreleased, `t_e56c0413`).**
 *
 * `handover()` answers on every return, and `taken` says whether *this call* handed the sound over.
 * When it did not — the adopt branch, where the phone stops the queue because the app's own player is
 * already sounding the entry; a queue the owner paused himself; a queue that was not the thing
 * sounding — the answer still carries a `returnReading()`: this side's own `audible` entry, at
 * `positionMs: 0`, on `path: 'plugin'`. That is not an offer. Read as one, `adoptHandover` matched it
 * against the visible track and called `play(track, 0, force: true)`, and `force` bypasses `play`'s
 * idempotence rule — so the track reloaded, `select` was dispatched, the row went back to `loading`,
 * and the position the return had just rendered (`renderReading`) was overwritten with 0:00.
 *
 * The gate is here, at the wire boundary, instead of in Swift's `handover()`: the contract is that a
 * reading means "the sound is now yours", and every producer of this answer is held to it here — the
 * engine's `adoptHandover` cannot be made to start a player by a field it never read. Answering `{}`
 * from Swift was the alternative and was rejected as the *only* fix: it duplicates a rule the bridge
 * already owns, and any other native side (or a future branch) answering a full reading with
 * `taken: false` would restart the track again.
 */
export const handoverAnswerOf = (raw: unknown): NativeHandover | null => {
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as { taken?: unknown }).taken !== true) return null;
  return handoverOf(raw);
};

/*
 * The player's own reading of what is sounding (unreleased). Unlike `handoverOf` this keeps an
 * **empty** `songId`: "nothing this side can name is sounding" is an answer the return has to be
 * able to read (it is the one that sends the return to the handover branch), and dropping it here
 * would turn it into "the plugin did not answer", which is a different fact.
 */
export const returnReadingOf = (raw: unknown): NativeReturnReading | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { songId?: unknown; index?: unknown; positionMs?: unknown; path?: unknown; sounding?: unknown };
  const path = record.path === 'queue' || record.path === 'fetch' ? record.path : 'plugin';
  const asked = Number(record.positionMs);
  return {
    songId: typeof record.songId === 'string' ? record.songId : '',
    index: Number.isFinite(Number(record.index)) ? Number(record.index) : -1,
    positionMs: Number.isFinite(asked) && asked > 0 ? Math.round(asked) : 0,
    path,
    /*
     * **The phone's own answer, not a re-derivation (unreleased, `t_e56c0413`).** This read
     * `path === 'queue'`, so a paused queue — the same route, holding the same entry, making no sound
     * — was described as sounding on every return, and the guard that ends the row `paused` over it
     * could never be taken. `undefined` on the wire (a build that predates the key) is a queue that
     * has not said it is sounding, so it does not own the row.
     */
    sounding: record.sounding === true,
  };
};

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
  path: 'adopt' | 'handover';
  /** The entry the reading named (or the visible one when the player named nothing). */
  songId: string;
  /** The route that owned the sound when the return decided: `queue` / `fetch` / `plugin` / `none`. */
  route: string;
  /** The reading's live position, ms — `-1` when there was no reading. */
  positionMs: number;
  /** The track's duration, ms, as the return ended — `-1` when unknown. */
  durationMs: number;
  /** Whether a start was issued through `play` during this return. `true` is the handover's business. */
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
   * It is an *adoption*: the audio is already playing, so the listener to this must move onto that
   * track rather than start it. Optional so a bridge without it (an older build, the fake bridges in
   * the tests) is a bridge that simply never reports one.
   *
   * **And a position rides with it when the native side is ANSWERING a refusal (unreleased).** A
   * `handover-refused` that names the entry the queue is sounding is an answer, and the answer
   * carries where that entry is now (`positionMs`) plus `reading: true`: the app renders that
   * reading instead of leaving the row on `loading` and asking again every three seconds.
   */
  onAdvanced?(songId: string, index: number, positionMs?: number): void;
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
  /** Run work on the audible lane: a start, an adoption, the play of a start, a slot's unload. */
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
  } catch {
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
    } catch {}
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      return new URL(artworkUrl, window.location.origin).toString();
    } catch {}
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
    /** What the last `adopt()` did, in the words the reason line shows (v1.9.5). */
    let adoptOutcome = 'not attempted';
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
     * say a boundary was taken and not one number about where its seconds went. The native plugin
     * records the five moments and this is the sentence the diagnostics row carries.
     *
     * Only an away boundary is timed natively (v2.0-beta.15), so the sentence names it as that and
     * carries its **age**: these numbers survive the return to the foreground, and an old boundary's
     * milliseconds read exactly like a fresh one unless the row says which boundary it is.
     */
    let lastTimeline = 'last away-boundary: none taken yet';
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
    /**
     * Whether the reading this layer holds was **adopted** rather than measured (v2.0-beta.15).
     *
     * A return from `hidden` is not a boundary this layer took: the native side may have taken it
     * minutes ago, and the item is already sounding before a single line here runs. Beginning a
     * boundary on that return measured the microseconds between `reconcile()` and `sync()` and
     * overwrote the last real reading with them (the ~12 ms that measures nothing). So the return
     * marks the reading adopted instead, the previous reading stands (aged), and no stamp is written
     * until a boundary this layer genuinely begins.
     */
    let foregroundAdopted = false;
    /**
     * The next `load()` is the adoption of a track the native side is already playing — set by
     * `reconcile()` when it finds the player on another entry, and consumed by that load.
     */
    let adoptingNextLoad = false;
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
      foregroundAdopted = false;
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
      if (foregroundStartedAt === 0 || foregroundAudibleAt > 0 || foregroundAdopted) return;
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
    const spectrum = Capacitor.isPluginAvailable(NAVILITE_SPECTRUM)
      ? registerPlugin<NaviliteSpectrumPlugin>(NAVILITE_SPECTRUM)
      : null;

    let lastPositionMs = 0;



    /**
     * Publish the whole queue to the native side, and take its answer (v1.9.9).
     *
     * The slots are attached here rather than by the caller, because the caller (the engine) tracks
     * tracks by id and the native side plays *slots* — and the only thing that knows which slot holds
     * which track is this file. The rule that keeps a slot and a URL from ever disagreeing is kept
     * from v1.9.8: an entry is named with a slot **only when this bridge holds it under exactly the
     * URL the engine says it was warmed with**. Everything else goes to the native side without a
     * slot, which is not a gap — it is the instruction to fetch that entry itself at the boundary,
     * and that is why the queue cannot run out.
     */
    /*
     * `handoverOf` / `handoverAnswerOf` / `returnReadingOf` are module-level (unreleased,
     * `t_e56c0413`): the two wire shapes a return is decided from are parsed by exported functions so
     * a test can drive the same parse the bridge performs, instead of inventing a `NativeReturnReading`
     * the phone could never have produced. Nothing in them reads this closure.
     */

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
    ): Promise<boolean> => {
      if (!remote?.queueTransport) return false;
      const at = Number.isFinite(positionMs) ? Math.round(positionMs as number) : -1;
      /* `index` travels only with `play`: it names an entry, and the presses name none. */
      const asked: { op: NativeQueueOp; index?: number; positionMs: number } = { op, positionMs: at };
      if (op === 'play') asked.index = index;
      const answer = await bounded(remote.queueTransport(asked), null, `queueTransport-${op}`, ms);
      if (!answer?.ok) {
        boundaryReason = `the queue's own player did not take the ${op}: ${answer?.why ?? 'the plugin did not answer'}`;
        return false;
      }
      return true;
    };

    return {
      async load(info) {
        /*
         * The JS-side boundary begins here (v2.0-beta.15): this is the first moment the layer asks
         * for the incoming track, so it is the start the foreground gap is measured from — before
         * the fetch, the same way the native timeline measures from the item end.
         */
        /*
         * An **adoption** is not a boundary (v2.0-beta.15): when `reconcile()` handed the app a track
         * the native side is already playing, this load is the app moving onto it — the sound began
         * before the app was running, so a clock started here would measure the few ms between the
         * return and this call and call it a gap. The previous reading stands instead, aged.
         */
        if (adoptingNextLoad) {
          adoptingNextLoad = false;
          foregroundAdopted = true;
        } else {
          beginForegroundBoundary();
        }
        audibleSongId = info.id ?? audibleSongId;
        loadOutcome = 'the queue holds every entry — this selection is the start that follows it';
      },
      /**
       * **Nothing to warm here any more.** Warming was three plugin slots holding the previous song
       * and the next two; the queue's own next items are that now (`armAwayQueue`/`topUpAwayQueue`
       * in `NaviliteRemote.swift`, fed by `setQueue`), so this answers `false` — no track is held
       * warm by *this* bridge, and the engine must not record one as if it were.
       */
      async prepare() {
        return false;
      },
      invalidatePrepared() {
        // A prepare the listener did not ask for has nothing to refuse: there is no slot job to
        // stand aside. Kept as a callable no-op because the queue still makes it.
      },
      async adopt() {
        adoptOutcome = 'nothing to adopt — the queue already holds the item';
        return false;
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
      async handover() {
        if (!remote?.handover) return { songId: '', index: -1, positionMs: 0 };
        const answer = await bounded(remote.handover(), null, 'handover');
        /*
         * `handoverAnswerOf`, not `handoverOf` (unreleased, `t_e56c0413`): an answer with
         * `taken !== true` did not hand the sound over, whatever reading it carries — the adopt
         * branch's `returnReading()` is this side's own entry at 0:00, and `adoptHandover` starts
         * the track on any reading it is given.
         */
        return handoverAnswerOf(answer) ?? { songId: '', index: -1, positionMs: 0 };
      },
      async releaseHandover(next) {
        if (!remote?.releaseHandover) return false;
        const answer = await bounded(
          remote.releaseHandover({ songId: next?.songId ?? '', positionMs: next?.positionMs ?? -1 }),
          null,
          'releaseHandover',
        );
        return answer?.released === true;
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
      async reconcile() {
        if (!remote?.now) return null;
        const state = await bounded(remote.now(), null, 'reconcile');
        if (!state) {
          boundaryReason = 'the native boundary plugin did not answer, so the app cannot ask it which entry it is playing';
          return null;
        }
        if (Number.isFinite(state.advances)) nativeAdvances = Number(state.advances);
        if (Number.isFinite(state.failures)) nativeFailures = Number(state.failures);
        if (Number.isFinite(state.ignored)) nativeIgnored = Number(state.ignored);
        if (typeof state.reason === 'string' && state.reason) boundaryReason = state.reason;
        /*
         * **The return is not a boundary this layer measured (v2.0-beta.15).** It used to begin one
         * here, and `engine` calls `sync()` ms later on the same path (src/player/engine.ts:2260) —
         * so the return closed a boundary at the time it took to get there (5–50 ms) for a boundary
         * the native side may have taken minutes earlier, and overwrote the last real reading with
         * it. What the return does now is leave the reading it already has standing — aged, and said
         * to be old by the row — and, when the player is on another entry, mark the load that adopts
         * it as an adoption rather than a new clock.
         */
        if (state.timeline) {
          lastTimeline = timelineText(state.timeline);
          /*
           * `-1` is the plugin's "nothing has been timed" (NaviliteRemote.swift:938) and it is
           * **truthy**, so passing it through made every `if (startedAt)` read a boundary that never
           * existed. Normalised here, at the boundary, to the `0` the contract declares (src/player/
           * engine-contract.ts:318).
           */
          const timed = Number(state.timeline.startedAt);
          lastTimelineAt = Number.isFinite(timed) && timed > 0 ? timed : 0;
        }
        if (state.identity) nativeIdentity = state.identity;
        if (state.scene) nativeScene = state.scene;
        const nativeIndex = Number.isFinite(state.index) ? Number(state.index) : -1;
        /*
         * **The index is the whole test now (unreleased, `t_fa149147`).** The slot comparison went
         * with the slots: there is one player, so the only way the app can be following the wrong
         * track is that the queue itself moved. An index that differs from the one the app last
         * published is a boundary the native side took, whether or not the entry came out of the
         * item the app expected — and an index is what a shuffled order needs, where a name is not.
         */
        const movedIndex = nativeIndex >= 0 && nativeIndex !== statement.index;
        const reading = returnReadingOf(state.return);
        if (!movedIndex) {
          return { changed: false, songId: state.songId ?? null, index: nativeIndex, resume: handoverOf(state.resume), reading };
        }
        /*
         * The native player is on another entry than the app believed. That is a track the app
         * advanced to without being told, and the answer is to move onto it — never to play anything:
         * the sound is already coming out of the queue's own item.
         */
        audibleSongId = typeof state.songId === 'string' && state.songId ? state.songId : null;
        // The load that moves the app onto this entry is an adoption, not a new clock (v2.0-beta.15).
        adoptingNextLoad = true;
        return { changed: true, songId: audibleSongId, index: nativeIndex, resume: handoverOf(state.resume), reading: returnReadingOf(state.return) };
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
         * Never on an **adopted** reading: that clock is not this layer's boundary, and writing a
         * play into it would print a `play→sound` for a start nothing here made.
         */
        if (!foregroundAdopted) {
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
         * **The truth probe is the queue's own reading** (unreleased, `t_fa149147`). `now()` answers
         * with `returnReading()`, and that is `currentItem`'s own position plus `queueIsSounding` —
         * `timeControlStatus` on the player, not this side's copy of a flag. `durationMs` is left at
         * 0 because the reading does not publish `currentItem.duration` yet; the engine keeps the
         * track's own duration as its fallback (`durationMs()`, `engine.ts:1140`).
         */
        if (!remote?.now) return null;
        const state = await bounded(remote.now(), null, 'sync');
        if (!state) return null;
        const reading = returnReadingOf(state.return);
        const playing = reading?.sounding === true;
        const positionMs = reading ? reading.positionMs : lastPositionMs;
        lastPositionMs = positionMs;
        /*
         * The foreground boundary's end — the **second** reader (v2.0-beta.15). This call never runs
         * at an awake track boundary: it runs on resume, after a seek, and on the return from
         * hidden. It still closes a boundary here — a resumed or sought start is this layer's own —
         * but never an **adopted** one: the return's `5–50 ms` was exactly that mistake, a number
         * measuring the round trip rather than the gap.
         */
        noteForegroundAudible(playing, positionMs / 1000);
        return { playing, positionMs, durationMs: 0 };
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
      loadOutcome() {
        // What the last load did — a fetch beside the track being heard, a handover to a slot that
        // already held it, or nothing at all because the audible slot already had it (v1.9.11). Read
        // by the engine's reason line, so a boundary that was served from the pool is not reported as
        // a cold fetch and vice versa.
        return loadOutcome;
      },
      adoptOutcome() {
        // What the last adopt did — 'adopted', 'nothing prepared', 'play refused (…)', 'timed out'
        // (v1.9.5). Read by the engine's reason line; nothing here acts on it.
        return adoptOutcome;
      },
      droppedEvents() {
        // Two counters about the plugin's events: the inaudible ones and the ones swallowed by a
        // slot's write grace. There are no plugin events and no slots, so neither can tick.
        return { inaudible: 0, slotGrace: 0 };
      },
      async startSpectrum() {
        /*
         * **The tap is not started from here any more.** It is installed once per item, at item
         * creation, inside `makeItem` in `NaviliteRemote.swift` — keyed to the item, never attached
         * by a state transition and never detached by a transport (§3 of the design). There is no
         * install left to ask for, so this answers `false`: what the visualiser draws comes from the
         * queue's own tap, through the snapshot.
         */
        return false;
      },
      async stopSpectrum() {
        // Nothing detaches a tap except the item's own `finalize`.
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
               * the app adopts by position in the order it published.
               */
              remote.addListener('advanced', (event) => {
                const songId = typeof event?.songId === 'string' ? event.songId : '';
                const moved = Number.isFinite(event?.index) ? Number(event?.index) : -1;
                /*
                 * **A refusal that names the sound is an answer (unreleased).** `positionMs` is
                 * present only when the native side is answering a `handover-refused` — the entry
                 * the queue is sounding, where it is now — and it is what the row renders instead
                 * of staying on `loading` while the queue plays and the app asks again every three
                 * seconds. An ordinary away boundary carries no position and is the adoption it
                 * always was.
                 */
                const answered = Number.isFinite(event?.positionMs) ? Number(event?.positionMs) : undefined;
                nativeAdvances += 1;
                /*
                 * The entry the native side says it moved to is the one the queue is on from that
                 * instant, and it is taken from the message rather than looked up.
                 */
                if (songId) audibleSongId = songId;
                /*
                 * And the index the native side moved to becomes the index the app has published,
                 * so the reconciliation on the way back does not read this same advance a second
                 * time and move the queue again.
                 *
                 * **A reading's index is published BEFORE it is written (unreleased).** When
                 * `positionMs` is present the event is the answer to a `handover-refused` — the
                 * entry the QUEUE is sounding and where the queue is — and the adopt exit uses the
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
                   * adopt exit, which names the entry the app's own player took, still moves the
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

/* ----------------------------------------------------------------- downloads */

const NAVILITE_DOWNLOADS = 'NaviliteDownloads';

/**
 * Our own iOS download plugin (v1.9.12): a background `URLSession` transfer, a staging write, an
 * atomic move and a byte-count check — none of it on the audio bridge or the `AssetLanes` queue.
 * A download may never `prepareNext`, `warmedUrl`, `discardPrepared` or `yieldToAudible`.
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
  } catch {
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
