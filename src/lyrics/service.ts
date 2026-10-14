/**
 * The lyrics facade the UI talks to.
 *
 * Two behaviours it owns, both about the owner's library being the only source:
 *   - the cache is consulted first, so flipping between Spectrum and Lyrics is instant and
 *     a track's text is fetched once per visit;
 *   - the answer is per **track**, and "the library has no lyrics for this track" is cached
 *     too (briefly — `LyricsCache` expires misses in minutes), so a sidecar that lands later
 *     is picked up without re-asking on every visit.
 *
 * Both handles are getters rather than values: the lyrics service is created with the shell,
 * before anyone has connected — and the route (`ctx.sidecar`) only exists once a library has
 * been reached (`src/api/sidecar.ts`).
 */
import { fetchLyrics, type LyricsDoc, type LyricsSource } from '../api/lyrics.ts';
import type { SidecarSource } from '../api/sidecar.ts';
import type { Song } from '../api/types.ts';
import type { LyricsStore } from '../storage/lyrics.ts';
import type { OfflineStore } from '../state/offline.ts';

export class LyricsService {
  private readonly cache: LyricsStore;
  private readonly library: () => LyricsSource | null;
  private readonly sidecar: () => SidecarSource | null;
  private readonly offline: () => OfflineStore | null;
  private readonly inflight = new Map<string, Promise<LyricsDoc | null>>();

  constructor(
    cache: LyricsStore,
    library: () => LyricsSource | null,
    sidecar: () => SidecarSource | null = () => null,
    offline: () => OfflineStore | null = () => null,
  ) {
    this.cache = cache;
    this.library = library;
    this.sidecar = sidecar;
    this.offline = offline;
  }

  /** Lyrics for a track, from the device cache when it has them. Null = none to show. */
  async lyricsFor(song: Song): Promise<LyricsDoc | null> {
    const cached = this.cache.get(song.id);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(song.id);
    if (existing) return existing;
    const promise = this.load(song);
    this.inflight.set(song.id, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(song.id);
    }
  }

  /** Wipe the on-device copy (Settings → "Clear cached lyrics"). */
  forget(): void {
    this.cache.clear();
  }

  get cachedTracks(): number {
    return this.cache.size;
  }

  private async load(song: Song): Promise<LyricsDoc | null> {
    /*
     * Step ② (v1.9.12): the durable offline copy, between the view cache and the network. A
     * `present` row reads the stored body off disk and parses it with the same `fromSidecar` the
     * route's bytes go through — no network, and the timing already lives in the doc. A `none` row
     * inside its freshness window returns `null` with no request at all; anything else falls
     * through to today's sources unchanged.
     */
    const offline = this.offline();
    if (offline) {
      const resolution = await offline.lyricsDoc(song.id);
      if (resolution.kind === 'present') {
        this.cache.set(song.id, resolution.doc);
        return resolution.doc;
      }
      if (resolution.kind === 'none-fresh') return null;
    }
    try {
      const doc = await fetchLyrics(song, this.library(), this.sidecar());
      this.cache.set(song.id, doc);
      return doc;
    } catch {
      return null;
    }
  }
}
