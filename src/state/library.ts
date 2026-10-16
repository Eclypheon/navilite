/** Library reads, with a small cache so navigating back and forth stays instant. */
import { SubsonicClient } from '../api/subsonic.ts';
import type { Album, AlbumWithSongs, Artist, ArtistWithAlbums, Playlist, PlaylistWithEntries, SearchResult3, Song, StarKind, Starred2 } from '../api/types.ts';

export type AlbumListType = 'alphabeticalByName' | 'newest' | 'recent' | 'frequent' | 'starred';

/** Resolves a song id to a local `file://` path when a complete offline copy exists, else null. */
export type OfflinePathResolver = (songId: string) => string | null;

/**
 * Resolves a **cover id** to a URL the page can read when that cover is on this phone, else null
 * (v1.9.20). Injected exactly like {@link OfflinePathResolver} above, so the browser bundle and the
 * tests can pass a stub and this file never touches `Capacitor`.
 */
export type OfflineArtResolver = (coverArtId: string) => string | null;

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
  private readonly resolveOffline: OfflinePathResolver;
  private readonly resolveOfflineArt: OfflineArtResolver;

  constructor(client: SubsonicClient, resolveOffline: OfflinePathResolver = () => null, resolveOfflineArt: OfflineArtResolver = () => null) {
    this.client = client;
    this.resolveOffline = resolveOffline;
    this.resolveOfflineArt = resolveOfflineArt;
  }

  get crossOrigin(): boolean {
    return this.client.isCrossOrigin;
  }

  /**
   * The cover for a cover id — **the one chokepoint for art resolution** (v1.9.20), exactly as
   * {@link streamUrl} is the one for audio.
   *
   * A local copy wins when there is one: the art that came down with the song is what the spectrum
   * page draws and what `player/palette.ts` reads its colours from, with no connection at all. Every
   * caller in the app already goes through here — the palette, the player bar, the spectrum page and
   * every thumb — so this one edit is what makes all of them offline-capable, and `palette.ts` is not
   * touched.
   *
   * Offline with no local cover the URL is still the network's, and the view draws its placeholder
   * exactly as it did before: art is never a reason for a view to wait or to fail (§I3).
   */
  coverUrl(coverArtId: string | undefined, size = 512): string | null {
    if (!coverArtId) return null;
    return this.resolveOfflineArt(coverArtId) ?? this.client.coverArtUrl(coverArtId, size);
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
    /*
     * Local-first resolution (v1.9.12). When the index holds a complete row for this song, the
     * local copy is played — no stream fetch, no data. Synchronous and null-safe: an unhydrated
     * index resolves to `null` and the stream URL is returned unchanged, never `undefined`.
     *
     * A local path ignores `maxBitRate`: it is already a file, and asking for a transcode of a
     * local file is meaningless. This one edit serves the audible load, the warm pool *and* the
     * queue published to the native side, which is what makes offline playback survive suspension.
     */
    const local = this.resolveOffline(song.id);
    if (local !== null) return local;
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
