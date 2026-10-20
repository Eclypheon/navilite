/**
 * The queue, and the play reporting that Navidrome actually notices.
 *
 * Two details from the research are load-bearing here:
 *   - Navidrome does **not** count a track as played because it was streamed. Only
 *     `scrobble` does. So we send `submission=false` when a track starts (now
 *     playing) and `submission=true` once it passes the Subsonic threshold — half
 *     the track or four minutes, whichever comes first.
 *   - `savePlayQueue` is what makes the queue survive an app restart, so it is sent
 *     debounced on track change rather than on every tick.
 *
 * v1.1 adds shuffle and repeat, and restoring the queue saved by a previous session.
 * Both are modelled as a **play order** (`order`, a permutation of item indexes) plus a
 * cursor into it, which is what makes "track 3 of 12" honest while shuffle is on: the
 * number shown is the position in the order you are actually hearing.
 */
import type { Song, QueueContext, QueueItem } from '../api/types.ts';
import type { AudioEngine } from '../player/engine.ts';
import type { PublishedTrack, TrackRequest } from '../player/engine-contract.ts';
import { updateNowPlaying, updatePlaybackState, updatePositionState, mediaSessionAvailable } from '../player/mediasession.ts';
import { clearSnapshot, saveSnapshot } from '../storage/session.ts';
import { ByteRate } from './bitrate.ts';
import { fillSong } from './song-metadata.ts';
import type { Library } from './library.ts';

const SAVE_QUEUE_DEBOUNCE_MS = 5000;
/** How often the local resume snapshot is allowed to be written (see `src/storage/session.ts`). */
const SNAPSHOT_INTERVAL_MS = 5000;
const PLAY_THRESHOLD_MS = 240000; // Subsonic: half the song, or four minutes

export type RepeatMode = 'off' | 'all' | 'one';

/** What a snapshot needs to bring a session back exactly (`src/storage/session.ts`). */
export interface ResumeSessionState {
  songs: Song[];
  order: number[];
  cursor: number;
  shuffle: boolean;
  repeat: RepeatMode;
  context: QueueContext | null;
}

/** The context a restored queue shows when the session did not record where it came from. */
export const LAST_SESSION: QueueContext = { kind: 'song', name: 'your last session' };

function isRepeatMode(value: unknown): value is RepeatMode {
  return value === 'off' || value === 'all' || value === 'one';
}

/**
 * Subsonic's rule for counting a play: half the track, or four minutes, whichever
 * comes first. Pure so it can be tested without an audio element.
 */
export function playThresholdMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return PLAY_THRESHOLD_MS;
  return Math.min(PLAY_THRESHOLD_MS, durationMs / 2);
}

export function shouldSubmitPlay(playedMs: number, durationMs: number): boolean {
  return playedMs >= playThresholdMs(durationMs);
}

/**
 * A play order for `length` items: identity when shuffle is off, and otherwise the item at
 * `keepIndex` first (so turning shuffle on never interrupts what is playing) followed by the
 * rest in a shuffled order. `rng` is injectable so the order is testable.
 */
export function shuffleOrder(length: number, keepIndex: number, rng: () => number = Math.random): number[] {
  const rest: number[] = [];
  for (let i = 0; i < length; i += 1) if (i !== keepIndex) rest.push(i);
  // Fisher–Yates, from the end down.
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return keepIndex >= 0 && keepIndex < length ? [keepIndex, ...rest] : rest;
}

export function identityOrder(length: number): number[] {
  return Array.from({ length }, (_unused, i) => i);
}

/** What should happen when a track ends (`auto`) or the next button is pressed. */
export type AdvancePlan = { kind: 'play'; cursor: number } | { kind: 'repeat-current' } | { kind: 'stop' };

/**
 * The advance rule, pure so it can be tested without an audio element:
 *
 *   - repeat `one` + the track ending on its own → the same track again;
 *   - the last track + repeat `off` + the track ending → stop (do not loop the queue);
 *   - the last track + repeat `all` → back to the top;
 *   - pressing *next* on the last track → back to the top (a button should always do
 *     something), and repeat `one` never traps you on the next button.
 */
export function planAdvance(cursor: number, length: number, auto: boolean, repeat: RepeatMode): AdvancePlan {
  if (length === 0) return { kind: 'stop' };
  if (auto && repeat === 'one' && cursor >= 0) return { kind: 'repeat-current' };
  if (cursor >= length - 1) {
    if (auto && repeat !== 'all') return { kind: 'stop' };
    return { kind: 'play', cursor: 0 };
  }
  return { kind: 'play', cursor: cursor + 1 };
}

