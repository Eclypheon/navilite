/**
 * A small Subsonic API client — deliberately Subsonic, not Navidrome's private
 * `/api` + `/auth` internals (see DECISIONS.md / docs/research-modality.md §4).
 *
 * Auth is the token scheme from API 1.13.0: a random salt `s` and `t = md5(password + salt)`.
 * The plaintext password never leaves the device except as that hash, and there is exactly
 * one place that builds a URL.
 *
 * v1.9.2 — **one salt per session, not per request.** The API permits a fresh salt per call
 * and the app used to take it, which made every URL the app ever built unique: the same
 * stream twice was two different URLs, and so was the same cover art. Nothing downstream
 * could ever answer from a cache — the player's own whole-file cache, the web view's HTTP
 * cache and the server's — and a track played again cost a full cold fetch, on the link
 * (a phone on mobile data, through a relay) where that is seconds of silence. The token is
 * exactly as opaque as it was (a salted MD5, and the salt never leaves the device), and the
 * signature is still verified by every request; the difference is that a URL now names a
 * resource rather than a moment.
 *
 * IDs are opaque strings: Navidrome 0.64.0 re-encoded them, so nothing here parses
 * or assumes a shape.
 */
import { md5Hex, randomSalt } from './md5.ts';
import type {
  Album,
  AlbumWithSongs,
  Artist,
  ArtistWithAlbums,
  Playlist,
  PlaylistWithEntries,
  SearchResult3,
  ServerInfo,
  Song,
  StarKind,
  Starred2,
  StructuredLyrics,
  LegacyLyrics,
} from './types.ts';

export const API_VERSION = '1.16.1';
export const CLIENT_NAME = 'Navilite';

export class SubsonicError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'SubsonicError';
    this.code = code;
  }
}

export interface SubsonicCredentials {
  /** Empty string means "same origin as this app" — the deployment we design for. */
  serverUrl: string;
  username: string;
  password: string;
}

export interface PlayQueueResponse {
  entry?: Song[];
  current?: string;
  position?: number;
}

type QueryValue = string | number | boolean | undefined;
type Payload = Record<string, unknown>;

interface SubsonicEnvelope {
  status?: string;
  version?: string;
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
  error?: { code?: number; message?: string };
}

const REQUEST_TIMEOUT_MS = 20000;

/** `''` or `/` → same origin; a bare host gets https; trailing slashes and a pasted `/rest` go away. */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (url === '' || url === '/' || url === '.') return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/rest(\.view)?$/i, '');
  return url;
}

export class SubsonicClient {
  /** Base with no trailing slash; `''` when the app is served alongside Navidrome. */
  readonly baseUrl: string;
  readonly username: string;
  /**
   * The session's salt and the token it produces (v1.9.2). Written once, here, and never
   * again — which is the whole of the change from "a fresh salt per request".
   */
  private readonly salt: string;
  private readonly token: string;

  constructor(credentials: SubsonicCredentials) {
    this.baseUrl = normalizeServerUrl(credentials.serverUrl);
    this.username = credentials.username;
    this.salt = randomSalt();
    this.token = md5Hex(credentials.password + this.salt);
  }

  /** True when the library lives on another origin, so audio/CORS rules apply. */
  get isCrossOrigin(): boolean {
    if (this.baseUrl === '') return false;
    try {
      return new URL(this.baseUrl).origin !== globalThis.location.origin;
    } catch {
      return true;
    }
  }

  /** Auth parameters. The same salt for the session, so a URL is stable and caches can hit. */
  authParams(): Record<string, string> {
    return {
      u: this.username,
      t: this.token,
      s: this.salt,
      v: API_VERSION,
      c: CLIENT_NAME,
      f: 'json',
    };
  }

  /** Absolute URL for an endpoint, auth included. Used for `stream`/`getCoverArt`. */
  url(method: string, params: Record<string, QueryValue> = {}): string {
    return `${this.baseUrl}/rest/${method}.view?${buildQuery({ ...this.authParams(), ...params })}`;
  }

