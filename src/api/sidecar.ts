/**
 * The library's own lyric route — the **primary** lyrics source from v1.3.
 *
 * Navidrome only answers `getLyricsBySongId` with what its own parser and `LyricsPriority`
 * agree on. This route (kanban t_766e7aa5, `navilite-lyrics`) lives on the same door as the
 * Subsonic API and reads the `.lrc`/`.txt` sidecar that sits next to the audio, at request
 * time — so it serves the file itself, timed or untimed, and stays right as more sidecars
 * are written.
 *
 *   GET <door>/lyrics?path=<track path relative to the music root>
 *     200 text/plain   the lyric body (a timed `.lrc`, or untimed `.txt` — the normal case)
 *     404              no sidecar for this track
 *     400/413/415/503  the route refused that path, or it cannot see the library
 *
 * The path is Navidrome's own `song.path`, which is already relative to the music root, so
 * nothing has to be guessed. The route also accepts it without the audio extension.
 *
 * Nothing here throws. "This track has no sidecar", "the route is down" and "there is no such
 * route on this server" all reach the caller the same way — as `null` — and `src/api/lyrics.ts`
 * then asks Navidrome instead. A lyrics screen may be empty; it may never be wrong, and it may
 * never be a spinner that does not end.
 *
 * **Why the wrapped builds do not use `fetch`.** The route is meant to be fetched *same-origin*
 * (the app is served by the same door) and it sends no `Access-Control-Allow-Origin`. Inside the
 * APK/IPA the page's origin is the webview's own (`https://localhost`), which makes the request
 * cross-origin, and the browser would refuse to hand the text back. `CapacitorHttp` is the
 * platform's own HTTP client — no browser origin, so no CORS — and it is used *only* there. The
 * browser path stays one small `fetch`. Both go through the same `SidecarFetch` seam, so the
 * tests never touch a network.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { HttpOptions, HttpResponse } from '@capacitor/core';

import type { Song } from './types.ts';

/** One answer from the route: the HTTP status and the body as text. */
export interface SidecarAnswer {
  status: number;
  body: string;
}

/**
 * How the route is reached. Injected so the fetch itself is testable and so the native build
 * can use the platform's client. `null` means the request never produced an answer at all
 * (offline, refused, timed out).
 */
export type SidecarFetch = (url: string, timeoutMs: number) => Promise<SidecarAnswer | null>;

/** What `fetchLyrics` needs from the route. */
export interface SidecarSource {
  /** The lyric body for this track, or null when there is none / the route could not answer. */
  lyricsFor(song: Song): Promise<string | null>;
  /** The URL the route is asked at, or null when the track carries no library path (v1.9.12). */
  urlFor?(song: Song): string | null;
}

/** The route's path on the door, next to `/rest/*` and the app shell. */
export const SIDECAR_ROUTE = '/lyrics';

/**
 * Long enough for a cold read of a big sidecar over the tailnet, short enough that a lyrics
 * screen never waits on a route that is not answering: `PATIENCE_MS` in the view is 15 s, and
 * Navidrome is still asked if this gives up.
 */
export const SIDECAR_TIMEOUT_MS = 8000;

export class LyricsRoute implements SidecarSource {
  /** The library's base URL with no trailing slash; `''` means "the origin serving the app". */
  private readonly baseUrl: string;
  private readonly fetch: SidecarFetch;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    options: { fetch?: SidecarFetch; timeoutMs?: number } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? defaultSidecarFetch();
    this.timeoutMs = options.timeoutMs ?? SIDECAR_TIMEOUT_MS;
  }

  /**
   * The URL the route is asked at for this track, or `null` when the track carries no library
   * path. `/`, spaces and every non-ASCII character are percent-encoded: the door hands the
   * query string through untouched, so the encoding is what makes a Japanese path work.
   */
  urlFor(song: Song): string | null {
    const path = song.path?.trim();
    if (!path) return null;
    return `${this.baseUrl}${SIDECAR_ROUTE}?path=${encodeURIComponent(path)}`;
  }

  async lyricsFor(song: Song): Promise<string | null> {
    const url = this.urlFor(song);
    if (!url) return null;
    try {
      const answer = await this.fetch(url, this.timeoutMs);
      if (!answer || answer.status !== 200) return null;
      return answer.body.trim() === '' ? null : answer.body;
    } catch {
      // A fetch that throws is the same thing as one that never answered.
      return null;
    }
  }
}

/** The browser: one plain same-origin GET, with a deadline. */
export const webSidecarFetch: SidecarFetch = async (url, timeoutMs) => {
  const response = await fetch(url, {
    headers: { accept: 'text/plain' },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, body: await response.text() };
};

/** The slice of `CapacitorHttp` this module uses, so the wrapped-build path is testable. */
export interface NativeHttp {
  request(options: HttpOptions): Promise<HttpResponse>;
}

/**
 * The wrapped builds: the OS's own HTTP client (`CapacitorHttp`), which is not a browser
 * request and therefore not subject to CORS. iOS hands back a string for `text/plain`; a JSON
 * body (which is what a 404 or a 400 looks like) is stringified here and ignored by the caller.
 * Timeouts are in milliseconds, and there are two of them: connecting, then reading.
 */
export function nativeSidecarFetch(http: NativeHttp): SidecarFetch {
  return async (url, timeoutMs) => {
    const answer = await http.request({
      url,
      method: 'GET',
      headers: { accept: 'text/plain' },
      responseType: 'text',
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    });
    const body = typeof answer.data === 'string' ? answer.data : JSON.stringify(answer.data ?? '');
    return { status: answer.status, body };
  };
}

function defaultSidecarFetch(): SidecarFetch {
  return Capacitor.isNativePlatform() ? nativeSidecarFetch(CapacitorHttp) : webSidecarFetch;
}
