/**
 * Media Session: lock-screen / notification controls for the *web* playback path.
 * Inside the wrapped builds the native plugin owns the Now Playing card; this is what
 * makes the installable PWA behave like a player on Android and on iOS 15+.
 */

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(positionMs: number): void;
}

export interface NowPlayingMetadata {
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

export function mediaSessionAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function updateNowPlaying(metadata: NowPlayingMetadata, handlers: MediaSessionHandlers): void {
  if (!mediaSessionAvailable()) return;
  const session = navigator.mediaSession;
  const artwork = metadata.artworkUrl
    ? [
        { src: metadata.artworkUrl, sizes: '256x256', type: 'image/jpeg' },
        { src: metadata.artworkUrl, sizes: '512x512', type: 'image/jpeg' },
      ]
    : [];
  try {
    session.metadata = new MediaMetadata({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      artwork,
    });
    session.setActionHandler('play', () => handlers.play());
    session.setActionHandler('pause', () => handlers.pause());
    session.setActionHandler('nexttrack', () => handlers.next());
    session.setActionHandler('previoustrack', () => handlers.previous());
    session.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') handlers.seekTo(details.seekTime * 1000);
    });
  } catch (error) {
    // setActionHandler throws for actions a browser does not know; never fatal.
    console.warn('[navilite] media session handler not set', error);
  }
}

export function updatePlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (!mediaSessionAvailable()) return;
  navigator.mediaSession.playbackState = state;
}

export function updatePositionState(durationMs: number, positionMs: number, rate = 1): void {
  if (!mediaSessionAvailable() || typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const duration = durationMs / 1000;
  const position = Math.min(Math.max(0, positionMs / 1000), duration);
  try {
    navigator.mediaSession.setPositionState({ duration, position, playbackRate: rate });
  } catch (cause) {
    /*
     * Browsers reject inconsistent states, and the position on the system's own card is cosmetic —
     * the app's row is the reading that counts. An absence already rendered (the card simply keeps
     * the last position), not a playback failure; the cause is bound so the reason survives
     * (design §5).
     */
    void cause;
  }
}
