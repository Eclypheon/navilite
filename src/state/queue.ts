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
import type { AudioEngine, TrackRequest } from '../player/engine.ts';
import { updateNowPlaying, updatePlaybackState, updatePositionState, mediaSessionAvailable } from '../player/mediasession.ts';
import { clearSnapshot, saveSnapshot } from '../storage/session.ts';
import { ByteRate } from './bitrate.ts';
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
   * v1.9.1: the track after the current one, and the **exact URL** it was prepared under.
   *
   * This is the queue's look-ahead, and its one invariant is that `prepared.songId` is the song at
   * `order[cursor + 1]` — anything else is discarded rather than left buffering. The URL is bound
   * here at prepare time and used again, unchanged, as the play request's URL: the transcode key
   * (`maxBitRate`) is part of the string, and v1.9.0 built it twice — once for the prefetch and once
   * at the boundary, from a rate that had *changed* in between — so Navidrome was asked to transcode
   * the same file twice, the second time from scratch, at the moment the listener was waiting for
   * sound.
   */
  private prepared: { songId: string; url: string } | null = null;
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

  constructor(engine: AudioEngine, library: Library) {
    this.engine = engine;
    this.library = library;
    engine.onEnded = () => void this.advance(true);
    engine.onProgress = (positionMs, durationMs) => this.trackProgress(positionMs, durationMs);
    // The lock screen's next/previous (v1.7): the platform delivers them, the queue acts on them.
    engine.onNextRequested = () => void this.next();
    engine.onPreviousRequested = () => void this.previous();
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
     * v1.9.2 — there is no WebView probe to cancel any more (the prefetch is deleted), so all this
     * has to do is make sure nothing is left buffering for where the listener *was*: that is the
     * prepared slot, handled below.
     */
    /*
     * And the prepared slot follows the same rule (v1.9.1) — with one exception that matters.
     *
     * A prepared track that is neither the track he touched nor the track that now follows it is
     * buffering something nobody is going to hear: on his link that is a second download competing
     * with the very stream he is waiting for, so it is thrown away. When it *is* one of those two,
     * it is kept — and that is the case the exception exists for: he taps the row that was already
     * being got ready, so there is nothing to fetch at all and the track starts in a seek's time.
     */
    const touched = this.currentSong?.id ?? null;
    const follows = this.nextSongId();
    if (this.prepared && this.prepared.songId !== touched && this.prepared.songId !== follows) this.cancelPrepared();
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
   * The bitrate the next stream will ask for: `null` = the original file, a number = Navidrome
   * transcodes to it. The player bar shows the number while a cap is in force, so a cap is never
   * silent (v1.9.0).
   */
  get streamKbps(): number | null {
    return this.rate.maxBitRate;
  }

  /**
   * Put a queue back without starting it — used at launch to restore the queue the server
   * saved, so the app can open on the spectrum screen showing what was playing.
   */
  restore(items: QueueItem[], startIndex: number, positionMs = 0, context: QueueContext | null = null): void {
    this.items = items;
    this.order = identityOrder(items.length);
    this.cursor = Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1));
    this.context = context;
    this.pendingStartMs = Math.max(0, positionMs);
    this.onChanged?.();
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
    // Under three seconds in, "previous" means the previous track; after that it is
    // the usual restart-this-one behaviour.
    const position = this.engine.status().positionMs;
    if (position > 3000 || this.cursor <= 0) {
      await this.engine.seek(0);
      if (position <= 3000) return;
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
    this.onChanged?.();
    await this.startCurrent();
  }

  async seek(positionMs: number): Promise<void> {
    await this.engine.seek(positionMs);
    this.lastPositionMs = positionMs;
    // A seek is the one position change worth writing immediately: it is the difference between
    // coming back at the right second and coming back where the listener left off.
    this.persistSnapshot(true);
  }

  /** Shuffle on/off. Turning it on keeps the current track; turning it off keeps the order. */
  setShuffle(on: boolean): void {
    if (on === this.shuffled) return;
    this.shuffled = on;
    this.applyShuffle(on);
    this.onChanged?.();
  }

  setRepeat(mode: RepeatMode): void {
    if (mode === this.repeatMode) return;
    this.repeatMode = mode;
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
    this.cancelPrepared();
    clearSnapshot();
    await this.engine.stop();
    this.onChanged?.();
  }

  queueSnapshot(): QueueItem[] {
    return this.items;
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
    /*
     * **The URL the track was prepared under is the URL it is played with** (v1.9.1).
     *
     * Same string, so Navidrome is asked for the transcode it has already started rather than for a
     * second one at a rate the link measurement moved in the meantime — and so the asset that is
     * already buffered is the asset that becomes audible.
     */
    const preparedUrl = this.prepared?.songId === song.id ? this.prepared.url : null;
    if (preparedUrl !== null) this.prepared = null;
    const request = this.trackRequest(song, preparedUrl, artworkUrl);
    this.inFlightSongId = song.id;
    this.onChanged?.();
    /*
     * **The start, and — since v1.9.2 — how long it took, and what to do when it did not happen.**
     *
     * `engine.play` now resolves only when the player has reported sound (or the deadline has run
     * out), so this await is the whole of the wait the listener is in, and `startDidFail` is the
     * engine's honest answer to "did that work".
     *
     * A start that failed is retried **once**, one rung down the bitrate ladder: the same URL asking
     * the same question of a link that could not answer it is the same answer, and the smaller
     * stream is the one thing this app can actually change about his side of a relayed link. If the
     * retry fails too, the failure stands on screen (`didNotStart`) and one tap tries again.
     *
     * The time it took is the measurement the ladder is built on (v1.9.2) — and it is only measured
     * for a start that fetched: an adopted track was buffered while the previous one played, so its
     * "latency" says nothing about the link.
     */
    const startedAt = Date.now();
    await this.engine.play(request, startMs);
    let failed = this.engine.startDidFail?.() === true;
    if (!failed && preparedUrl === null) this.rate.noteStart(Date.now() - startedAt);
    if (failed && token === this.playToken) {
      this.rate.demote();
      const retry = this.trackRequest(song, null, artworkUrl);
      this.onChanged?.();
      await this.engine.play(retry, startMs);
      failed = this.engine.startDidFail?.() === true;
    }
    this.inFlightSongId = null;
    if (token !== this.playToken) return;
    /*
     * The engine has the stream — or has told us it does not. Either way the wait is over: the
     * loading state comes off with this same redraw, and the look-ahead starts here rather than
     * anywhere else, because "the next track" only means something once the current one is actually
     * the current one.
     */
    this.loading = false;
    this.startFailed = failed;
    if (failed) {
      /*
       * Nothing is playing, so nothing is reported as playing: no now-playing, no media session, no
       * play queue. What is left is the row and the chip saying so, and the tap that tries again.
       *
       * **And the look-ahead is re-armed here rather than left dead (v1.9.4).** This path used to
       * cancel the prepared slot and return *before* `prepareNext()` — so from the first start that
       * failed, the player held nothing the next boundary could adopt, and every later track paid a
       * full cold fetch on the one link where a cold fetch is the problem. That is the second half
       * of the owner's report: *"the first track that plays starts very quickly, but this behaviour
       * quickly stops"*. Nothing is claimed about the track that failed; the track after it is got
       * ready exactly as it is on the path where a start succeeded.
       */
      this.cancelPrepared();
      this.onChanged?.();
      this.prepareNext();
      return;
    }
    this.reportNowPlaying(song);
    this.setupMediaSession(song, artworkUrl);
    this.scheduleSaveQueue();
    // A new track, at a known position: the snapshot is written now rather than on the next tick.
    this.persistSnapshot(true);
    this.onChanged?.();
    this.prepareNext();
  }

  /**
   * One request, built from one place, so the retry differs only in the URL it asks for.
   *
   * `url` is the prepared slot's own URL when the track was already got ready, and otherwise the
   * URL the link's own measurement earns (`rate.maxBitRate`: `null` = the original file).
   */
  private trackRequest(song: Song, url: string | null, artworkUrl: string | null): TrackRequest {
    return {
      id: song.id,
      url: url ?? this.library.streamUrl(song, this.rate.maxBitRate),
      crossOrigin: this.library.crossOrigin,
      title: song.title,
      artist: song.artist ?? 'Unknown artist',
      album: song.album ?? '',
      artworkUrl,
      durationMs: (song.duration ?? 0) * 1000,
    };
  }

  /** The song after the one playing, in the play order — `null` at the end of the queue. */
  private nextSongId(): string | null {
    return this.items[this.order[this.cursor + 1]]?.song.id ?? null;
  }

  /**
   * Get the next track ready on the player, while this one plays (v1.9.1).
   *
   * The player is prepared: the track after this one is loaded by the plugin itself, under its own
   * asset id, in the player that is already running — buffered, silent, never played. At the track
   * boundary that asset is adopted, so the next track starts in a seek's time: this is what "the
   * whole previous track was available to prepare the next one" buys.
   *
   * v1.9.2 — **and the slot is a result, not a claim.** `engine.prepareNext` answers whether the
   * player actually took the track, and only then is there a prepared track as far as the queue is
   * concerned. It used to be recorded on the way *in*, before the call: a prepare that timed out, or
   * that was cancelled because the listener had moved on, left this side believing the next track
   * was buffered while the player held nothing — so the boundary adopted nothing, paid a cold fetch,
   * and (worse) `prepared` was never cleared, so the track was never prepared again either.
   *
   * Exactly one of these is ever in flight, it is for the item that follows the one the listener
   * actually chose, and it cannot move the queue: nothing here reads or writes `order`.
   */
  private prepareNext(): void {
    const next = this.items[this.order[this.cursor + 1]];
    if (!next) {
      this.cancelPrepared();
      return;
    }
    const url = this.library.streamUrl(next.song, this.rate.maxBitRate);
    // Already holding exactly this, under exactly this URL: preparing it twice is the same work.
    if (this.prepared?.songId === next.song.id && this.prepared.url === url) return;
    const songId = next.song.id;
    this.cancelPrepared();
    void this.engine
      .prepareNext({
        id: next.song.id,
        url,
        crossOrigin: this.library.crossOrigin,
        title: next.song.title,
        artist: next.song.artist ?? 'Unknown artist',
        album: next.song.album ?? '',
        artworkUrl: this.library.coverUrl(next.song.coverArt ?? next.song.albumId, 512),
        durationMs: (next.song.duration ?? 0) * 1000,
      })
      .then((settled) => {
        // A prepare that did not happen is not a prepared track — and the queue must not say it is.
        if (settled === false) return;
        // The listener may have moved while the player was taking it; then it is not "the next one".
        if (this.nextSongId() !== songId) return;
        this.prepared = { songId, url };
      })
      .catch((error: unknown) => {
        console.warn('[navilite] the next track could not be prepared on the player', error);
      });
  }

  private cancelPrepared(): void {
    this.prepared = null;
    void this.engine.discardPrepared?.();
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
