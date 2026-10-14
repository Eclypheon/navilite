/**
 * The offline download store: the in-memory index, the per-playlist records, the §5 state machine
 * and the synchronous resolver the audible path reads.
 *
 * Two rules from the design bound this file:
 *
 *   - **It never builds a URL.** The stream URL is `Library.streamUrl`'s alone; the download URL
 *     (`download?id=`) is handed in as a factory. This file relays URLs, it does not mint them.
 *   - **It never touches playback.** It imports neither `state/queue.ts`, `player/engine.ts` nor
 *     `player/native.ts` — only the mirror and the downloads bridge. Invariant 7 is an executable
 *     claim here (see `test/offline-store.test.ts`'s dependency check).
 *
 * The native `index.json` is the truth about what is on disk; this store's `rows` map is its
 * in-memory copy, hydrated once at boot and updated by `done`/`failed` events. The mirror in
 * `storage/offline.ts` is a cache of that map, written after every change, so a relaunch resolves
 * local on the first start without waiting for `list()`.
 */
import { fromSidecar, type LyricsDoc } from '../api/lyrics.ts';
import { clearMirror, loadMirror, saveMirror, type MirrorStore, mirrorStore } from '../storage/offline.ts';
import type { Song } from '../api/types.ts';

export type DownloadState = 'complete' | 'staging' | 'failed';

/** The lyrics axis, independent of the audio axis (§"Offline lyrics"): per song. */
export type LyricsState = 'pending' | 'present' | 'none' | 'failed';

/** The durable lyrics row, held beside the audio row. Never the text — only state and bytes. */
export interface LyricsRow {
  state: LyricsState;
  /** The file name under the offline root, e.g. `abc123.lyrics`. */
  file?: string;
  /** The measured body bytes when `present`, else 0. */
  bytes: number;
  /** When the row was last written — the `none` staleness window reads this. */
  fetchedAt?: number;
}

/** One row of the native index, as `list()` reports it. */
export interface IndexRow {
  songId: string;
  path: string;
  suffix: string;
  bytes: number;
  state: DownloadState;
  downloadedAt?: number;
  refs: string[];
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  /** The lyrics axis; absent = never asked. */
  lyrics?: LyricsRow;
}

export interface DownloadJob {
  songId: string;
  url: string;
  suffix: string;
  bytes: number;
  /** Playlist ids that asked for this song — the index row's `refs`. */
  refs: string[];
  title: string;
  artist: string;
  album: string;
  durationSec: number;
}

export interface DownloadEvent {
  songId: string;
  /** `lyrics` for a lyrics transfer; the audio axis is the default. */
  kind?: 'audio' | 'lyrics';
  path?: string;
  bytes?: number;
  total?: number;
  error?: string;
}

/** The native side of a download: transfer, staging write, atomic move, byte verification. */
export interface DownloadsBridge {
  configure(options: { allowsCellular: boolean; maxConcurrent: number }): Promise<void>;
  enqueue(job: DownloadJob): Promise<void>;
  cancel(songId: string): Promise<void>;
  remove(songId: string): Promise<void>;
  list(): Promise<IndexRow[]>;
  /** Free bytes on the volume, or -1 when the platform cannot answer. */
  freeBytes(): Promise<number>;
  /** Read the stored lyric body for a song, or null when there is none / it cannot be read. */
  readLyrics(songId: string): Promise<string | null>;
  /** Write a lyric body straight to the durable copy (the `getLyrics` fallback — no URL to enqueue). */
  writeLyrics(songId: string, text: string): Promise<void>;
  addListener(eventName: 'progress' | 'done' | 'failed', listener: (event: DownloadEvent) => void): Promise<() => void>;
}

export type PlaylistDownloadState = 'idle' | 'estimating' | 'downloading' | 'complete' | 'partial' | 'failed';

export interface PlaylistRecord {
  state: PlaylistDownloadState;
  /** How many of `songs` are complete. */
  done: number;
  total: number;
  /** The size the control promises, in bytes (§4). */
  bytes: number;
  /** True when every entry carried a `size`, so the figure is the real one. */
  exact: boolean;
  songs: Song[];
}

