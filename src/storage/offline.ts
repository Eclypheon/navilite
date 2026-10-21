/**
 * The offline mirror: a localStorage cache of the native download index.
 *
 * Why it exists at all: invariant 1 of the offline design — the audible path is synchronous.
 * `Library.streamUrl` must be able to answer "is there a local copy, and where" without a
 * filesystem call, an HTTP call or an `await`, so the whole of the answer the resolver needs is
 * kept in an in-memory map. This file is the *persistence* half of that map: it survives a
 * relaunch so the first `startCurrent` of a session already resolves local.
 *
 * It is deliberately a **cache**, not the truth. The native `index.json` is the truth about what
 * is on disk; this mirror is rewritten after boot reconcile, after every `done`/`failed` event and
 * after any removal. A stale mirror is a performance bug, never a correctness bug: the resolver
 * only trusts a row that says `complete`, and the store re-checks it against the native index on
 * boot, dropping rows whose files are gone.
 */
import type { Song } from '../api/types.ts';
import { availableLocalStorage } from './local-store.ts';

export interface OfflineMirrorRow {
  /** The `file://` URL of the verified file, as the native side reported it. */
  path: string;
  /** The actual bytes written, verified against `Content-Length`. */
  bytes: number;
  state: 'complete' | 'staging' | 'failed';
  /**
   * Copy metadata (v1.9.20). Optional, on the same rule as everything the mirror carries: a row
   * written by 1.9.19 parses exactly as it always did (`title` absent → the browse list draws the
   * id for one paint, until the next `saveMirror` writes it).
   *
   * Why it is here at all: the mockless first paint is local, and the downloaded-songs list has to
   * print **titles**, not a column of blanks for the length of a `bridge.list()` round trip. Making
   * the view wait for that round trip is the 1.9.19 defect, rebuilt in a new place.
   */
  title?: string;
  artist?: string;
  album?: string;
  /** The row's cover id, so the art file can be found by cover rather than by song (§5). */
  coverArt?: string;
  durationSec?: number;
  /**
   * The lyrics axis, stored beside the audio row (v1.9.12). Never the text — the `.lyrics` file
   * holds the raw body and is parsed at read time; this is only the state and the measured bytes,
   * so the resolver and the estimator answer synchronously.
   *
   * `fetchedAt` is carried for the `none` staleness window: without it a "no lyrics" row answers
   * `miss` on the first lyrics open of every session and re-asks the network for a fact the store
   * already recorded.
   */
  lyrics?: { state: 'pending' | 'present' | 'none' | 'failed'; bytes: number; fetchedAt?: number };
  /**
   * The art axis (v1.9.20): state, file name and measured bytes, keyed by cover. Optional, like
   * everything a 1.9.19 row does not have.
   */
  art?: { state: 'pending' | 'present' | 'none' | 'failed'; file?: string; bytes: number; fetchedAt?: number };
}

/**
 * A playlist's durable manifest, stored beside the rows (v1.9.12). The store's `record()` is
 * derived from it — `total` is the manifest's length, never the number of completed files, so a
 * download killed mid-flight (or a playlist a track was added to) can never reconcile as complete.
 * `state: 'downloading'` is the resume flag: only a manifest the owner did not cancel is re-enqueued
 * on the next foreground.
 */
export interface OfflinePlaylistManifest {
  /** The songs the playlist held when the download was requested — the durable half of `total`. */
  songs: Song[];
  /**
   * The playlist's name as the server reported it (v1.9.18). It is the one piece of a downloaded
   * playlist the song rows cannot carry, and without it the offline browse list could only show
   * playlist ids — which are opaque strings, not names. Optional: a manifest written by an older
   * build has none, and the UI falls back rather than inventing one.
   */
  name?: string;
  /** When the download was requested, for diagnostics. */
  requestedAt: number;
  /** `downloading` until it finishes or is cancelled; `partial`/`complete` never auto-resume. */
  state: 'downloading' | 'complete' | 'partial';
}

export interface OfflineMirror {
  v: number;
  /** When the mirror was written, for diagnostics. */
  hydratedAt: number;
  rows: Record<string, OfflineMirrorRow>;
  /** One manifest per playlist that was downloaded or is being downloaded. */
  playlists?: Record<string, OfflinePlaylistManifest>;
}

/** Just the part of `Storage` this needs, so a test can pass a plain object. */
export interface MirrorStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const OFFLINE_MIRROR_VERSION = 1;
export const OFFLINE_MIRROR_KEY = 'navilite.offline';

/** `localStorage` when it exists and works, otherwise a store that quietly keeps nothing. */
export function mirrorStore(): MirrorStore {
  return (
    availableLocalStorage('__navilite_offline_probe__') ?? {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }
  );
}