  async call<T extends Payload>(method: string, params: Record<string, QueryValue> = {}): Promise<T> {
    const target = this.url(method, params);
    let response: Response;
    try {
      response = await fetch(target, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new SubsonicError(0, describeNetworkFailure(cause, this.baseUrl));
    }
    if (!response.ok) {
      throw new SubsonicError(response.status, `${method} failed: HTTP ${response.status} ${response.statusText}`);
    }
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new SubsonicError(
        0,
        `${method} did not return JSON — is ${this.baseUrl || 'this origin'} really a Navidrome?`,
      );
    }
    const envelope = body['subsonic-response'] as SubsonicEnvelope | undefined;
    if (!envelope) {
      throw new SubsonicError(0, `${method} returned an unrecognised response (no subsonic-response wrapper)`);
    }
    if (envelope.status !== 'ok') {
      const code = envelope.error?.code ?? 0;
      throw new SubsonicError(code, subsonicErrorMessage(code, envelope.error?.message));
    }
    return envelope as unknown as T;
  }

  async ping(): Promise<ServerInfo> {
    const res = await this.call<Payload & SubsonicEnvelope>('ping');
    return {
      version: res.version,
      type: res.type,
      serverVersion: res.serverVersion,
      openSubsonic: res.openSubsonic,
    };
  }

  async getArtists(): Promise<Artist[]> {
    const res = await this.call<{ artists?: { index?: Array<{ artist?: Artist[] }> } }>('getArtists');
    const indexes = res.artists?.index ?? [];
    return indexes.flatMap((index) => index.artist ?? []);
  }

  async getArtist(id: string): Promise<ArtistWithAlbums> {
    const res = await this.call<{ artist?: ArtistWithAlbums }>('getArtist', { id });
    return res.artist ?? { id, name: 'Unknown artist' };
  }

  async getAlbum(id: string): Promise<AlbumWithSongs> {
    const res = await this.call<{ album?: AlbumWithSongs }>('getAlbum', { id });
    return res.album ?? { id, name: 'Unknown album' };
  }

  async getAlbumList2(
    type: 'newest' | 'recent' | 'frequent' | 'random' | 'alphabeticalByName' | 'starred' | 'byYear' = 'alphabeticalByName',
    options: { size?: number; offset?: number; fromYear?: number; toYear?: number } = {},
  ): Promise<Album[]> {
    const res = await this.call<{ albumList2?: { album?: Album[] } }>('getAlbumList2', {
      type,
      size: options.size ?? 50,
      offset: options.offset,
      fromYear: options.fromYear,
      toYear: options.toYear,
    });
    return res.albumList2?.album ?? [];
  }

  async getSong(id: string): Promise<Song | null> {
    const res = await this.call<{ song?: Song }>('getSong', { id });
    return res.song ?? null;
  }

  async search3(query: string, options: { songCount?: number; albumCount?: number; artistCount?: number } = {}): Promise<SearchResult3> {
    const res = await this.call<{ searchResult3?: SearchResult3 }>('search3', {
      query,
      songCount: options.songCount ?? 40,
      albumCount: options.albumCount ?? 10,
      artistCount: options.artistCount ?? 10,
      songOffset: 0,
      albumOffset: 0,
      artistOffset: 0,
    });
    return res.searchResult3 ?? {};
  }

  async getStarred2(): Promise<Starred2> {
    const res = await this.call<{ starred2?: Starred2 }>('getStarred2');
    return res.starred2 ?? {};
  }

  async star(id: string, kind: StarKind): Promise<void> {
    await this.call('star', starParam(id, kind));
  }

  async unstar(id: string, kind: StarKind): Promise<void> {
    await this.call('unstar', starParam(id, kind));
  }

  /** 0 clears the rating, 1..5 sets it. */
  async setRating(id: string, rating: number): Promise<void> {
    await this.call('setRating', { id, rating });
  }

  /**
   * `submission=false` reports "now playing"; `true` is the play count.
   * Navidrome only marks a track played on scrobble — never on `stream`.
   */
  async scrobble(id: string, submission: boolean, time = Date.now()): Promise<void> {
    await this.call('scrobble', { id, submission, time });
  }

  async getPlaylists(): Promise<Playlist[]> {
    const res = await this.call<{ playlists?: { playlist?: Playlist[] } }>('getPlaylists');
    return res.playlists?.playlist ?? [];
  }

  async getPlaylist(id: string): Promise<PlaylistWithEntries> {
    const res = await this.call<{ playlist?: PlaylistWithEntries }>('getPlaylist', { id });
    return res.playlist ?? { id, name: 'Unknown playlist' };
  }

  async createPlaylist(name: string, songIds: string[] = []): Promise<Playlist | null> {
    const res = await this.call<{ playlist?: Playlist }>('createPlaylist', { name, songId: songIds.join(',') || undefined });
    return res.playlist ?? null;
  }