export interface SizeEstimate {
  total: number;
  exact: boolean;
}

/**
 * What the durable copy can say for a track's lyrics, answered synchronously in the service's
 * step ②. `present` carries the parsed doc (read from disk, no network); `none-fresh` says
 * "asked, nothing there, recently" and the caller shows the empty state with no request; `miss`
 * says "nothing to say" and the caller falls through to today's network sources.
 */
export type LyricsResolution = { kind: 'present'; doc: LyricsDoc } | { kind: 'none-fresh' } | { kind: 'miss' };

/** 320 kbit/s — an upper bound for the originals, so the fallback never under-promises. */
const FALLBACK_BYTES_PER_SECOND = 40_000;
const FALLBACK_FLOOR_BYTES = 1_000_000;
/**
 * 12 KB per unresolved track, an upper bound for the lyric body (a timed `.lrc` line is ~30–60
 * bytes; 200 lines of dense singing is ≈12 KB). Only the constant moves if the library ever
 * exceeds it; the rule does not.
 */
export const LYRICS_ASSUMED_BYTES = 12 * 1024;
/** How long a `none` row stays fresh before a network-reachable reconcile re-asks it. */
export const LYRICS_MISS_TTL_MS = 5 * 60 * 1000;
/** §5: leave this much headroom over the estimate before a download is allowed to start. */
const FREE_SPACE_MARGIN = 250 * 1024 * 1024;
const MAX_CONCURRENT = 3;

/**
 * §4 — the size a playlist will take, summed over its entries, plus the lyric bodies.
 *
 * Exact (byte-equal to the sum of `Content-Length`, because the files come from `download?id=` —
 * original, untranscoded, exact length) when every entry carries a `size` **and** every lyric is
 * already resolved (`present` or `none`); otherwise the figure is an over-estimate, prefixed
 * `up to` by the UI — a missing audio size is bounded above by 320 kbit/s and an unresolved lyric
 * by `LYRICS_ASSUMED_BYTES`, so the number is a ceiling, never an under-promise.
 */
export function estimateBytes(
  songs: Array<Pick<Song, 'id' | 'size' | 'duration'>>,
  rows?: ReadonlyMap<string, IndexRow>,
): SizeEstimate {
  let total = 0;
  let exact = true;
  for (const song of songs) {
    if (typeof song.size === 'number' && song.size > 0) {
      total += song.size;
    } else {
      exact = false;
      total += Math.max(FALLBACK_FLOOR_BYTES, Math.round((song.duration ?? 0) * FALLBACK_BYTES_PER_SECOND));
    }
  }
  let lyrics = 0;
  let lyricsExact = true;
  for (const song of songs) {
    const row = rows?.get(song.id)?.lyrics;
    if (row?.state === 'present') lyrics += row.bytes;
    else if (row?.state === 'none') {
      // Asked, nothing there: zero, and it does not make the figure inexact.
    } else {
      lyrics += LYRICS_ASSUMED_BYTES;
      lyricsExact = false;
    }
  }
  return { total: total + lyrics, exact: exact && lyricsExact };
}

/** "312 MB", "1.2 GB", "0 B" — the same shape the settings line and the control use. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * §5 resume rule, the half that is pure: a `staging` row whose written bytes equal the expected
 * `Content-Length` is promoted to `complete` (the bytes arrived, only the callback was lost);
 * otherwise it is `partial` and re-fetched. "Correct or re-fetch", never "trust a partial".
 */
export function reconcileStaging(actualBytes: number, expectedBytes: number): 'complete' | 'partial' {
  return expectedBytes > 0 && actualBytes === expectedBytes ? 'complete' : 'partial';
}

export type DownloadResult = { kind: 'started' } | { kind: 'no-space'; free: number; needed: number };

export class OfflineStore {
  private readonly rows = new Map<string, IndexRow>();
  private readonly playlists = new Map<string, PlaylistRecord>();
  private readonly bridge: DownloadsBridge | null;
  private readonly store: MirrorStore;
  private readonly downloadUrl: (song: Song) => string;
  private readonly lyricsUrl: (song: Song) => string | null;
  private readonly lyricsFallback: (song: Song) => Promise<string | null>;
  private readonly unlisteners: Array<() => void> = [];
  private listening = false;

