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

/**
 * OpenSubsonic `getLyricsBySongId` — the endpoint Navidrome serves from the lyrics file that
 * sits next to the audio. A `.lrc` sidecar arrives with `synced: true` and a `start` in
 * milliseconds per line; a `.txt` sidecar arrives as the same shape without timings.
 */
export interface StructuredLyrics {
  displayArtist?: string;
  displayTitle?: string;
  lang?: string;
  /** True when every line carries a `start` time in ms. */
  synced?: boolean;
  /** Whole-file offset in ms, added to each line's start. */
  offset?: number;
  line?: Array<{ start?: number; value?: string }>;
}

/**
 * The old Subsonic `getLyrics` answer: one flat blob, no timings, looked up by artist and
 * title rather than by song id. `artist`/`title` are what the *server* matched, so the app
 * can check it was handed the right song's words — two songs can share a title.
 */
export interface LegacyLyrics {
  artist?: string;
  title?: string;
  value: string;
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