export class PlaybackQueue {
  private items: QueueItem[] = [];
  /** Play order: `order[cursor]` is the index into `items` that is playing. */
  private order: number[] = [];
  private cursor = -1;
  private context: QueueContext | null = null;
  private shuffled = false;
  private repeatMode: RepeatMode = 'off';
  /** Where to start the next `play()`: set when the queue is restored, not played yet. */
  private pendingStartMs = 0;
  private playedMs = 0;
  private submitted = false;
  private submittedIds = new Set<string>();
  private lastPositionMs = 0;
  private lastSnapshotAt = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private playToken = 0;
  /** v1.9.0: the tap has painted and the engine has not answered yet. See `select` and `isLoading`. */
  private loading = false;
  /**
   * v1.9.2: the last start ended without sound, and the screen has to say so.
   *
   * Set from the engine's own answer (`startDidFail`) once `play()` has returned. Cleared by the
   * next start, by the retry, and by anything that moves the queue. What it is *for* is the one
   * ending this app never had: a track that did not start, with the row and the chip saying so
   * instead of a transport that claims to be playing while nothing sounds.
   */
  private startFailed = false;
  /**
   * v1.9.1: the song the engine has been asked for and has not answered yet.
   *
   * A second tap on that row is not a second request — the load is already running for that very
   * track — but it is also not nothing: the row must stay drawn as waiting until that load answers,
   * which is what the owner saw as *"tapping a row also still does not select it instantly 100% of
   * the time"*.
   */
  private inFlightSongId: string | null = null;
  /** v1.9.0: what the link has been measured doing. Read by the stream URL and by the player bar. */
  private readonly rate = new ByteRate();

  /** Fired whenever the queue or the current track changes, so the UI can redraw. */
  onChanged: (() => void) | null = null;

  private readonly engine: AudioEngine;
  private readonly library: Library;

  /**
   * v1.9.17 — **the one signal the app gets that a downloaded row's file has gone.**
   *
   * The offline resolver is synchronous by design and never touches the filesystem, so nothing on
   * the resolving side can discover that a row's file was deleted; a start that produced no sound
   * for a track that was asked for **as a file** is all the evidence there is. The queue reports
   * the song id and the owner of the download store voids the row, so the next start of that track
   * resolves to the stream instead of a file that is not there. Absent in tests, and on a build
   * with no download store at all.
   */
  private readonly onLocalFileUnplayable: ((songId: string) => void) | null;

  constructor(
    engine: AudioEngine,
    library: Library,
    options: { onLocalFileUnplayable?: (songId: string) => void } = {},
  ) {
    this.engine = engine;
    this.library = library;
    this.onLocalFileUnplayable = options.onLocalFileUnplayable ?? null;
    engine.onEnded = () => void this.advance(true);
    engine.onProgress = (positionMs, durationMs) => this.trackProgress(positionMs, durationMs);
    // The lock screen's next/previous (v1.7): the platform delivers them, the queue acts on them.
    engine.onNextRequested = () => void this.next();
    engine.onPreviousRequested = () => void this.previous();
    /*
     * And the boundary the **native player took by itself** (v1.9.8).
     *
     * While the app is off screen the web layer is not running, so the track that ended has no
     * owner for "next" here at all: the native side plays the slot the app armed for it, and this
     * is how the queue hears about it — on the way back, or immediately if the web layer was
     * still alive to receive the message. It is an *adoption*, not an advance: the audio is
     * already playing, so the queue moves its cursor onto the track that is sounding and never
     * asks the engine to start anything.
     */
    engine.onAdvancedNatively = (songId, index, positionMs) => this.adoptNativeAdvance(songId, index, positionMs);
  }

  get current(): QueueItem | null {
    const index = this.order[this.cursor];
    return index === undefined ? null : this.items[index] ?? null;
  }

  get currentSong(): Song | null {
    return this.current?.song ?? null;
  }

  get length(): number {
    return this.items.length;
  }

  /** Position in the play order, 0-based. The UI shows `position + 1` of `length`. */
  get position(): number {
    return this.cursor;
  }

  /**
   * Position of the current track **in the playlist** (0-based), which is what the
   * "Playing from … (x/y)" line shows: with shuffle on, x stays the track's place in the
   * list the owner can see, rather than jumping to 1 the moment shuffle is switched on.
   */
  get songPosition(): number {
    return this.order[this.cursor] ?? -1;
  }

  get queueContext(): QueueContext | null {
    return this.context;
  }

  get shuffle(): boolean {
    return this.shuffled;
  }

  get repeat(): RepeatMode {
    return this.repeatMode;
  }

  /** Replace the queue and start playing at `startIndex`. */
  async play(items: QueueItem[], startIndex = 0, context: QueueContext | null = null): Promise<void> {
    this.select(items, startIndex, context);
    await this.start();
  }