  async updatePlaylist(
    id: string,
    changes: { name?: string; comment?: string; public?: boolean; addSongIds?: string[]; removeIndexes?: number[] } = {},
  ): Promise<void> {
    await this.call('updatePlaylist', {
      playlistId: id,
      name: changes.name,
      comment: changes.comment,
      public: changes.public,
      songIdToAdd: changes.addSongIds?.join(',') || undefined,
      songIndexToRemove: changes.removeIndexes?.join(',') || undefined,
    });
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.call('deletePlaylist', { id });
  }

  async getNowPlaying(): Promise<Array<{ id?: string; title?: string; artist?: string; username?: string }>> {
    const res = await this.call<{ nowPlaying?: { entry?: Array<{ id?: string; title?: string; artist?: string; username?: string }> } }>(
      'getNowPlaying',
    );
    return res.nowPlaying?.entry ?? [];
  }

  async savePlayQueue(songIds: string[], current: string, positionMs: number): Promise<void> {
    await this.call('savePlayQueue', {
      id: songIds.join(','),
      current,
      position: Math.max(0, Math.round(positionMs)),
    });
  }

  async getPlayQueue(): Promise<PlayQueueResponse | null> {
    const res = await this.call<{ playQueue?: PlayQueueResponse }>('getPlayQueue');
    return res.playQueue ?? null;
  }

  /**
   * The lyrics for a track, from the library itself (OpenSubsonic `getLyricsBySongId`).
   *
   * This is the call Navidrome answers from the lyrics file next to the audio. A `.lrc`
   * sidecar comes back with `synced: true` and a `start` per line; a `.txt` sidecar comes
   * back as the same shape without timings. Several entries can be returned when more than
   * one sidecar exists for the track — `src/api/lyrics.ts` picks the useful one.
   *
   * Throws `SubsonicError` when the server does not implement it, which is why the lyrics
   * client falls back to `getLyrics` below rather than failing.
   */
  async getLyricsBySongId(id: string): Promise<StructuredLyrics[]> {
    const res = await this.call<{
      lyricsList?: { structuredLyrics?: StructuredLyrics | StructuredLyrics[] };
      lyrics?: { structuredLyrics?: StructuredLyrics | StructuredLyrics[] };
    }>('getLyricsBySongId', { id });
    const raw = res.lyricsList?.structuredLyrics ?? res.lyrics?.structuredLyrics;
    if (raw === undefined || raw === null) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  /** The old Subsonic call: a plain blob looked up by artist and title, no timings. */
  async getLyrics(options: { artist?: string; title?: string } = {}): Promise<LegacyLyrics | null> {
    const res = await this.call<{ lyrics?: LegacyLyrics }>('getLyrics', {
      artist: options.artist,
      title: options.title,
    });
    const lyrics = res.lyrics;
    if (!lyrics || typeof lyrics.value !== 'string' || lyrics.value === '') return null;
    return lyrics;
  }

  /** The audio URL. `size`-less, byte-range friendly, and the same origin whenever possible. */
  streamUrl(id: string, options: { maxBitRate?: number; format?: string } = {}): string {
    return this.url('stream', { id, maxBitRate: options.maxBitRate, format: options.format });
  }

  coverArtUrl(id: string, size = 512): string {
    return this.url('getCoverArt', { id, size });
  }
}

/** `star`/`unstar` take `id` for songs and `albumId`/`artistId` for the rest. */
function starParam(id: string, kind: StarKind): Record<string, string> {
  return kind === 'song' ? { id } : { [`${kind}Id`]: id };
}

function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return search.toString();
}

function subsonicErrorMessage(code: number, serverMessage?: string): string {
  const known: Record<number, string> = {
    0: 'generic server error',
    10: 'the server is missing a required parameter',
    20: 'Subsonic API is not enabled on this server',
    30: 'incompatible Subsonic version',
    40: 'wrong username or password',
    41: 'this server refuses token authentication (it needs the legacy plaintext `p=` parameter)',
    50: 'this server does not have that feature turned on',
    60: 'the trial period is over',
    70: 'the requested data was not found',
  };
  const hint = known[code];
  return [hint ?? 'server error', serverMessage].filter(Boolean).join(': ');
}

function describeNetworkFailure(cause: unknown, baseUrl: string): string {
  const target = baseUrl || 'this origin';
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return `could not reach ${target} (${detail}). Over Tailscale, check the tailnet is up and the proxy is serving this path.`;
}
