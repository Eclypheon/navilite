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
import { fromSidecar, isRouteErrorBody, type LyricsDoc } from '../api/lyrics.ts';
import {
  clearMirror,
  loadMirror,
  saveMirror,
  type MirrorStore,
  type OfflineMirror,
  type OfflinePlaylistManifest,
  mirrorStore,
} from '../storage/offline.ts';
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
  /** The HTTP status when the response got that far — `404` on the lyrics route is "no sidecar". */
  status?: number;
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
  /** The manifest's length — the songs the download was *asked* for, never the completed row count. */
  total: number;
  /** The size the control promises, in bytes (§4). */
  bytes: number;
  /** True when every entry carried a `size`, so the figure is the real one. */
  exact: boolean;
  songs: Song[];
  /** When the download was requested; present on every record rebuilt from a manifest. */
  requestedAt?: number;
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
 *
 * The rule lives in `NaviliteDownloads.swift`'s boot reconcile, where the staging bytes are: JS
 * cannot promote a file (it never touches the filesystem), so a second copy of this arithmetic here
 * would only be a decoration. `test/download-lane.test.ts` asserts the native implementation reads
 * as this rule, which is the half that can be checked without a phone.
 */
export type DownloadResult = { kind: 'started' } | { kind: 'no-space'; free: number; needed: number };

export class OfflineStore {
  private readonly rows = new Map<string, IndexRow>();
  private readonly playlists = new Map<string, PlaylistRecord>();
  /** The durable half of each playlist record: what was asked for, and whether it is still wanted. */
  private readonly manifests = new Map<string, OfflinePlaylistManifest>();
  private readonly bridge: DownloadsBridge | null;
  private readonly store: MirrorStore;
  private readonly downloadUrl: (song: Song) => string;
  private readonly lyricsUrl: (song: Song) => string | null;
  private readonly lyricsFallback: (song: Song) => Promise<string | null>;
  private readonly unlisteners: Array<() => void> = [];
  private readonly changeListeners = new Set<() => void>();
  private listening = false;
  /** True once this process has done its boot reconcile; only that first pass may re-enqueue. */
  private bootReconciled = false;
  /**
   * The songs whose poisoned lyric row has already been re-fetched in this session (§3). A
   * re-fetch that finds nothing records `none`, so the store cannot ask twice on its own; this
   * guard is what stops one bad read after another from queueing the same fetch again.
   */
  private readonly lyricsRefetched = new Set<string>();