  /** Fired whenever the index or a playlist record changes, so the UI can redraw the control. */
  onChange: (() => void) | null = null;

  constructor(
    bridge: DownloadsBridge | null,
    options: {
      downloadUrl?: (song: Song) => string;
      /** The sidecar route URL for a track, or null when there is none to enqueue. */
      lyricsUrl?: (song: Song) => string | null;
      /** The `getLyrics` fallback body for a track (route has no URL), or null → `none`. */
      lyricsFallback?: (song: Song) => Promise<string | null>;
      store?: MirrorStore;
    } = {},
  ) {
    this.bridge = bridge;
    this.store = options.store ?? mirrorStore();
    this.downloadUrl = options.downloadUrl ?? ((song) => `download?id=${song.id}`);
    this.lyricsUrl = options.lyricsUrl ?? (() => null);
    this.lyricsFallback = options.lyricsFallback ?? (async () => null);
    // Seed the in-memory map from the mirror synchronously, so the resolver answers local on the
    // very first start of a session — before `hydrate()` has had a chance to talk to the plugin.
    const mirror = loadMirror(this.store);
    if (mirror) {
      for (const [songId, row] of Object.entries(mirror.rows)) {
        this.rows.set(songId, {
          songId,
          path: row.path,
          suffix: 'mp3',
          bytes: row.bytes,
          state: row.state,
          refs: [],
          title: '',
          artist: '',
          album: '',
          durationSec: 0,
          lyrics: row.lyrics ? { state: row.lyrics.state, bytes: row.lyrics.bytes } : undefined,
        });
      }
    }
  }

  /** The synchronous resolver: a `file://` path when the index holds a complete row, else null. */
  pathFor(songId: string): string | null {
    const row = this.rows.get(songId);
    return row !== undefined && row.state === 'complete' ? row.path : null;
  }

  /** The durable lyrics row for a song, synchronously from the in-memory index. */
  lyricsState(songId: string): LyricsRow | null {
    return this.rows.get(songId)?.lyrics ?? null;
  }

  /**
   * Step ② of the lyrics service: the durable copy. `present` → the body read off disk and parsed
   * by the same `fromSidecar` the route's bytes go through; `none-fresh` → asked-and-absent inside
   * `LYRICS_MISS_TTL_MS`, so nothing is re-asked; anything else → `miss`, and the caller falls
   * through to the network. A `present` row whose file is gone returns `miss` rather than throwing
   * or serving a stale doc (§"Offline lyrics" recovery).
   */
  async lyricsDoc(songId: string): Promise<LyricsResolution> {
    const lyric = this.rows.get(songId)?.lyrics;
    if (lyric?.state === 'present' && this.bridge) {
      try {
        const body = await this.bridge.readLyrics(songId);
        if (body !== null && body !== '') {
          const doc = fromSidecar(body);
          if (doc) return { kind: 'present', doc };
        }
      } catch {
        // A read that failed is the same as a file that is gone: fall through to the network.
      }
    } else if (lyric?.state === 'none' && lyric.fetchedAt !== undefined && Date.now() - lyric.fetchedAt < LYRICS_MISS_TTL_MS) {
      return { kind: 'none-fresh' };
    }
    return { kind: 'miss' };
  }

  /** §4 with the lyric axis: the size a playlist will take, using the store's in-memory rows. */
  estimate(songs: Song[]): SizeEstimate {
    return estimateBytes(songs, this.rows);
  }

  /** The record the download control renders from, or null for a playlist never downloaded. */
  record(playlistId: string): PlaylistRecord | null {
    return this.playlists.get(playlistId) ?? null;
  }

  totalBytes(): number {
    let total = 0;
    for (const row of this.rows.values()) if (row.state === 'complete') total += row.bytes;
    return total;
  }

  totalTracks(): number {
    let tracks = 0;
    for (const row of this.rows.values()) if (row.state === 'complete') tracks += 1;
    return tracks;
  }

