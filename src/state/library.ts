/** Library reads, with a small cache so navigating back and forth stays instant. */
import { SubsonicClient } from '../api/subsonic.ts';
import type { Album, AlbumWithSongs, Artist, ArtistWithAlbums, Playlist, PlaylistWithEntries, SearchResult3, Song, StarKind, Starred2 } from '../api/types.ts';

export type AlbumListType = 'alphabeticalByName' | 'newest' | 'recent' | 'frequent' | 'starred';

/**
 * How many entries each detail cache may hold (v1.9.7).
 *
 * `albumCache`, `artistDetailCache` and `playlistCache` were evicted only by {@link Library.invalidate}
 * — i.e. on a sign-out or a change of server — so a session that browsed enough albums, artists and
 * playlists held every one of them, with its whole song list, for the rest of the session. Thirty is
 * more than a screen's worth of back-and-forth, which is the whole of what the cache is for.
 */
const DETAIL_CACHE_LIMIT = 30;

/**
 * Insert into a detail cache, dropping the oldest entry when it is full (v1.9.7).
 *
 * Insertion order is the eviction order, and re-setting an existing key leaves it where it was —
 * deliberately, because nothing here needs more than "the cache does not grow for ever".
 */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.set(key, value);
  while (cache.size > DETAIL_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

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
   * The audio URL for a track — with the bitrate cap, when there is one.
   *
   * `maxBitRate` is the whole of the slow-link fix: Navidrome transcodes to that rate on demand,
   * the parameter is per request, and nothing about the server changes. `undefined` means the
   * original file, which is what a link that has been measured as fast gets.
   *
   * v1.9.2: the URL is *stable* for the session (`src/api/subsonic.ts` mints one salt per
   * session), so the player's own cache and the web view's can finally answer a repeat of the
   * same request instead of missing on a string that was never seen before.
   */
  streamUrl(song: Song, maxBitRate?: number | null): string {
    return this.client.streamUrl(song.id, maxBitRate == null ? {} : { maxBitRate });
  }

  /*
   * v1.9.2 — **the WebView prefetch that used to live here is deleted.**
   *
   * v1.9.0 pulled 512 KB of the next track's head here while the current one played, and the
   * release claimed it warmed the connection the player would use. It did not: the player has its
   * own HTTP stack, so those bytes were fetched twice at best, and `reader.cancel()` aborted the
   * transcode it had just asked Navidrome to start — so the player's own request paid for a second
   * ffmpeg spin-up. What it was *actually* useful for was measuring the link, and that is now
   * measured from the start itself (`ByteRate.noteStart`, `src/state/bitrate.ts`), which costs no
   * request at all. One fewer transfer per track, on the link where transfers are the problem.
   */

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
    remember(this.albumCache, id, album);
    return album;
  }

  async artist(id: string): Promise<ArtistWithAlbums> {
    const cached = this.artistDetailCache.get(id);
    if (cached) return cached;
    const artist = await this.client.getArtist(id);
    remember(this.artistDetailCache, id, artist);
    return artist;
  }

  async playlists(): Promise<Playlist[]> {
    return this.client.getPlaylists();
  }

  async playlist(id: string): Promise<PlaylistWithEntries> {
    const cached = this.playlistCache.get(id);
    if (cached) return cached;
    const playlist = await this.client.getPlaylist(id);
    remember(this.playlistCache, id, playlist);
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
