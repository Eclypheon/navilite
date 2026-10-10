/** Subsonic domain objects — only the fields Navilite actually reads. */

export interface Artist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  artistImageUrl?: string;
  starred?: string;
}

export interface Album {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  created?: string;
  played?: string;
  genre?: string;
  starred?: string;
}

export interface Song {
  id: string;
  title: string;
  artist?: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  coverArt?: string;
  duration?: number;
  track?: number;
  year?: number;
  genre?: string;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  size?: number;
  starred?: string;
}

export interface Playlist {
  id: string;
  name: string;
  songCount?: number;
  duration?: number;
  created?: string;
  changed?: string;
  owner?: string;
  public?: boolean;
  comment?: string;
  coverArt?: string;
}

export interface ArtistWithAlbums extends Artist {
  album?: Album[];
}

export interface AlbumWithSongs extends Album {
  song?: Song[];
}

export interface PlaylistWithEntries extends Playlist {
  entry?: Song[];
}

export interface Starred2 {
  artist?: Artist[];
  album?: Album[];
  song?: Song[];
}

export interface SearchResult3 {
  artist?: Artist[];
  album?: Album[];
  song?: Song[];
}

/** Anything that can be starred, as the Subsonic `star`/`unstar` calls want it. */
export type StarKind = 'song' | 'album' | 'artist';

export interface ServerInfo {
  version?: string;
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
}

/** One track queued for playback. */
export interface QueueItem {
  song: Song;
  /** Where it came from, so next/prev and "playing from" stay meaningful. */
  context: QueueContext;
}

export interface QueueContext {
  kind: 'album' | 'artist' | 'playlist' | 'favourites' | 'search' | 'song';
  id?: string;
  name: string;
}