  /**
   * Boot and on-visible reconcile: `list()` is the truth. Rebuild the index and the mirror from it,
   * and reconstruct each playlist record from the rows that still reference it.
   */
  async hydrate(): Promise<void> {
    const mirror = loadMirror(this.store);
    if (this.bridge) {
      try {
        const rows = await this.bridge.list();
        this.rows.clear();
        for (const row of rows) this.rows.set(row.songId, row);
      } catch (error) {
        console.warn('[navilite] could not reconcile the offline index', error);
      }
    }
    /*
     * The mirror is the fallback, not the truth: when `list()` came back empty (no plugin, or the
     * native side has nothing yet) but the mirror has rows from a previous session, those rows still
     * name complete files the resolver may trust. They are dropped again on the next real reconcile.
     */
    if (this.rows.size === 0 && mirror) {
      for (const [songId, row] of Object.entries(mirror.rows)) {
        this.rows.set(songId, {
          songId,
          path: row.path,
          suffix: 'mp3',
          bytes: row.bytes,
          state: row.state,
          refs: [],
          title: '',
          artist: '',
          album: '',
          durationSec: 0,
          lyrics: row.lyrics ? { state: row.lyrics.state, bytes: row.lyrics.bytes } : undefined,
        });
      }
    }
    // Playlist records survive a kill: they are rebuilt from the refs each row carries. A playlist
    // whose songs were all removed, or whose refs all aged out, simply has no record any more.
    this.rebuildPlaylists();
    this.saveMirror();
    this.onChange?.();
  }

  /**
   * §5 `idle → estimating → downloading`. Free-space guard first; then the songs that are not
   * already complete are enqueued, with the playlist id added to their refs.
   */
  async download(playlistId: string, songs: Song[], options: { allowsCellular?: boolean } = {}): Promise<DownloadResult> {
    if (!this.bridge) return { kind: 'started' };
    this.ensureListening();
    const estimate = this.estimate(songs);
    const doneInitially = songs.filter((song) => this.rows.get(song.id)?.state === 'complete').length;
    const record: PlaylistRecord = {
      state: 'estimating',
      done: doneInitially,
      total: songs.length,
      bytes: estimate.total,
      exact: estimate.exact,
      songs,
    };
    this.playlists.set(playlistId, record);
    this.onChange?.();

    const free = await this.bridge.freeBytes();
    if (free >= 0 && free < estimate.total + FREE_SPACE_MARGIN) {
      record.state = 'idle';
      this.onChange?.();
      return { kind: 'no-space', free, needed: estimate.total + FREE_SPACE_MARGIN };
    }

    await this.bridge.configure({ allowsCellular: options.allowsCellular === true, maxConcurrent: MAX_CONCURRENT });
    record.state = 'downloading';
    for (const song of songs) {
      const existing = this.rows.get(song.id);
      if (existing?.state === 'complete') {
        // Already on disk: add this playlist's ref (S9/S10 — a shared track must survive one
        // playlist's removal) and fetch no audio.
        if (!existing.refs.includes(playlistId)) existing.refs.push(playlistId);
      } else {
        this.addRef(song.id, playlistId, song);
        await this.bridge.enqueue({
          songId: song.id,
          url: this.downloadUrl(song),
          suffix: song.suffix ?? 'mp3',
          bytes: song.size ?? 0,
          refs: this.rows.get(song.id)?.refs ?? [playlistId],
          title: song.title,
          artist: song.artist ?? '',
          album: song.album ?? '',
          durationSec: song.duration ?? 0,
        });
      }
      // The long pole (audio) is enqueued first; the lyric rides its own transfer, second.
      await this.enqueueLyrics(song);
    }
    this.reconcileRecord(playlistId);
    this.onChange?.();
    return { kind: 'started' };
  }

  /** Cancel a running download; tracks already complete are kept (§4). */
  async cancel(playlistId: string): Promise<void> {
    const record = this.playlists.get(playlistId);
    if (!record || !this.bridge) return;
    for (const song of record.songs) {
      if (this.rows.get(song.id)?.state === 'complete') continue;
      await this.bridge.cancel(song.id);
      this.dropRef(song.id, playlistId);
    }
    record.state = record.done > 0 ? 'partial' : 'failed';
    this.saveMirror();
    this.onChange?.();
  }

