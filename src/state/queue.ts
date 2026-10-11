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
    this.items = items;
    this.order = identityOrder(items.length);
    this.cursor = Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1));
    this.context = context ?? this.current?.context ?? null;
    if (this.shuffled) this.applyShuffle(this.shuffled);
    this.pendingStartMs = 0;
    this.onChanged?.();
    await this.startCurrent();
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
    if (!this.current) return;
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
    this.cursor = Math.max(0, this.cursor - 1);
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
    this.cursor = plan.cursor;
    await this.startCurrent();
  }

  private async startCurrent(): Promise<void> {
    const item = this.current;
    if (!item) return;
    const song = item.song;
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
    const request: TrackRequest = {
      id: song.id,
      url: this.library.streamUrl(song),
      crossOrigin: this.library.crossOrigin,
      title: song.title,
      artist: song.artist ?? 'Unknown artist',
      album: song.album ?? '',
      artworkUrl,
      durationMs: (song.duration ?? 0) * 1000,
    };
    this.onChanged?.();
    await this.engine.play(request, startMs);
    if (token !== this.playToken) return;
    this.reportNowPlaying(song);
    this.setupMediaSession(song, artworkUrl);
    this.scheduleSaveQueue();
    // A new track, at a known position: the snapshot is written now rather than on the next tick.
    this.persistSnapshot(true);
    this.onChanged?.();
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
