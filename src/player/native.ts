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
  }>;
  /**
   * The persisted boundary log (v2.0-beta.16): every look-ahead and every boundary, one JSON object
   * per line, so the phone's own numbers can leave the phone instead of being read off a row.
   */
  boundaries(): Promise<{ path?: string; lines?: string[]; count?: number; tail?: string[] }>;
  addListener(eventName: 'next' | 'previous' | 'advanced' | 'advanceFailed', listenerFunc: (event: { songId?: string; assetId?: string; index?: number; reason?: string }) => void): Promise<PluginListenerHandle>;
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
   * Ask the native side which entry it is playing now, and adopt its answer (v1.9.8, by index since
   * v1.9.9).
   *
   * A track that advanced while the app was away is a fact the web layer never received, and this is
   * the only way it learns: on the way back, before anything is read from the player, the bridge
   * compares what the native side says with what it believes is audible, and reports the **index**
   * as well as the track — an index is what a shuffled play order needs, and the id lookup it used
   * to do was the hole once shuffle was on.
   */
  reconcile?(): Promise<{ changed: boolean; songId: string | null; index: number } | null>;
  /** What the native boundary has done, as numbers and a sentence — for the reason line (v1.9.8). */
  nativeAdvance?(): {
    armed: number;
    advances: number;
    failures: number;
    ignored: number;
    reason: string;
    /** The last boundary's five moments in ms from the item end, as one sentence (v2.0-beta.14). */
    timeline: string;
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
   */
  onAdvanced?(songId: string, index: number): void;
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
     * The slot the plugin last answered it had put (or kept) the tap on (v1.9.25).
     *
     * `NativeAudio`-side of the pair `spectrumEvidence` reports: the plugin's `start` resolves with
     * `tapped`, and until this release the bridge dropped it on the floor (`started === true` was all
     * it kept). It is not a decision — nothing in the engine acts on it — it is the one fact that
     * says whether the tap is even looking at the slot the listener is hearing.
     */
    let spectrumTapped: string | null = null;
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
     * What each slot **actually holds on the player**, as opposed to what the app claims it holds
     * (v1.9.11): `slot -> { songId, url }`, and it is not cleared when the claims are.
     *
     * This is the difference the boundary needed. `warm` is a *claim*: the app drops it whenever the
     * claim stops being one it can stand behind (a cold load clears it, a timed-out prepare gives it
     * back, a track that is no longer a neighbour is pruned). But dropping the claim does not empty
     * the slot — the item stays loaded and buffered on the player, which is exactly the thing a
     * boundary wants to start from. Until v1.9.11 nothing remembered that, so a boundary whose claim
     * had gone took the audible slot over and refetched a track that was already sitting there
     * buffered in the slot next to it — the owner's *"it does advance but it pauses for a moment, and
     * it seems to clear out all songs from the native player"*.
     *
     * So: `held` is written by `fillSlot` (after the preload resolved, so the plugin really has it),
     * deleted by `unloadSlot` and by any write to that slot, and it survives `load`/`discard` clearing
     * the claims. Stale entries are impossible to act on — a handover additionally requires the
     * **exact** URL, the same rule the engine's own adoption uses — and the pool is fixed at four
     * slots, so nothing can accumulate.
     */
    const held = new Map<string, { songId: string; url: string }>();
    /**
     * The slot the listener was hearing before a handover, freed once the incoming item has been
     * asked to play (v1.9.11) — never before it.
     *
     * `null` means there is nothing to free. It is set by a load that hands the audible name to
     * another slot and cleared by `play`, which is the one call that makes the new slot the one that
     * is sounding; a load that never got as far as its play leaves the old item loaded, which is a
     * slot's worth of memory and not a broken queue.
     */
    let outgoing: string | null = null;
    /** What the last `load` did, in the words the reason line shows (v1.9.11). */
    let loadOutcome = 'not attempted';
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
      // And the JS-side boundary's end, on the first report that this start is sounding (v2.0-beta.15).
      noteForegroundAudible(event.isPlaying, event.currentTime);
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
     * **Two lanes, and the audible one is never behind warm work.**
     *
     * A track is loaded with `unload`+`preload` under its slot's name, which makes an unfinished
     * `preload` and the next track's `unload`+`preload` two writers on one slot: the older one can
     * finish last and leave the plugin holding the wrong stream. So the writes are serialised — but
     * until v1.9.9 they were serialised **on one lane with the warm work**, and that is the
     * contention the owner can feel: `prepare` waits for real bytes now (it proves the slot holds
     * media), a tap's `load` queues behind it, and `boundedSettled` giving up on *waiting* does not
     * let the job go — the tap then waits for the whole network-bound warm to finish before its own
     * first byte is asked for.
     *
     * So the two are separate lanes: the audible one carries what the listener is waiting for (a
     * load, an adoption, the play of a start, the slot an adoption frees), the warm one carries what
     * he is not (a warm, its proof, a replaced slot's unload, a discard). A warm job additionally
     * **yields** while a start or an adoption is in flight — the bytes still share one pipe, so a
     * fetch competing with the track he is waiting for is the failure this app has shipped before.
     * The mechanism is exported (`createAssetLanes`) so the rule can be tested without a phone.
     */
    const lanes = createAssetLanes();

    /** What the lock-screen card shows for a track, in one place — the audible and prepared alike. */
    const metadata = (info: NativeTrackInfo) => ({
      title: info.title,
      artist: info.artist,
      album: info.album,
      artworkUrl: toAbsoluteArtworkUrl(info.artworkUrl, info.url),
    });

    /** Put `info` into `slot`, replacing whatever it held. Best-effort: the plugin rejects both on an empty slot. */
    const fillSlot = async (slot: string, info: NativeTrackInfo): Promise<void> => {
      slotWrittenAt.set(slot, Date.now());
      // Whatever this slot held is on its way out with the unload below (v1.9.11): nothing may claim
      // the old track for a slot that is about to hold a new one.
      held.delete(slot);
      try {
        await NativeAudio.unload({ assetId: slot });
      } catch {
        // Nothing loaded under that name yet — unload is best-effort.
      }
      try {
        await NativeAudio.preload({ assetId: slot, assetPath: info.url, isUrl: true, notificationMetadata: metadata(info) });
      } catch (error) {
        held.delete(slot);
        throw error;
      }
      // The slot holds it *now* — recorded from the plugin's own answer rather than from the intent.
      held.set(slot, { songId: info.id ?? info.url, url: info.url });
    };

    /** Give a slot's asset back to the player. Best-effort: an empty slot rejects. */
    const unloadSlot = async (slot: string): Promise<void> => {
      slotWrittenAt.set(slot, Date.now());
      held.delete(slot);
      try {
        await NativeAudio.unload({ assetId: slot });
      } catch {
        // Nothing loaded under that name — nothing to free.
      }
    };

    /**
     * Free the slot the listener was hearing before a handover, now that the new item has been asked
     * to play (v1.9.11).
     *
     * Called from `play`, after the play call and the buffer target — the order is the whole point.
     * Until v1.9.11 a load took the audible slot over first (`unload` + `preload` on the same name),
     * so the player held **nothing** while the incoming stream was fetched: the lock screen had no
     * item, the plugin had no current asset, and the next track appeared out of an empty player. The
     * incoming track now goes into a different slot and the outgoing one is only released once the
     * new one has been asked to play, so the queue is never emptied and no silence is *introduced* by
     * the app; whatever wait the fetch costs is the fetch's, not a hole the app made.
     */
    const freeOutgoing = async (): Promise<void> => {
      const slot = outgoing;
      outgoing = null;
      if (slot === null || slot === audibleId) return;
      await bounded(lanes.audible(() => unloadSlot(slot)), undefined, 'handover-unload');
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
    const stateQueue = async (): Promise<boolean> => {
      if (!remote?.setQueue) {
        boundaryArmed = false;
        boundaryQueued = 0;
        boundaryReason = 'this build has no native boundary plugin, so the web layer owns the boundary as it always did';
        return false;
      }
      let warmEntries = 0;
      const list = statement.list.map((entry) => {
        const held =
          entry.warmUrl == null
            ? undefined
            : [...warm.entries()].find(([, claim]) => claim.songId === entry.songId && claim.url === entry.warmUrl);
        const artworkUrl = toAbsoluteArtworkUrl(entry.artworkUrl, entry.url);
        if (held === undefined) {
          return { songId: entry.songId, url: entry.url, title: entry.title, artist: entry.artist, album: entry.album, artworkUrl };
        }
        warmEntries += 1;
        return {
          songId: entry.songId,
          url: entry.url,
          title: entry.title,
          artist: entry.artist,
          album: entry.album,
          artworkUrl,
          assetId: held[0],
        };
      });
      statementGeneration += 1;
      const answer = await bounded(
        remote.setQueue({
          list,
          index: statement.index,
          repeat: statement.repeat,
          awake: statement.awake,
          audibleAssetId: audibleId,
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
            ? `the native player will walk this queue itself if a track ends with the app away (${list.length} entries, ${warmEntries} of them held warm here)`
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
         *
         * v1.9.11 — **and dropping a claim is not the same as emptying a slot.** Every branch below is
         * about that distinction, because this call is the boundary's fallback and it used to take the
         * audible slot over unconditionally (`unload` then `preload` on the same name), which leaves
         * the player holding *nothing* until the new stream's first bytes arrive. In order:
         *
         *   1. **The track is already audible.** It is on the player under exactly this URL, so there
         *      is nothing to fetch and the play that follows is the whole start. (The old code
         *      unloaded and refetched it: the one case where a start has the most to lose and the
         *      least to gain.)
         *   2. **The player holds it in another slot.** This is the handover the invariant asks for:
         *      the armed item becomes current from its own buffered state, the audible name moves to
         *      it, and the outgoing slot is freed by `play` — never before the new item has been
         *      asked for. Nothing is fetched, nothing is emptied, and this works from what the
         *      *player* holds (`held`) rather than from the app's claims (`warm`), which is what makes
         *      it survive a boundary whose claim was dropped by a timeout or a prune.
         *   3. **Nothing holds it.** Then it is a genuine fetch, and it is performed *into a slot that
         *      is not the one being heard*: the incoming track is written beside the outgoing item,
         *      the audible name is handed over, and `play` frees the slot the old track was in. The
         *      queue is never empty and the lock screen never has to show nothing.
         */
        preparedEpoch += 1;
        warm.clear();
        audibleSongId = info.id ?? audibleSongId;
        const key = info.id ?? info.url;
        // A handover that never reached its play leaves the slot it was going to free still set, and
        // this call is another selection — free it now rather than carry it.
        await freeOutgoing();
        const audibleTrack = held.get(audibleId);
        if (audibleTrack?.songId === key && audibleTrack.url === info.url) {
          loadOutcome = `nothing to fetch — the audible slot already holds this track under exactly this URL, so this start is the play that follows it`;
          return;
        }
        const elsewhere = [...held.entries()].find(
          ([slot, h]) => slot !== audibleId && h.songId === key && h.url === info.url,
        );
        if (elsewhere) {
          const [slot] = elsewhere;
          warm.delete(slot);
          outgoing = audibleId;
          audibleId = slot;
          loadOutcome = `handed over to the slot that already holds this track, buffered (${slot}) — nothing was unloaded and nothing was fetched`;
          return;
        }
        /*
         * Into a slot that is not the one being heard. With a pool of four there is always such a
         * slot; the audible one is the fallback only for a bridge with a single slot, where there is
         * no other place to put it.
         */
        const spare = SLOTS.find((slot) => slot !== audibleId) ?? audibleId;
        // The listener's own request, on the lane that belongs to him — and while it is in flight,
        // warm work stands aside instead of competing for the link.
        await lanes.audible(() => bounded(fillSlot(spare, info), undefined, 'load'));
        if (spare === audibleId) {
          loadOutcome = `fetched into the audible slot itself — this bridge has no second slot to load beside the one being heard`;
          return;
        }
        outgoing = audibleId;
        audibleId = spare;
        loadOutcome = `fetched into ${spare} beside the track being heard, and the audible name was handed over to it — the previous item is freed once the new one has been asked to play`;
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
        for (const claim of warm.values()) if (claim.songId === key && claim.url === info.url) return true;
        const result = await boundedSettled(
          lanes.warm(async () => {
            if (epoch !== preparedEpoch) return false;
            /*
             * **And warm work stands aside while a start or an adoption is in flight (v1.9.9).**
             *
             * The lanes are separate, which is what keeps a tap from *queueing* behind a warm — but
             * the bytes are one pipe, and a fetch that runs while the listener waits for the first
             * seconds of a track he tapped is competing with the very stream he is waiting for. So
             * the warm waits for the audible lane to be quiet, with a bound: past it, this answers
             * "not warm" and issues nothing at all, which the engine reads as a claim that was never
             * made. Nothing is lost — the look-ahead warms again after the start has settled.
             */
            if (!(await lanes.yieldToAudible())) return false;
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
          for (const [slot, claim] of warm) {
            if (claim.songId !== songId) continue;
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
        const result = await lanes.audible(async () => {
          const attempt = (async (): Promise<boolean> => {
            try {
              await NativeAudio.play({ assetId: slotName, time: 0 });
            } catch (error) {
              refusal = `play refused (${error instanceof Error ? error.message : String(error)})`;
              return false;
            }
            return true;
          })();
          return boundedSettled(attempt, false, 'adopt');
        });
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
        // The slot this adoption emptied is not one a later load has to free (v1.9.11).
        if (outgoing === to) outgoing = null;
        await bounded(
          lanes.audible(async () => {
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
        const slot = typeof state.assetId === 'string' && state.assetId ? state.assetId : null;
        const nativeIndex = Number.isFinite(state.index) ? Number(state.index) : -1;
        /*
         * **The app is following the wrong track if either fact says so (v1.9.9).** The slot is the
         * old test and it still holds — but the *index* is the one a shuffled order needs: two
         * different tracks can be played from the same slot name over time, and the id lookup this
         * used to fall back on cannot tell an advance from a re-warm. An index that differs from the
         * one the app last published is a boundary the native side took, whether or not it happened
         * to come out of the slot the app expected.
         */
        const movedIndex = nativeIndex >= 0 && nativeIndex !== statement.index;
        if (slot === null || (slot === audibleId && !movedIndex)) return { changed: false, songId: state.songId ?? null, index: nativeIndex };
        /*
         * The native player is on another entry than the app believed. That is a track the app
         * advanced to without being told, and the answer is to move onto it — never to play anything:
         * the audio is already coming out of that slot.
         */
        if (slot !== null) {
          warm.delete(slot);
          audibleId = slot;
        }
        audibleSongId = typeof state.songId === 'string' && state.songId ? state.songId : null;
        // The load that moves the app onto this entry is an adoption, not a new clock (v2.0-beta.15).
        adoptingNextLoad = true;
        return { changed: true, songId: audibleSongId, index: nativeIndex };
      },
      nativeAdvance() {
        return {
          armed: boundaryArmed ? boundaryQueued : 0,
          advances: nativeAdvances,
          failures: nativeFailures,
          ignored: nativeIgnored,
          reason: boundaryReason,
          timeline: `${lastTimeline}${foregroundText()}`,
          startedAt: lastTimelineAt,
          foreground: foregroundBoundary(),
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
          lanes.warm(async () => {
            for (const slot of slots) await unloadSlot(slot);
          }),
          undefined,
          'discard',
        );
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
        // Behind the audible lane: the play for a track whose own load is still running must not
        // overtake it, and it must not start the previous track's asset either.
        await lanes.audible(() => bounded(NativeAudio.play({ assetId: audibleId, time: Math.max(0, startSeconds) }), undefined, 'play'));
        /*
         * The forward-buffer target, written **after** the play call (v1.9.2).
         *
         * The plugin sets its `currentlyPlayingAssetId` when it is asked to play, and that is what
         * our own plugin finds the audible player by; asking before this point would aim the target
         * at the outgoing item. Setting it after the play is still in time — the player fills
         * towards this target for as long as the item plays.
         */
        await configureBuffer();
        /*
         * **And only now the slot the previous track held (v1.9.11).** This is the whole of "the
         * queue is never emptied": a load writes the incoming track *beside* the item being heard and
         * hands the audible name over, and the item it replaced is released here — after the play has
         * been issued, so from the plugin's point of view the new asset is the one that is current
         * before the old one goes. Freeing it in `load` instead would be the empty player the owner
         * reported, whatever the incoming stream was doing.
         */
        await freeOutgoing();
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
          /*
           * The foreground boundary's end — the **second** reader (v2.0-beta.15). The primary one is
           * the plugin's own `playbackState` report (`noteForegroundAudible`), because this call never
           * runs at an awake track boundary: it runs on resume, after a seek, and on the return from
           * hidden. It still closes a boundary here — a resumed or sought start is this layer's own —
           * but never an **adopted** one: the return's `5–50 ms` was exactly that mistake, a number
           * measuring the round trip rather than the gap.
           */
          if (playing.isPlaying === true && foregroundStartedAt > 0 && foregroundAudibleAt === 0 && !foregroundAdopted) {
            foregroundAudibleAt = Date.now();
          }
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
          /*
           * The slot the plugin says it tapped (v1.9.25): kept for the reason line, never acted on.
           * A request that came back `started: false` answers nothing, so the last *answer* stands —
           * which is what the pair `tapped`/`audible` is read as.
           */
          if (result.started === true) spectrumTapped = typeof result.tapped === 'string' ? result.tapped : null;
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
      /*
       * Which slot the tap is on, and which slot is being heard (v1.9.25). Both are answers this
       * bridge already holds — the plugin's own `tapped` from its last install, and the slot this
       * bridge last made audible — and neither is acted on by anything: the reason line is where they
       * are read, because *"the tap is on another player"* and *"the tap is on this one and measures
       * nothing"* are the same flat bars on the screen.
       */
      spectrumEvidence() {
        return { tapped: spectrumTapped, audible: audibleId };
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
                const slot = typeof event?.assetId === 'string' ? event.assetId : '';
                const moved = Number.isFinite(event?.index) ? Number(event?.index) : -1;
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
                /*
                 * And the index the native side moved to becomes the index the app has published,
                 * so the reconciliation on the way back does not read this same advance a second
                 * time and move the queue again.
                 */
                if (moved >= 0) statement = { ...statement, index: moved };
                boundaryReason = `the native player took the boundary itself and is playing ${songId || 'the next entry'}`;
                events.onAdvanced?.(songId, moved);
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