  /** §S9/S10: drop this playlist's refs; delete a file only when it has no refs left. */
  async remove(playlistId: string): Promise<void> {
    const record = this.playlists.get(playlistId);
    if (!record) return;
    for (const song of record.songs) await this.dropRef(song.id, playlistId);
    this.playlists.delete(playlistId);
    this.saveMirror();
    this.onChange?.();
  }

  /** §S11: explicit global eviction — remove every download. */
  async removeAll(): Promise<void> {
    if (!this.bridge) return;
    const songIds = [...this.rows.keys()];
    for (const songId of songIds) await this.bridge.remove(songId);
    this.rows.clear();
    this.playlists.clear();
    clearMirror(this.store);
    this.onChange?.();
  }

  dispose(): void {
    for (const remove of this.unlisteners) {
      try {
        remove();
      } catch {
        // Nothing to do.
      }
    }
    this.unlisteners.length = 0;
    this.listening = false;
  }

  /* --------------------------------------------------------------- internals */

  private ensureListening(): void {
    if (this.listening || !this.bridge) return;
    this.listening = true;
    void this.bridge.addListener('done', (event) => this.onDone(event)).then((remove) => this.unlisteners.push(remove));
    void this.bridge.addListener('failed', (event) => this.onFailed(event)).then((remove) => this.unlisteners.push(remove));
    void this.bridge.addListener('progress', () => undefined).then((remove) => this.unlisteners.push(remove));
  }

