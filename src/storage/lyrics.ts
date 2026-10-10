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
 * would re-ask the library on every visit. And Navi is still writing sidecars, so a miss
 * expires much sooner than a hit — a track that gains lyrics later gets picked up.
 */
import type { LyricsDoc } from '../api/lyrics.ts';

const STORAGE_KEY = 'navilite.lyrics.v1';
const MAX_ENTRIES = 200;
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;

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