  /**
   * Subscribe to index/playlist changes, so the UI can redraw. Returns the unsubscribe — a
   * **list**, not one slot: the playlist page's control and the settings row are both live at once,
   * and whichever subscribed last used to silently replace the other.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Tell every subscriber something changed. One failing listener never blocks the others. */
  private notify(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // A redraw that throws is a UI bug, never a reason to stop telling the others.
      }
    }
  }

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
    if (mirror) this.seedRows(mirror.rows);
  }

  /** Copy mirror rows into the in-memory index, carrying the lyrics `fetchedAt` with them. */
  private seedRows(rows: OfflineMirror['rows']): void {
    for (const [songId, row] of Object.entries(rows)) {
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
        lyrics: row.lyrics
          ? { state: row.lyrics.state, bytes: row.lyrics.bytes, fetchedAt: row.lyrics.fetchedAt }
          : undefined,
      });
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
   *
   * The body is checked before it is served (§3): a row written by a build before v1.9.14 can hold
   * the lyrics route's **404 document**, which is not lyrics. Such a row is voided rather than
   * returned, and the track's lyric is re-fetched once.
   */
  async lyricsDoc(songId: string): Promise<LyricsResolution> {
    const lyric = this.rows.get(songId)?.lyrics;
    if (lyric?.state === 'present' && this.bridge) {
      try {
        const body = await this.bridge.readLyrics(songId);
        if (body !== null && body !== '' && isRouteErrorBody(body)) {
          this.voidErrorBody(songId);
        } else if (body !== null && body !== '') {
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
   * Boot and on-visible reconcile: `list()` is the truth about the files, the **manifest** is the
   * truth about what was asked for. Rebuild the index from `list()`, rebuild each playlist record
   * from its manifest, and resume the ones that were interrupted — a download killed mid-flight
   * reads `partial` with the tracks that are still missing, never `complete`.
   */
  async hydrate(): Promise<void> {
    const mirror = loadMirror(this.store);
    /*
     * The rows of the transfers that are **still running**, kept across the rebuild below.
     *
     * `list()` only ever reports what native has already finished (the index row is written on
     * completion), so on this — the on-foreground — pass those songs are simply absent from its
     * answer; and only the process's first reconcile may re-enqueue, so nothing else re-creates
     * them. Drop them and the `done`/`failed` event of every transfer that lands afterwards finds
     * no row (`if (!row) return`): the file is on disk, the index and the mirror never hear about
     * it, the playlist never reconciles and the control freezes on `n of m · retry`.
     *
     * The coverage that keeps a row alive is the manifest's, not the row's: a song is in flight
     * only while the playlist that asked for it is still `downloading` (the owner did not cancel
     * it). Everything else — a cancelled or finished download — keeps nothing alive.
     */
    const inFlight = new Map<string, IndexRow>();
    if (this.bootReconciled) {
      for (const [songId, row] of this.rows) {
        if (row.state !== 'staging') continue;
        if (row.refs.some((playlistId) => this.manifests.get(playlistId)?.state === 'downloading')) inFlight.set(songId, row);
      }
    }
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
    if (this.rows.size === 0 && mirror) this.seedRows(mirror.rows);
    // A `staging` row the native reconcile did not promote is a transfer that came back wrong: the
    // bytes are not trustworthy, so the row is not either (the native side has already deleted the
    // staging file). Leaving it named here would keep a track that can never play out of the sweep.
    for (const [songId, row] of [...this.rows]) {
      if (row.state === 'staging') this.rows.delete(songId);
    }
    // …and put back the ones that are still transferring (`inFlight`), unless `list()` has just
    // reported the song itself — a row native already finished is the better row. The event that
    // lands for a live transfer has to find a row here, or it is thrown away.
    for (const [songId, row] of inFlight) {
      if (!this.rows.has(songId)) this.rows.set(songId, row);
    }
    this.rebuildPlaylists(mirror?.playlists);
    /*
     * Resume only on this process's **first** reconcile. `hydrate()` is also the on-foreground
     * reconcile, and re-enqueueing a transfer that is already in `nsurlsessiond` would restart it
     * from zero every time the owner switches apps — the transfers that are still running land as
     * `done` events instead, which is the row the pass above keeps for them.
     */
    const resume = this.bootReconciled ? [] : this.resumable();
    this.bootReconciled = true;
    this.saveMirror();
    this.notify();
    // Only a manifest still marked `downloading` is resumed — a cancelled one stays `partial`
    // until the owner asks again (§6 E2, "the user had not cancelled").
    for (const playlistId of resume) await this.resume(playlistId);
  }

  /**
   * The playlists that boot must re-enqueue: a manifest still `downloading` whose songs are not all
   * on disk. Read before the resume runs, so `saveMirror` records the manifest as it was found.
   */
  private resumable(): string[] {
    const ids: string[] = [];
    for (const [playlistId, record] of this.playlists) {
      if (record.requestedAt === undefined) continue;
      if (record.state !== 'partial' && record.state !== 'downloading') continue;
      if (record.total === 0 || record.done === record.total) continue;
      if (this.manifests.get(playlistId)?.state !== 'downloading') continue;
      ids.push(playlistId);
    }
    return ids;
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
    /*
     * The manifest is written **before** a byte is fetched: `total` is the list that was asked for,
     * so a kill mid-transfer, or a track added to the playlist afterwards, can never reconcile as
     * `done === total` from the completed files alone.
     */
    this.manifests.set(playlistId, { songs, requestedAt: Date.now(), state: 'downloading' });
    const record: PlaylistRecord = {
      state: 'estimating',
      done: doneInitially,
      total: songs.length,
      bytes: estimate.total,
      exact: estimate.exact,
      songs,
      requestedAt: Date.now(),
    };
    this.playlists.set(playlistId, record);
    /*
     * Persist before the first byte — and before the first `await`. `enqueueSongs` takes a bridge
     * call per track (plus a serial `lyricsFallback` fetch for a track with no sidecar route), and a
     * kill inside that loop would otherwise leave no manifest at all: the next boot would find
     * nothing to rebuild from and would derive the record from the files that happened to land —
     * `done === total`, the item-2 defect this manifest exists to prevent.
     */
    this.saveMirror();
    this.notify();

    const free = await this.bridge.freeBytes();
    if (free >= 0 && free < estimate.total + FREE_SPACE_MARGIN) {
      record.state = 'idle';
      this.manifests.delete(playlistId);
      // The abort has to reach the mirror too, or the next boot would resume a download the owner
      // was just told there is no room for.
      this.saveMirror();
      this.notify();
      return { kind: 'no-space', free, needed: estimate.total + FREE_SPACE_MARGIN };
    }

    await this.bridge.configure({ allowsCellular: options.allowsCellular === true, maxConcurrent: MAX_CONCURRENT });
    record.state = 'downloading';
    await this.enqueueSongs(playlistId, songs);
    this.saveMirror();
    this.reconcileRecord(playlistId);
    this.notify();
    return { kind: 'started' };
  }

  /**
   * Boot resume (§5 / §6 E2): re-enqueue the songs of a manifest that is not finished. The playlist
   * stays `partial` in the sense that it is not complete; each `done` event moves it back to
   * `downloading` as the transfers land.
   */
  private async resume(playlistId: string): Promise<void> {
    const record = this.playlists.get(playlistId);
    const manifest = this.manifests.get(playlistId);
    if (!record || !manifest || !this.bridge) return;
    this.ensureListening();
    await this.enqueueSongs(playlistId, manifest.songs);
    this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /** The one place a song list becomes transfers: audio first (the long pole), its lyric second. */
  private async enqueueSongs(playlistId: string, songs: Song[]): Promise<void> {
    if (!this.bridge) return;
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
      // The lyric rides its own transfer, in the same lane, keyed by its own kind.
      await this.enqueueLyrics(song);
    }
  }

  /** Cancel a running download; tracks already complete are kept (§4). */
  async cancel(playlistId: string): Promise<void> {
    const record = this.playlists.get(playlistId);
    if (!record || !this.bridge) return;
    for (const song of record.songs) {
      if (this.rows.get(song.id)?.state === 'complete') continue;
      // `cancel(songId)` stops both of the song's transfers: audio and lyrics.
      await this.bridge.cancel(song.id);
      this.dropRef(song.id, playlistId);
    }
    record.state = record.done > 0 ? 'partial' : 'failed';
    // A cancelled manifest is never resumed by boot; only the owner's tap asks again.
    const manifest = this.manifests.get(playlistId);
    if (manifest) manifest.state = 'partial';
    this.saveMirror();
    this.notify();
  }

  /** §S9/S10: drop this playlist's refs; delete a file only when it has no refs left. */
  async remove(playlistId: string): Promise<void> {
    const record = this.playlists.get(playlistId);
    if (!record) return;
    for (const song of record.songs) await this.dropRef(song.id, playlistId);
    this.playlists.delete(playlistId);
    this.manifests.delete(playlistId);
    this.saveMirror();
    this.notify();
  }

  /** §S11: explicit global eviction — remove every download. */
  async removeAll(): Promise<void> {
    if (!this.bridge) return;
    const songIds = [...this.rows.keys()];
    for (const songId of songIds) await this.bridge.remove(songId);
    this.rows.clear();
    this.playlists.clear();
    this.manifests.clear();
    clearMirror(this.store);
    this.notify();
  }

  /**
   * How many of the playlist's *current* songs the download does not cover — the "a track was added
   * after the download" case. Zero for a playlist whose set is a subset of what was downloaded.
   */
  missingCount(playlistId: string, songs: Song[]): number {
    const manifest = this.manifests.get(playlistId);
    const covered = new Set((manifest?.songs ?? this.playlists.get(playlistId)?.songs ?? []).map((song) => song.id));
    if (covered.size === 0) return 0;
    let missing = 0;
    for (const song of songs) {
      if (!covered.has(song.id) || this.rows.get(song.id)?.state !== 'complete') missing += 1;
    }
    return missing;
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
      /*
       * …and the body is read back and checked (§3). Native refuses a non-200 body before this
       * event is ever emitted, so this is the second lock on the same door: a row is never left
       * reading `present` over the route's error document, whatever wrote it. The read is a few
       * kilobytes and it does not block the event.
       */
      void this.verifyStoredLyrics(event.songId);
    } else {
      row.state = 'complete';
      row.path = event.path ?? row.path;
      row.bytes = typeof event.bytes === 'number' ? event.bytes : row.bytes;
      row.downloadedAt = Date.now();
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  private onFailed(event: DownloadEvent): void {
    const row = this.rows.get(event.songId);
    if (!row) return;
    if (event.kind === 'lyrics') {
      /*
       * A `404` from the lyrics route is not a failure: it is the library saying this track has no
       * sidecar, which is a fact worth keeping (`none` — the fresh-miss row §"Offline lyrics" asks
       * about) rather than a lyric that makes the playlist read `· retry` for ever.
       *
       * It is not the end of the lane either (v1.9.14): Navidrome is asked for the body next, the
       * same way `fetchLyrics` asks it online, because a track whose words live inside the file
       * itself has no sidecar and would otherwise never be captured. The row stays `pending` while
       * that runs, so the playlist does not read `complete` before the answer is in.
       */
      if (event.status === 404) {
        row.lyrics = { state: 'pending', bytes: 0 };
        for (const playlistId of row.refs) this.reconcileRecord(playlistId);
        this.saveMirror();
        this.notify();
        void this.captureLibraryLyrics(this.songFromRow(row));
        return;
      }
      row.lyrics = { state: 'failed', bytes: 0, fetchedAt: Date.now() };
    } else {
      row.state = 'failed';
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /**
   * Enqueue a track's lyric transfer in the audio's own lane, or — when the route has nothing to
   * fetch — capture the body from Navidrome instead.
   *
   * The normal path is the sidecar route URL. A track the route carries no URL for is asked of
   * Navidrome directly (`lyricsFallback`: `getLyricsBySongId`, then the legacy blob behind the
   * caller's `sameSong` guard), and so is a track the route answers `404` for — see `onFailed`.
   * Both empty → `none`, a recorded miss.
   */
  private async enqueueLyrics(song: Song): Promise<void> {
    if (!this.bridge) return;
    const row = this.rows.get(song.id);
    if (!row) return;
    const lyric = row.lyrics;
    if (lyric?.state === 'present' || lyric?.state === 'none') return; // already resolved
    const url = this.lyricsUrl(song);
    if (url === null || url === '') {
      await this.captureLibraryLyrics(song);
      return;
    }
    row.lyrics = { state: 'pending', bytes: 0 };
    await this.bridge.enqueue({
      songId: song.id,
      url,
      suffix: 'lyrics',
      /*
       * No byte count is known before the transfer starts, and inventing one would be a lie.
       * Native verifies against the **response's** `Content-Length` (the route always sends one)
       * and records it on the job as it arrives, so the lyrics axis is checked exactly as the
       * audio axis is — `bytes: 0` here means "unknown yet", never "do not check".
       */
      bytes: 0,
      refs: row.refs,
      title: song.title,
      artist: song.artist ?? '',
      album: song.album ?? '',
      durationSec: song.duration ?? 0,
    });
  }

  /**
   * The Navidrome half of the lane: ask for this track's lyrics and store the body **raw**, so the
   * read path (`fromSidecar`: LRC when a line is timed, else plain text) parses it exactly as it
   * parses the route's bytes — one stored format, never a second one. Every source empty → `none`,
   * the same fact a 404 writes, so the playlist shows no `· retry` for a track that simply has no
   * words. The same predicate runs here as at every other write: the route's error document is
   * never stored as lyrics, whatever a caller hands back.
   */
  private async captureLibraryLyrics(song: Song): Promise<void> {
    if (!this.bridge) return;
    const row = this.rows.get(song.id);
    if (!row) return;
    try {
      const body = await this.lyricsFallback(song);
      if (body !== null && body !== '' && !isRouteErrorBody(body)) {
        await this.bridge.writeLyrics(song.id, body);
        row.lyrics = { state: 'present', file: `${song.id}.lyrics`, bytes: body.length, fetchedAt: Date.now() };
      } else {
        row.lyrics = { state: 'none', bytes: 0, fetchedAt: Date.now() };
      }
    } catch {
      row.lyrics = { state: 'none', bytes: 0, fetchedAt: Date.now() };
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /** After a lyric transfer lands: read the body back and void the row if it is the route's error. */
  private async verifyStoredLyrics(songId: string): Promise<void> {
    if (!this.bridge) return;
    const row = this.rows.get(songId);
    if (row?.lyrics?.state !== 'present') return;
    let body: string | null = null;
    try {
      body = await this.bridge.readLyrics(songId);
    } catch {
      return; // A read that failed cannot convict the body.
    }
    if (body === null || !isRouteErrorBody(body)) return;
    this.voidErrorBody(songId);
  }

  /**
   * A stored body that is the route's 404 document is **not lyrics** (§3): the row reads absent
   * (`none`, with a `fetchedAt` old enough that online reads still reach the network rather than
   * answering "nothing here" for the next five minutes), and the track's lyric is re-fetched once.
   */
  private voidErrorBody(songId: string): void {
    const row = this.rows.get(songId);
    if (!row) return;
    row.lyrics = { state: 'none', bytes: 0, fetchedAt: 0 };
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
    if (this.lyricsRefetched.has(songId)) return;
    this.lyricsRefetched.add(songId);
    void this.captureLibraryLyrics(this.songFromRow(row));
  }

  /** The `Song` the Navidrome fallback needs, rebuilt from the durable row. No `path`: the route
   * has already been asked and had nothing, so it is not asked a third time. */
  private songFromRow(row: IndexRow): Song {
    return {
      id: row.songId,
      title: row.title,
      artist: row.artist === '' ? undefined : row.artist,
      album: row.album === '' ? undefined : row.album,
      duration: row.durationSec,
    };
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
    // The persisted half: only a manifest still `downloading` is resumed by the next boot, so a
    // cancelled (`partial`) or finished one is never re-enqueued behind the owner's back.
    const manifest = this.manifests.get(playlistId);
    if (manifest) {
      if (record.state === 'complete') manifest.state = 'complete';
      else if (record.state === 'downloading') manifest.state = 'downloading';
      else manifest.state = 'partial';
    }
  }

  /**
   * Rebuild playlist records at boot. The manifest is the primary source — its song list is the
   * durable `total` — and the refs the native rows carry are the fallback for a playlist downloaded
   * before the manifest existed (or whose manifest was dropped as unreadable).
   */
  private rebuildPlaylists(manifests?: Record<string, OfflinePlaylistManifest>): void {
    this.playlists.clear();
    this.manifests.clear();
    for (const [playlistId, manifest] of Object.entries(manifests ?? {})) this.manifests.set(playlistId, manifest);
    for (const [playlistId, manifest] of this.manifests) {
      const done = manifest.songs.filter((song) => this.rows.get(song.id)?.state === 'complete').length;
      const allAudio = manifest.songs.length > 0 && done === manifest.songs.length;
      const lyricPending = manifest.songs.some((song) => this.rows.get(song.id)?.lyrics?.state === 'pending');
      const lyricFailed = manifest.songs.some((song) => this.rows.get(song.id)?.lyrics?.state === 'failed');
      const estimate = this.estimate(manifest.songs);
      this.playlists.set(playlistId, {
        /*
         * Never `complete` from the files that happened to land. Missing songs are `partial` — the
         * label that offers `retry` — **unless** the manifest is still `downloading`, i.e. the owner
         * asked and did not cancel: then the transfers are in flight (or the boot resume is about to
         * re-enqueue them), and a `retry` label on a live download is a trap, because a tap on it
         * re-enqueues and native `enqueue` cancels the task it is replacing.
         */
        state: allAudio
          ? lyricPending
            ? 'downloading'
            : lyricFailed
              ? 'partial'
              : 'complete'
          : manifest.state === 'downloading'
            ? 'downloading'
            : 'partial',
        done,
        total: manifest.songs.length,
        bytes: estimate.total,
        exact: estimate.exact,
        songs: manifest.songs,
        requestedAt: manifest.requestedAt,
      });
    }
    const byPlaylist = new Map<string, IndexRow[]>();
    for (const row of this.rows.values()) {
      for (const playlistId of row.refs) {
        if (this.playlists.has(playlistId)) continue;
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
    const rows: Record<string, { path: string; bytes: number; state: DownloadState; lyrics?: { state: LyricsState; bytes: number; fetchedAt?: number } }> = {};
    for (const [songId, row] of this.rows) {
      rows[songId] = {
        path: row.path,
        bytes: row.bytes,
        state: row.state,
        // `fetchedAt` is written or a `none` row answers `miss` again on the next launch.
        lyrics: row.lyrics ? { state: row.lyrics.state, bytes: row.lyrics.bytes, fetchedAt: row.lyrics.fetchedAt } : undefined,
      };
    }
    const playlists: Record<string, OfflinePlaylistManifest> = {};
    for (const [playlistId, manifest] of this.manifests) playlists[playlistId] = manifest;
    saveMirror({ v: 1, hydratedAt: Date.now(), rows, playlists }, this.store);
  }
}
