/** Library reads, with a small cache so navigating back and forth stays instant. */
import { SubsonicClient } from '../api/subsonic.ts';
import type { Album, AlbumWithSongs, Artist, ArtistWithAlbums, Playlist, PlaylistWithEntries, SearchResult3, Song, StarKind, Starred2 } from '../api/types.ts';

export type AlbumListType = 'alphabeticalByName' | 'newest' | 'recent' | 'frequent' | 'starred';

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

  streamUrl(song: Song): string {
    return this.client.streamUrl(song.id);
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
