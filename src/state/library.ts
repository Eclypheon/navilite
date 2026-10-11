/** Library reads, with a small cache so navigating back and forth stays instant. */
import { SubsonicClient } from '../api/subsonic.ts';
import type { Album, AlbumWithSongs, Artist, ArtistWithAlbums, Playlist, PlaylistWithEntries, SearchResult3, Song, StarKind, Starred2 } from '../api/types.ts';
import type { ThroughputSample } from './bitrate.ts';

export type AlbumListType = 'alphabeticalByName' | 'newest' | 'recent' | 'frequent' | 'starred';

/**
 * How much of the *next* track is pulled ahead of time (v1.9.0, queue-ahead).
 *
 * Half a megabyte is roughly 30 s of a 128 kbps stream and a handful of seconds of a 320 — far
 * more than the "token few KB" the ask rules out. The transfer is measured as it goes, which is
 * where the app's only honest reading of the link comes from (`src/state/bitrate.ts`).
 */
export const PREFETCH_BYTES = 512 * 1024;

export class Library {
  client: SubsonicClient;
  private artistCache: Artist[] | null = null;
  private albumListCache = new Map<string, Album[]>();
  private albumCache = new Map<string, AlbumWithSongs>();
  private artistDetailCache = new Map<string, ArtistWithAlbums>();
  private playlistCache = new Map<string, PlaylistWithEntries>();
  private starredCache: Starred2 | null = null;

  constructor(client: SubsonicClient) {
    this.client = client;
  }

  get crossOrigin(): boolean {
    return this.client.isCrossOrigin;
  }

  coverUrl(coverArtId: string | undefined, size = 512): string | null {
    return coverArtId ? this.client.coverArtUrl(coverArtId, size) : null;
  }

  /**
   * The audio URL for a track — with the bitrate cap, when there is one (v1.9.0).
   *
   * `maxBitRate` is the whole of the slow-link fix: Navidrome transcodes to that rate on demand,
   * the parameter is per request, and nothing about the server changes. `undefined` means the
   * original file, which is what a link that has been measured as fast gets.
   */
  streamUrl(song: Song, maxBitRate?: number | null): string {
    return this.client.streamUrl(song.id, maxBitRate == null ? {} : { maxBitRate });
  }

  /**
   * Pull the head of the next track while the current one plays (v1.9.0, queue-ahead).
   *
   * What this buys on the link the owner actually has — a phone off wifi, reaching the house
   * through a relay:
   *   - the TCP/TLS connection to the server is opened and warmed *now*, so the stream that
   *     follows does not pay a full round trip through the relay before its first byte arrives;
   *   - Navidrome has already started transcoding the next track, so the request that matters
   *     answers from work that is already done;
   *   - and the bytes that come back are the app's only real measurement of the link, which is
   *     what the bitrate decision is built on.
   *
   * What it deliberately does *not* do: touch the queue, change what is playing, or re-order
   * anything. It reads `url` and reports one sample. `signal` is the cancellation — a prefetch the
   * listener has moved on from is aborted, so exactly one of these is ever in flight.
   */
  async prefetch(url: string, signal: AbortSignal, onSample: (sample: ThroughputSample) => void): Promise<void> {
    const started = Date.now();
    let bytes = 0;
    try {
      const response = await fetch(url, {
        signal,
        // The head of the file, not the whole of it: the buffer is for the start of the next track.
        headers: { Range: `bytes=0-${PREFETCH_BYTES - 1}` },
      });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value?.byteLength ?? 0;
        if (bytes >= PREFETCH_BYTES) {
          // Enough is enough: the rest of the track belongs to the player, later.
          await reader.cancel();
          break;
        }
      }
      onSample({ bytes, ms: Date.now() - started });
    } catch {
      /*
       * A cancelled prefetch is not an error and must not reach the console as one, and a failed
       * one is not worth a warning either: it is an optimisation, and the player's own load is
       * what has to work. Nothing is reported and nothing is retried.
       */
    }
  }

  invalidate(): void {
    this.artistCache = null;
    this.albumListCache.clear();
    this.albumCache.clear();
    this.artistDetailCache.clear();
    this.playlistCache.clear();
    this.starredCache = null;
  }

  async artists(): Promise<Artist[]> {
    if (!this.artistCache) this.artistCache = await this.client.getArtists();
    return this.artistCache;
  }

  async albumList(type: AlbumListType, size = 100): Promise<Album[]> {
    const key = `${type}:${size}`;
    const cached = this.albumListCache.get(key);
    if (cached) return cached;
    const albums = await this.client.getAlbumList2(type, { size });
    this.albumListCache.set(key, albums);
    return albums;
  }

  async album(id: string): Promise<AlbumWithSongs> {
    const cached = this.albumCache.get(id);
    if (cached) return cached;
    const album = await this.client.getAlbum(id);
    this.albumCache.set(id, album);
    return album;
  }

  async artist(id: string): Promise<ArtistWithAlbums> {
    const cached = this.artistDetailCache.get(id);
    if (cached) return cached;
    const artist = await this.client.getArtist(id);
    this.artistDetailCache.set(id, artist);
    return artist;
  }

  async playlists(): Promise<Playlist[]> {
    return this.client.getPlaylists();
  }

  async playlist(id: string): Promise<PlaylistWithEntries> {
    const cached = this.playlistCache.get(id);
    if (cached) return cached;
    const playlist = await this.client.getPlaylist(id);
    this.playlistCache.set(id, playlist);
    return playlist;
  }

  async starred(): Promise<Starred2> {
    if (!this.starredCache) this.starredCache = await this.client.getStarred2();
    return this.starredCache;
  }

  async search(query: string): Promise<SearchResult3> {
    return this.client.search3(query);
  }

  async setStarred(id: string, kind: StarKind, starred: boolean): Promise<void> {
    if (starred) await this.client.star(id, kind);
    else await this.client.unstar(id, kind);
    this.starredCache = null;
    if (kind === 'album') this.albumListCache.delete('starred:100');
    if (kind === 'artist') this.artistDetailCache.delete(id);
    if (kind === 'album') this.albumCache.delete(id);
  }

  async createPlaylist(name: string, songIds: string[]): Promise<void> {
    await this.client.createPlaylist(name, songIds);
  }

  async addToPlaylist(playlistId: string, songIds: string[]): Promise<void> {
    await this.client.updatePlaylist(playlistId, { addSongIds: songIds });
    this.playlistCache.delete(playlistId);
  }

  async removeFromPlaylist(playlistId: string, index: number): Promise<void> {
    await this.client.updatePlaylist(playlistId, { removeIndexes: [index] });
    this.playlistCache.delete(playlistId);
  }
}
