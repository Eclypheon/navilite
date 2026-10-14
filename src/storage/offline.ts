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
export interface OfflineMirrorRow {
  /** The `file://` URL of the verified file, as the native side reported it. */
  path: string;
  /** The actual bytes written, verified against `Content-Length`. */
  bytes: number;
  state: 'complete' | 'staging' | 'failed';
  /**
   * The lyrics axis, stored beside the audio row (v1.9.12). Never the text — the `.lyrics` file
   * holds the raw body and is parsed at read time; this is only the state and the measured bytes,
   * so the resolver and the estimator answer synchronously.
   */
  lyrics?: { state: 'pending' | 'present' | 'none' | 'failed'; bytes: number };
}

export interface OfflineMirror {
  v: number;
  /** When the mirror was written, for diagnostics. */
  hydratedAt: number;
  rows: Record<string, OfflineMirrorRow>;
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
  try {
    const probe = '__navilite_offline_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  }
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
      lyrics = { state: r.lyrics.state, bytes: r.lyrics.bytes };
    }
    rows[songId] = { path: r.path, bytes: r.bytes, state: r.state, lyrics };
  }
  return { v: OFFLINE_MIRROR_VERSION, hydratedAt: candidate.hydratedAt ?? Date.now(), rows };
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