/** Parse and validate a stored mirror. Returns null for anything that cannot be trusted. */
export function parseMirror(raw: string | null): OfflineMirror | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<OfflineMirror>;
  if (candidate.v !== OFFLINE_MIRROR_VERSION) return null;
  if (typeof candidate.rows !== 'object' || candidate.rows === null || Array.isArray(candidate.rows)) return null;
  const rows: Record<string, OfflineMirrorRow> = {};
  for (const [songId, row] of Object.entries(candidate.rows)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<OfflineMirrorRow>;
    if (typeof r.path !== 'string' || r.path.length === 0) continue;
    if (typeof r.bytes !== 'number') continue;
    if (r.state !== 'complete' && r.state !== 'staging' && r.state !== 'failed') continue;
    let lyrics: OfflineMirrorRow['lyrics'];
    if (
      r.lyrics &&
      typeof r.lyrics === 'object' &&
      (r.lyrics.state === 'pending' || r.lyrics.state === 'present' || r.lyrics.state === 'none' || r.lyrics.state === 'failed') &&
      typeof r.lyrics.bytes === 'number'
    ) {
      lyrics = {
        state: r.lyrics.state,
        bytes: r.lyrics.bytes,
        // Carried, not dropped: a `none` row without it would be re-asked every session.
        fetchedAt: typeof r.lyrics.fetchedAt === 'number' ? r.lyrics.fetchedAt : undefined,
      };
    }
    /*
     * The art axis, on exactly the lyrics rule: kept only when it is well-formed enough to trust, and
     * **dropped rather than defaulted** when it is not — a row that claims `present` with no file name
     * would send `artPathFor` looking for a file that cannot be named, and the honest answer for a
     * row we cannot read is "no art", which the network URL then fills.
     */
    let art: OfflineMirrorRow['art'];
    if (
      r.art &&
      typeof r.art === 'object' &&
      (r.art.state === 'pending' || r.art.state === 'present' || r.art.state === 'none' || r.art.state === 'failed') &&
      typeof r.art.bytes === 'number' &&
      (r.art.state !== 'present' || (typeof r.art.file === 'string' && r.art.file !== ''))
    ) {
      art = {
        state: r.art.state,
        file: typeof r.art.file === 'string' && r.art.file !== '' ? r.art.file : undefined,
        bytes: r.art.bytes,
        fetchedAt: typeof r.art.fetchedAt === 'number' ? r.art.fetchedAt : undefined,
      };
    }
    rows[songId] = {
      path: r.path,
      bytes: r.bytes,
      state: r.state,
      // The metadata (v1.9.20) is passed through only as far as it is usable: an empty title is the
      // same fact as no title, and the store treats both the same way.
      title: typeof r.title === 'string' ? r.title : undefined,
      artist: typeof r.artist === 'string' ? r.artist : undefined,
      album: typeof r.album === 'string' ? r.album : undefined,
      coverArt: typeof r.coverArt === 'string' && r.coverArt !== '' ? r.coverArt : undefined,
      durationSec: typeof r.durationSec === 'number' ? r.durationSec : undefined,
      lyrics,
      art,
    };
  }
  return { v: OFFLINE_MIRROR_VERSION, hydratedAt: candidate.hydratedAt ?? Date.now(), rows, playlists: parseManifests(candidate.playlists) };
}

/** The playlist manifests, kept only where they are well-formed enough to trust. */
function parseManifests(value: unknown): Record<string, OfflinePlaylistManifest> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const playlists: Record<string, OfflinePlaylistManifest> = {};
  for (const [playlistId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const manifest = entry as Partial<OfflinePlaylistManifest>;
    if (manifest.state !== 'downloading' && manifest.state !== 'complete' && manifest.state !== 'partial') continue;
    if (!Array.isArray(manifest.songs)) continue;
    const songs = manifest.songs.filter((song): song is Song => typeof song === 'object' && song !== null && typeof (song as Song).id === 'string');
    if (songs.length !== manifest.songs.length || songs.length === 0) continue;
    playlists[playlistId] = {
      songs,
      // A name is carried only when it is a usable one; anything else reads as "not recorded".
      name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : undefined,
      requestedAt: typeof manifest.requestedAt === 'number' ? manifest.requestedAt : Date.now(),
      state: manifest.state,
    };
  }
  return Object.keys(playlists).length > 0 ? playlists : undefined;
}

export function loadMirror(store: MirrorStore = mirrorStore()): OfflineMirror | null {
  try {
    return parseMirror(store.getItem(OFFLINE_MIRROR_KEY));
  } catch {
    return null;
  }
}

export function saveMirror(mirror: OfflineMirror, store: MirrorStore = mirrorStore()): void {
  try {
    store.setItem(OFFLINE_MIRROR_KEY, JSON.stringify({ ...mirror, v: OFFLINE_MIRROR_VERSION }));
  } catch {
    // A full or unavailable store is not a playback failure.
  }
}

export function clearMirror(store: MirrorStore = mirrorStore()): void {
  try {
    store.removeItem(OFFLINE_MIRROR_KEY);
  } catch {
    // Nothing to do.
  }
}
