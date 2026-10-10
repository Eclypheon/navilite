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
 */
import type { Song, QueueContext, QueueItem } from '../api/types.ts';
import type { AudioEngine, TrackRequest } from '../player/engine.ts';
import { updateNowPlaying, updatePlaybackState, updatePositionState, mediaSessionAvailable } from '../player/mediasession.ts';
import type { Library } from './library.ts';

const SAVE_QUEUE_DEBOUNCE_MS = 5000;
const PLAY_THRESHOLD_MS = 240000; // Subsonic: half the song, or four minutes

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

export class PlaybackQueue {
  private items: QueueItem[] = [];
  private index = -1;
  private context: QueueContext | null = null;
  private playedMs = 0;
  private submitted = false;
  private submittedIds = new Set<string>();
  private lastPositionMs = 0;
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
  }

  get current(): QueueItem | null {
    return this.items[this.index] ?? null;
  }

  get currentSong(): Song | null {
    return this.current?.song ?? null;
  }

  get length(): number {
    return this.items.length;
  }

  get position(): number {
    return this.index;
  }

  get queueContext(): QueueContext | null {
    return this.context;
  }

  /** Replace the queue and start playing at `startIndex`. */
  async play(items: QueueItem[], startIndex = 0, context: QueueContext | null = null): Promise<void> {
    this.items = items;
    this.index = Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1));
    this.context = context ?? items[this.index]?.context ?? null;
    this.onChanged?.();
    await this.startCurrent();
  }

  /** Append without interrupting playback. */
  enqueue(items: QueueItem[]): void {
    this.items = [...this.items, ...items];
    this.onChanged?.();
    this.scheduleSaveQueue();
  }

  async toggle(): Promise<void> {
    if (!this.current) return;
    await this.engine.toggle();
  }

  async next(): Promise<void> {
    await this.advance(true);
  }

  async previous(): Promise<void> {
    // Under three seconds in, "previous" means the previous track; after that it is
    // the usual restart-this-one behaviour.
    const position = this.engine.status().positionMs;
    if (position > 3000 || this.index <= 0) {
      await this.engine.seek(0);
      if (position <= 3000) return;
    }
    this.index = Math.max(0, this.index - 1);
    await this.startCurrent();
  }

  async seek(positionMs: number): Promise<void> {
    await this.engine.seek(positionMs);
    this.lastPositionMs = positionMs;
  }

  async clear(): Promise<void> {
    this.items = [];
    this.index = -1;
    this.context = null;
    await this.engine.stop();
    this.onChanged?.();
  }

  queueSnapshot(): QueueItem[] {
    return this.items;
  }

  private async advance(auto: boolean): Promise<void> {
    if (this.items.length === 0) return;
    if (this.index >= this.items.length - 1) {
      if (auto) {
        await this.engine.pause();
        return;
      }
      this.index = 0;
    } else {
      this.index += 1;
    }
    await this.startCurrent();
  }

  private async startCurrent(): Promise<void> {
    const item = this.current;
    if (!item) return;
    const song = item.song;
    this.playedMs = 0;
    this.submitted = false;
    this.lastPositionMs = 0;
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
    await this.engine.play(request);
    if (token !== this.playToken) return;
    this.reportNowPlaying(song);
    this.setupMediaSession(song, artworkUrl);
    this.scheduleSaveQueue();
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
