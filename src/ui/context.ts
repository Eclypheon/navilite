/*
 * The app's own types: the shell it builds, and the context every view and seam is handed.
 *
 * Sliced out of `app.ts` (v2.0-beta, slice A1a). Interfaces only, so the compiler is the pin for the
 * move — but they are 92 lines of prose inside a type block that sits between the constants at the
 * top of that file and the code that uses them, and every reader of `app.ts` scrolls past them.
 */
import type { SidecarSource } from '../api/sidecar.ts';
import type { LyricsService } from '../lyrics/service.ts';
import type { AudioEngine } from '../player/engine.ts';
import type { Palette } from '../player/palette.ts';
import type { PlatformInfo } from '../platform.ts';
import type { Library } from '../state/library.ts';
import type { OfflineStore } from '../state/offline.ts';
import type { PlaybackQueue } from '../state/queue.ts';
import type { SecretStore } from '../storage/secret.ts';
import type { Settings } from '../storage/settings.ts';
import type { LyricsView } from './lyrics.ts';
import type { Pager } from './pager.ts';

export type NowMode = 'spectrum' | 'lyrics';

export interface Shell {
  header: HTMLElement;
  /** The app's one scroll container; every view draws into `view` inside it. */
  viewScroll: HTMLElement;
  view: HTMLElement;
  playerBar: HTMLElement;
  nowOverlay: HTMLElement;
  visualizerHost: HTMLElement;
  canvas: HTMLCanvasElement;
  toast: HTMLElement;
  tabs: Map<string, HTMLButtonElement>;
  barCover: HTMLElement;
  barTitle: HTMLElement;
  barSubtitle: HTMLElement;
  barPlay: HTMLButtonElement;
  barProgress: HTMLInputElement;
  barPosition: HTMLElement;
  barDuration: HTMLElement;
  barChip: HTMLElement;
  /**
   * v1.9.5: the app's own account of what the player and the engine are doing, one line under the
   * chip. It is shown only when something is *not* the healthy playing-with-a-live-spectrum state,
   * because that is the state the owner's reports are about and the one no diagnosis has been able
   * to see from here.
   */
  barReason: HTMLElement;
  nowCover: HTMLElement;
  nowTitle: HTMLElement;
  nowSubtitle: HTMLElement;
  nowContext: HTMLElement;
  nowProgress: HTMLInputElement;
  nowPosition: HTMLElement;
  nowDuration: HTMLElement;
  nowPlay: HTMLButtonElement;
  nowShuffle: HTMLButtonElement;
  nowRepeat: HTMLButtonElement;
  lyricsHost: HTMLElement;
  /** The two-pane strip inside the now screen: spectrum | lyrics. */
  nowPages: HTMLElement;
  pillSpectrum: HTMLButtonElement;
  pillLyrics: HTMLButtonElement;
  nowMode: NowMode;
  /** v1.5: the swipe pager behind the now screen (playlist | spectrum | lyrics). */
  pager: Pager;
  lyrics: LyricsView;
  /** Song id currently marked as playing in a list, so the toggle only runs when it changes. */
  highlighted: string | null;
  /** v1.9.0: whether that row was also drawn in its loading state, so the toggle has both facts. */
  highlightedLoading: boolean;
  /** The last non-now route, so closing the now screen returns where you were. */
  lastBrowseRoute: string;
  /** v1.6: the screen a stacked one (settings, the changelog) was opened from. */
  stackedFrom: string;
  scrubbing: boolean;
  /**
   * Where the finger is, in ms, while a seek bar is being dragged (v1.7.2).
   *
   * The label used to be written only from the engine's own position, and only when no finger was
   * down — so while dragging, the clock sat still and he had no way to know where he was seeking
   * to. *"can you make it so the timing changes dynamically as i drag the seek bar so i know to what
   * time im seeking to if i release it?"* This is that number: the destination, shown from the
   * finger rather than from the player, and cleared the moment the gesture ends — however it ends.
   */
  scrubMs: number | null;
  /** The route whose content is in `view` right now — the key the scroll restore is filed under. */
  viewRoute: string | null;
  /** True while the now-playing screen covers `view` and its scroll container is frozen. */
  scrollLocked: boolean;
  /** Where the covered view was scrolled to, waiting for that view to be drawn again. */
  pendingScroll: { route: string | null; top: number } | null;
}

export interface AppContext {
  platform: PlatformInfo;
  settings: Settings;
  secrets: SecretStore;
  engine: AudioEngine;
  library: Library | null;
  queue: PlaybackQueue | null;
  /** Offline downloads: the synchronous resolver and the per-playlist records (v1.9.12). */
  offline: OfflineStore | null;
  /** The library's own lyric route (`/lyrics`), once a library has been reached. */
  sidecar: SidecarSource | null;
  lyrics: LyricsService;
  /** Rows showing a given song, so the playing one can be highlighted wherever it appears. */
  rows: Map<string, Set<HTMLElement>>;
  palette: Palette;
  render(): void;
  toast(message: string, kind?: 'info' | 'error'): void;
}
