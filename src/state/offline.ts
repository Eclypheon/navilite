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

/**
 * The album-art axis (v1.9.20), the third one beside audio and lyrics.
 *
 * Same shape and the same job as the lyric axis, with one difference that is the whole of its
 * design: **it is keyed by cover id, not by song.** A 12-track album is one cover, so the file is
 * one per cover (`<coverId>.art`) and every index row of that album carries the same row here.
 * A missing, failed or 404 cover gates nothing (§I5): a track plays because its *audio* row is
 * `complete`, and a playlist's state is decided by audio and lyrics only.
 */
export type ArtState = 'pending' | 'present' | 'none' | 'failed';

/** The durable art row, held on every index row that carries the cover. Never the bytes. */
export interface ArtRow {
  state: ArtState;
  /** The file name under the offline root, e.g. `cover-album-1-1.art`. */
  file?: string;
  /** The measured body bytes when `present`, else 0. */
  bytes: number;
  /** When the row was last written — the `none` staleness window reads this. */
  fetchedAt?: number;
}

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
  /**
   * This row's cover id (v1.9.20), optional by hard rule (§I9): `readIndex()` returns `[:]` on a
   * decode failure and the native boot sweep then deletes every file the index does not name, so a
   * non-optional field added against a 1.9.19 index is a silent deletion of the owner's downloads.
   */
  coverArt?: string;
  /** The art axis; absent = never asked. */
  art?: ArtRow;
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
  /** The cover this transfer is for, when it is an art transfer (§5.4). */
  coverArt?: string;
  /**
   * The songs that share this cover, for an **art** transfer only (§5.4).
   *
   * The native side needs it to attach the finished cover to rows that have never carried a
   * `coverArt` of their own — the rows a 1.9.19 download wrote. Without it those rows cannot learn
   * which cover is theirs: their audio job is never re-enqueued (the track is already on disk), so
   * there is no other moment at which the association can be recorded.
   */
  coverOf?: string[];
}

