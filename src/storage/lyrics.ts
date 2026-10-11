/**
 * The on-device lyrics cache.
 *
 * Lyrics are copyrighted and the repository is public, so they are never committed, never
 * bundled into `dist/`, and never shipped inside the APK/IPA. What lives here is a copy on
 * the device that asked for them — the same thing a browser cache or a music app's local
 * library has always done — and it is plain `localStorage` so a user can clear it by
 * clearing site data (the app also offers "Clear cached lyrics" in Settings).
 *
 * Do not fetch them from an outside service.
 *
 * "No lyrics for this track" is cached too, briefly: otherwise every track without lyrics
 * would re-ask the library on every visit. But a miss is a **snapshot, not a fact** — Navi is
 * still writing sidecars, and the owner hit exactly this: tracks he opened before the corpus
 * existed stayed blank. So a miss lives for minutes, and a hit for a week: the route serves
 * the file as it is *now*, and a `.txt` sidecar that is later upgraded to a timed `.lrc` has
 * to be able to appear without anyone clearing anything.
 */
import type { LyricsDoc } from '../api/lyrics.ts';

const STORAGE_KEY = 'navilite.lyrics.v1';
const MAX_ENTRIES = 200;
/**
 * v1.3: a week, not a month. Sidecars are being written (202 → 355 in one session on
 * 2026-10-11), and a timed `.lrc` landing next to a track whose `.txt` was already read has to
 * show up as a highlight within a week rather than never.
 */
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * v1.3: five minutes, not six hours. This is the fix for "tracks I opened before the corpus
 * existed stayed blank": the shortest honest window that still keeps a library full of
 * sidecar-less tracks from re-asking on every scroll past. It also means a miss written by an
 * older build is already expired when this one starts.
 */
const MISS_TTL_MS = 5 * 60 * 1000;

interface Entry {
  key: string;
  at: number;
  doc: LyricsDoc | null;
}

export class LyricsCache {
  private entries = new Map<string, Entry>();
  private readonly store: Pick<Storage, 'getItem' | 'setItem'> | null;
  private readonly now: () => number;

  constructor(
    store: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStore(),
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.now = now;
    this.load();
  }

  /** `undefined` = not cached (or expired); `null` = cached "no lyrics for this track". */
  get(key: string): LyricsDoc | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ttl = entry.doc === null ? MISS_TTL_MS : HIT_TTL_MS;
    if (this.now() - entry.at > ttl) {
      this.entries.delete(key);
      this.persist();
      return undefined;
    }
    return entry.doc;
  }

  set(key: string, doc: LyricsDoc | null): void {
    this.entries.delete(key);
    this.entries.set(key, { key, at: this.now(), doc });
    if (this.entries.size > MAX_ENTRIES) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.persist();
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }

  get size(): number {
    return this.entries.size;
  }

  private load(): void {
    if (!this.store) return;
    try {
      const raw = this.store.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed as Entry[]) {
        if (typeof item?.key === 'string' && typeof item?.at === 'number') this.entries.set(item.key, item);
      }
    } catch {
      // A corrupt cache is not worth a startup failure: start empty.
      this.entries.clear();
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.setItem(STORAGE_KEY, JSON.stringify([...this.entries.values()]));
    } catch {
      // Out of quota, or storage disabled: the cache is an optimisation, not a feature.
    }
  }
}

/** What the lyrics service needs from a cache, so tests can pass a fake. */
export type LyricsStore = Pick<LyricsCache, 'get' | 'set' | 'clear' | 'size'>;

function defaultStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
