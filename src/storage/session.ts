/**
 * The resume snapshot: what was playing, exactly where, and the queue it was in.
 *
 * Why this exists at all (v1.7): the server's `savePlayQueue` is *eventual* — it is sent debounced on
 * a track change, five seconds after the fact — so a cold start restored "the right track, from the
 * top". The owner's report is that resume is already correct in the ordinary case (v1.6's queue fix)
 * and must stay that way; what makes it exact is a snapshot written **locally, on the device, while
 * the track plays**, so a relaunch lands on the same second of the same track and never rebuilds the
 * queue from whatever the server happened to have.
 *
 * What it holds is deliberately the whole of a resumable session:
 *   - the queue itself (the songs), so a restore does not need the network — and therefore cannot
 *     come back as a *different* queue because the server's copy was older;
 *   - the play **order** and the cursor into it, so a shuffled queue comes back in the same order
 *     rather than being re-shuffled at launch;
 *   - the position and whether it was playing.
 *
 * Nothing secret is in here: no credentials, no tokens — the stream URLs are not stored either
 * (they are rebuilt from the settings, at play time).
 *
 * `songs` is the only bulk in it (a queue of a few hundred tracks is well under 200 KB), and a write
 * is a single `localStorage.setItem` on a 5-second tick, which is what makes "exact" affordable.
 */
import type { QueueContext, Song } from '../api/types.ts';
import { isRepeatMode, type RepeatMode } from '../state/queue.ts';
import { availableLocalStorage } from './local-store.ts';

/** Just the part of `Storage` this needs, so a test can pass a plain object. */
export interface SnapshotStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Bumped when the shape changes. An older snapshot is *ignored*, never half-read: a queue restored
 * from a shape this build does not understand would be worse than no resume at all.
 */
export const SNAPSHOT_VERSION = 2;

export const SNAPSHOT_KEY = 'navilite.resume';

export interface ResumeSnapshot {
  v: number;
  /** When the snapshot was written, for the age check below. */
  savedAt: number;
  songId: string;
  positionMs: number;
  playing: boolean;
  /** The queue in queue order. */
  songs: Song[];
  /** The play order: a permutation of indexes into `songs`. */
  order: number[];
  /** Where we were in `order`. */
  cursor: number;
  shuffle: boolean;
  repeat: RepeatMode;
  context: QueueContext | null;
}

/**
 * How old a snapshot may be and still be resumed. A queue left overnight is not a session anyone
 * expects to find playing, and the server's own `savePlayQueue` is still there for that case.
 */
export const SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** A permutation check, because a corrupt `order` would index past the queue. */
function isPermutation(order: unknown, length: number): order is number[] {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set<number>();
  for (const value of order) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) return false;
    if (seen.has(value)) return false;
    seen.add(value);
  }
  return true;
}

/**
 * Parse and validate a stored snapshot. Returns null for anything that cannot be resumed exactly —
 * an old shape, a corrupt queue, a position past the end — rather than a partial restore.
 */
export function parseSnapshot(raw: string | null, now = Date.now()): ResumeSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ResumeSnapshot>;
  if (candidate.v !== SNAPSHOT_VERSION) return null;
  if (typeof candidate.savedAt !== 'number' || now - candidate.savedAt > SNAPSHOT_MAX_AGE_MS) return null;
  if (!Array.isArray(candidate.songs) || candidate.songs.length === 0) return null;
  if (!candidate.songs.every((song) => typeof song?.id === 'string' && song.id.length > 0)) return null;
  if (typeof candidate.songId !== 'string' || candidate.songId.length === 0) return null;
  if (!isPermutation(candidate.order, candidate.songs.length)) return null;
  const cursor = candidate.cursor;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0 || cursor >= candidate.order.length) return null;
  if (typeof candidate.positionMs !== 'number' || !Number.isFinite(candidate.positionMs) || candidate.positionMs < 0) return null;
  if (candidate.order[cursor] === undefined) return null;
  return {
    v: SNAPSHOT_VERSION,
    savedAt: candidate.savedAt,
    songId: candidate.songId,
    positionMs: candidate.positionMs,
    playing: candidate.playing === true,
    songs: candidate.songs,
    order: candidate.order,
    cursor,
    shuffle: candidate.shuffle === true,
    repeat: isRepeatMode(candidate.repeat) ? candidate.repeat : 'off',
    context: candidate.context ?? null,
  };
}

/** `localStorage` when it exists and works, otherwise a store that quietly keeps nothing. */
export function browserStore(): SnapshotStore {
  return (
    availableLocalStorage('__navilite_probe__') ?? {
      // Private mode, a disabled store, or a non-browser runtime: resume is simply off.
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }
  );
}

export function loadSnapshot(store: SnapshotStore = browserStore(), now = Date.now()): ResumeSnapshot | null {
  try {
    return parseSnapshot(store.getItem(SNAPSHOT_KEY), now);
  } catch {
    return null;
  }
}

export function saveSnapshot(snapshot: Omit<ResumeSnapshot, 'v'> & { v?: number }, store: SnapshotStore = browserStore()): void {
  try {
    store.setItem(SNAPSHOT_KEY, JSON.stringify({ ...snapshot, v: SNAPSHOT_VERSION }));
  } catch {
    // A full or unavailable store is not a playback failure.
  }
}

export function clearSnapshot(store: SnapshotStore = browserStore()): void {
  try {
    store.removeItem(SNAPSHOT_KEY);
  } catch {
    // Nothing to do.
  }
}