export interface DownloadEvent {
  songId: string;
  /**
   * `lyrics` for a lyrics transfer, `art` for a cover transfer; the audio axis is the default.
   *
   * For an art transfer `songId` is a **cover id**, so every handler that looks a song up by it
   * misses by construction — `onDone`/`onFailed` fan out by cover instead (§5.4).
   */
  kind?: 'audio' | 'lyrics' | 'art';
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
  /**
   * The playlist's name, as the server reported it when it was downloaded or last listed
   * (v1.9.18). Absent for a manifest written before names were recorded, in which case the
   * offline browse list falls back rather than inventing one.
   */
  name?: string;
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
 * A playlist that can be browsed with no connection (v1.9.18): its id (what the row navigates on),
 * the name it was downloaded under, and the record — whose `songs` are the manifest's, i.e. the
 * ones the app already holds Song metadata for as well as the download state.
 */
export interface DownloadedPlaylist {
  id: string;
  name: string;
  record: PlaylistRecord;
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
/**
 * 256 KB per unresolved **cover**, an upper bound for the re-encoded 512 px cover the app asks for
 * (`getCoverArt?size=512`, §5.1). The rule is the lyric rule, and so is the honesty about it:
 * Navidrome passes an original through whole when it is already smaller than the requested size, so
 * a pathological multi-megabyte original is the one case where `up to` is optimistic. The free-space
 * guard's 250 MB margin absorbs it, asking the server for each cover's length first would be a round
 * trip per album (§I3), and the remedy if it ever bites is to move this constant.
 *
 * It is counted **once per cover**, never once per track (§5.6): a 14-track, 2-album playlist adds
 * 512 KB, not 3.5 MB. After the first download the term is the measured file, so the figure is exact.
 */
export const ART_ASSUMED_BYTES = 256 * 1024;
/** How long a `none` row stays fresh before a network-reachable reconcile re-asks it. */
export const LYRICS_MISS_TTL_MS = 5 * 60 * 1000;
/** §5: leave this much headroom over the estimate before a download is allowed to start. */
const FREE_SPACE_MARGIN = 250 * 1024 * 1024;
/**
 * How many transfers the app asks native to keep moving (v2.0.0-beta.10): the same number is the
 * plugin's `maxLive` window — `configure` sets both — so a playlist of 233 tracks opens a handful of
 * transfers at a time rather than several hundred, each of which needs its own temp file.
 */
const MAX_CONCURRENT = 4;

/**
 * v2.0.0-beta.4 — the bounds the enqueue loop itself was missing.
 *
 * A download's song list was handed to the bridge one transfer at a time, `await`ed, uncaught and
 * unbounded. The first call that rejected — or that simply never answered — ended the enumeration
 * where it stood: the owner's 269-track playlist stopped at 254 with nothing on screen to say why,
 * and the covers of the albums past that point were never asked for at all, which is the second tap
 * he described. Each call is now bounded and retried, and its failure cannot end the loop.
 */
const ENQUEUE_ATTEMPTS = 3;
const ENQUEUE_RETRY_MS = 400;
/** The self-completion pump's backoff, one entry per round; the last entry repeats. */
const PUMP_BACKOFF_MS = [1500, 4000, 10000, 20000];

/**
 * v2.0.0-beta.5 — **the stall window**: how long a download may say nothing at all before the
 * control is allowed to offer a `retry`.
 *
 * The owner, verbatim: "the retry should not appear if the download is still actively working". A
 * job is working whenever anything has happened for it inside this window — a `progress` event from
 * any of its transfers (native emits one per chunk, `didProgress`), a transfer settling, or a pump
 * pass the job scheduled for itself. Twenty seconds is deliberately longer than the pump's own
 * longest backoff (20 s) plus a slow start on a tailnet, and it is the one state in which a human
 * tap is genuinely the only thing left. `DECISIONS.md`, "The stall window (v2.0.0-beta.5)".
 */
export const STALL_MS = 20_000;

/**
 * How often a running download may repaint its control. Native reports bytes per chunk, which on a
 * fast connection is far more often than a screen can use; the owner asked for "updating every
 * second", and a quarter-second ceiling keeps the label honest without turning a download into a
 * render loop.
 */
const PROGRESS_NOTIFY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One bridge call, bounded: a Capacitor promise that never settles is a hang, not a slow answer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('enqueue timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
/**
 * How many rows **one** `repairMetadata` pass may ask the server about (v1.9.23).
 *
 * The sweep is one `getSong` per still-blank row, sequentially, and it exists for the rows the
 * download's own record cannot name — the case where a build's manifest is gone. The owner has 497
 * rows on the phone: uncapped, one visit to **On this phone** with his manifests gone is 497 round
 * trips off a screen he is only looking at, and the first pass after an upgrade is precisely when
 * they are all blank. Twenty is about two seconds on a tailnet and the rows past it are named by the
 * next pass (each pass asks the first twenty it has not asked yet, so the work still finishes), while
 * the manifest pass — the ordinary case — costs no round trips at all.
 */
export const SERVER_ASKS_PER_PASS = 20;

/**
 * §4 — the size a playlist will take, summed over its entries, plus the lyric bodies and the covers.
 *
 * Exact (byte-equal to the sum of `Content-Length`, because the files come from `download?id=` —
 * original, untranscoded, exact length) when every entry carries a `size` **and** every lyric is
 * already resolved (`present` or `none`) **and** every cover is (`present` or `none`); otherwise the
 * figure is an over-estimate, prefixed `up to` by the UI — a missing audio size is bounded above by
 * 320 kbit/s, an unresolved lyric by `LYRICS_ASSUMED_BYTES` and an unresolved cover by
 * `ART_ASSUMED_BYTES`, so the number is a ceiling, never an under-promise.
 *
 * Album art is counted once per **cover id** (§5.6), the same way the file itself is stored: two
 * tracks of one album are one JPEG, and charging for it twice would be a lie in the other direction.
 */
export type EstimateSong = Pick<Song, 'id' | 'size' | 'duration'> & { coverArt?: string; albumId?: string };

export function estimateBytes(songs: EstimateSong[], rows?: ReadonlyMap<string, IndexRow>): SizeEstimate {
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
  /*
   * …and the covers, deduped by cover id (§5.6). The row is per song, the *file* per cover, so the
   * lookup below can be answered by any row that names this cover — the fee is charged once, to the
   * first track of the album that mentions it.
   */
  let art = 0;
  let artExact = true;
  const covers = new Set<string>();
  for (const song of songs) {
    const cover = song.coverArt ?? song.albumId;
    if (cover === undefined || cover === '') continue; // nothing to fetch
    if (covers.has(cover)) continue; // one cover per album
    covers.add(cover);
    const row = artRowForCover(rows, cover);
    if (row?.state === 'present') art += row.bytes;
    else if (row?.state === 'none') {
      // Asked, this album has no cover: zero, and exact.
    } else {
      art += ART_ASSUMED_BYTES;
      artExact = false;
    }
  }
  return { total: total + lyrics + art, exact: exact && lyricsExact && artExact };
}

/**
 * The art row for a cover id, from any index row that carries it — synchronously, memory only.
 *
 * The file is keyed by cover and the row is held *per song*, so the answer is "does any of this
 * cover's rows know?" rather than "does the first track's row know?" — the fan-out writes the same
 * row to all of them, and this reads it the same way.
 */
function artRowForCover(rows: ReadonlyMap<string, IndexRow> | undefined, cover: string): ArtRow | undefined {
  if (!rows) return undefined;
  for (const row of rows.values()) {
    if (row.coverArt === cover && row.art) return row.art;
  }
  return undefined;
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
 * **The download control's own figure** (v2.0.0-beta.5): one decimal, always, and never a range.
 *
 * The owner: "show the exact filesize to one decimal point eg. 4.8 GB rather than an Up to 5 GB".
 * `formatBytes` above rounds a big number to whole units and a small one to a tenth, which is right
 * for a settings line and wrong for the one number he checks against his phone: `5 GB` is a claim
 * about a playlist, `4.8 GB` is a figure. This formatter is used by the control and by nothing else,
 * so the rest of the app's sizes stay in `formatBytes`'s shorter shape.
 *
 * Where the estimate is not byte-equal to the sum of `Content-Length` (`estimateBytes`'s `exact`
 * flag: an entry with no `size`, an unresolved lyric or cover), the number is still printed to a
 * tenth and still climbs to the measured total as files land — the honest fix is the figure he can
 * compare, not a `up to` hedge he has to interpret.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * What a running download has to show (v2.0.0-beta.5): bytes, the figure they are a fraction of, and
 * when the job last said anything.
 *
 * `bytes` is measured, never promised: complete audio rows' own recorded lengths, their lyrics and
 * their covers, plus the in-flight transfer's last reported count (`progress`), so the bar moves
 * between `done` events instead of jumping once per file. `total` is the estimate the control prints
 * (`record.bytes`), and `at` is the store's own last-signal clock — the input to `stallOf`, so the
 * indicator and the retry verdict can never disagree about whether the job is alive.
 */
export interface DownloadActivity {
  /** Bytes that have actually arrived: on-disk files plus the transfer in flight. */
  bytes: number;
  /** The figure the bar is a fraction of — the estimate, or the measured bytes when it has none. */
  total: number;
  /** When the job last said anything (`0` when it never has). */
  at: number;
  /** Transfers the job still owes: audio not complete, plus covers not settled. */
  pending: number;
}

/**
 * **The last thing that failed for this playlist** (v2.0.0-beta.6) — the status and the words, kept
 * so the control can say *why* a download is not completing instead of only reporting that it has
 * not.
 *
 * The native side has always computed this and sent it on the `failed` event
 * (`{songId, kind, status, error}`: `HTTP 206`, `byte count 1048576 != 2097152`, a move error), and
 * JS discarded it — which left the owner watching 500 MB arrive under `0 of 233` with no way to tell
 * which door rejected the bytes. This is a **measurement, not narration**: it renders on the download
 * control (never on the now-playing screen), the next failure replaces it, and a job that finishes
 * takes it away.
 */
export interface DownloadFailure {
  /** The HTTP status the transfer answered with, when it got that far. */
  status?: number;
  /** The native side's own words for it. */
  error: string;
  /** The track (or cover) whose transfer failed. */
  songId: string;
  /** When it was reported — the clock the control could date it by. */
  at: number;
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

/**
 * What the store knows about a playlist, for the one row the UI draws (v1.9.20, §3.1).
 *
 * `state` is the badge, and nothing here is a second state machine: it is `record()` plus the one
 * question the record cannot answer on its own — *"is the playlist in front of me still the one that
 * was downloaded?"*, which is what `expectedTracks` (the server's `songCount`, when there is a
 * server) answers.
 */
export interface PlaylistBadge {
  state: 'none' | 'partial' | 'downloading' | 'complete';
  /** Complete files among the playlist's songs — never `record.total`, never the estimate. */
  done: number;
  /** The playlist's length as the store knows it (the manifest's). */
  total: number;
  /**
   * **Measured** bytes of the audio rows that are here (§I4) — never `record.bytes`, which is a
   * ceiling for a download that has not happened. 0 when none.
   */
  bytes: number;
  /** A cover id that is on this phone, when one is (§5). */
  coverArt?: string;
}

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
  private readonly artUrl: (coverArtId: string) => string | null;
  private readonly toLocalSrc: (fileUrl: string) => string;
  /**
   * The metadata repair's second source (v1.9.22): the library's own answer for one song id.
   *
   * Injected like the URL factories above, and for the same reason — `src/state/offline.ts` does
   * not own a client. It is asked only for a complete row whose copy metadata is still blank after
   * the download's own record has had its turn (see {@link repairMetadata}).
   */
  private readonly songLookup: (songId: string) => Promise<Song | null>;
  private readonly unlisteners: Array<() => void> = [];
  /**
   * The last `bytes` a transfer reported, per song id (v2.0.0-beta.5) — what makes the control's
   * figure and bar move between `done` events. Cleared when the transfer settles, so the count on
   * screen is never a stale chunk added to a file that is already complete.
   */
  private readonly inFlight = new Map<string, number>();
  /**
   * The last failure the native side reported, per playlist id (v2.0.0-beta.6) — see
   * `DownloadFailure`. Never persisted: it describes a transfer that is over, and a fresh launch
   * asks the native index (the truth) rather than replaying a stale sentence.
   */
  private readonly lastFailure = new Map<string, DownloadFailure>();
  /**
   * One walk per playlist at a time (v2.0.0-beta.6). `download()` (the owner's tap), `resume()` (the
   * boot reconcile) and `pump()` (the self-completion pass) all enumerate the same playlist, and the
   * native `enqueue` used to cancel-and-restart whatever was in flight for a key — so two overlapping
   * walks destroyed each other's transfers and the byte figure fell back. A caller that arrives while
   * a walk is running joins it instead of starting a second one.
   */
  private readonly walks = new Map<string, Promise<void>>();
  /** When each playlist's job last said anything — the stall window's only input (v2.0.0-beta.5). */
  private readonly lastSignal = new Map<string, number>();
  /** One shared repaint timer for all progress events, so a fast transfer cannot flood the UI. */
  private progressNotify: ReturnType<typeof setTimeout> | null = null;
  private readonly changeListeners = new Set<() => void>();
  private listening = false;
  /** How long one bridge `enqueue` may take before it is treated as a failure (v2.0.0-beta.4). */
  private readonly enqueueTimeoutMs: number;
  /** The self-completion pump: one timer per playlist, and the backoff round that timer is on. */
  private readonly pumpTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pumpRounds = new Map<string, number>();
  private disposed = false;
  /** A repair pass is running; a second caller joins the first rather than starting another. */
  private repairing = false;
  /** The ids this session has already asked the server about, so a blank row is asked once. */
  private readonly askedServer = new Set<string>();
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
      /** The cover URL for a cover id (the cover route), or null when there is none to enqueue. */
      artUrl?: (coverArtId: string) => string | null;
      /**
       * Make a `file://` URL from the app's own container readable by the page (v1.9.20).
       *
       * Injected, like the two URL factories above and for the same reason: this store **never
       * mints a URL**, and the platform call that turns a device path into a same-origin one
       * (`Capacitor.convertFileSrc`) belongs to the shell that knows the platform. The default is
       * the identity, which is exactly right for a path that is already a URL the page can read.
       */
      toLocalSrc?: (fileUrl: string) => string;
      /**
       * The library's answer for one song id, or null when it does not know it (v1.9.22). Used by
       * {@link repairMetadata} for a row the download's own record cannot name.
       */
      songLookup?: (songId: string) => Promise<Song | null>;
      /**
       * How long one bridge `enqueue` call may take before it counts as failed (v2.0.0-beta.4).
       *
       * A Capacitor call that never answers used to hang the whole enumeration — the 254-of-269
       * stop — so the wait is bounded and the job is retried. Injectable so a test does not wait
       * 2.5 s to prove it.
       */
      enqueueTimeoutMs?: number;
      store?: MirrorStore;
    } = {},
  ) {
    this.bridge = bridge;
    this.store = options.store ?? mirrorStore();
    this.downloadUrl = options.downloadUrl ?? ((song) => `download?id=${song.id}`);
    this.lyricsUrl = options.lyricsUrl ?? (() => null);
    this.lyricsFallback = options.lyricsFallback ?? (async () => null);
    this.artUrl = options.artUrl ?? (() => null);
    this.toLocalSrc = options.toLocalSrc ?? ((fileUrl) => fileUrl);
    this.songLookup = options.songLookup ?? (async () => null);
    this.enqueueTimeoutMs = options.enqueueTimeoutMs ?? 2500;
    // Seed the in-memory map from the mirror synchronously, so the resolver answers local on the
    // very first start of a session — before `hydrate()` has had a chance to talk to the plugin.
    const mirror = loadMirror(this.store);
    if (mirror) {
      this.seedRows(mirror.rows);
      /*
       * …and the **playlist records** from the mirror's manifests, in the same tick (v1.9.19).
       *
       * v1.9.18 rebuilt these only in `hydrate()`, and `hydrate()` reaches `rebuildPlaylists` after
       * `await this.bridge.list()` — a native round trip that takes up to `BRIDGE_TIMEOUT_MS` (5 s)
       * when it is slow, and is *never* instantaneous. Boot starts hydration with `void
       * offline.hydrate()` and paints the first route without awaiting it, so on the phone (where a
       * bridge exists) `record()` and `downloadedPlaylists()` answered out of an empty map for the
       * whole of that window: a cold launch in airplane mode drew the Library and a downloaded
       * playlist as *"nothing is downloaded on this phone yet"* over a phone full of downloads.
       *
       * The browser harness could not see it by construction: `createDownloadsBridge` returns null
       * on the web (`player/native.ts`), which makes `hydrate()` fully synchronous, so the store was
       * always warm by the time the harness read it. The mirror holds the manifests, so the records
       * are rebuilt here from exactly the same data `hydrate()` will use, one round trip earlier;
       * the reconcile that follows replaces them with `list()`'s answer.
       */
      this.rebuildPlaylists(mirror.playlists);
    }
  }

  /**
   * Copy mirror rows into the in-memory index, carrying the lyrics `fetchedAt` with them — and
   * (v1.9.20) the metadata the browse list and the badges need with no round trip.
   *
   * The metadata fields are optional in the mirror (§I9), so a row written by 1.9.19 lands here with
   * empty strings and `durationSec: 0`: the first paint after the upgrade can show a row with an
   * empty sub-line, and the next `saveMirror` — one `list()` away, in the same launch — writes it.
   * Nothing is dropped and nothing throws, which is the whole requirement.
   */
  private seedRows(rows: OfflineMirror['rows']): void {
    for (const [songId, row] of Object.entries(rows)) {
      this.rows.set(songId, {
        songId,
        path: row.path,
        suffix: 'mp3',
        bytes: row.bytes,
        state: row.state,
        refs: [],
        title: row.title ?? '',
        artist: row.artist ?? '',
        album: row.album ?? '',
        durationSec: row.durationSec ?? 0,
        coverArt: row.coverArt,
        lyrics: row.lyrics
          ? { state: row.lyrics.state, bytes: row.lyrics.bytes, fetchedAt: row.lyrics.fetchedAt }
          : undefined,
        art: row.art ? { state: row.art.state, file: row.art.file, bytes: row.art.bytes, fetchedAt: row.art.fetchedAt } : undefined,
      });
    }
  }

  /** The synchronous resolver: a `file://` path when the index holds a complete row, else null. */
  pathFor(songId: string): string | null {
    const row = this.rows.get(songId);
    return row !== undefined && row.state === 'complete' ? row.path : null;
  }

  /**
   * The local art for a cover id, or null (v1.9.20, §5.5). Synchronous, memory only (§I2, §I3).
   *
   * The path is derived from the row's own `path` — the art file sits in the same directory as the
   * audio, and `list()` reports the audio's absolute URL — so the store still needs to know nothing
   * about where the container lives. It is then handed to the injected `toLocalSrc`, which is where
   * `Capacitor.convertFileSrc` makes it same-origin for the page: a `file://` URL is not fetchable
   * from `https://localhost`, and an art URL the page cannot read is an art URL that never themes
   * anything (§5.5's tainted-canvas failure mode, closed by construction).
   *
   * Answered for a **cover id, never a song**: one file serves every track of the album, which is
   * the point of keying it that way.
   */
  artPathFor(coverArtId: string): string | null {
    if (coverArtId === '') return null;
    for (const row of this.rows.values()) {
      const art = row.art;
      if (art?.state !== 'present' || art.file === undefined || art.file === '') continue;
      if (row.coverArt !== coverArtId) continue;
      const slash = row.path.lastIndexOf('/');
      if (slash < 0) return null;
      // The art file shares the audio's directory: `<dir>/<songId>.<suffix>` → `<dir>/<coverId>.art`.
      return this.toLocalSrc(`${row.path.slice(0, slash + 1)}${art.file}`);
    }
    return null;
  }

  /**
   * **Every complete row ends up with real copy metadata (v1.9.22)** — at the source, once.
   *
   * The owner, on the installed build: *"the library was populated by a bunch of nameless songs with
   * no durations... when I click in, they are playable and even have album art and lyrics."* 497
   * tracks, ten rows of blanks and `--:--`, and nothing wrong with any of the files.
   *
   * The mechanism is a version boundary, not a bug in the writer. A row carries the song's
   * title/artist/album/coverArt/durationSec only as far as the build that wrote it passed them
   * (`src/storage/offline.ts:24-38`: the fields arrived in v1.9.20, and a row a 1.9.19 build wrote
   * parses with `title` absent), and `downloadedSongs()` maps a row straight to a `Song` — so the
   * browse list drew a column of blanks, with `formatDuration(undefined)`'s `--:--` where the
   * duration goes, over files that play perfectly (the art and lyrics resolve from the file and the
   * server lazily, which is why those looked fine). Every download older than v1.9.20 is in that
   * state, and nothing ever went back for them.
   *
   * Two passes, in this order, and both of them write to the row — never to the view:
   *
   *   1. **the download's own record.** The manifest holds the `Song` objects the playlist was
   *      answered with when the owner pressed the button, titles and durations included
   *      (`src/storage/offline.ts`'s `OfflinePlaylistManifest.songs`). It is on the phone, so this
   *      pass needs no connection at all, and it is the one that covers everything a playlist
   *      download brought in.
   *   2. **the server**, one `getSong` per row that is still blank and one ask per row per session
   *      (`askedServer`), for the tracks that came in through a build whose record is gone. The
   *      sweep is **capped** (`SERVER_ASKS_PER_PASS`) and sequential, and its failure path is
   *      honest about both halves: a lookup that *failed* is forgotten again so the next pass in
   *      this session retries it, a `null` answer (the server does not know the id) is not asked
   *      twice, and the rows past the cap wait for the next pass rather than for a burst of
   *      hundreds of round trips off one screen.
   *
   * It is never on the first paint's path: the view draws from `downloadedSongs()` synchronously and
   * calls this afterwards, and the answer is what re-draws it (through `notify`, which the store's
   * own subscribers turn into the row's text — see `songFor`). Making the rows wait for a round trip
   * before they can be printed is the 1.9.19 defect this view was built to avoid. Returns how many
   * rows were filled.
   */
  async repairMetadata(): Promise<number> {
    if (this.repairing) return 0;
    this.repairing = true;
    try {
      let fixed = this.repairFromRecords();
      if (fixed > 0) {
        this.saveMirror();
        this.notify();
      }
      let asks = 0;
      for (const songId of this.blankRows()) {
        if (this.askedServer.has(songId)) continue;
        if (asks >= SERVER_ASKS_PER_PASS) break;
        asks += 1;
        this.askedServer.add(songId);
        let song: Song | null = null;
        try {
          song = await this.songLookup(songId);
        } catch {
          /*
           * No connection, a server that does not answer: the row stays as it is, and **this id is
           * forgotten again** so a later pass in this session has another go. v1.9.22 wrote it into
           * `askedServer` *before* the await, so the comment here ("the next pass … has another go")
           * was false in-session — the row was asked again on the next launch at best.
           */
          this.askedServer.delete(songId);
          continue;
        }
        const row = this.rows.get(songId);
        if (song === null || row === undefined) continue;
        if (this.fillFrom(row, song)) fixed += 1;
      }
      if (fixed > 0) {
        this.saveMirror();
        this.notify();
      }
      return fixed;
    } finally {
      this.repairing = false;
    }
  }

  /** The repair's first source: the `Song`s the downloads were asked for, from the phone itself. */
  private repairFromRecords(): number {
    let fixed = 0;
    const sources: Song[][] = [];
    for (const manifest of this.manifests.values()) sources.push(manifest.songs);
    for (const record of this.playlists.values()) sources.push(record.songs);
    for (const songs of sources) {
      for (const song of songs) {
        const row = this.rows.get(song.id);
        if (row === undefined || row.state !== 'complete') continue;
        if (this.fillFrom(row, song)) fixed += 1;
      }
    }
    return fixed;
  }

  /**
   * Copy what a `Song` knows into a row's empty fields, and nothing else. `false` when the row
   * already had everything the song had to give — which is what keeps a repair pass quiet.
   */
  private fillFrom(row: IndexRow, song: Song): boolean {
    let changed = false;
    if (row.title === '' && song.title !== '') {
      row.title = song.title;
      changed = true;
    }
    if (row.artist === '' && (song.artist ?? '') !== '') {
      row.artist = song.artist ?? '';
      changed = true;
    }
    if (row.album === '' && (song.album ?? '') !== '') {
      row.album = song.album ?? '';
      changed = true;
    }
    if ((row.durationSec ?? 0) <= 0 && (song.duration ?? 0) > 0) {
      row.durationSec = song.duration ?? 0;
      changed = true;
    }
    const cover = song.coverArt ?? song.albumId;
    if ((row.coverArt ?? '') === '' && cover !== undefined && cover !== '') {
      row.coverArt = cover;
      changed = true;
    }
    return changed;
  }

  /** The complete rows that cannot be named or timed yet — the repair's work list. */
  private blankRows(): string[] {
    const ids: string[] = [];
    for (const [songId, row] of this.rows) {
      if (row.state !== 'complete') continue;
      if (row.title !== '' && (row.durationSec ?? 0) > 0) continue;
      ids.push(songId);
    }
    return ids;
  }

  /**
   * Every track with a complete file on disk, as `Song`s, for the one view that browses them
   * (v1.9.20, §4.2).
   *
   * Rows only — never the manifests: a song in two playlists is one row and one entry here, and a
   * song whose playlist record was removed is on the phone only if its row survived (§S9/S10).
   * Order is the library's own (artist, album, title), because this is "browse my library", not
   * "what did I download last". No I/O and no fetch: it answers from the same map `pathFor` does,
   * which is what makes the view draw with no connection at all.
   */
  downloadedSongs(): Song[] {
    const out: Song[] = [];
    for (const [songId, row] of this.rows) {
      if (row.state !== 'complete') continue;
      out.push(this.rowAsSong(songId, row));
    }
    out.sort((a, b) => {
      const byArtist = (a.artist ?? '').localeCompare(b.artist ?? '');
      if (byArtist !== 0) return byArtist;
      const byAlbum = (a.album ?? '').localeCompare(b.album ?? '');
      if (byAlbum !== 0) return byAlbum;
      const byTitle = (a.title ?? '').localeCompare(b.title ?? '');
      return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
    });
    return out;
  }

  /**
   * The store's answer for **one** song id, in the shape a view and the queue draw one from
   * (v1.9.23). Synchronous, memory only; `null` for an id this phone does not hold a complete file
   * for.
   *
   * It exists because the repair reaches the screen through two callers that each hold a different
   * half of the state — the row that is already drawn, and the queue's own copy of the song — and
   * neither may build a `Song` out of a row itself. The row → `Song` mapping is the store's
   * (`downloadedSongs` is the list of them), and a second copy of it is exactly how two screens end
   * up disagreeing about one track, which is the v1.9.21 lesson.
   */
  songFor(songId: string): Song | null {
    const row = this.rows.get(songId);
    if (row === undefined || row.state !== 'complete') return null;
    return this.rowAsSong(songId, row);
  }

  /**
   * One row as the `Song` every caller reads it as. `downloadedSongs()` is this, for all of them;
   * `songFor` is this, for one. The three optional fields stay absent rather than becoming `''`/`0`,
   * so a row with nothing to say draws the app's placeholders (`--:--`, an empty sub-line) and never
   * a stand-in that reads like data.
   */
  private rowAsSong(songId: string, row: IndexRow): Song {
    return {
      id: songId,
      title: row.title,
      artist: row.artist === '' ? undefined : row.artist,
      album: row.album === '' ? undefined : row.album,
      duration: row.durationSec === 0 ? undefined : row.durationSec,
      coverArt: row.coverArt,
      suffix: row.suffix,
      size: row.bytes,
    };
  }

  /**
   * The badge for a playlist row (§3.1) — `record()` plus the one question the record cannot answer
   * on its own: *is the playlist in front of me still the one that was downloaded?*
   *
   * `expectedTracks` is the server's `songCount` when there is a server. A playlist the owner has
   * added to since downloading it is **not** entirely downloaded, and the row must not say it is;
   * the playlist page reaches the same verdict through `missingCount`, which counts the same songs
   * the same way (`missingCount(songs) > 0` ⟺ `songCount > record.total`).
   *
   * Nothing here reads `record.bytes` (an estimate for a download that has not happened), the
   * manifest's length (a claim about what was asked for) or `staging` (a transfer in flight): the
   * mark is read from complete files, synchronously, so it can never disagree with what plays.
   */
  playlistBadge(playlistId: string, expectedTracks?: number): PlaylistBadge {
    const record = this.playlists.get(playlistId);
    if (!record || record.state === 'idle') return { state: 'none', done: 0, total: 0, bytes: 0 };
    if (record.state === 'failed' && record.done === 0) return { state: 'none', done: 0, total: 0, bytes: 0 };
    let bytes = 0;
    for (const song of record.songs) {
      const row = this.rows.get(song.id);
      if (row?.state === 'complete') bytes += row.bytes;
    }
    const coverArt = this.localCoverFor(record.songs);
    const badge: PlaylistBadge = {
      state: 'partial',
      done: record.done,
      total: record.total,
      bytes,
      ...(coverArt === undefined ? {} : { coverArt }),
    };
    if (expectedTracks !== undefined && expectedTracks > record.total) return badge; // grown
    if (record.state === 'complete') return { ...badge, state: 'complete' };
    if (record.state === 'estimating' || record.state === 'downloading') return { ...badge, state: 'downloading' };
    return badge;
  }

  /**
   * Distinct covers among these songs with no complete art file on disk (v1.9.20, §5.8).
   *
   * This is the one thing that keeps the download control from lying to the owner: a playlist that
   * is `complete` on audio and lyrics but whose covers are not here is not *finished*, and its
   * label says so (`✓ 312 MB · ↓ covers`) so one tap can fetch the covers and nothing else.
   */
  missingCovers(songs: Song[]): number {
    const pending = new Set<string>();
    for (const song of songs) {
      const cover = song.coverArt ?? song.albumId;
      if (cover === undefined || cover === '') continue;
      const row = artRowForCover(this.rows, cover);
      if (row?.state === 'present' || row?.state === 'none') continue;
      pending.add(cover);
    }
    return pending.size;
  }

  /**
   * The cover a playlist row can draw, for the case where there is no server object to ask (§2.2):
   * a row of the playlist that is on disk and knows its own cover, or a cover whose file is here.
   */
  private localCoverFor(songs: Song[]): string | undefined {
    for (const song of songs) {
      /*
       * The **row** first: it is the thing on disk, and it is the only source that knows the cover of
       * a download made by an older build — whose manifest carries the song as the server sent it.
       */
      const row = this.rows.get(song.id);
      if (row?.state === 'complete' && row.coverArt !== undefined && row.coverArt !== '') return row.coverArt;
      const cover = song.coverArt ?? song.albumId;
      if (cover === undefined || cover === '') continue;
      if (artRowForCover(this.rows, cover)?.state === 'present') return cover;
    }
    return undefined;
  }

  /**
   * §6 E3 recovery — **a complete row whose file has gone is voided, so the next start resolves to
   * the stream** (v1.9.17).
   *
   * The resolver above is synchronous and never touches the filesystem (invariant 1), so it cannot
   * discover a missing file by itself: a row whose file was deleted outside this app — by iOS under
   * storage pressure, by the Files app, by anything that does not go through `remove` — answered
   * with its dead `file://` path for ever, and that song played nothing from then on. The one
   * signal the app gets is a start that produced no sound for a track it asked for **as a file**
   * (`state/queue.ts`: the failed start whose request URL began `file://`), and that is what calls
   * this.
   *
   * The row is dropped from the in-memory index, from the mirror *and* from the native index:
   * `bridge.remove` is the durable half, because `list()` reports `index.json` without stat-ing the
   * file (`NaviliteDownloads.swift`), so a row only dropped here would be back at the next boot
   * reconcile. The playlist records that referenced it reconcile down, so a playlist whose
   * downloaded copy has gone reads incomplete and offers the download again rather than reading
   * `complete` over a track that cannot play. Same shape as `voidErrorBody` for a lyrics row that
   * is not lyrics: void the row, re-resolve next time.
   */
  async voidMissingFile(songId: string): Promise<void> {
    const row = this.rows.get(songId);
    if (row?.state !== 'complete') return;
    this.rows.delete(songId);
    if (this.bridge) {
      try {
        await this.bridge.remove(songId);
      } catch {
        // The file is already gone, or the bridge refused — the row is dropped regardless.
      }
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
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

  /**
   * The last failure this playlist's transfers reported, or null (v2.0.0-beta.6) — the reason the
   * control prints beside its figures, so "bytes arrive, nothing completes" is a stated cause and
   * not a silence. Kept until the next failure replaces it, the job finishes, or it is cancelled.
   */
  failureOf(playlistId: string): DownloadFailure | null {
    return this.lastFailure.get(playlistId) ?? null;
  }

  /**
   * What the playlist's job has actually moved (v2.0.0-beta.5), for the control's live indicator.
   *
   * Every byte here is **measured**: the file's own recorded length for a complete row, the lyric
   * body's for a present one, the cover's once per album, plus the in-flight transfer's last
   * reported count. So the figure climbs as the download climbs and, when the job finishes, equals
   * the sum the row prints — one arithmetic, before and after, which is what "the exact filesize"
   * means. `total` is the estimate (the control's own sentence) and `at` is the same clock
   * `stallOf` reads, so the bar and the retry verdict can never disagree.
   */
  activityOf(playlistId: string): DownloadActivity {
    const record = this.playlists.get(playlistId);
    if (!record) return { bytes: 0, total: 0, at: 0, pending: 0 };
    let bytes = 0;
    let pending = 0;
    const covers = new Set<string>();
    for (const song of record.songs) {
      const row = this.rows.get(song.id);
      if (row?.state === 'complete') bytes += row.bytes;
      else {
        bytes += this.inFlight.get(song.id) ?? 0;
        pending += 1;
      }
      if (row?.lyrics?.state === 'present') bytes += row.lyrics.bytes;
      const cover = row?.coverArt ?? song.coverArt ?? song.albumId;
      if (cover !== undefined && cover !== '') covers.add(cover);
    }
    for (const cover of covers) {
      const art = artRowForCover(this.rows, cover);
      if (art?.state === 'present') bytes += art.bytes;
      if (art?.state === 'pending') pending += 1;
    }
    return { bytes, total: record.bytes > 0 ? record.bytes : bytes, at: this.lastSignal.get(playlistId) ?? 0, pending };
  }

  /**
   * **Is this download stalled?** (v2.0.0-beta.5) — the one question the control asks before it
   * prints `retry`, because the owner's report was that a retry appeared while the job was working.
   *
   * Not stalled when: there is nothing left to fetch; the record is finished; or the job has a pump
   * pass scheduled for itself — a scheduled pass *is* the job working, and a tap there would
   * re-enqueue over it (native `enqueue` cancels the task it replaces). Otherwise the job is stalled
   * once `lastSignal` is older than `STALL_MS`, and a job that has recorded no signal at all (a
   * cancelled one: `cancel` drops the entry) is stalled immediately — nothing is running, so there
   * is nothing to wait for.
   */
  stallOf(playlistId: string, now = Date.now()): { stalled: boolean; idleMs: number; window: number } {
    const idle = { stalled: false, idleMs: 0, window: STALL_MS };
    const record = this.playlists.get(playlistId);
    if (!record || record.state === 'complete' || record.state === 'idle') return idle;
    if (this.outstanding(record) === 0) return idle;
    if (this.pumpTimers.has(playlistId)) return idle;
    const at = this.lastSignal.get(playlistId);
    const idleMs = at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - at);
    return { stalled: idleMs >= STALL_MS, idleMs, window: STALL_MS };
  }

  /** Transfers the job still owes: audio not complete, lyrics pending, covers in flight. */
  private outstanding(record: PlaylistRecord): number {
    let pending = 0;
    const covers = new Set<string>();
    for (const song of record.songs) {
      const row = this.rows.get(song.id);
      if (row?.state !== 'complete') pending += 1;
      if (row?.lyrics?.state === 'pending') pending += 1;
      const cover = row?.coverArt ?? song.coverArt ?? song.albumId;
      if (cover !== undefined && cover !== '') covers.add(cover);
    }
    for (const cover of covers) {
      if (artRowForCover(this.rows, cover)?.state === 'pending') pending += 1;
    }
    return pending;
  }

  /** The job said something: refresh the stall clock and repaint the control, at most every 250 ms. */
  private touch(playlistId: string): void {
    if (playlistId === '') return;
    this.lastSignal.set(playlistId, Date.now());
    this.scheduleProgressNotify();
  }

  private scheduleProgressNotify(): void {
    if (this.progressNotify !== null || this.disposed) return;
    this.progressNotify = setTimeout(() => {
      this.progressNotify = null;
      this.notify();
    }, PROGRESS_NOTIFY_MS);
    (this.progressNotify as unknown as { unref?: () => void }).unref?.();
  }


  /**
   * The playlists a connection is not needed for (v1.9.18) — every playlist with at least one
   * complete file on disk, newest request first.
   *
   * This is what the offline browse list and the offline degrade are drawn from: the song lists
   * come from the durable manifests, so the rows are the playlist as it was downloaded, with no
   * Subsonic round trip anywhere in the path. A playlist deliberately removed has no record and is
   * absent here, which is the same rule the download control uses.
   */
  downloadedPlaylists(): DownloadedPlaylist[] {
    const out: DownloadedPlaylist[] = [];
    for (const [playlistId, record] of this.playlists) {
      if (record.done === 0) continue;
      const name = record.name ?? this.manifests.get(playlistId)?.name;
      out.push({ id: playlistId, name: name !== undefined && name !== '' ? name : 'Downloaded playlist', record });
    }
    out.sort((a, b) => (b.record.requestedAt ?? 0) - (a.record.requestedAt ?? 0));
    return out;
  }

  /**
   * Record what a playlist is called, from the one source that knows: the server's own list.
   *
   * It is written into the manifest only when it actually differs, so the playlists screen (which
   * calls this on every successful listing) costs a mirror write once per rename rather than once
   * per visit. A playlist with no manifest is not ours to name — there is no download to label.
   */
  rememberPlaylistName(playlistId: string, name: string): void {
    if (name === '') return;
    const manifest = this.manifests.get(playlistId);
    if (!manifest || manifest.name === name) return;
    manifest.name = name;
    const record = this.playlists.get(playlistId);
    if (record) record.name = name;
    this.saveMirror();
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
        /*
         * **The copy metadata comes across the reconcile (v1.9.22).**
         *
         * `list()` is the truth about the *files*, and it carries the song's title/artist/album/
         * duration only as far as the build that wrote the row passed them — the fields arrived in
         * v1.9.20 (`src/storage/offline.ts:24-38`), so a 1.9.19 index answers with rows that have
         * none. Replacing the map wholesale therefore threw away the one copy that does have them:
         * the mirror's own (which opened the session, and which `repairMetadata` writes back). A
         * repaired row would have been repaired again on every foreground — one round trip per
         * track, for a fact the phone had already been told.
         *
         * So the rows come from `list()` and the *metadata* is filled from what this store already
         * knew. The file, its bytes and its state are the index's; the names are the ones the
         * library answered with.
         */
        const known = new Map(this.rows);
        this.rows.clear();
        for (const row of rows) {
          const previous = known.get(row.songId);
          if (previous !== undefined) this.fillFrom(row, this.songFromRow(previous));
          this.rows.set(row.songId, row);
        }
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
   *
   * `name` is what the playlist was called when the owner asked for it (v1.9.18), and it is stored
   * in the manifest because it is the one fact about a downloaded playlist that cannot be rebuilt
   * from the files afterwards.
   */
  async download(
    playlistId: string,
    songs: Song[],
    options: { allowsCellular?: boolean; name?: string } = {},
  ): Promise<DownloadResult> {
    if (!this.bridge) return { kind: 'started' };
    this.ensureListening();
    const estimate = this.estimate(songs);
    const doneInitially = songs.filter((song) => this.rows.get(song.id)?.state === 'complete').length;
    /*
     * The manifest is written **before** a byte is fetched: `total` is the list that was asked for,
     * so a kill mid-transfer, or a track added to the playlist afterwards, can never reconcile as
     * `done === total` from the completed files alone.
     */
    this.manifests.set(playlistId, { songs, name: options.name, requestedAt: Date.now(), state: 'downloading' });
    const record: PlaylistRecord = {
      state: 'estimating',
      name: options.name ?? this.playlists.get(playlistId)?.name,
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

  /** The one place a song list becomes transfers: audio first (the long pole), then its lyric, then its cover. */
  private async enqueueSongs(playlistId: string, songs: Song[]): Promise<void> {
    if (!this.bridge) return;
    /*
     * **One walk per playlist** (v2.0.0-beta.6). A pass that arrives while another is running joins
     * it: the running pass is enumerating the same manifest, so a second walk would re-enqueue tracks
     * whose transfers are already moving — which is what "the progress climbs and then drops back"
     * was, because a native re-enqueue replaced the transfer it named.
     */
    const running = this.walks.get(playlistId);
    if (running !== undefined) {
      await running;
      return;
    }
    const walk = this.enqueueWalk(playlistId, songs);
    this.walks.set(playlistId, walk);
    try {
      await walk;
    } finally {
      if (this.walks.get(playlistId) === walk) this.walks.delete(playlistId);
    }
  }

  /** One pass over a playlist's manifest. Never entered concurrently for the same playlist. */
  private async enqueueWalk(playlistId: string, songs: Song[]): Promise<void> {
    if (!this.bridge) return;
    for (const song of songs) {
      const existing = this.rows.get(song.id);
      if (existing?.state === 'complete') {
        // Already on disk: add this playlist's ref (S9/S10 — a shared track must survive one
        // playlist's removal) and fetch no audio.
        if (!existing.refs.includes(playlistId)) existing.refs.push(playlistId);
        /*
         * …and record which cover this row belongs to (v1.9.20), if it does not know yet. A row a
         * 1.9.19 build wrote carries no cover id — which is exactly why the owner's existing
         * downloads cannot get their art back without this line and the `coverOf` the art job
         * carries below.
         */
        if (existing.coverArt === undefined || existing.coverArt === '') {
          const cover = song.coverArt ?? song.albumId;
          if (cover !== undefined && cover !== '') existing.coverArt = cover;
        }
      } else {
        this.addRef(song.id, playlistId, song);
        await this.safeEnqueue({
          songId: song.id,
          url: this.downloadUrl(song),
          suffix: song.suffix ?? 'mp3',
          bytes: song.size ?? 0,
          refs: this.rows.get(song.id)?.refs ?? [playlistId],
          title: song.title,
          artist: song.artist ?? '',
          album: song.album ?? '',
          durationSec: song.duration ?? 0,
          // The row's cover id travels with the audio job, so the native index knows it from the
          // song's birth and the art fan-out can match by cover — not only by the `coverOf` list.
          coverArt: song.coverArt ?? song.albumId,
        }, () => {
          const failed = this.rows.get(song.id);
          if (failed) failed.state = 'failed';
          this.schedulePump(playlistId);
        });
      }
      // The lyric rides its own transfer, in the same lane, keyed by its own kind.
      await this.enqueueLyrics(playlistId, song);
      // …and so does the cover, one transfer per distinct cover id, keyed by the cover (§5.4).
      await this.enqueueArt(playlistId, song, songs);
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
    this.clearPump(playlistId);
    record.state = record.done > 0 ? 'partial' : 'failed';
    // A cancelled job is not explaining a failure any more (v2.0.0-beta.6).
    this.lastFailure.delete(playlistId);
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
    this.clearPump(playlistId);
    this.lastFailure.delete(playlistId);
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
    this.disposed = true;
    for (const playlistId of [...this.pumpTimers.keys()]) this.clearPump(playlistId);
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

  /**
   * The one place a job reaches the bridge (v2.0.0-beta.4).
   *
   * Bounded, retried, and never throwing: the loop that builds a playlist's transfer list goes on to
   * the next track whatever this one does. `giveUp` runs only after every attempt has failed, and it
   * is the hook that records the failure *and* asks for the pump.
   */
  private async safeEnqueue(job: DownloadJob, giveUp: () => void): Promise<boolean> {
    if (!this.bridge) return false;
    for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
      try {
        await withTimeout(this.bridge.enqueue(job), this.enqueueTimeoutMs);
        return true;
      } catch {
        if (attempt < ENQUEUE_ATTEMPTS) await delay(ENQUEUE_RETRY_MS * attempt);
      }
    }
    giveUp();
    return false;
  }

  /**
   * Self-completion, without a human tap: a download that is not finished asks again on its own,
   * with a backoff, up to `PUMP_BACKOFF_MS.length` rounds.
   *
   * One timer per playlist while a pass is scheduled; a pass re-runs the same idempotent enumeration
   * the owner's tap does — complete audio, resolved lyrics and settled covers are skipped — so it
   * costs a walk of the list and the few transfers that are actually missing.
   */
  private schedulePump(playlistId: string): void {
    if (!this.bridge || this.disposed || playlistId === '') return;
    if (this.pumpTimers.has(playlistId)) return;
    const round = this.pumpRounds.get(playlistId) ?? 0;
    if (round >= PUMP_BACKOFF_MS.length) return;
    this.pumpRounds.set(playlistId, round + 1);
    const timer = setTimeout(() => {
      this.pumpTimers.delete(playlistId);
      void this.pump(playlistId);
    }, PUMP_BACKOFF_MS[Math.min(round, PUMP_BACKOFF_MS.length - 1)]);
    // A pending pump must not keep a process that is not a browser alive (tests, tools).
    (timer as unknown as { unref?: () => void }).unref?.();
    this.pumpTimers.set(playlistId, timer);
  }

  private clearPump(playlistId: string): void {
    const timer = this.pumpTimers.get(playlistId);
    if (timer !== undefined) clearTimeout(timer);
    this.pumpTimers.delete(playlistId);
    this.pumpRounds.delete(playlistId);
  }

  /** One pump pass — `download()`'s own enumeration, re-run. */
  private async pump(playlistId: string): Promise<void> {
    const record = this.playlists.get(playlistId);
    const manifest = this.manifests.get(playlistId);
    if (!record || !manifest || this.disposed || !this.bridge) return;
    if (record.state === 'complete' || record.state === 'idle') {
      this.pumpRounds.delete(playlistId);
      return;
    }
    record.state = 'downloading';
    this.saveMirror();
    this.notify();
    await this.enqueueSongs(playlistId, manifest.songs);
    this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /** Every row that names this cover reads `failed`, so the next pass re-asks it (art gates nothing). */
  private markArtFailed(cover: string): void {
    const art: ArtRow = { state: 'failed', bytes: 0, fetchedAt: Date.now() };
    for (const row of this.rows.values()) {
      if (row.coverArt !== cover) continue;
      row.art = art;
    }
  }

  private ensureListening(): void {
    if (this.listening || !this.bridge) return;
    this.listening = true;
    void this.bridge.addListener('done', (event) => this.onDone(event)).then((remove) => this.unlisteners.push(remove));
    void this.bridge.addListener('failed', (event) => this.onFailed(event)).then((remove) => this.unlisteners.push(remove));
    void this.bridge.addListener('progress', (event) => this.onProgress(event)).then((remove) => this.unlisteners.push(remove));
  }

  /**
   * A transfer is moving (v2.0.0-beta.5).
   *
   * The event was subscribed to and thrown away ("`addListener('progress', () => undefined)`") for
   * the whole of 1.x: the owner's complaint was not only that he could not see the download, it is
   * that the control could not tell a running job from a dead one and printed `retry` at both. Two
   * facts are taken from it now — the byte count the indicator prints, and the timestamp the stall
   * verdict reads — and neither is authoritative about anything else: `list()` stays the truth, and
   * a `progress` for a song this store has no row for is ignored.
   */
  private onProgress(event: DownloadEvent): void {
    const row = this.rows.get(event.songId);
    if (!row) return;
    if (event.kind === undefined || event.kind === 'audio') {
      if (typeof event.bytes === 'number' && event.bytes >= 0) {
        /*
         * **The figure never goes down while the track is moving** (v2.0.0-beta.6). One URLSession
         * task's own byte count only rises, so a smaller reading for the same track can only come
         * from a *second* task for it — the overlap that made the owner watch the bytes "increment
         * then suddenly regress". Both halves of that overlap are gone (native `enqueue` is a no-op
         * for a live transfer, and one walk per playlist at a time), so keeping the higher of the two
         * numbers is not invented progress: it is the bytes that were actually reported, and with one
         * transfer per key the higher number is always this transfer's own.
         */
        const reported = this.inFlight.get(event.songId) ?? 0;
        this.inFlight.set(event.songId, Math.max(reported, event.bytes));
      }
    }
    for (const playlistId of row.refs) this.touch(playlistId);
  }

  private onDone(event: DownloadEvent): void {
    /*
     * An art transfer's key is a **cover id**, not a song id (§5.4). The lookup below would miss by
     * construction and the event would be dropped on the floor: the rows would stay `pending` for
     * ever, the estimate would never become exact, and no cover would ever reach a screen. So the
     * fan-out happens first, over the rows that carry that cover.
     */
    if (event.kind === 'art') {
      this.onArtDone(event);
      return;
    }
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
      /*
       * The transfer is over, so its last reported count is too (v2.0.0-beta.6): leaving it in the
       * map added a settled transfer's bytes to every later reading of the figure, which is how the
       * control could climb while `done` stood still. The complete row carries those bytes now.
       */
      this.inFlight.delete(event.songId);
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  private onFailed(event: DownloadEvent): void {
    if (event.kind === 'art') {
      this.onArtFailed(event);
      return;
    }
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
      /*
       * The transfer is over, so its count settles with it (v2.0.0-beta.6) — and its own reason is
       * kept for the control before the pump asks again, because a figure that keeps climbing over a
       * track nothing ever completes is one half of the owner's report and a silence is the other.
       */
      this.inFlight.delete(event.songId);
      const failure: DownloadFailure = {
        status: typeof event.status === 'number' ? event.status : undefined,
        error: typeof event.error === 'string' && event.error !== '' ? event.error : 'transfer failed',
        songId: event.songId,
        at: Date.now(),
      };
      for (const playlistId of row.refs) this.lastFailure.set(playlistId, failure);
      /*
       * v2.0.0-beta.4: a failed transfer used to sit there until the owner tapped retry. It goes
       * back through the pump instead, with a backoff, so one flaky track cannot hold a 269-track
       * playlist one short of done for ever.
       */
      for (const playlistId of row.refs) this.schedulePump(playlistId);
    }
    for (const playlistId of row.refs) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /**
   * A cover landed (§5.4). Every row that carries this cover gets the same art row — the file is one
   * per cover, and the rows that name it are what make the file findable (`artPathFor`) and what
   * keep it alive (the native boot sweep deletes a file no row names).
   */
  private onArtDone(event: DownloadEvent): void {
    const cover = event.songId;
    const bytes = typeof event.bytes === 'number' ? event.bytes : 0;
    const art: ArtRow = { state: 'present', file: `${cover}.art`, bytes, fetchedAt: Date.now() };
    let touched = false;
    for (const row of this.rows.values()) {
      if (row.coverArt !== cover) continue;
      row.art = art;
      touched = true;
    }
    if (!touched) {
      /*
       * No row names this cover: the transfer is a fact about a file whose album is not on the phone.
       * The file is not named by the mirror either, so the native sweep collects it (§5.7). Recording
       * nothing is the honest answer — an index row for a song that was never downloaded would be a
       * row claiming a file that is not there.
       */
      return;
    }
    /*
     * v2.0.0-beta.5 — the cover is a transfer of the playlist's own job, so its landing can be what
     * *finishes* the job (`reconcileRecord`: a pending cover holds the record on `downloading`).
     * Without this line the record would stay open until some other event happened to reconcile it,
     * which for the last cover of the last album means "for ever".
     */
    for (const playlistId of this.refsForCover(cover)) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /** Every playlist whose rows name this cover — the fan-out axis for an art event (§5.4). */
  private refsForCover(cover: string): string[] {
    const ids = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.coverArt !== cover) continue;
      for (const ref of row.refs) ids.add(ref);
    }
    return [...ids];
  }

  /**
   * A cover did not land (§5's failure table). It gates nothing: the track plays, the badge stays on,
   * the playlist is not held on `· retry` — a missing cover is a missing picture, not a missing song.
   *
   * A `404` is the library saying this album has no cover at all, which is a fact worth keeping
   * (`none`, zero bytes), so the estimate does not carry a phantom 256 KB for it and the control does
   * not offer to fetch it again for ever. Anything else is `failed`, and a later tap may re-ask.
   */
  private onArtFailed(event: DownloadEvent): void {
    const cover = event.songId;
    const art: ArtRow =
      event.status === 404
        ? { state: 'none', bytes: 0, fetchedAt: Date.now() }
        : { state: 'failed', bytes: 0, fetchedAt: Date.now() };
    let touched = false;
    for (const row of this.rows.values()) {
      if (row.coverArt !== cover) continue;
      row.art = art;
      touched = true;
    }
    if (!touched) return;
    /*
     * v2.0.0-beta.5 — the record **is** reconciled now, and the sentence above still holds: neither
     * `none` nor `failed` counts as pending in `reconcileRecord`, so a cover that will not come
     * leaves the playlist `complete` on audio and lyrics (never `· retry`). What changed is that a
     * job whose last outstanding transfer was this cover must be told the transfer is over, or it
     * would sit on `downloading` for ever waiting for a byte that is not coming.
     */
    for (const playlistId of this.refsForCover(cover)) this.reconcileRecord(playlistId);
    this.saveMirror();
    this.notify();
  }

  /**
   * Enqueue one cover's transfer — one per distinct cover id per download (§5.1, §5.4).
   *
   * `songs` is the whole list being downloaded, and that is what makes the legacy case work: the art
   * job carries `coverOf` (every song id that shares the cover), so the native side can attach the
   * finished cover to rows a 1.9.19 download wrote — rows that have never carried a cover id, whose
   * audio job is never re-enqueued, and which therefore have no other moment at which to learn it.
   *
   * Skips a cover that is already resolved (`present`) or recorded as absent (`none`), and one whose
   * transfer is already in flight (`pending`), so calling this for every track of an album enqueues
   * exactly one transfer. A `failed` row is re-asked: the only way this runs is a tap the owner made.
   */
  private async enqueueArt(playlistId: string, song: Song, songs: Song[]): Promise<void> {
    if (!this.bridge) return;
    const row = this.rows.get(song.id);
    if (!row) return;
    const cover = song.coverArt ?? song.albumId;
    if (cover === undefined || cover === '') return; // nothing to fetch
    const known = artRowForCover(this.rows, cover);
    if (known && known.state !== 'failed') return;
    const url = this.artUrl(cover);
    if (url === null || url === '') return;
    const coverOf = songs
      .filter((entry) => (entry.coverArt ?? entry.albumId) === cover)
      .map((entry) => entry.id);
    // The association is recorded here, before a byte moves: it is what maps the finished file back
    // to these rows, both in this session and in the mirror the next launch reads.
    for (const songId of coverOf) {
      const sibling = this.rows.get(songId);
      if (sibling) {
        sibling.coverArt = cover;
        sibling.art = { state: 'pending', bytes: 0 };
      }
    }
    await this.safeEnqueue({
      songId: cover,
      url,
      suffix: 'art',
      // No byte count is known before the transfer starts, and inventing one would be a lie. Native
      // verifies against the response's own `Content-Length` and records the measured bytes back.
      bytes: 0,
      refs: row.refs,
      title: song.album ?? song.title,
      artist: song.artist ?? '',
      album: song.album ?? '',
      durationSec: 0,
      coverArt: cover,
      coverOf,
    }, () => {
      /*
       * The cover was never asked for. `failed` — not `pending` — is what makes the pump's next pass
       * re-ask it: a `pending` row is skipped by design, and that skip is why these covers used to
       * need a second tap.
       */
      this.markArtFailed(cover);
      this.schedulePump(playlistId);
    });
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
  private async enqueueLyrics(playlistId: string, song: Song): Promise<void> {
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
    await this.safeEnqueue({
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
      // The lyric row is an index row too, so it carries the cover id (v1.9.20): whichever of the
      // three transfers writes this song's row first, the row knows its cover.
      coverArt: song.coverArt ?? song.albumId,
    }, () => {
      const stuck = this.rows.get(song.id);
      if (stuck) stuck.lyrics = { state: 'failed', bytes: 0, fetchedAt: Date.now() };
      this.schedulePump(playlistId);
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
    const cover = song.coverArt ?? song.albumId;
    if (existing) {
      if (!existing.refs.includes(playlistId)) existing.refs.push(playlistId);
      existing.state = 'staging';
      if (existing.coverArt === undefined || existing.coverArt === '') existing.coverArt = cover;
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
      coverArt: cover,
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
    // A reconcile is the job saying something: every caller is one of its own events or a pass of
    // its own, and that is exactly what the stall window reads (v2.0.0-beta.5).
    this.touch(playlistId);
    let done = 0;
    let staging = 0;
    let lyricPending = 0;
    let lyricFailed = 0;
    const covers = new Set<string>();
    for (const song of record.songs) {
      const row = this.rows.get(song.id);
      const state = row?.state;
      if (state === 'complete') done += 1;
      else if (state === 'staging') staging += 1;
      const lyric = row?.lyrics?.state;
      if (lyric === 'pending') lyricPending += 1;
      else if (lyric === 'failed') lyricFailed += 1;
      const cover = row?.coverArt ?? song.coverArt ?? song.albumId;
      if (cover !== undefined && cover !== '') covers.add(cover);
    }
    /*
     * v2.0.0-beta.5 — **the covers are part of the finish, not a second step.**
     *
     * The owner: "once the download of the playlist completes, the button text still changes to
     * download covers which i then have to click on". The job had always enqueued the art
     * (`enqueueArt`, in the same tap); what was wrong is that this method declared the playlist
     * `complete` as soon as the **audio** was in, while the covers it had just asked for were still
     * `pending`. `missingCovers()` then answered "> 0" for a job that was still running, and the
     * control printed `✓ 4.8 GB · ↓ covers` — a second tap offered for work already in flight. A
     * cover still in flight is a transfer of this job, so it holds the record on `downloading`
     * exactly as a `staging` track does. A cover that has settled (`present`, `none`) or genuinely
     * failed does **not** hold it: a missing picture must never leave a playlist on `· retry` for
     * ever (the rule `onArtFailed` states), and a failed cover is re-asked by the pump.
     */
    let artPending = 0;
    for (const cover of covers) {
      if (artRowForCover(this.rows, cover)?.state === 'pending') artPending += 1;
    }
    record.done = done;
    if (done === record.total && record.total > 0) {
      // Audio all in; the playlist is complete only when every other transfer of the same job is in.
      if (lyricPending > 0 || artPending > 0) record.state = 'downloading';
      else if (lyricFailed > 0) record.state = 'partial'; // one small transfer to retry
      else record.state = 'complete';
    } else if (staging > 0 || artPending > 0) {
      record.state = 'downloading';
    } else {
      record.state = done > 0 ? 'partial' : 'failed';
    }
    // A job that has finished has nothing left to explain (v2.0.0-beta.6): the failure line goes
    // with the last transfer that caused it, so a completed download never reads `· failed: …`.
    if (record.state === 'complete') this.lastFailure.delete(playlistId);
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
        name: manifest.name,
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
    const rows: Record<string, OfflineMirror['rows'][string]> = {};
    for (const [songId, row] of this.rows) {
      rows[songId] = {
        path: row.path,
        bytes: row.bytes,
        state: row.state,
        // Carried so the browse list and the badge are correct on the first paint of the next
        // launch, with no round trip (§4.3). Every one is optional in the mirror, so a 1.9.19
        // mirror is still written as a 1.9.20 one and still parses.
        title: row.title,
        artist: row.artist,
        album: row.album,
        coverArt: row.coverArt,
        durationSec: row.durationSec,
        // `fetchedAt` is written or a `none` row answers `miss` again on the next launch.
        lyrics: row.lyrics ? { state: row.lyrics.state, bytes: row.lyrics.bytes, fetchedAt: row.lyrics.fetchedAt } : undefined,
        // The art file is named by cover, and the row is how the next launch finds it (§5.7).
        art: row.art ? { state: row.art.state, file: row.art.file, bytes: row.art.bytes, fetchedAt: row.art.fetchedAt } : undefined,
      };
    }
    const playlists: Record<string, OfflinePlaylistManifest> = {};
    for (const [playlistId, manifest] of this.manifests) playlists[playlistId] = manifest;
    saveMirror({ v: 1, hydratedAt: Date.now(), rows, playlists }, this.store);
  }
}