  private onDone(event: DownloadEvent): void {
    const row = this.rows.get(event.songId);
    if (!row) return;
    if (event.kind === 'lyrics') {
      row.lyrics = { state: 'present', file: `${event.songId}.lyrics`, bytes: typeof event.bytes === 'number' ? event.bytes : 0, fetchedAt: Date.now() };
    } else {
      row.state = 'complete';
      row.path = event.path ?? row.path;
      row.bytes = typeof event.bytes === 'number' ? event.bytes : row.bytes;
      row.downloadedAt = Date.now();
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.onChange?.();
  }

  private onFailed(event: DownloadEvent): void {
    const row = this.rows.get(event.songId);
    if (!row) return;
    if (event.kind === 'lyrics') {
      row.lyrics = { state: 'failed', bytes: 0, fetchedAt: Date.now() };
    } else {
      row.state = 'failed';
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.onChange?.();
  }

  /**
   * Enqueue a track's lyric transfer in the audio's own lane. The normal path is the sidecar
   * route URL; a track the route has no URL for falls back to the injected `getLyrics` body, stored
   * raw behind the caller's `sameSong` guard. Both empty → `none`, a recorded miss.
   */
  private async enqueueLyrics(song: Song): Promise<void> {
    if (!this.bridge) return;
    const row = this.rows.get(song.id);
    if (!row) return;
    const lyric = row.lyrics;
    if (lyric?.state === 'present' || lyric?.state === 'none') return; // already resolved
    const url = this.lyricsUrl(song);
    if (url !== null && url !== '') {
      row.lyrics = { state: 'pending', bytes: 0 };
      await this.bridge.enqueue({
        songId: song.id,
        url,
        suffix: 'lyrics',
        bytes: 0,
        refs: row.refs,
        title: song.title,
        artist: song.artist ?? '',
        album: song.album ?? '',
        durationSec: song.duration ?? 0,
      });
      return;
    }
    try {
      const body = await this.lyricsFallback(song);
      if (body !== null && body !== '') {
        await this.bridge.writeLyrics(song.id, body);
        row.lyrics = { state: 'present', file: `${song.id}.lyrics`, bytes: body.length, fetchedAt: Date.now() };
      } else {
        row.lyrics = { state: 'none', bytes: 0, fetchedAt: Date.now() };
      }
    } catch {
      row.lyrics = { state: 'none', bytes: 0, fetchedAt: Date.now() };
    }
  }

  private addRef(songId: string, playlistId: string, song: Song): void {
    const existing = this.rows.get(songId);
    if (existing) {
      if (!existing.refs.includes(playlistId)) existing.refs.push(playlistId);
      existing.state = 'staging';
      return;
    }
    this.rows.set(songId, {
      songId,
      path: '',
      suffix: song.suffix ?? 'mp3',
      bytes: 0,
      state: 'staging',
      refs: [playlistId],
      title: song.title,
      artist: song.artist ?? '',
      album: song.album ?? '',
      durationSec: song.duration ?? 0,
    });
  }

  private async dropRef(songId: string, playlistId: string): Promise<void> {
    const row = this.rows.get(songId);
    if (!row) return;
    row.refs = row.refs.filter((id) => id !== playlistId);
    if (row.refs.length === 0) {
      this.rows.delete(songId);
      if (this.bridge) {
        try {
          await this.bridge.remove(songId);
        } catch {
          // The file is already gone, or the bridge refused — the index row is dropped regardless.
        }
      }
    }
  }

  /** Recompute `done`/state for a playlist record from the rows that reference it. */
  private reconcileRecord(playlistId: string): void {
    const record = this.playlists.get(playlistId);
    if (!record) return;
    let done = 0;
    let staging = 0;
    let lyricPending = 0;
    let lyricFailed = 0;
    for (const song of record.songs) {
      const row = this.rows.get(song.id);
      const state = row?.state;
      if (state === 'complete') done += 1;
      else if (state === 'staging') staging += 1;
      const lyric = row?.lyrics?.state;
      if (lyric === 'pending') lyricPending += 1;
      else if (lyric === 'failed') lyricFailed += 1;
    }
    record.done = done;
    if (done === record.total && record.total > 0) {
      // Audio all in; the playlist is complete only when every lyric axis is present or none.
      if (lyricPending > 0) record.state = 'downloading';
      else if (lyricFailed > 0) record.state = 'partial'; // one small transfer to retry
      else record.state = 'complete';
    } else if (staging > 0) {
      record.state = 'downloading';
    } else {
      record.state = done > 0 ? 'partial' : 'failed';
    }
  }

  /** Rebuild playlist records from the refs the native rows carry (boot reconcile). */
  private rebuildPlaylists(): void {
    this.playlists.clear();
    const byPlaylist = new Map<string, IndexRow[]>();
    for (const row of this.rows.values()) {
      for (const playlistId of row.refs) {
        const list = byPlaylist.get(playlistId) ?? [];
        list.push(row);
        byPlaylist.set(playlistId, list);
      }
    }
    for (const [playlistId, rows] of byPlaylist) {
      const done = rows.filter((row) => row.state === 'complete').length;
      const lyricPending = rows.some((row) => row.lyrics?.state === 'pending');
      const lyricFailed = rows.some((row) => row.lyrics?.state === 'failed');
      let state: PlaylistDownloadState;
      if (done === rows.length && rows.length > 0) {
        state = lyricPending ? 'downloading' : lyricFailed ? 'partial' : 'complete';
      } else {
        state = done > 0 ? 'partial' : 'failed';
      }
      this.playlists.set(playlistId, {
        state,
        done,
        total: rows.length,
        bytes: rows.reduce((total, row) => total + row.bytes, 0),
        exact: true,
        songs: rows.map((row) => ({
          id: row.songId,
          title: row.title,
          artist: row.artist,
          album: row.album,
          duration: row.durationSec,
          suffix: row.suffix,
          size: row.bytes,
        })),
      });
    }
  }

  private saveMirror(): void {
    const rows: Record<string, { path: string; bytes: number; state: DownloadState; lyrics?: { state: LyricsState; bytes: number } }> = {};
    for (const [songId, row] of this.rows) {
      rows[songId] = {
        path: row.path,
        bytes: row.bytes,
        state: row.state,
        lyrics: row.lyrics ? { state: row.lyrics.state, bytes: row.lyrics.bytes } : undefined,
      };
    }
    saveMirror({ v: 1, hydratedAt: Date.now(), rows }, this.store);
  }
}