  /**
   * Choose the track, and let the screen answer the finger — **synchronously, with no await, no
   * fetch and no I/O ahead of it** (v1.9.0).
   *
   * This is item 2 of the release, and it is a split rather than an optimisation. Until now the
   * tap went straight into `play()`, which reaches the network on its very first turn: on a slow
   * link the row, the title, the artist, the artwork and the transport all sat there showing the
   * *previous* track for as long as the player took to resolve a stream through the relay — the UI
   * looked dead for seconds. There is no work in here at all: it is a few assignments and one
   * redraw, so the paint cannot be behind anything.
   *
   * `loading` is part of that paint: it is true from this instant until the engine answers, which
   * is what the row's and the player bar's loading state (and `isLoading`) are drawn from. It is
   * never true for a tap that has already been superseded — the play token sees to that.
   */
  select(items: QueueItem[], startIndex = 0, context: QueueContext | null = null): void {
    this.items = items;
    this.order = identityOrder(items.length);
    this.cursor = Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1));
    this.context = context ?? this.current?.context ?? null;
    if (this.shuffled) this.applyShuffle(this.shuffled);
    this.pendingStartMs = 0;
    this.loading = true;
    /*
     * And the queue is **published to the native side** the moment a selection moves it (v1.9.9).
     *
     * What goes is the queue: the resolved order, the entry this tap is on, and the repeat mode.
     * The native side may not act on it (the app is on screen, so the statement carries
     * `awake: true`), but it holds the picture, so a track that ends while the app is in the
     * background advances from where the listener actually is.
     */
    this.publishQueue();
    this.startFailed = false;
    this.onChanged?.();
  }

  /** True between the tap and the engine answering it. The UI's loading state. */
  get isLoading(): boolean {
    return this.loading;
  }

  /**
   * True when the last start ended without sound (v1.9.2).
   *
   * The screen shows this where it would otherwise show a transport that is playing: the row says
   * it did not start, and one tap tries again. It is the honest ending the app did not have — the
   * owner's *"even after a minute it doesn't load"* was a screen that claimed success.
   */
  get didNotStart(): boolean {
    return this.startFailed;
  }

  /**
   * The rate the ladder has landed on: `null` = no cap, a number = the rung.
   *
   * The player bar shows the number, so nothing about the ladder is silent (v1.9.0). Since the
   * look-ahead went (unreleased) **no URL is asked for at a cap any more** — every request is the
   * track's own file (`trackRequest`) — so this is a readout of the measurement, not a request.
   */
  get streamKbps(): number | null {
    return this.rate.maxBitRate;
  }

  /**
   * Put a queue back without starting it — used at launch to restore the queue the server
   * saved, so the app can open on the spectrum screen showing what was playing.
   *
   * **Returns false when it declines, and the one case it declines is a queue already in use
   * (v1.9.19).** The server's saved queue is fetched *after* the first paint since v1.9.18, so on a
   * slow server it can land up to the request timeout (20 s) into a session the owner has already
   * started: he taps a downloaded track, the old server queue then overwrote the items, the order,
   * the cursor and the context and republished all of it, so the bar, the now screen and the row
   * highlight jumped to another track while the audio kept playing his choice — and the native side
   * was handed the stale queue. Adopting a launch convenience is only honest when nothing has been
   * chosen; `currentSong !== null` is exactly "something has started".
   */
  restore(items: QueueItem[], startIndex: number, positionMs = 0, context: QueueContext | null = null): boolean {
    if (this.currentSong !== null) return false;
    this.items = items;
    this.order = identityOrder(items.length);
    this.cursor = Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1));
    this.context = context;
    this.pendingStartMs = Math.max(0, positionMs);
    // The queue is published even before it is played (v1.9.9): the native side then holds the
    // picture the app is showing, so an edge case like "the app is backgrounded before anything is
    // tapped" cannot leave it walking a queue the listener is no longer looking at.
    this.publishQueue();
    this.onChanged?.();
    return true;
  }

  /**
   * The whole resumable session: the queue, the play order, where we are in it, and the flags.
   * What `src/storage/session.ts` snapshots on a timer, so a relaunch can be exact.
   */
  resumeState(): ResumeSessionState {
    return {
      songs: this.items.map((item) => item.song),
      order: [...this.order],
      cursor: this.cursor,
      shuffle: this.shuffled,
      repeat: this.repeatMode,
      context: this.context,
    };
  }

  /**
   * Put a whole session back **exactly** — the same songs, the same play order, the same cursor,
   * the same flags, at the same second. Nothing comes from the server and nothing is re-derived:
   * a shuffled queue is not re-shuffled, and a restore cannot land on a different track because
   * the server's copy of the queue was older than the one the app had (that is what makes this
   * path safe to prefer over `savePlayQueue` at launch).
   */
  restoreExact(state: ResumeSessionState, positionMs = 0): void {
    this.items = state.songs.map((song) => ({ song, context: state.context ?? LAST_SESSION }));
    const usable =
      state.order.length === this.items.length && state.order.every((index) => Number.isInteger(index) && index >= 0 && index < this.items.length);
    this.order = usable ? [...state.order] : identityOrder(this.items.length);
    this.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, this.items.length - 1));
    this.shuffled = state.shuffle;
    this.repeatMode = isRepeatMode(state.repeat) ? state.repeat : 'off';
    this.context = state.context;
    this.pendingStartMs = Math.max(0, positionMs);
    this.lastPositionMs = this.pendingStartMs;
    this.publishQueue();
    this.onChanged?.();
  }

  /** Start the track the queue is sitting on, at its pending position. The resume path. */
  async start(): Promise<void> {
    if (!this.current) {
      this.loading = false;
      return;
    }
    this.loading = true;
    await this.startCurrent();
  }

  /** Append without interrupting playback. */
  enqueue(items: QueueItem[]): void {
    this.items = [...this.items, ...items];
    if (this.order.length !== this.items.length) {
      this.order = this.shuffled ? [...this.order, ...identityOrder(items.length).map((i) => i + this.order.length)] : identityOrder(this.items.length);
    }
    // What was appended is part of the queue the native side walks (v1.9.9).
    this.publishQueue();
    this.onChanged?.();
    this.scheduleSaveQueue();
  }

  async toggle(): Promise<void> {
    if (!this.current) return;
    // A restored queue has a track selected but nothing loaded into the engine yet.
    if (this.engine.status().state === 'idle') {
      await this.startCurrent();
      return;
    }
    await this.engine.toggle();
  }

  async next(): Promise<void> {
    // `false` = a person pressed next, so the last track wraps instead of stopping.
    await this.advance(false);
  }

  async previous(): Promise<void> {
    /*
     * What "previous" means, in code at last (v1.9.9).
     *
     * The rule has been written in a comment at this spot since v1.1 and it was never what the code
     * did. It read `if (position > 3000) { await seek(0); if (position <= 3000) return; }` — the
     * second test is inside a branch the first test has already answered, so it is dead, and what
     * the app actually did was: past three seconds, **seek to zero and then play the previous track
     * anyway**. "Restart this one" never happened on this button.
     *
     * So, as the queue's own rule and the lock screen's:
     *   - more than three seconds in: restart the track that is playing, and go nowhere else;
     *   - within the first three seconds: the previous entry, at 0:00;
     *   - and at the very first entry of the queue: restart it (no wrap — wrapping backwards out of
     *     the first track is a jump to the end of the queue, which is not what a back button is for).
     */
    const position = this.engine.status().positionMs;
    if (position > 3000 || this.cursor <= 0) {
      await this.engine.seek(0);
      return;
    }
    /*
     * v1.9.2 — the one start path that still could not show waiting, which matters *more* now that
     * `loading` means something: `advance` has set it since v1.9.1, and this path (the lock screen's
     * previous, the bar's previous) moved the queue and then looked exactly like a track that had
     * never been asked for. The same three lines the advance path uses.
     */
    this.cursor = Math.max(0, this.cursor - 1);
    this.loading = true;
    this.startFailed = false;
    // The cursor moved: the native side is told where the listener now is (v1.9.9).
    this.publishQueue();
    this.onChanged?.();
    await this.startCurrent();
  }

  async seek(positionMs: number): Promise<void> {
    await this.engine.seek(positionMs);
    this.lastPositionMs = positionMs;
    /*
     * v1.9.7 — **the ordinary throttle, not a forced write.**
     *
     * This asked for `persistSnapshot(true)` on every commit, and the seek bar commits while a finger
     * is still moving: that is a synchronous `JSON.stringify` of the whole queue plus a
     * `localStorage.setItem` roughly eight times a second during a drag, on the gesture where the
     * screen has to keep up. Five seconds is the throttle the position stream already writes under,
     * and the forced writes are not lost — a track change forces one, and so does the way into the
     * background (`flushSnapshot`). Coming back at the right second does not need eight answers
     * during one drag.
     */
    this.persistSnapshot();
  }

  /** Shuffle on/off. Turning it on keeps the current track; turning it off keeps the order. */
  setShuffle(on: boolean): void {
    if (on === this.shuffled) return;
    this.shuffled = on;
    this.applyShuffle(on);
    // The order *is* the queue the native side walks (v1.9.9): a shuffle it does not hear about is
    // a boundary that plays the wrong track.
    this.publishQueue();
    this.onChanged?.();
  }

  setRepeat(mode: RepeatMode): void {
    if (mode === this.repeatMode) return;
    this.repeatMode = mode;
    // Repeat decides what happens at the end of the published queue, so it is part of the statement.
    this.publishQueue();
    this.onChanged?.();
  }

  cycleRepeat(): RepeatMode {
    const next: RepeatMode = this.repeatMode === 'off' ? 'all' : this.repeatMode === 'all' ? 'one' : 'off';
    this.setRepeat(next);
    return next;
  }

  async clear(): Promise<void> {
    this.items = [];
    this.order = [];
    this.cursor = -1;
    this.context = null;
    this.pendingStartMs = 0;
    this.loading = false;
    this.startFailed = false;
    // There is no queue, so the native side is told there is none (v1.9.9).
    this.publishQueue();
    clearSnapshot();
    await this.engine.stop();
    this.onChanged?.();
  }

  queueSnapshot(): QueueItem[] {
    return this.items;
  }

  /**
   * v1.9.23 — **the queue's own copies of its songs, filled from the store's repair.**
   *
   * A `QueueItem` holds the `Song` object the view handed it at the tap (`select(items, …)`, and
   * `currentSong` *is* that object), so a queue built from a list drawn before the metadata repair
   * holds a blank title and no duration for the whole track: the player bar prints the title it
   * holds (`src/ui/app.ts`, `updatePlayerBar`) and the total it draws is
   * `status.durationMs || (song.duration ?? 0) * 1000` — 0, which is the `0:00` beside the blank
   * title in the owner's screenshot, from the same rows.
   *
   * `lookup` answers with the best copy of one song the app has, by id, or null; each item's
   * **empty** fields are filled from it and nothing else ({@link fillSong}). A song that came from
   * the server is complete, so this is a no-op for it, and a track nobody can name yet keeps the
   * blank it has instead of a stand-in. Returns how many songs were filled.
   *
   * The redraw is driven from here rather than left to the next status event: while a track plays
   * the engine emits those a dozen times a second, but a *paused* queue emits none, and the name
   * arriving with no repaint at all is the defect this exists to close.
   */
  applyMetadata(lookup: (songId: string) => Song | null): number {
    let filled = 0;
    for (const item of this.items) {
      const known = lookup(item.song.id);
      if (known === null) continue;
      if (fillSong(item.song, known) > 0) filled += 1;
    }
    if (filled > 0) this.onChanged?.();
    return filled;
  }

  private applyShuffle(on: boolean): void {
    const currentIndex = this.order[this.cursor] ?? -1;
    this.order = on ? shuffleOrder(this.items.length, currentIndex) : identityOrder(this.items.length);
    const at = this.order.indexOf(currentIndex);
    this.cursor = at === -1 ? (on ? 0 : Math.min(Math.max(0, currentIndex), Math.max(0, this.items.length - 1))) : at;
  }

  private async advance(auto: boolean): Promise<void> {
    const plan = planAdvance(this.cursor, this.items.length, auto, this.repeatMode);
    if (plan.kind === 'stop') {
      await this.engine.pause();
      return;
    }
    if (plan.kind === 'repeat-current') {
      await this.engine.seek(0);
      await this.engine.resume();
      return;
    }
    /*
     * v1.9.1 — an advance crosses **the same transition a tap does**.
     *
     * The owner's *"i let a song end normally the next one takes 40s to start"* was two things at
     * once: a cold fetch (nothing had been prepared) and a screen that showed no sign of anything
     * happening, because this path never set the loading state — only `select` did. So a track that
     * ended moved the queue and then looked exactly like a track that had never started.
     *
     * The probe for the track being *left* is gone with the prefetch (v1.9.2); what remains is
     * that nothing is left buffering for a chain nobody is on: the prepare that was in flight for
     * the old "next" is refused at the source by the bridge's own epoch, and `select`'s rule about
     * the slot applies here through `startCurrent`.
     */
    this.cursor = plan.cursor;
    this.loading = true;
    this.startFailed = false;
    // The native side is told where the listener now is (v1.9.9) — an advance is a cursor move.
    this.publishQueue();
    this.onChanged?.();
    await this.startCurrent();
  }

  private async startCurrent(): Promise<void> {
    const item = this.current;
    if (!item) return;
    const song = item.song;
    /*
     * A second start for a track whose load is still in flight is not a second load (v1.9.1).
     *
     * It is the same request — and it is answered by keeping the waiting state it painted rather
     * than by clearing it on the instant. `select` has already painted the row and set the loading
     * state; nothing else is sent, and the load that is running is the one that will clear it. This
     * is the intermittent half of *"tapping a row also still does not select it instantly 100% of the
     * time"*: a re-tap of a row whose load had not answered yet used to paint, then clear itself
     * with no engine work at all, which reads exactly like a missed tap.
     */
    if (this.inFlightSongId === song.id) {
      this.loading = true;
      this.onChanged?.();
      return;
    }
    const startMs = this.pendingStartMs;
    this.pendingStartMs = 0;
    this.playedMs = 0;
    this.submitted = false;
    this.lastPositionMs = startMs;
    // A play token, so overlapping play() calls (a rapid double tap, a hand-off in
    // flight) cannot each report "now playing" for the same or a stale track.
    this.playToken += 1;
    const token = this.playToken;
    const artworkUrl = this.library.coverUrl(song.coverArt ?? song.albumId, 512);
    const request = this.trackRequest(song, artworkUrl);
    this.inFlightSongId = song.id;
    this.onChanged?.();
    /*
     * **The start, and — since v1.9.2 — how long it took, and what to do when it did not happen.**
     *
     * `engine.play` now resolves only when the player has reported sound (or the deadline has run
     * out), so this await is the whole of the wait the listener is in, and `startDidFail` is the
     * engine's honest answer to "did that work".
     *
     * v1.9.8 — **the retry is in place, and it never unloads anything that may be sounding.**
     *
     * This used to answer a start that produced no sound with a *second full cold load of the same
     * track* at a new URL: `unload` + `preload` on the audible slot, which takes the item that may
     * already be playing away and puts a fresh fetch where it was. Worst case that is thirty more
     * seconds of nothing, or the same song restarting — and it is now impossible by construction,
     * because the app no longer has a reason to ask for a *different* stream: the track was asked
     * for as the original file, and the only thing the retry changes is that the player is asked
     * again. So the retry is `retryPlayInPlace`: the item the load left there is told to play once
     * more, and the failure stands on screen if that does not produce sound either.
     *
     * The time it took is the measurement the ladder is built on (v1.9.2) — and since v1.9.8 it is
     * taken from **audio-start**: only a start the player itself concluded (`lastStartOutcome` of
     * `player`) is a number about this link. A start that ended in a timeout, or in the app going
     * off screen, is not measured at all.
     */
    const startedAt = Date.now();
    /*
     * v1.9.7 — **a start that throws is a start that failed, not a screen stuck on "loading…".**
     *
     * Everything below used to be unwrapped: a rejection from `engine.play` — and the engine's own
     * `ensureNative` round trip is the one that can reject before any of its internal handlers exist
     * — escaped into `void this.queue.play(...)` at the call sites, which swallowed it. `loading` was
     * never cleared, so the row and the bar sat on "loading…" for the rest of the session with
     * nothing playing, nothing said, and no tap that could clear it: the one ending this app must
     * never have. The failure path is the one that already exists two branches down, taken with the
     * same five steps, so a throw lands exactly where an honest "no sound" answer lands: waiting off,
     * the failure on screen, the row free again, the look-ahead re-armed, and a tap to try again.
     */
    let failed: boolean;
    try {
      await this.engine.play(request, startMs);
      failed = this.engine.startDidFail?.() === true;
      const concludedByThePlayer = (this.engine.lastStartOutcome?.() ?? 'player') === 'player';
      if (!failed && concludedByThePlayer) this.rate.noteStart(Date.now() - startedAt);
      if (failed && token === this.playToken) {
        /*
         * One rung down, and **the same item tried again** (v1.9.8). No URL is asked for at a cap
         * any more (unreleased — the look-ahead that carried it is gone), so the rung moves the
         * readout and nothing else; the retry asks the player that already holds this track for
         * sound rather than fetching it a second time.
         */
        this.rate.demote();
        this.onChanged?.();
        const retry = this.engine.retryPlayInPlace;
        if (retry) {
          const heard = await retry.call(this.engine, startMs);
          failed = !heard;
        }
      }
    } catch (error) {
      // The same silence the engine reports by itself, except that here it arrived as a rejection.
      console.warn('[navilite] starting a track failed', error);
      failed = true;
    }
    this.inFlightSongId = null;
    if (token !== this.playToken) return;
    /*
     * The engine has the stream — or has told us it does not. Either way the wait is over and the
     * loading state comes off with this same redraw.
     */
    this.loading = false;
    this.startFailed = failed;
    if (failed) {
      /*
       * Nothing is playing, so nothing is reported as playing: no now-playing, no media session, no
       * play queue. What is left is the row and the chip saying so, and the tap that tries again.
       */
      /*
       * v1.9.17 — **a start that produced no sound for a `file://` track is the file that has gone,
       * and the row behind it is voided here.**
       *
       * Nothing else can find out. The resolver is synchronous and never touches the filesystem, and
       * the retry above is *in place* by design (v1.9.8) — the same dead item asked again — so this
       * is the only moment the app learns that a downloaded track cannot play. The store drops the
       * row (the index, the mirror and the native `index.json`), which is what makes the next start
       * of this song resolve to the stream instead of the missing file: the track comes back rather
       * than being unplayable until the download is deleted and made again. The failure still stands
       * on screen for the attempt that failed, with the tap that tries again.
       *
       * The scheme test is the whole of the guard: a stream that failed is a link or a server
       * problem, and no download row is involved in it at all.
       */
      if (request.url.startsWith('file://')) this.onLocalFileUnplayable?.(song.id);
      this.onChanged?.();
      this.publishQueue();
      return;
    }
    this.reportNowPlaying(song);
    this.setupMediaSession(song, artworkUrl);
    this.scheduleSaveQueue();
    // A new track, at a known position: the snapshot is written now rather than on the next tick.
    this.persistSnapshot(true);
    this.onChanged?.();
    // Every start is a selection: the boundary, a tap, a skip and a step back all land here, so all
    // four leave the queue stated to the native side behind them.
    this.publishQueue();
  }

  /**
   * A play request for one song — always the **original file**, with no `maxBitRate` at all
   * (v1.9.8).
   *
   * That absence is the owner's rule, and it is the whole of the first-tap regression: v1.7 asked
   * for `streamUrl(song.id)` and nothing else, v1.9.0 started asking for `maxBitRate=128` on every
   * URL, and a request for `maxBitRate` is a request for Navidrome to spawn a transcode *before the
   * first byte*. A track the listener is waiting to hear is never asked for at a lower rate.
   */
  private trackRequest(song: Song, artworkUrl: string | null): TrackRequest {
    return {
      id: song.id,
      url: this.library.streamUrl(song),
      crossOrigin: this.library.crossOrigin,
      title: song.title,
      artist: song.artist ?? 'Unknown artist',
      album: song.album ?? '',
      artworkUrl,
      durationMs: (song.duration ?? 0) * 1000,
    };
  }

  /**
   * Publish the queue to the engine (v1.9.9), which states it to the native side.
   *
   * The list is the **resolved play order** — `order` applied, so a shuffled queue is published
   * shuffled and the native side needs no second model of what shuffle means — and `index` is the
   * position in that order the listener is on. Every URL is the track's own file: an entry is only
   * ever a URL the native side could fetch and play as it sits on the server.
   */
  private publishQueue(): void {
    this.engine.setQueue?.({
      list: this.order.map((itemIndex) => this.publishedTrack(this.items[itemIndex]!.song)),
      index: this.cursor,
      repeat: this.repeatMode,
    });
  }

  /** One entry of the published queue, from the song and this library. */
  private publishedTrack(song: Song): PublishedTrack {
    return {
      songId: song.id,
      url: this.library.streamUrl(song),
      title: song.title,
      artist: song.artist ?? 'Unknown artist',
      album: song.album ?? '',
      artworkUrl: this.library.coverUrl(song.coverArt ?? song.albumId, 512),
    };
  }

  /**
   * The native player took the boundary by itself, and this is the queue catching up (v1.9.8).
   *
   * Three things make this a different kind of method from `advance`:
   *
   *   - **it is an adoption, not a start.** The track is already playing — the native side played
   *     the slot the app had armed for it — so nothing here asks the engine to load, adopt or play
   *     anything. The cursor moves to the track that is *sounding*, and the engine is told which
   *     request it is now the audible one.
   *   - **it is idempotent on the track.** The same message can arrive two ways (a message that
   *     was waiting for the web view, and the foreground reconciliation that reads the player's own
   *     record), and it can arrive after the ordinary JS advance has already moved there. In both
   *     cases the answer is the same: the cursor is already on it, so there is nothing to move —
   *     only the statement to re-send.
   *   - **a track this queue does not hold is ignored**, not guessed at: a chain armed before the
   *     queue was replaced can name a song that is not in this list any more, and moving the cursor
   *     to it would be inventing one.
   */
  async adoptNativeAdvance(songId: string, index = -1, positionMs?: number): Promise<void> {
    /*
     * **By index first (v1.9.9), and by id only as a fallback.**
     *
     * The native side now walks the queue the app published, so it can say *where* it moved to as
     * well as what it moved to — and a position in the published order is the only thing that is
     * right when that order is shuffled. The id lookup this used to rely on alone was the hole:
     * with shuffle on, the track's position in the list is not its position in the order, and the
     * old lookup took the *item* index and then asked the order for it — which is correct but only
     * checks the track, never that the two sides agree on where they are.
     */
    let at = -1;
    if (index >= 0 && index < this.order.length && this.items[this.order[index]!]?.song.id === songId) {
      at = index;
    } else {
      const itemIndex = this.items.findIndex((item) => item.song.id === songId);
      at = itemIndex === -1 ? -1 : this.order.indexOf(itemIndex);
    }
    if (at === -1) return;
    if (this.currentSong?.id === songId) {
      this.loading = false;
      /*
       * **The entry is already the visible one, and the reading still has to be rendered
       * (unreleased).** This branch used to clear `loading` and nothing else — the *engine's* machine
       * was left where the return's own start had put it, on `loading`, because that start never
       * committed and no release ever came. That is the owner's spinner: the song on the label, the
       * queue making the sound, and a row that says it is still waiting. A reading that names a
       * position is the answer, and it is rendered.
       */
      if (typeof positionMs === 'number' && Number.isFinite(positionMs) && positionMs >= 0) {
        this.engine.renderReading(positionMs);
      }
      this.pendingStartMs = 0;
      this.publishQueue();
      return;
    }
    this.cursor = at;
    this.pendingStartMs = 0;
    this.loading = false;
    this.startFailed = false;
    this.playedMs = 0;
    this.submitted = false;
    this.inFlightSongId = null;
    this.playToken += 1;
    const song = this.items[this.order[at]!]!.song;
    const artworkUrl = this.library.coverUrl(song.coverArt ?? song.albumId, 512);
    this.onChanged?.();
    await this.engine.nativeMovedTo(this.trackRequest(song, artworkUrl), positionMs);
    this.reportNowPlaying(song);
    this.setupMediaSession(song, artworkUrl);
    this.scheduleSaveQueue();
    this.persistSnapshot(true);
    this.onChanged?.();
    this.publishQueue();
  }

  private reportNowPlaying(song: Song): void {
    void this.library.client.scrobble(song.id, false).catch((error: unknown) => {
      console.warn('[navilite] now-playing report failed', error);
    });
  }

  private trackProgress(positionMs: number, durationMs: number): void {
    const song = this.currentSong;
    if (!song) return;
    const delta = positionMs - this.lastPositionMs;
    // Ignore seeks (a large jump) rather than counting them as listening.
    if (delta > 0 && delta < 3000) this.playedMs += delta;
    this.lastPositionMs = positionMs;
    updatePositionState(durationMs || (song.duration ?? 0) * 1000, positionMs);
    // The exact-resume snapshot rides on the position stream, throttled: see `persistSnapshot`.
    this.persistSnapshot();

    const threshold = playThresholdMs((song.duration ?? 0) * 1000);
    if (!this.submitted && this.playedMs >= threshold) {
      this.submitted = true;
      if (!this.submittedIds.has(song.id)) {
        this.submittedIds.add(song.id);
        void this.library.client.scrobble(song.id, true).catch((error: unknown) => {
          console.warn('[navilite] play submission failed', error);
        });
      }
    }
  }

  private setupMediaSession(song: Song, artworkUrl: string | null): void {
    if (!mediaSessionAvailable()) return;
    updateNowPlaying(
      {
        title: song.title,
        artist: song.artist ?? 'Unknown artist',
        album: song.album ?? '',
        artworkUrl,
      },
      {
        play: () => void this.engine.resume(),
        pause: () => void this.engine.pause(),
        next: () => void this.next(),
        previous: () => void this.previous(),
        seekTo: (positionMs) => void this.seek(positionMs),
      },
    );
    updatePlaybackState('playing');
  }

  /**
   * Write the whole session — queue, play order, cursor, position, flags — to the device, so a
   * relaunch lands on the same second of the same track. Throttled, and forced on the changes that
   * matter (a new track, a seek) and on the way into the background (`flushSnapshot`).
   *
   * v1.6's rule holds here: this only ever *reads* the queue's state. It cannot move the queue, and
   * a snapshot that fails to parse is thrown away rather than half-restored (`parseSnapshot`).
   */
  private persistSnapshot(force = false): void {
    const song = this.currentSong;
    if (!song) return;
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    const status = this.engine.status();
    this.lastSnapshotAt = now;
    saveSnapshot({
      savedAt: now,
      songId: song.id,
      positionMs: Math.max(0, Math.round(status.positionMs)),
      playing: status.state === 'playing',
      ...this.resumeState(),
    });
  }

  /** Write the snapshot now, whatever the throttle says — the app is going into the background. */
  flushSnapshot(): void {
    this.persistSnapshot(true);
  }

  /** Push the queue to the server so it survives a restart. Debounced. */
  private scheduleSaveQueue(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const current = this.currentSong;
      if (!current) return;
      void this.library.client
        .savePlayQueue(
          this.items.map((item) => item.song.id),
          current.id,
          this.engine.status().positionMs,
        )
        .catch((error: unknown) => {
          console.warn('[navilite] savePlayQueue failed', error);
        });
    }, SAVE_QUEUE_DEBOUNCE_MS);
  }
}
