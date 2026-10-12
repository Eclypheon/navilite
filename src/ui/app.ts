/**
 * The application shell: routing, views, the player bar and the now-playing screen.
 *
 * Plain DOM, no framework. The whole UI is element building and a router over the URL
 * hash — a virtual DOM would buy nothing here, and the visualiser wants a canvas it
 * owns rather than a tree that gets re-rendered underneath it.
 *
 * v1.1 shape of the app: **Library**, **Playlists** and a settings gear; the now-playing
 * screen is a route (`#/now`) rather than a hidden overlay, so the logo, a swipe and a cold
 * start can all land on it. Its controls live in one compact bar at the bottom of the
 * screen, and the Spectrum/Lyrics switch at the top swaps what fills the middle.
 */
import { SubsonicClient, SubsonicError } from '../api/subsonic.ts';
import { LyricsRoute, type SidecarSource } from '../api/sidecar.ts';
import type { Album, Artist, Playlist, QueueContext, QueueItem, Song } from '../api/types.ts';
import { DEFAULT_SERVER_URL, SERVER_URL_PLACEHOLDER } from '../config.ts';
import { AudioEngine, type EngineStatus } from '../player/engine.ts';
import { attachVisualizer } from '../player/visualizer.ts';
import { DEFAULT_PALETTE, paletteFromArtwork, type Palette } from '../player/palette.ts';
import { platformInfo, type PlatformInfo } from '../platform.ts';
import { LyricsService } from '../lyrics/service.ts';
import { PlaybackQueue } from '../state/queue.ts';
import { Library, type AlbumListType } from '../state/library.ts';
import { LyricsCache } from '../storage/lyrics.ts';
import { createSecretStore, type SecretStore } from '../storage/secret.ts';
import { loadSettings, saveSettings, type Settings } from '../storage/settings.ts';
import { loadSnapshot } from '../storage/session.ts';
import { CHANGELOG } from './changelog.ts';
import { ICONS, cover, formatDuration, formatTime, h, icon, playIcon, replace, starIcon } from './dom.ts';
import { createLyricsView, type LyricsView } from './lyrics.ts';
import { createPager, type Pager } from './pager.ts';

const PASSWORD_KEY = 'subsonic-password';
const BUILD_ID = '__BUILD_ID__';
const DEFAULT_ROUTE = '#/artists';
/** The now screen, on the spectrum pane. */
const NOW_ROUTE = '#/now';
/** The now screen, on the lyrics pane — the mode is part of the route so back/forward walk it. */
const LYRICS_ROUTE = '#/now/lyrics';
/**
 * v1.6: the *stacked* screens — settings, the changelog, the connect form.
 *
 * They are pushed on top of whatever you were looking at, not panes of the pager: there is nothing
 * beside them to page to, so the pager's gesture surface is off while one is showing and the only
 * horizontal gesture that means anything is a right swipe *back* to the screen they were opened from.
 */
const STACKED_ROUTES = new Set(['settings', 'changelog', 'connect']);
/**
 * Pixels of movement that still counts as a tap rather than a scroll.
 *
 * v1.6.2. The number is the whole discriminator now — it was one of three in v1.6, and the other two
 * were the ones refusing real taps (see `bindTapSurface`). **8 px, measured as straight-line
 * distance**, is the canonical value for this: it is the `DRAG_SLOP` in the tap-vs-scroll research
 * this release was asked to conform to (`navilite-tap-vs-scroll-canonical.md`, §1 and §3 — "px of
 * touch movement that is still a tap"; `@use-gesture`'s `tapsThreshold` defaults to 3, Swiper uses a
 * comparable per-device number, and both are in the same order as WebKit's own slop before it gives
 * up on a tap).
 *
 * Note the direction: the app was at 10 px *per axis*, which is up to 14 px of travel diagonally,
 * so moving to the documented 8 px straight-line is **tighter**, not looser — a press-and-hold that
 * then swipes has to be recognised as a drag sooner, which is what the owner asked for. That change
 * is the one risky edit in this release (refusing a click is how v1.6 broke tapping), which is why
 * the harness now also proves a *wobbling* tap still plays: see `holdThenDrag` and `jitterTap` in
 * `tools/v16-check.mjs`.
 */
const TAP_SLOP_PX = 8;
/**
 * How long a refusal may wait for the click it belongs to.
 *
 * A refusal is armed when a gesture ends as a drag and is consumed by the *very next* click. If that
 * click never comes — WebKit claims the gesture itself and cancels the touch sequence, or the
 * browser suppresses the click on its own — the refusal has to expire rather than sit there and eat a
 * later tap. 700 ms is longer than the gap between a real drag's `touchend` and its click on every
 * engine here, and shorter than any deliberate pause between two taps.
 */
const SUPPRESS_TTL_MS = 700;
/*
 * The three panes of the swipe pager, in the order the owner asked for: **playlist | spectrum |
 * lyrics**. Pane 0 is the browser screen the app already had; the other two are inside the now
 * overlay (see src/ui/pager.ts).
 */
const PANE_PLAYLIST = 0;
const PANE_SPECTRUM = 1;
const PANE_LYRICS = 2;

type NowMode = 'spectrum' | 'lyrics';

interface Shell {
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

interface AppContext {
  platform: PlatformInfo;
  settings: Settings;
  secrets: SecretStore;
  engine: AudioEngine;
  library: Library | null;
  queue: PlaybackQueue | null;
  /** The library's own lyric route (`/lyrics`), once a library has been reached. */
  sidecar: SidecarSource | null;
  lyrics: LyricsService;
  /** Rows showing a given song, so the playing one can be highlighted wherever it appears. */
  rows: Map<string, Set<HTMLElement>>;
  palette: Palette;
  render(): void;
  toast(message: string, kind?: 'info' | 'error'): void;
}

export async function boot(root: HTMLElement): Promise<void> {
  const platform = platformInfo();
  const settings = loadSettings();
  const secrets = await createSecretStore(platform.os);
  const engine = new AudioEngine();
  /*
   * The one engine, and the one place a build chooses it: inside the Capacitor shell the native
   * player, in a browser the media element. There is no preference that selects between them any
   * more (v1.7.3 deleted "web audio only"), and nothing to hand over at hide time. `prewarm()`
   * builds the native bridge before the first press so the press does not pay for it — it produces
   * no sound.
   */
  engine.prewarm();

  const shell = buildShell(root);
  const visualizer = attachVisualizer(shell.canvas, engine, DEFAULT_PALETTE);
  visualizerRef = visualizer;

  const lyrics = new LyricsService(
    new LyricsCache(),
    () => ctx.library?.client ?? null,
    () => ctx.sidecar,
  );
  const ctx: AppContext = {
    platform,
    settings,
    secrets,
    engine,
    library: null,
    queue: null,
    sidecar: null,
    lyrics,
    rows: new Map(),
    palette: DEFAULT_PALETTE,
    render: () => renderRoute(ctx, shell),
    toast: (message, kind = 'info') => toast(shell, message, kind),
  };
  shell.lyrics = createLyricsView(lyrics);
  shell.lyricsHost.append(shell.lyrics.element);
  shell.lyrics.show(null);

  const applyPalette = (palette: Palette): void => {
    ctx.palette = palette;
    // The canvas is a consumer of the same palette, applied in the same call — see `applyPaletteVars`.
    applyPaletteVars(shell, palette);
  };
  applyPalette(DEFAULT_PALETTE);

  let restored = false;
  if (await restoreSession(ctx, shell, applyPalette)) {
    restored = await restorePlayQueue(ctx);
    if (!location.hash) location.hash = restored ? NOW_ROUTE : DEFAULT_ROUTE;
  }

  window.addEventListener('hashchange', () => renderRoute(ctx, shell));
  engine.subscribe((status) => updatePlayerBar(ctx, shell, status));
  refreshSeekLabels = () => updatePlayerBar(ctx, shell, engine.status());
  /*
   * Going out of sight is the last moment the app is guaranteed to be running: write the exact
   * resume snapshot here rather than hope the OS gives us another tick.
   */
  const onLifecycle = (hidden: boolean): void => {
    void ctx.engine.handleVisibility(hidden);
    if (hidden) ctx.queue?.flushSnapshot();
  };
  /*
   * Every lifecycle input, into the one machine.
   *
   * `visibilitychange` is the one that fires on iOS when the app is backgrounded; `pageshow` /
   * `pagehide` and `focus` cover the web page and the cases where visibility alone does not move
   * (a bfcache restore, a tab that was never hidden). Capacitor's own `appStateChange` is not
   * wired because `@capacitor/app` is not a dependency of this app, and adding one for an event
   * `visibilitychange` already delivers on both platforms would be a new moving part, not a fix.
   */
  document.addEventListener('visibilitychange', () => onLifecycle(document.hidden));
  window.addEventListener('pagehide', () => onLifecycle(true));
  window.addEventListener('pageshow', () => onLifecycle(document.hidden));
  window.addEventListener('focus', () => onLifecycle(false));
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === ' ') {
      event.preventDefault();
      void ctx.queue?.toggle();
    } else if (event.key === 'ArrowRight' && event.shiftKey) {
      void ctx.queue?.next();
    } else if (event.key === 'ArrowLeft' && event.shiftKey) {
      void ctx.queue?.previous();
    }
  });

  visualizer.start();
  renderRoute(ctx, shell);
  if (restored) updatePlayerBar(ctx, shell, engine.status());

  // A small read-only seam: it lets the end-to-end harness (and anyone debugging a real
  // deployment from devtools) ask what the engine is actually doing. It exposes no
  // credentials and cannot change playback.
  (window as unknown as { __navilite: unknown }).__navilite = {
    status: () => engine.status(),
    spectrum: () => {
      const data = engine.spectrumData();
      return data ? Array.from(data) : null;
    },
    sampleRate: () => engine.sampleRate(),
    fftSize: () => engine.fftSize,
    libraryReady: () => ctx.library !== null,
    /**
     * The palette the app is actually wearing (v1.4.1, and the seam `tools/palette-check.mjs` reads
     * — it has been calling this since v1.4.1 and the key was never here, which is why the
     * palette-apply check failed the moment a `dist/` build existed to run it against).
     */
    palette: () => ctx.palette,
    route: () => location.hash,
    nowMode: () => shell.nowMode,
    /** v1.5: the swipe pager's own state — the pane, the offset and what it has transformed. */
    pager: () => shell.pager.state(),
    playingRow: () => document.querySelector('.row.song.playing .row-title')?.textContent ?? null,
    context: () => shell.nowContext.textContent,
    // Visible lyrics, so an end-to-end check can read what the panel actually shows.
    lyrics: () => Array.from(document.querySelectorAll('.lyric-line')).map((node) => node.textContent),
    activeLyric: () => document.querySelector('.lyric-line.active')?.textContent ?? null,
    lyricsMessage: () => document.querySelector('.lyrics-empty')?.textContent ?? null,
    /**
     * v1.7.2: the spectrum the canvas is drawing from, band by band — the native tap's own frame
     * when the native player is the engine, and the analyser's bins otherwise. Read-only, and the
     * only way an end-to-end check (or a person with devtools) can quote what the bars are showing.
     */
    spectrumBands: () => {
      const data = engine.spectrumData();
      return data ? Array.from(data) : null;
    },
    /** The last native tap frame, straight from the plugin: bands plus the tap's own counters. */
    nativeSpectrum: () => engine.readNativeFrame(),

    /** The track the player is on, and the track the lyrics panel loaded for. */
    tracks: () => ({
      playing: ctx.queue?.currentSong?.id ?? null,
      panel: shell.lyrics.state().songId,
      panelLoaded: shell.lyrics.state().loaded,
      panelLines: shell.lyrics.state().lines,
      panelMessage: shell.lyrics.state().message,
    }),
  };

  if (!ctx.library) await renderConnect(ctx, shell);
}

function errorText(error: unknown): string {
  if (error instanceof SubsonicError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function toast(shell: Shell, message: string, kind: 'info' | 'error'): void {
  shell.toast.textContent = message;
  shell.toast.className = `toast visible ${kind}`;
  const token = message;
  window.setTimeout(() => {
    if (shell.toast.textContent === token) shell.toast.className = 'toast';
  }, kind === 'error' ? 7000 : 3200);
}

/* ------------------------------------------------------------------ shell */

function buildShell(root: HTMLElement): Shell {
  const tabs = new Map<string, HTMLButtonElement>();
  // v1.1: two tabs, not five. Albums, Favourites and Search were removed at the owner's
  // request; search stays reachable from inside Library (see renderArtists), and the album
  // and favourites views still exist as routes for deep links.
  const tabDefs: Array<[string, string]> = [
    ['artists', 'Library'],
    ['playlists', 'Playlists'],
  ];
  const nav = h(
    'nav',
    { class: 'tabs', 'aria-label': 'Sections' },
    tabDefs.map(([route, label]) => {
      const button = h('button', {
        class: 'tab',
        text: label,
        onclick: () => {
          location.hash = `#/${route}`;
        },
      });
      tabs.set(route, button);
      return button;
    }),
  );
  const brand = h(
    'button',
    {
      class: 'brand',
      'aria-label': 'Now playing',
      title: 'Now playing',
      onclick: () => openNow(),
    },
    [h('span', { class: 'brand-mark', text: '◧' }), h('span', { text: 'Navilite' })],
  );
  const header = h('header', { class: 'topbar' }, [
    brand,
    nav,
    h('button', { class: 'icon-button', 'aria-label': 'Settings', onclick: () => (location.hash = '#/settings') }, [
      icon(ICONS.settings),
    ]),
  ]);

  const view = h('main', { class: 'view', id: 'view' });
  /*
   * v1.4: one fixed shell plus one inner scroll container per view.
   *
   * The document does not scroll any more (see styles.css), so this box is the only thing a scroll
   * gesture can move: the header above it is a fixed row of the shell and the player bar is fixed
   * to the bottom of the screen, which is what makes "the top bar cannot grow or scroll away" true
   * by construction rather than by careful styling. Every view still draws into `.view` exactly as
   * before — the wrapper is the scroll context, not a second layout.
   */
  const viewScroll = h('div', { class: 'view-scroll' }, [view]);

  const barCover = h('div', { class: 'pb-cover' });
  const barTitle = h('span', { class: 'pb-title', text: '—' });
  const barSubtitle = h('span', { class: 'pb-sub', text: '' });
  const barPlay = h('button', { class: 'transport', 'aria-label': 'Play or pause', onclick: () => void togglePlayback() }, [
    playIcon(false),
  ]);
  const barProgress = h('input', { class: 'progress', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  const barPosition = h('span', { class: 'time', text: '0:00' });
  const barDuration = h('span', { class: 'time', text: '0:00' });
  const barChip = h('span', { class: 'mode-chip', text: 'idle' });
  const barReason = h('p', { class: 'pb-reason hidden', text: '' });
  const playerBar = h('footer', { class: 'playerbar hidden' }, [
    h('div', { class: 'pb-main' }, [
      barCover,
      h('div', { class: 'pb-meta' }, [barTitle, barSubtitle]),
      h('div', { class: 'pb-controls' }, [
        h('button', { class: 'transport small', 'aria-label': 'Previous', onclick: () => void queueRef?.previous() }, [
          icon(ICONS.previous),
        ]),
        barPlay,
        h('button', { class: 'transport small', 'aria-label': 'Next', onclick: () => void queueRef?.next() }, [icon(ICONS.next)]),
      ]),
    ]),
    h('div', { class: 'pb-progress', 'data-pager': 'off' }, [barPosition, barProgress, barDuration]),
    barChip,
    barReason,
  ]);

  const canvas = h('canvas', { class: 'now-canvas' });
  const visualizerHost = h('div', { class: 'now-visualizer' }, [canvas]);
  const nowCover = h('div', { class: 'now-cover' });
  const nowTitle = h('h2', { class: 'now-title', text: 'Nothing playing' });
  const nowSubtitle = h('p', { class: 'now-sub', text: '' });
  const nowContext = h('p', { class: 'now-context', text: '' });
  const nowProgress = h('input', { class: 'progress', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Seek' });
  const nowPosition = h('span', { class: 'time', text: '0:00' });
  const nowDuration = h('span', { class: 'time', text: '0:00' });
  const nowPlay = h('button', { class: 'transport big', 'aria-label': 'Play or pause', onclick: () => void togglePlayback() }, [
    playIcon(false, 26),
  ]);
  const nowShuffle = h(
    'button',
    {
      class: 'transport small toggle',
      'aria-label': 'Shuffle',
      'aria-pressed': 'false',
      onclick: () => {
        queueRef?.setShuffle(!(queueRef?.shuffle ?? false));
      },
    },
    [icon(ICONS.shuffle, 20)],
  );
  const nowRepeat = h(
    'button',
    {
      class: 'transport small toggle',
      'aria-label': 'Repeat',
      'aria-pressed': 'false',
      onclick: () => {
        queueRef?.cycleRepeat();
      },
    },
    [icon(ICONS.repeat, 20)],
  );

  const pillSpectrum = h('button', { class: 'pill-option active', text: 'Spectrum', onclick: () => setNowMode('spectrum') });
  const pillLyrics = h('button', { class: 'pill-option', text: 'Lyrics', onclick: () => setNowMode('lyrics') });
  const pill = h('div', { class: 'pill', role: 'tablist', 'aria-label': 'Spectrum or lyrics' }, [pillSpectrum, pillLyrics]);

  const lyricsHost = h('div', { class: 'now-lyrics' });
  /*
   * v1.5: the middle of the now-playing screen is a two-pane strip, and the overlay around it is
   * the window the playlist is paged past — the geometry is in `src/ui/pager.ts`, the panes are
   * here. The (x/y) line, the title block and the compact transport bar deliberately sit *outside*
   * the strip: they are the same controls on whichever pane is showing, which is what keeps them
   * working while a finger is mid-drag.
   */
  const nowPages = h('div', { class: 'now-pages' }, [
    h('div', { class: 'now-page now-page-spectrum' }, [nowCover, visualizerHost]),
    h('div', { class: 'now-page now-page-lyrics' }, [lyricsHost]),
  ]);
  const nowOverlay = h('section', { class: 'now hidden', 'aria-label': 'Now playing' }, [
    h('div', { class: 'now-top', 'data-pager': 'off' }, [
      h('button', { class: 'icon-button now-close', 'aria-label': 'Close now playing', onclick: () => closeNow() }, [
        icon(ICONS.close),
      ]),
      pill,
    ]),
    nowPages,
    nowTitle,
    nowSubtitle,
    nowContext,
    h('div', { class: 'now-progress', 'data-pager': 'off' }, [nowPosition, nowProgress, nowDuration]),
    h('div', { class: 'now-bar', 'data-pager': 'off', 'aria-label': 'Playback controls' }, [nowShuffle, h('button', {
      class: 'transport',
      'aria-label': 'Previous',
      onclick: () => void queueRef?.previous(),
    }, [icon(ICONS.previous, 22)]), nowPlay, h('button', {
      class: 'transport',
      'aria-label': 'Next',
      onclick: () => void queueRef?.next(),
    }, [icon(ICONS.next, 22)]), nowRepeat]),
  ]);

  const toastNode = h('div', { class: 'toast' });

  /*
   * The pager is built before the shell object because the shell carries it: its callbacks reach
   * the app through the same late-bound references the rest of the shell uses (`queueRefRef` is the
   * shell, `queueRef` the queue), so none of them need the shell to exist yet.
   */
  const pager = createPager({
    host: root,
    list: viewScroll,
    overlay: nowOverlay,
    strip: nowPages,
    onSettle: (position) => settlePane(position),
    onPrepare: (target) => preparePane(target),
  });

  const shell: Shell = {
    header,
    viewScroll,
    view,
    playerBar,
    nowOverlay,
    visualizerHost,
    canvas,
    toast: toastNode,
    tabs,
    barCover,
    barTitle,
    barSubtitle,
    barPlay,
    barProgress,
    barPosition,
    barDuration,
    barChip,
    barReason,
    nowCover,
    nowTitle,
    nowSubtitle,
    nowContext,
    nowProgress,
    nowPosition,
    nowDuration,
    nowPlay,
    nowShuffle,
    nowRepeat,
    lyricsHost,
    nowPages,
    pillSpectrum,
    pillLyrics,
    nowMode: 'spectrum',
    pager,
    lyrics: null as unknown as LyricsView,
    highlighted: null,
    highlightedLoading: false,
    lastBrowseRoute: DEFAULT_ROUTE,
    stackedFrom: '',
    scrubbing: false,
    scrubMs: null,
    viewRoute: null,
    scrollLocked: false,
    pendingScroll: null,
  };

  bindSeek(shell.barProgress, shell, () => queueRef);
  bindSeek(shell.nowProgress, shell, () => queueRef);
  playerBar.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button, input')) return;
    openNow();
  });
  /*
   * v1.6.1: the list is the tap surface. It owns both facts a tap needs — where the finger went down,
   * and whether the list moved under it — and refuses exactly one click after a drag, once.
   * See `bindTapSurface`.
   */
  bindTapSurface(viewScroll);
  bindStackedBack(root);

  root.replaceChildren(header, viewScroll, playerBar, nowOverlay, toastNode);
  return shell;
}

/** The queue is created after the shell, so the shell's buttons read it lazily. */
let queueRef: PlaybackQueue | null = null;

/**
 * How a settled (or cancelled) seek puts the label back where it belongs.
 *
 * `updatePlayerBar` is the one writer of the transport's own position, and it is created with the
 * app context — after the shell, and therefore after the seek bars are bound. This is the seam
 * between them: a hook the bars call when the finger has gone, so the number stops being the
 * finger's and becomes the player's again on the same frame rather than on the next status event.
 */
let refreshSeekLabels: () => void = () => undefined;

function togglePlayback(): void {
  void queueRef?.toggle();
}

/** The logo, and the mini player, both land here. */
function openNow(): void {
  if (location.hash !== NOW_ROUTE) location.hash = NOW_ROUTE;
}

/** The × on the now screen: page back to the playlist he is on, through the pager. */
function closeNow(): void {
  queueRefRef.pager.goTo(PANE_PLAYLIST, { animate: true });
}

/** The shell needs to be reachable from the module-level routing helpers. */
let queueRefRef: Shell = null as unknown as Shell;

/* ------------------------------------------------------------ the gesture */

/**
 * The finger that is down on the list, and whether it has moved far enough to be a drag.
 *
 * v1.6.1: one press for the whole list, not one per row. A row cannot be the authority on "was this a
 * tap" — the touch sequence and the click it may or may not produce need not land on the same element
 * once a finger drifts a little — and a per-row copy of the state also has to be reset on
 * `touchcancel`, which v1.6 never did: a touch the engine cancelled left a row believing a press was
 * still in flight.
 */
interface Press {
  x: number;
  y: number;
  /** True once the finger travelled past {@link TAP_SLOP_PX}, or the list scrolled under it. */
  moved: boolean;
}
let press: Press | null = null;
/**
 * The one-shot refusal: a timestamp until which the next click is refused, or 0 for "nothing armed".
 *
 * Consumed by the first click that arrives ({@link refuseClick}), so one drag can never refuse two
 * clicks, and cleared when a new finger goes down, so it can never cross into the next gesture.
 */
let suppressClickUntil = 0;

/** The gesture ended as a drag: the click it leaves behind is refused, once. */
function refuseNextClick(): void {
  suppressClickUntil = performance.now() + SUPPRESS_TTL_MS;
}

/**
 * Is this click the one a drag left behind? Always consumes the refusal — armed or expired, it never
 * survives this call.
 */
function refuseClick(now: number): boolean {
  if (suppressClickUntil === 0) return false;
  const refuse = now <= suppressClickUntil;
  suppressClickUntil = 0;
  return refuse;
}

/**
 * Activate an element on a click, and on nothing else.
 *
 * The click is the browser's own, so a thumb, a keyboard Enter, a switch control, a VoiceOver
 * double-tap and a script all arrive by the same door. Nothing is reconstructed from touch maths: that
 * was v1.6's mistake — it rebuilt a tap out of `touchstart`/`touchmove`/`touchend`, and the two
 * thresholds it invented (a press longer than 700 ms, and *any* `scroll` event during the press)
 * refused taps that a synthetic one-pixel tap never produces but a real thumb produces constantly.
 *
 * What can be refused is the click a drag leaves behind, and that is decided once, on the surface the
 * rows sit on — see {@link bindTapSurface}. A click with no drag in front of it cannot be refused: by
 * construction nothing arms the refusal for it.
 */
function bindTap<T extends HTMLElement>(element: T, activate: () => void): T {
  element.addEventListener('click', () => activate());
  return element;
}

/**
 * The tap surface: the scroll container every row lives in. It owns the only two facts a tap needs.
 *
 *   - where the finger went down, so {@link TAP_SLOP_PX} of travel can be told from a still finger;
 *   - whether the list moved, which is a scroll however still the finger was.
 *
 * A gesture that did either arms {@link refuseNextClick} — a one-shot consumed by the very next click
 * and expired by {@link SUPPRESS_TTL_MS}, so it can never eat a later tap. The click is read in the
 * capture phase, so a refused one never reaches the row's own handler.
 *
 * Note what is deliberately *not* here: any judgement of a press by how long it lasted. v1.6 refused a
 * click when the press had been down for more than 700 ms from `touchstart` — and WebKit delivers the
 * click *after* `touchend` — so a deliberate tap, or a tap WebKit spent a moment deciding about, was
 * refused for being slow rather than for being a drag. That is the plainest way "tapping does nothing"
 * becomes *"i'm not even able to tap to go into my playlist"*.
 */
function bindTapSurface(surface: HTMLElement): void {
  surface.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (!touch || event.touches.length !== 1) {
        press = null;
        return;
      }
      // A new finger supersedes the last gesture: any click still to come belongs to this press.
      suppressClickUntil = 0;
      press = { x: touch.clientX, y: touch.clientY, moved: false };
    },
    { passive: true },
  );
  surface.addEventListener(
    'touchmove',
    (event) => {
      const active = press;
      if (!active) return;
      const touch = event.touches[0];
      if (!touch) return;
      if (Math.hypot(touch.clientX - active.x, touch.clientY - active.y) > TAP_SLOP_PX) {
        active.moved = true;
      }
    },
    { passive: true },
  );
  /*
   * The list moved under a finger that did not — momentum from a flick, or the scroller settling.
   * That is a scroll, not a tap, and it is the case a movement threshold alone cannot see. Only a
   * scroll *while a finger is down* counts: engines deliver scroll events coalesced and late, and a
   * scroll from before this press must not be read as part of it.
   */
  surface.addEventListener(
    'scroll',
    () => {
      if (press) press.moved = true;
    },
    { passive: true },
  );
  const release = (): void => {
    const ended = press;
    press = null;
    if (ended?.moved) refuseNextClick();
  };
  surface.addEventListener('touchend', release, { passive: true });
  // WebKit fires `touchcancel` the moment it claims a touch sequence for itself. v1.6 had no handler
  // here at all, which left a row convinced that a press was still in flight.
  surface.addEventListener('touchcancel', release, { passive: true });
  surface.addEventListener(
    'click',
    (event) => {
      /*
       * Only a *user's* click can be the one a drag left behind, and only a user's click is refused.
       *
       * `isTrusted` is the whole distinction: a click the browser delivers — from a thumb, a mouse, a
       * keyboard Enter, a switch control — is trusted, and WebKit's click at the end of a drag is one
       * of those. A click a script synthesises (`element.click()`) is not a gesture at all, and
       * refusing it would take the rows away from every diagnostic that drives them — measured here,
       * not reasoned: an untrusted click arriving inside the refusal's 700 ms window was eaten, which
       * is what `test/pager.test.ts` and `test/scroll-containment.test.ts` caught within a minute of
       * this being written.
       */
      if (!event.isTrusted) return;
      if (!refuseClick(performance.now())) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

/** The route the app is on right now, by its first segment. */
function currentHead(): string {
  return routeParts()[0] ?? 'artists';
}

/** True when the screen on top is a stacked one (settings, the changelog, the connect form). */
function onStackedRoute(): boolean {
  return STACKED_ROUTES.has(currentHead());
}

/**
 * v1.6: from a stacked screen, a right swipe is *back* — and it is the only horizontal gesture that
 * does anything there, because settings is not a pane of the pager (see `renderRoute`, which gates
 * `pager.setEnabled`). The owner's words: *"when im in settings, swiping left or right seems to bring
 * me to the spectrum or lyrics. this should not be the case, i should only be able to swipe right to
 * return to the previous screen which i accessed settings from."*
 *
 * It reads the recorded opener rather than `history.back()`, so it still works on the first screen
 * after a cold start (where back would leave the app).
 */
function bindStackedBack(host: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  host.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      tracking = Boolean(touch) && event.touches.length === 1 && onStackedRoute();
      if (!touch || !tracking) return;
      startX = touch.clientX;
      startY = touch.clientY;
    },
    { passive: true },
  );
  host.addEventListener(
    'touchend',
    (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // Right, mostly horizontal, and far enough to be meant.
      if (dx < 60 || dx < Math.abs(dy) * 1.4) return;
      const target = queueRefRef?.stackedFrom;
      if (target) location.hash = target;
    },
    { passive: true },
  );
}

/* -------------------------------------------------------------- the pager */

/**
 * The pager came to rest on a pane: say so in the route.
 *
 * The URL is the pager's state (see `renderRoute`), and writing it here is what makes the browser's
 * back and forward buttons walk the panes — the owner's optional nice-to-have, and free once the
 * route and the pane are the same fact.
 */
function settlePane(position: number): void {
  const shell = queueRefRef;
  if (!shell) return;
  const target =
    position === PANE_PLAYLIST
      ? shell.lastBrowseRoute || DEFAULT_ROUTE
      : position === PANE_LYRICS
        ? LYRICS_ROUTE
        : NOW_ROUTE;
  if (location.hash !== target) {
    location.hash = target;
    return;
  }
  // The route did not move — a drag that came back to where it started — so nothing will re-render
  // for us: put the screen back by hand, or the overlay would stay over the list.
  if (position === PANE_PLAYLIST) hideNowScreen(shell);
}

/**
 * A drag has just been read as horizontal, heading for `target`: make that pane exist before it
 * arrives. The overlay may still be hidden (a drag that starts on the playlist) and the lyrics are
 * fetched on first need, so both are readied here rather than assumed.
 */
function preparePane(target: number): void {
  const shell = queueRefRef;
  if (!shell) return;
  if (target === PANE_PLAYLIST) return;
  shell.nowOverlay.classList.remove('hidden');
  shell.playerBar.classList.add('hidden');
  applyNowMode(target === PANE_LYRICS ? 'lyrics' : 'spectrum');
}

/** The now screen is showing on `pane`. */
function showNowScreen(shell: Shell, pane: number): void {
  shell.nowOverlay.classList.remove('hidden');
  shell.playerBar.classList.add('hidden');
  applyNowMode(pane === PANE_LYRICS ? 'lyrics' : 'spectrum');
  shell.pager.show(pane);
}

/** The now screen is gone: the playlist is the screen, and the transport is back. */
function hideNowScreen(shell: Shell): void {
  shell.pager.hide();
  shell.nowOverlay.classList.add('hidden');
  shell.playerBar.classList.toggle('hidden', queueRef?.currentSong == null);
}

/** Which pane a route means. Anything that is not the now screen is the playlist. */
function paneOfRoute(head: string, id: string | undefined): number {
  if (head !== 'now') return PANE_PLAYLIST;
  return id === 'lyrics' ? PANE_LYRICS : PANE_SPECTRUM;
}

/**
 * Apply a mode to the screen — the pill, the class the dense text layout hangs off, and the lyrics
 * themselves. It does not move the pager: `setNowMode` does that by writing the route, and the
 * router animates.
 */
function applyNowMode(mode: NowMode): void {
  const shell = queueRefRef;
  shell.nowMode = mode;
  const lyrics = mode === 'lyrics';
  shell.pillSpectrum.classList.toggle('active', !lyrics);
  shell.pillLyrics.classList.toggle('active', lyrics);
  shell.pillSpectrum.setAttribute('aria-selected', String(!lyrics));
  shell.pillLyrics.setAttribute('aria-selected', String(lyrics));
  // v1.2/v1.5: the class the dense lyrics metrics hang off. The panes themselves are laid out side
  // by side now, so nothing is hidden here — the pager decides what is on screen.
  shell.nowOverlay.classList.toggle('lyrics-mode', lyrics);
  // Load on first view rather than on every track change: fewer requests, same result.
  if (lyrics) shell.lyrics.show(queueRef?.currentSong ?? null);
}

/**
 * The spectrum/lyrics pill. Both options are the *same pager* the finger drives — the route is what
 * moves, so the switch slides the strip instead of cutting to the other pane.
 */
function setNowMode(mode: NowMode): void {
  const target = mode === 'lyrics' ? LYRICS_ROUTE : NOW_ROUTE;
  if (location.hash === target) return;
  // A hashchange does not fire when the only difference is the trailing pane on the same screen and
  // the app is already there, so apply the mode directly as well; the pager follows the route.
  applyNowMode(mode);
  queueRefRef.pager.goTo(mode === 'lyrics' ? PANE_LYRICS : PANE_SPECTRUM);
  location.hash = target;
}

/**
 * The seek bar, and the drag that seeks with it.
 *
 * v1.7.1 — three things, all of them the owner's report that *"i can't drag the seek bar because it
 * registers as im trying to swipe to a different pane"*:
 *
 *   1. **The gesture belongs to the bar.** The row carries `data-pager="off"` and the pager asks by
 *      hit-test as well as by element, so a drag that starts here can never turn a page
 *      (`src/ui/pager.ts`, `ownsGesture`). The CSS gives the control its own `touch-action`, so the
 *      platform does not read the horizontal movement as a pan either.
 *   2. **The drag seeks, continuously.** v1.7 sought only on `change` — that is, on release — so
 *      nothing happened while the thumb was being dragged. Every move now seeks, throttled to one
 *      round trip per `SEEK_INTERVAL_MS`, with the last position always committed and the value on
 *      release seeking exactly where the finger left it.
 *   3. **The thumb is not pulled out from under the finger.** `scrubbing` is set on the way down (on
 *      `pointerdown` and on `touchstart`, because audio controls are reached by touch) and cleared
 *      when the gesture ends however it ends, so the engine's own position updates stop writing the
 *      input's value while a finger is on it.
 *
 * v1.7.2 — *"can you make it so the timing changes dynamically as i drag the seek bar so i know to
 * what time im seeking to if i release it?"*: the **label** follows the thumb now, not just the
 * thumb's position. v1.7.1 sought continuously, but the clock beside the bar was still written from
 * the player's own position and only when no finger was down, so the number under his thumb never
 * moved — the seek was happening, and the screen said nothing about it. `shell.scrubMs` is the
 * destination: written on every move, by whichever of the two bars is being dragged, and cleared on
 * release (which commits it) or on cancel (which does not, and puts the real position back).
 *
 * v1.7.4 — *"seek bar doesn't work on drag nothing happens but tapping does let me seek"*, and v1.7.3
 * shipped a bar whose drag was still the *platform's*. Everything v1.7.1 did made the gesture reach
 * the control (the pager refuses it by name and by hit-test, `touch-action: none` keeps the platform
 * from reading it as a pan) — and then the control's own slider behaviour was the only thing that
 * could turn the movement into a value. In the installed app it evidently never ran: nothing was
 * written, so nothing was seeked, while a tap still jumped the thumb because that is a `click` the
 * control answers on its own. That is exactly the shape of his report, and a tap-vs-drag difference
 * cannot be seen from a test that only taps.
 *
 * So the bar drives itself now. `pointerdown` on it captures the pointer and takes the value from
 * the finger's own x over the bar's own box (`msAtX`), one write per `pointermove`, committing
 * through the same throttle as before; `dragging` silences the `input` listener for the length of
 * the gesture, so the platform's slider — if it also runs — cannot write a second, relative answer
 * under us. Nothing that used to work is lost: with no pointer events at all, `dragging` never goes
 * true and the `input`/`change` path below is still the whole implementation.
 */
const SEEK_INTERVAL_MS = 120;

function bindSeek(input: HTMLInputElement, shell: Shell, getQueue: () => PlaybackQueue | null): void {
  let lastSeekAt = 0;
  let pendingMs: number | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  /** True from the moment a finger lands on the bar until the gesture ends: we are the writer. */
  let dragging = false;
  let pointerId: number | null = null;
  /**
   * Which channel owns the gesture that is running.
   *
   * v1.8.0 — this is the fix. The two input channels are not interchangeable on iOS: a native
   * `<input type=range>` is driven by WebKit's own recogniser, and the pointer stream that belongs
   * to the touch it claims is *cancelled* as soon as that recogniser takes over, while the touch
   * stream is delivered either way. v1.7.4 wrote the position from `pointermove` alone, so the only
   * writer of the value was an event the platform stops sending — which is why the drag worked in
   * the Chrome harness (whose synthetic touch feeds Chrome's input pipeline, which *does* synthesize
   * pointer events) and did nothing at all on the phone, while a tap still worked, because a tap
   * needs no move at all.
   */
  let owner: 'pointer' | 'touch' | null = null;

  const durationOf = (): number => queueDurationMs(getQueue());
  const valueMs = (): number => (Number(input.value) / 1000) * durationOf();

  const commit = (ms: number): void => {
    const queue = getQueue();
    if (!queue || ms < 0) return;
    void queue.seek(ms);
  };

  /**
   * Where a finger at this x is, in ms: the bar's own box, measured where the finger is.
   *
   * Absolute, not relative to the grab point, because the thumb on a seek bar is a position and not
   * a knob to push — the same reading a tap has always had, which is the one thing on this control
   * that was already working.
   */
  const msAtX = (clientX: number): number => {
    const duration = durationOf();
    if (duration <= 0) return 0;
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return fraction * duration;
  };

  /** The label, written from the finger: both bars show the same destination, wherever it was dragged. */
  const showDestination = (ms: number): void => {
    shell.scrubMs = ms;
    const text = formatTime(ms / 1000);
    shell.barPosition.textContent = text;
    shell.nowPosition.textContent = text;
    shell.barProgress.value = input.value;
    shell.nowProgress.value = input.value;
  };

  const begin = (): void => {
    shell.scrubbing = true;
  };

  /** Whatever ends the gesture: stop hiding the thumb, and seek to where the finger left it. */
  const finish = (): void => {
    const wasScrubbing = shell.scrubbing;
    shell.scrubbing = false;
    shell.scrubMs = null;
    if (trailing !== null) clearTimeout(trailing);
    trailing = null;
    pendingMs = null;
    if (!wasScrubbing) return;
    if (durationOf() > 0) commit(valueMs());
    // The bar goes back to the player's own clock — which is now the position that was just asked
    // for, so the label stays where the finger left it rather than snapping back.
    refreshSeekLabels();
  };

  /**
   * A cancelled gesture commits nothing and puts the real position back.
   *
   * The thumb was dragged away by the platform (a call, a system gesture, the screen locking), so
   * the track never went anywhere and the label must not keep claiming it did.
   */
  const cancel = (): void => {
    if (!shell.scrubbing) return;
    shell.scrubbing = false;
    shell.scrubMs = null;
    pendingMs = null;
    if (trailing !== null) clearTimeout(trailing);
    trailing = null;
    refreshSeekLabels();
  };

  /** The label and the seek, from one number — whichever of the two paths produced it. */
  const applyMs = (ms: number): void => {
    input.setAttribute('aria-valuetext', formatTime(ms / 1000));
    // The number under the thumb moves on every frame of the drag, whether or not a seek is sent.
    showDestination(ms);
    const now = performance.now();
    if (now - lastSeekAt >= SEEK_INTERVAL_MS) {
      lastSeekAt = now;
      pendingMs = null;
      commit(ms);
      return;
    }
    // Between round trips the finger keeps moving; the last position is what gets sent, so the
    // seek lands where the finger stopped rather than where it was 120 ms ago.
    pendingMs = ms;
    if (trailing !== null) return;
    trailing = setTimeout(() => {
      trailing = null;
      lastSeekAt = performance.now();
      const queued = pendingMs;
      pendingMs = null;
      if (queued !== null) commit(queued);
    }, SEEK_INTERVAL_MS);
  };

  /** The finger's own reading of the bar: write the position, then show it and commit it. */
  const write = (clientX: number): void => {
    const duration = durationOf();
    if (duration <= 0) return;
    const ms = msAtX(clientX);
    input.value = String(Math.round((ms / duration) * 1000));
    applyMs(ms);
  };

  const release = (id: number | null): void => {
    if (id !== null && typeof input.releasePointerCapture === 'function') {
      try {
        input.releasePointerCapture(id);
      } catch {
        // The capture is already gone (the platform took the gesture back). Nothing to release.
      }
    }
    dragging = false;
    pointerId = null;
    owner = null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A gesture the touch channel has already claimed is not this channel's to write (v1.8.0).
    if (owner === 'touch') return;
    /*
     * The gesture is the bar's from here, and it is the bar that will write the value.
     *
     * Capture, so every move of this finger reaches the bar even after it travels off the bar's own
     * box (a drag that leaves the control must keep seeking, not silently stop), and `preventDefault`
     * so the platform's own slider does not begin a second, relative drag underneath ours. Both
     * writers running is precisely the "nothing happens" this is fixing.
     */
    owner = 'pointer';
    dragging = true;
    pointerId = event.pointerId;
    begin();
    if (typeof input.setPointerCapture === 'function') {
      try {
        input.setPointerCapture(event.pointerId);
      } catch {
        // No capture available: moves inside the box still arrive, and the `input` path below is
        // still armed for the ones that do not.
      }
    }
    if (event.cancelable) event.preventDefault();
    write(event.clientX);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (owner !== 'pointer' || !dragging || (pointerId !== null && event.pointerId !== pointerId)) return;
    if (event.cancelable) event.preventDefault();
    write(event.clientX);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (owner !== 'pointer' || !dragging || (pointerId !== null && event.pointerId !== pointerId)) return;
    release(pointerId);
    finish();
  };

  const onPointerCancel = (): void => {
    if (owner !== 'pointer' || !dragging) return;
    release(pointerId);
    cancel();
  };

  /**
   * The touch channel: the finger's own events, and the ones this control now owns the drag on.
   *
   * v1.8.0 — everything the owner reported as "i can only tap to seek" comes from the missing writer
   * here. A real finger on a native `<input type=range>` produces no usable `pointermove` in WebKit
   * (the control's own recogniser claims the touch and the pointer stream is cancelled), so the bar
   * has to take the movement from `touchmove`, which iOS delivers for this control as for any other
   * element. Two separate things are needed and neither is optional:
   *
   *   - `write(touches[0].clientX)` on the move — the value comes from where the finger *is*, over
   *     the bar's own box, exactly the reading the tap already used;
   *   - `preventDefault()` on a **non-passive** `touchmove` — `touch-action: none` stops the page
   *     scrolling, it does not stop the range control's own drag, and letting both run is the
   *     "nothing happens" of two writers again. A passive listener cannot call `preventDefault`, so
   *     the option is part of the fix rather than a detail of it.
   *
   * The `touchstart` listener is deliberately passive and writes nothing but the value: it must not
   * prevent the default there, because the browser needs it to see this as a touch sequence at all.
   */
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    // A second finger is a pinch or a scroll, not a seek: give the gesture up rather than fight it.
    if (event.touches.length > 1) {
      if (owner === 'touch') {
        owner = null;
        dragging = false;
        cancel();
      }
      return;
    }
    if (!touch) return;
    owner = 'touch';
    dragging = true;
    begin();
    write(touch.clientX);
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (owner !== 'touch' || !dragging) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (event.cancelable) event.preventDefault();
    write(touch.clientX);
  };

  const onTouchEnd = (): void => {
    if (owner !== 'touch') return;
    owner = null;
    dragging = false;
    finish();
  };

  const onTouchCancel = (): void => {
    if (owner !== 'touch') return;
    owner = null;
    dragging = false;
    cancel();
  };

  input.addEventListener('pointerdown', onPointerDown);
  input.addEventListener('pointermove', onPointerMove);
  input.addEventListener('pointerup', onPointerUp);
  input.addEventListener('pointercancel', onPointerCancel);
  input.addEventListener('touchstart', onTouchStart, { passive: true });
  // Non-passive by necessity: this listener's `preventDefault` is what keeps the native control
  // from taking the movement the bar is measuring (see the note on `onTouchStart`).
  input.addEventListener('touchmove', onTouchMove, { passive: false });
  input.addEventListener('input', () => {
    // Our own drag is the writer for the length of the gesture; a second writer is the bug.
    if (dragging) return;
    if (durationOf() <= 0) return;
    applyMs(valueMs());
  });
  input.addEventListener('change', () => {
    if (!dragging) finish();
  });
  input.addEventListener('touchend', onTouchEnd, { passive: true });
  input.addEventListener('touchcancel', onTouchCancel, { passive: true });
}

function queueDurationMs(queue: PlaybackQueue | null): number {
  if (!queue) return 0;
  const song = queue.currentSong;
  return (song?.duration ?? 0) * 1000;
}

function applyPaletteVars(shell: Shell, palette: Palette): void {
  shell.visualizerHost.style.setProperty('--accent-primary', palette.primary);
  shell.visualizerHost.style.setProperty('--accent-secondary', palette.secondary);
  shell.visualizerHost.style.setProperty('--accent-tertiary', palette.accent);
  document.documentElement.style.setProperty('--accent-primary', palette.primary);
  document.documentElement.style.setProperty('--accent-secondary', palette.secondary);
  document.documentElement.style.setProperty('--accent-tertiary', palette.accent);
  /*
   * v1.7.4 — the canvas is a consumer of the palette, right here, in the same call.
   *
   * The owner: *"the colors are also not matching the album art theme it seems to just be one blue
   * color no matter what"*. There was one palette function (`syncPalette`) and it reached the
   * visualiser through a path of its own (`applyPalette` in `boot`), while the palette the rest of
   * the UI wears is written *here* — and this function is called from the cold start, from a fresh
   * sign-in and from the settings screen, which is one path too many for the two to stay in step.
   * Painting the bars from the same function that paints the variables makes the two the same
   * palette by construction: there is no longer a route that can colour the UI and not the
   * spectrum. `setPalette` rebuilds the bar colours once (never per frame), so a track change
   * recolours the spectrum with nothing in the frame loop to recompute.
   */
  visualizerRef?.setPalette(palette);
}

/**
 * The one visualiser this app has, so the palette above can reach it without threading a handle
 * through every sign-in path.
 */
let visualizerRef: ReturnType<typeof attachVisualizer> | null = null;

/* ------------------------------------------------------------------- state */

/*
 * The palette hook is a plain callback, not an object with an `apply` method.
 *
 * v1.4.1 fixed this on `main` and v1.5 branched away from it, so the bug came back with the pager:
 * until v1.6 this file declared `interface PaletteHooks { apply(palette: Palette): void }`, and that
 * shape is a trap — **a function satisfies it structurally**, because `(palette: Palette) => void`
 * already has an `apply`: `Function.prototype.apply`. So `restoreSession(ctx, shell, applyPalette)` —
 * the cold-start path, i.e. every normal launch — type-checked fine, `hooks.apply(DEFAULT_PALETTE)`
 * then ran `applyPalette(undefined)`, and `applyPaletteVars` threw on `palette.primary` inside a
 * floating promise: no theme, no error anyone could see. Passing the function itself removes the
 * shape that made the mistake possible, in both directions.
 */
type ApplyPalette = (palette: Palette) => void;

let currentPaletteSong: string | null = null;

async function restoreSession(ctx: AppContext, shell: Shell, applyPalette: ApplyPalette): Promise<boolean> {
  const { serverUrl, username } = ctx.settings;
  if (!username) return false;
  const password = await ctx.secrets.get(PASSWORD_KEY);
  if (password === null) return false;
  connect(ctx, shell, { serverUrl, username, password }, applyPalette, { silent: true });
  return true;
}

/**
 * Bring back exactly what was playing, without asking the server first.
 *
 * The device's own snapshot (`src/storage/session.ts`) is written every few seconds while a track
 * plays and holds the play order as well as the position, so a relaunch lands on the same second of
 * the same track in the same order. The server's `savePlayQueue` — which v1.6 restored from — is
 * written debounced on a track change, so it knows the right *track* but only an approximate
 * position; it stays as the fallback for a fresh install or a snapshot older than 12 hours.
 *
 * If the snapshot says it was playing, it is started again: that is what "the resume is exact" has
 * to mean when the OS killed the app in the background. On the web the browser will refuse audio
 * without a gesture — that is not an error, the queue simply stays restored and paused, which is
 * what v1.1 promised.
 */
async function restorePlayQueue(ctx: AppContext): Promise<boolean> {
  const queue = ctx.queue;
  if (!queue) return false;
  const snapshot = loadSnapshot();
  if (snapshot) {
    queue.restoreExact(
      {
        songs: snapshot.songs,
        order: snapshot.order,
        cursor: snapshot.cursor,
        shuffle: snapshot.shuffle,
        repeat: snapshot.repeat,
        context: snapshot.context,
      },
      snapshot.positionMs,
    );
    if (snapshot.playing) {
      try {
        await queue.start();
      } catch (error) {
        console.warn('[navilite] could not start the restored track; leaving it paused', error);
      }
    }
    return true;
  }
  return restoreServerQueue(ctx);
}

/**
 * The queue the server saved for us (`savePlayQueue` on every track change), put back
 * without starting playback. This is what makes a cold start land on the spectrum screen
 * for the track that was playing, as the owner asked.
 */
async function restoreServerQueue(ctx: AppContext): Promise<boolean> {
  const client = ctx.library?.client;
  const queue = ctx.queue;
  if (!client || !queue) return false;
  try {
    const saved = await client.getPlayQueue();
    const entries = saved?.entry ?? [];
    if (entries.length === 0) return false;
    const items: QueueItem[] = entries.map((song) => ({ song, context: { kind: 'song', name: 'your last session' } }));
    const found = entries.findIndex((song) => song.id === saved?.current);
    queue.restore(items, found === -1 ? 0 : found, saved?.position ?? 0, {
      kind: 'song',
      name: 'your last session',
    });
    return true;
  } catch (error) {
    console.warn('[navilite] could not restore the saved play queue', error);
    return false;
  }
}

interface Credentials {
  serverUrl: string;
  username: string;
  password: string;
}

function connect(ctx: AppContext, shell: Shell, credentials: Credentials, applyPalette: ApplyPalette, options: { silent?: boolean } = {}): void {
  const client = new SubsonicClient(credentials);
  const library = new Library(client);
  const queue = new PlaybackQueue(ctx.engine, library);
  ctx.library = library;
  ctx.queue = queue;
  // The library's own lyric route lives on the same door as the API, so it is derived from the
  // same base URL: `''` means "the origin this app was served from" (`src/api/sidecar.ts`).
  ctx.sidecar = new LyricsRoute(client.baseUrl);
  queueRef = queue;
  queue.onChanged = () => {
    updatePlayerBar(ctx, shell, ctx.engine.status());
    void syncPalette(ctx, applyPalette);
  };
  if (!options.silent) {
    queue.onChanged();
  }
}

async function syncPalette(ctx: AppContext, applyPalette: ApplyPalette): Promise<void> {
  const song = ctx.queue?.currentSong ?? null;
  if (!song || song.id === currentPaletteSong) return;
  currentPaletteSong = song.id;
  const url = ctx.library?.coverUrl(song.coverArt ?? song.albumId, 256) ?? null;
  /*
   * v1.9.0 — the reset is deferred past the task that asked for it, and the *reason* is measured
   * rather than assumed: the first tap of a session paints in ~55 ms, and every tap after it in
   * under a millisecond (Chrome at 393 x 852, against the mock — `test/slow-link-browser.test.ts`
   * quotes both). A deferred write cannot be more than a small part of a burst that size, but a
   * full-document style recalculation has no business inside the task that owes the finger a
   * highlight: the reset only exists so the previous track's colours do not sit under the new one
   * for the length of the artwork read, and nothing is lost by paying for it one macrotask later.
   */
  await new Promise((resolve) => setTimeout(resolve, 0));
  applyPalette(DEFAULT_PALETTE);
  const palette = await paletteFromArtwork(url);
  if (ctx.queue?.currentSong?.id === song.id) applyPalette(palette);
}

/* ------------------------------------------------------------------ lock */

/**
 * Freeze the view behind the now-playing screen — and remember where it was.
 *
 * v1.4. Both halves are needed. Hiding the scroll container takes the list underneath out of the
 * scroll pipeline entirely, so a wheel or touch gesture over the overlay has nothing to reach (the
 * overlay covers the screen, and the box under it is not scrollable); and recording the offset is
 * what makes closing the spectrum land on the row he was looking at instead of the top of the list.
 *
 * The offset is only *re-applied* once the view has been drawn again — see `restoreScroll`, which
 * the router calls when a view's promise settles. Restoring it here would be pointless: the render
 * that follows briefly collapses the list to "Loading…", and the browser clamps a scroll position
 * it cannot reach to zero.
 */
function setScrollLock(shell: Shell, locked: boolean): void {
  if (locked === shell.scrollLocked) return;
  shell.scrollLocked = locked;
  if (locked) {
    shell.pendingScroll = { route: shell.viewRoute, top: shell.viewScroll.scrollTop };
    shell.viewScroll.classList.add('scroll-locked');
    return;
  }
  shell.viewScroll.classList.remove('scroll-locked');
}

/** Put the covered view back exactly where it was, once that view's content is on screen again. */
function restoreScroll(shell: Shell, route: string): void {
  const pending = shell.pendingScroll;
  if (!pending) return;
  shell.pendingScroll = null;
  // Only the route it was recorded on gets it back; a different screen starts at the top.
  if (pending.route === route) shell.viewScroll.scrollTop = pending.top;
}

/* ----------------------------------------------------------------- router */

function routeParts(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

function renderRoute(ctx: AppContext, shell: Shell): void {
  queueRefRef = shell;
  const [head = 'artists', id, extra] = routeParts();
  setActiveTab(shell, head);
  const nowOpen = head === 'now';
  const stacked = STACKED_ROUTES.has(head);
  /*
   * v1.6: the pager's surface is the panes and the list behind them — never a stacked screen.
   *
   * Settings and the changelog are pushed on top of a screen, not beside one, so a horizontal drag
   * there has nothing to page to and must be inert (the owner: *"when im in settings, swiping left
   * or right seems to bring me to the spectrum or lyrics"*). The pager's own `setEnabled` also drops
   * any drag that was in flight, so the gate cannot be crossed mid-gesture.
   */
  shell.pager.setEnabled(!stacked);
  // v1.5: the route *is* the pager's position — `#/now` is the spectrum pane and `#/now/lyrics` the
  // lyrics, so the router is what moves the pager (and the back button walks the panes).
  if (nowOpen) showNowScreen(shell, paneOfRoute(head, id));
  else hideNowScreen(shell);
  // v1.4: the overlay freezes what is under it, and closing it puts that view back where it was.
  setScrollLock(shell, nowOpen);
  if (stacked) {
    /*
     * Remember what was on screen when the stacked screen was pushed, for its right swipe back.
     * `viewRoute` still holds the previous screen at this point (it is reassigned below), and a
     * stacked screen opened *from* another stacked screen keeps the original opener.
     */
    const previousHead = (shell.viewRoute ?? '').replace(/^#\/?/, '').split('/')[0] ?? '';
    if (!STACKED_ROUTES.has(previousHead)) {
      shell.stackedFrom = shell.viewRoute || shell.lastBrowseRoute || DEFAULT_ROUTE;
    }
  } else if (!nowOpen) {
    shell.lastBrowseRoute = location.hash || DEFAULT_ROUTE;
  }
  // The view behind the now screen is only rendered when it is not covered: it saves a
  // network round trip on a cold start that lands straight on the spectrum.
  if (nowOpen && ctx.queue?.currentSong) {
    shell.playerBar.classList.add('hidden');
    return;
  }
  shell.playerBar.classList.toggle('hidden', ctx.queue?.currentSong == null);
  if (!ctx.library || !ctx.queue) {
    void renderConnect(ctx, shell);
    return;
  }
  ctx.rows.clear();
  shell.highlighted = null;
  const routeKey = location.hash || DEFAULT_ROUTE;
  shell.viewRoute = routeKey;
  const fail = (error: unknown) => {
    replace(shell.view, h('div', { class: 'empty' }, [h('p', { text: errorText(error) })]));
  };
  /**
   * Every view is drawn asynchronously (the library is a network away), so the scroll restore waits
   * for the promise: the offset belongs to the finished view, not to the "Loading…" placeholder
   * that stands in for it while the request is in flight.
   */
  const drawn = (promise: Promise<void>): void => {
    void promise.then(() => restoreScroll(shell, routeKey)).catch(fail);
  };
  switch (head) {
    case 'artists':
      drawn(renderArtists(ctx, shell));
      break;
    case 'albums':
      drawn(renderAlbums(ctx, shell));
      break;
    case 'playlists':
      drawn(renderPlaylists(ctx, shell));
      break;
    case 'favourites':
      drawn(renderFavourites(ctx, shell));
      break;
    case 'search':
      drawn(renderSearch(ctx, shell, id ? decodeURIComponent(id) : ''));
      break;
    case 'artist':
      drawn(renderArtist(ctx, shell, id ?? ''));
      break;
    case 'album':
      drawn(renderAlbum(ctx, shell, id ?? ''));
      break;
    case 'playlist':
      drawn(renderPlaylist(ctx, shell, id ?? ''));
      break;
    case 'settings':
      renderSettings(ctx, shell);
      restoreScroll(shell, routeKey);
      break;
    case 'changelog':
      renderChangelog(shell);
      restoreScroll(shell, routeKey);
      break;
    case 'connect':
      void renderConnect(ctx, shell);
      restoreScroll(shell, routeKey);
      break;
    case 'now':
      // Covered by the overlay; nothing to draw behind it.
      replace(shell.view, h('div'));
      restoreScroll(shell, routeKey);
      break;
    default:
      replace(
        shell.view,
        h('div', { class: 'empty' }, [
          h('p', { text: `No such screen: ${head}${extra ? `/${extra}` : ''}` }),
          h('button', { class: 'button', text: 'Back to the library', onclick: () => (location.hash = DEFAULT_ROUTE) }),
        ]),
      );
      restoreScroll(shell, routeKey);
  }
  updateRowHighlight(ctx, shell);
}

function setActiveTab(shell: Shell, head: string): void {
  const alias = head === 'artist' ? 'artists' : head === 'playlist' ? 'playlists' : head;
  // The now screen, settings and the changelog do not belong to a tab: leaving the last
  // one highlighted is the honest thing, since you got there from it.
  if (!shell.tabs.has(alias)) return;
  for (const [route, button] of shell.tabs) {
    const active = route === alias;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  }
}

function pageTitle(shell: Shell, title: string, subtitle?: string, actions: HTMLElement[] = []): void {
  replace(
    shell.view,
    h('div', { class: 'page-head' }, [
      h('div', { class: 'page-title-text' }, [h('h1', { text: title }), subtitle ? h('p', { class: 'muted', text: subtitle }) : null]),
      h('div', { class: 'page-actions' }, actions),
    ]),
  );
}

function loading(shell: Shell, message = 'Loading…'): void {
  replace(shell.view, h('div', { class: 'empty' }, [h('p', { class: 'muted', text: message })]));
}

/* ------------------------------------------------------------------ views */

async function renderConnect(ctx: AppContext, shell: Shell): Promise<void> {
  const urlInput = h('input', {
    class: 'field',
    type: 'url',
    inputmode: 'url',
    autocapitalize: 'off',
    autocomplete: 'off',
    placeholder: SERVER_URL_PLACEHOLDER,
    value: ctx.settings.serverUrl || DEFAULT_SERVER_URL,
  });
  const userInput = h('input', {
    class: 'field',
    type: 'text',
    autocomplete: 'username',
    placeholder: 'username',
    value: ctx.settings.username,
  });
  const passwordInput = h('input', { class: 'field', type: 'password', autocomplete: 'current-password', placeholder: 'password' });
  const status = h('p', { class: 'muted', text: '' });
  const testButton = h('button', { class: 'button', text: 'Test connection' });
  const saveButton = h('button', { class: 'button primary', text: 'Save and continue' });

  const readForm = (): Credentials => ({
    // v1.1: a blank field means the library, not a dead end.
    serverUrl: urlInput.value.trim() || DEFAULT_SERVER_URL,
    username: userInput.value.trim(),
    password: passwordInput.value,
  });

  testButton.addEventListener('click', () => {
    const credentials = readForm();
    status.textContent = 'Testing…';
    void (async () => {
      try {
        const client = new SubsonicClient(credentials);
        const info = await client.ping();
        status.textContent = `Connected: ${info.type ?? 'server'} ${info.serverVersion ?? info.version ?? ''}`.trim();
      } catch (error) {
        status.textContent = errorText(error);
      }
    })();
  });

  saveButton.addEventListener('click', () => {
    const credentials = readForm();
    if (!credentials.username || !credentials.password) {
      status.textContent = 'Username and password are required.';
      return;
    }
    status.textContent = 'Checking…';
    void (async () => {
      try {
        const client = new SubsonicClient(credentials);
        await client.ping();
        ctx.settings = { ...ctx.settings, serverUrl: credentials.serverUrl, username: credentials.username };
        saveSettings(ctx.settings);
        await ctx.secrets.set(PASSWORD_KEY, credentials.password);
        connect(ctx, shell, credentials, (palette) => applyPaletteGlobal(shell, palette));
        location.hash = DEFAULT_ROUTE;
        ctx.toast(`Connected as ${credentials.username}`);
      } catch (error) {
        status.textContent = errorText(error);
      }
    })();
  });

  replace(
    shell.view,
    h('div', { class: 'connect' }, [
      h('h1', { text: 'Connect to your library' }),
      h('p', { class: 'muted', text: 'Navilite talks Subsonic to Navidrome. The password never leaves the device except as a per-request md5 token.' }),
      h('label', { class: 'label', text: 'Server URL' }),
      urlInput,
      h('label', { class: 'label', text: 'Username' }),
      userInput,
      h('label', { class: 'label', text: 'Password' }),
      passwordInput,
      h('div', { class: 'row' }, [testButton, saveButton]),
      status,
      h('p', { class: 'muted small', text: ctx.secrets.secure
        ? `Credentials are stored in ${ctx.secrets.description}.`
        : `Credentials are stored in ${ctx.secrets.description} — a pure PWA has no OS keystore. The Android/iOS builds use Keychain / Android Keystore instead.` }),
      h('p', { class: 'muted small', text: 'Left blank, the address above is used — that is your library.' }),
    ]),
  );
}

/** One-off palette application when the shell's own hooks are not in scope. */
function applyPaletteGlobal(shell: Shell, palette: Palette): void {
  applyPaletteVars(shell, palette);
}

async function renderArtists(ctx: AppContext, shell: Shell): Promise<void> {
  // Search lives here now that the Search tab is gone (the owner asked for the tab to go,
  // not the ability), and the URL is still `#/search/<query>` so a deep link works.
  const query = h('input', {
    class: 'field inline',
    type: 'search',
    placeholder: 'Search your library',
    autocomplete: 'off',
    enterkeyhint: 'search',
    'aria-label': 'Search your library',
  });
  const run = (): void => {
    const value = query.value.trim();
    if (value === '') return;
    location.hash = `#/search/${encodeURIComponent(value)}`;
  };
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') run();
  });
  pageTitle(shell, 'Library', 'Artists, from getArtists', [
    query,
    h('button', { class: 'button', 'aria-label': 'Search', text: 'Search', onclick: run }),
  ]);
  const listHost = h('div', { class: 'list' }, [h('p', { class: 'muted', text: 'Loading artists…' })]);
  shell.view.append(listHost);
  const artists = await ctx.library!.artists();
  if (artists.length === 0) {
    replace(listHost, h('p', { class: 'muted', text: 'No artists in this library.' }));
    return;
  }
  replace(
    listHost,
    ...artists.map((artist) => artistRow(ctx, artist)),
  );
}

async function renderAlbums(ctx: AppContext, shell: Shell): Promise<void> {
  const select = h('select', { class: 'field inline' }, [
    ...(
      [
        ['alphabeticalByName', 'A–Z'],
        ['newest', 'Newest'],
        ['recent', 'Recently played'],
        ['frequent', 'Most played'],
        ['starred', 'Favourites'],
      ] as Array<[AlbumListType, string]>
    ).map(([value, label]) => h('option', { value, text: label })),
  ]);
  pageTitle(shell, 'Albums', 'getAlbumList2', [select]);
  const listHost = h('div', { class: 'grid' }, [h('p', { class: 'muted', text: 'Loading albums…' })]);
  shell.view.append(listHost);
  const load = async (): Promise<void> => {
    const albums = await ctx.library!.albumList(select.value as AlbumListType, 200);
    replace(listHost, ...albums.map((album) => albumCard(ctx, album)));
    if (albums.length === 0) replace(listHost, h('p', { class: 'muted', text: 'Nothing here yet.' }));
  };
  select.addEventListener('change', () => void load());
  await load();
}

function albumCard(ctx: AppContext, album: Album): HTMLElement {
  return bindTap(
    h('button', { class: 'card', 'aria-label': `Open ${album.name}` }, [
      cover(ctx.library!.coverUrl(album.coverArt ?? album.id, 256), 'card-cover', album.name),
      h('span', { class: 'card-title', text: album.name }),
      h('span', { class: 'card-sub', text: album.artist ?? '' }),
    ]),
    () => (location.hash = `#/album/${encodeURIComponent(album.id)}`),
  );
}

/** An artist in a list: a tap opens the artist, a drag that scrolls the list does not. */
function artistRow(ctx: AppContext, artist: Artist): HTMLElement {
  return bindTap(
    h('button', { class: 'row', 'aria-label': `Open ${artist.name}` }, [
      cover(ctx.library!.coverUrl(artist.coverArt ?? artist.id, 128), 'thumb', artist.name),
      h('div', { class: 'row-text' }, [
        h('span', { class: 'row-title', text: artist.name }),
        h('span', { class: 'row-sub', text: `${artist.albumCount ?? 0} album${artist.albumCount === 1 ? '' : 's'}` }),
      ]),
    ]),
    () => (location.hash = `#/artist/${encodeURIComponent(artist.id)}`),
  );
}

async function renderArtist(ctx: AppContext, shell: Shell, id: string): Promise<void> {
  loading(shell);
  const artist = await ctx.library!.artist(id);
  pageTitle(shell, artist.name, `${artist.albumCount ?? artist.album?.length ?? 0} albums`);
  const host = h('div', { class: 'grid' });
  const albums = artist.album ?? [];
  replace(host, ...albums.map((album) => albumCard(ctx, album)));
  shell.view.append(host);
  if (albums.length === 0) shell.view.append(h('p', { class: 'muted', text: 'No albums returned for this artist.' }));
}

async function renderAlbum(ctx: AppContext, shell: Shell, id: string): Promise<void> {
  loading(shell);
  const album = await ctx.library!.album(id);
  const songs = album.song ?? [];
  const items: QueueItem[] = songs.map((song) => ({ song, context: { kind: 'album', id, name: album.name } }));
  const starred = Boolean(album.starred);

  const playAll = h('button', { class: 'button primary', text: 'Play album' }, [icon(ICONS.play, 16)]);
  playAll.addEventListener('click', () => void ctx.queue!.play(items, 0, items[0]?.context ?? null));
  const starButton = h('button', { class: 'button', title: starred ? 'Remove from favourites' : 'Add to favourites' }, [
    starIcon(starred),
  ]);
  starButton.addEventListener('click', () => {
    void (async () => {
      await ctx.library!.setStarred(id, 'album', !starred);
      ctx.toast(starred ? 'Removed from favourites' : 'Added to favourites');
      ctx.render();
    })();
  });

  const playlistPicker = h('select', { class: 'field inline' }, [h('option', { value: '', text: 'Add to playlist…' })]);
  void (async () => {
    const playlists = await ctx.library!.playlists();
    for (const playlist of playlists) playlistPicker.append(h('option', { value: playlist.id, text: playlist.name }));
  })();
  playlistPicker.addEventListener('change', () => {
    const playlistId = playlistPicker.value;
    if (!playlistId) return;
    void (async () => {
      try {
        await ctx.library!.addToPlaylist(playlistId, songs.map((song) => song.id));
        ctx.toast(`Added ${songs.length} tracks to the playlist`);
      } catch (error) {
        ctx.toast(errorText(error), 'error');
      }
      playlistPicker.value = '';
    })();
  });

  replace(
    shell.view,
    h('div', { class: 'detail' }, [
      cover(ctx.library!.coverUrl(album.coverArt ?? album.id, 512), 'detail-cover', album.name),
      h('div', { class: 'detail-text' }, [
        h('h1', { text: album.name }),
        h('p', { class: 'muted', text: [album.artist, album.year, `${songs.length} tracks`, formatDuration(album.duration)].filter(Boolean).join(' · ') }),
        h('div', { class: 'row' }, [playAll, starButton, playlistPicker]),
      ]),
    ]),
    h('div', { class: 'list' }, songs.map((song, index) => songRow(ctx, song, index, items, items[0]?.context ?? null, true))),
  );
  updateRowHighlight(ctx, shell);
}

async function renderPlaylists(ctx: AppContext, shell: Shell): Promise<void> {
  const nameInput = h('input', { class: 'field inline', placeholder: 'New playlist name', autocomplete: 'off' });
  const createButton = h('button', { class: 'button primary', text: 'Create' });
  createButton.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    void (async () => {
      try {
        await ctx.library!.createPlaylist(name, []);
        nameInput.value = '';
        ctx.toast(`Created “${name}”`);
        ctx.render();
      } catch (error) {
        ctx.toast(errorText(error), 'error');
      }
    })();
  });
  pageTitle(shell, 'Playlists', 'getPlaylists / createPlaylist', [nameInput, createButton]);
  const host = h('div', { class: 'list' }, [h('p', { class: 'muted', text: 'Loading playlists…' })]);
  shell.view.append(host);
  const playlists = await ctx.library!.playlists();
  if (playlists.length === 0) {
    replace(host, h('p', { class: 'muted', text: 'No playlists yet — name one above.' }));
    return;
  }
  replace(host, ...playlists.map((playlist) => playlistRow(ctx, playlist)));
}

function playlistRow(ctx: AppContext, playlist: Playlist): HTMLElement {
  const row = bindTap(
    h('button', { class: 'row', 'aria-label': `Open ${playlist.name}` }, [
      cover(ctx.library!.coverUrl(playlist.coverArt ?? playlist.id, 128), 'thumb', playlist.name),
      h('div', { class: 'row-text' }, [
        h('span', { class: 'row-title', text: playlist.name }),
        h('span', { class: 'row-sub', text: `${playlist.songCount ?? 0} tracks · ${formatDuration(playlist.duration)}` }),
      ]),
    ]),
    () => (location.hash = `#/playlist/${encodeURIComponent(playlist.id)}`),
  );
  return row;
}

async function renderPlaylist(ctx: AppContext, shell: Shell, id: string): Promise<void> {
  loading(shell);
  const playlist = await ctx.library!.playlist(id);
  const songs = playlist.entry ?? [];
  const items: QueueItem[] = songs.map((song) => ({ song, context: { kind: 'playlist', id, name: playlist.name } }));
  const playAll = h('button', { class: 'button primary', text: 'Play playlist' }, [icon(ICONS.play, 16)]);
  playAll.addEventListener('click', () => void ctx.queue!.play(items, 0, items[0]?.context ?? null));
  pageTitle(shell, playlist.name, `${songs.length} tracks · ${formatDuration(playlist.duration)}`, [playAll]);
  replace(
    shell.view,
    shell.view.firstElementChild ?? h('div'),
    h(
      'div',
      { class: 'list' },
      songs.map((song, index) =>
        songRow(ctx, song, index, items, items[0]?.context ?? null, true, () => {
          void (async () => {
            try {
              await ctx.library!.removeFromPlaylist(id, index);
              ctx.toast('Removed from the playlist');
              ctx.render();
            } catch (error) {
              ctx.toast(errorText(error), 'error');
            }
          })();
        }),
      ),
    ),
  );
  updateRowHighlight(ctx, shell);
}

async function renderFavourites(ctx: AppContext, shell: Shell): Promise<void> {
  loading(shell);
  const starred = await ctx.library!.starred();
  const songs = starred.song ?? [];
  const albums = starred.album ?? [];
  const artists = starred.artist ?? [];
  const items: QueueItem[] = songs.map((song) => ({ song, context: { kind: 'favourites', name: 'Favourites' } }));
  const playAll = h('button', { class: 'button primary', text: 'Play favourites' }, [icon(ICONS.play, 16)]);
  playAll.disabled = items.length === 0;
  playAll.addEventListener('click', () => void ctx.queue!.play(items, 0, items[0]?.context ?? null));
  pageTitle(shell, 'Favourites', `${songs.length} tracks · ${albums.length} albums · ${artists.length} artists`, [playAll]);

  if (songs.length === 0 && albums.length === 0 && artists.length === 0) {
    shell.view.append(h('p', { class: 'muted', text: 'Nothing starred yet. Use the star on an album — its tracks come along.' }));
    return;
  }

  if (artists.length > 0) {
    shell.view.append(
      h('h2', { class: 'section', text: 'Artists' }),
      h(
        'div',
        { class: 'grid' },
        ...artists.map((artist: Artist) =>
          bindTap(
            h('button', { class: 'card', 'aria-label': `Open ${artist.name}` }, [
              cover(ctx.library!.coverUrl(artist.coverArt ?? artist.id, 256), 'card-cover', artist.name),
              h('span', { class: 'card-title', text: artist.name }),
            ]),
            () => (location.hash = `#/artist/${encodeURIComponent(artist.id)}`),
          ),
        ),
      ),
    );
  }
  if (albums.length > 0) {
    shell.view.append(h('h2', { class: 'section', text: 'Albums' }), h('div', { class: 'grid' }, ...albums.map((album) => albumCard(ctx, album))));
  }
  if (songs.length > 0) {
    shell.view.append(
      h('h2', { class: 'section', text: 'Tracks' }),
      h('div', { class: 'list' }, ...songs.map((song, index) => songRow(ctx, song, index, items, items[0]?.context ?? null, true))),
    );
  }
  updateRowHighlight(ctx, shell);
}

async function renderSearch(ctx: AppContext, shell: Shell, initial = ''): Promise<void> {
  const input = h('input', {
    class: 'field inline',
    type: 'search',
    placeholder: 'Search the library',
    autocomplete: 'off',
    enterkeyhint: 'search',
    value: initial,
  });
  const results = h('div', { class: 'list' });
  const submit = (): void => {
    const query = input.value.trim();
    if (!query) return;
    replace(results, h('p', { class: 'muted', text: 'Searching…' }));
    void (async () => {
      try {
        const found = await ctx.library!.search(query);
        const songs = found.song ?? [];
        const albums = found.album ?? [];
        const artists = found.artist ?? [];
        const items: QueueItem[] = songs.map((song) => ({ song, context: { kind: 'search', name: query } }));
        replace(
          results,
          songs.length > 0 ? h('h2', { class: 'section', text: 'Tracks' }) : null,
          ...songs.map((song, index) => songRow(ctx, song, index, items, items[0]?.context ?? null, true)),
          albums.length > 0 ? h('h2', { class: 'section', text: 'Albums' }) : null,
          ...albums.map((album) => albumCard(ctx, album)),
          artists.length > 0 ? h('h2', { class: 'section', text: 'Artists' }) : null,
          ...artists.map((artist: Artist) =>
            bindTap(
              h('button', { class: 'row', 'aria-label': `Open ${artist.name}` }, [
                h('div', { class: 'row-text' }, [h('span', { class: 'row-title', text: artist.name })]),
              ]),
              () => (location.hash = `#/artist/${encodeURIComponent(artist.id)}`),
            ),
          ),
          songs.length + albums.length + artists.length === 0 ? h('p', { class: 'muted', text: 'Nothing found.' }) : null,
        );
        updateRowHighlight(ctx, shell);
      } catch (error) {
        replace(results, h('p', { class: 'muted', text: errorText(error) }));
      }
    })();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  pageTitle(shell, 'Search', 'search3 — Navidrome does not offer Lucene syntax here', [
    input,
    h('button', { class: 'button', text: 'Search', onclick: submit }),
  ]);
  shell.view.append(results);
  input.focus();
  if (initial !== '') submit();
}

function renderSettings(ctx: AppContext, shell: Shell): void {
  const whatsNew = h('button', { class: 'button', text: "What's new" }, [icon(ICONS.changelog, 16)]);
  whatsNew.addEventListener('click', () => (location.hash = '#/changelog'));

  const clearLyrics = h('button', { class: 'button', text: 'Clear cached lyrics' });
  clearLyrics.addEventListener('click', () => {
    ctx.lyrics.forget();
    ctx.toast('Cached lyrics cleared');
  });

  const forget = h('button', { class: 'button danger', text: 'Forget credentials' });
  forget.addEventListener('click', () => {
    void (async () => {
      await ctx.secrets.remove(PASSWORD_KEY);
      ctx.settings = { ...ctx.settings, username: '' };
      saveSettings(ctx.settings);
      ctx.library = null;
      ctx.queue = null;
      ctx.sidecar = null;
      queueRef = null;
      await ctx.engine.stop();
      location.hash = '#/connect';
      ctx.render();
    })();
  });

  const serverLabel = ctx.settings.serverUrl === '' ? `${location.origin} (same origin)` : ctx.settings.serverUrl;
  replace(
    shell.view,
    h('div', { class: 'detail-text settings' }, [
      h('h1', { text: 'Settings' }),
      h('h2', { class: 'section', text: 'Library' }),
      h('p', { class: 'muted wrap-anywhere', text: `Server: ${serverLabel}` }),
      h('p', { class: 'muted', text: `User: ${ctx.settings.username || '—'}` }),
      h('h2', { class: 'section', text: 'Credential storage' }),
      h('p', { class: 'muted', text: ctx.secrets.description }),
      h('p', { class: ctx.secrets.secure ? 'ok small' : 'warn small', text: ctx.secrets.secure
        ? 'Stored by the operating system (Keychain / Android Keystore), not in web storage.'
        : 'Plain web storage. That is the honest limit of an installable PWA on iOS and Android — the wrapped builds avoid it.' }),
      h('h2', { class: 'section', text: 'Playback and visualiser' }),
      h('p', { class: 'muted small', text: 'One audio engine, chosen by the app rather than by a setting: the phone\'s own player in the installed app, the page itself in a browser. The spectrum reads the same player the sound comes from, so the bars are always in step with what you hear.' }),
      h('h2', { class: 'section', text: 'Lyrics' }),
      h('p', { class: 'muted small', text: `Lyrics come from your own library — the lyrics file that sits next to the song — and are cached on this device only (${ctx.lyrics.cachedTracks} track${ctx.lyrics.cachedTracks === 1 ? '' : 's'} right now). Nothing is bundled with the app and nothing is fetched from anyone else.` }),
      h('div', { class: 'row' }, [clearLyrics]),
      h('h2', { class: 'section', text: 'About' }),
      h('p', { class: 'muted', text: `Navilite ${BUILD_ID} · Subsonic API 1.16.1 · ${ctx.platform.native ? `wrapped ${ctx.platform.os} build` : 'browser / PWA'}` }),
      h('div', { class: 'row' }, [whatsNew, forget]),
    ]),
  );
}

function renderChangelog(shell: Shell): void {
  replace(
    shell.view,
    h('div', { class: 'changelog' }, [
      h('h1', { text: "What's new" }),
      h('p', { class: 'muted small', text: 'Every user-visible change, newest last. The same list is in the repository as CHANGELOG.md.' }),
      ...CHANGELOG.map((release) =>
        h('section', { class: 'release' }, [
          h('h2', { class: 'section', text: `Version ${release.version} — ${release.date}` }),
          h('ul', { class: 'release-items' }, ...release.items.map((item) => h('li', { text: item }))),
        ]),
      ),
      h('div', { class: 'row' }, [
        h('button', { class: 'button', text: 'Back to settings', onclick: () => (location.hash = '#/settings') }),
      ]),
    ]),
  );
}

function songRow(
  ctx: AppContext,
  song: Song,
  index: number,
  items: QueueItem[],
  context: QueueContext | null,
  showAlbum: boolean,
  onRemove?: () => void,
): HTMLElement {
  /*
   * v1.5: the whole row is the tap target — "tapping anywhere on a song row must play that song".
   * The play mark is the row's own affordance (`span.row-play`) rather than a second control inside
   * a control, and the favourite star is gone from rows: the album screen still stars albums, the
   * Favourites screen still lists what is starred, and the row's own highlight is untouched.
   */
  const row = bindTap(
    h(
      'button',
      {
        class: 'row song',
        'aria-label': `Play ${song.title}`,
      },
      [
        h('span', { class: 'row-play' }, [icon(ICONS.play, 18)]),
        h('div', { class: 'row-text' }, [
          h('span', { class: 'row-title', text: song.title }),
          h('span', { class: 'row-sub', text: [song.artist, showAlbum ? song.album : null].filter(Boolean).join(' · ') }),
        ]),
        h('span', { class: 'row-time', text: formatDuration(song.duration) }),
      ],
    ),
    () => {
      /*
       * v1.9.0 — the tap paints first, and the network comes second.
       *
       * The order here is the whole fix: `select` is synchronous (no await, no fetch, no I/O) and
       * it is what draws the row highlight, the title, the artist, the artwork and the loading
       * state; only then does `start` reach for the stream. The old line went straight into
       * `queue.play`, so on a slow link every one of those things sat on the *previous* track while
       * the player resolved a URL through the relay, and the screen looked dead.
       */
      ctx.queue!.select(items, index, context);
      openNow();
      void ctx.queue!.start();
    },
  );
  let rows = ctx.rows.get(song.id);
  if (!rows) {
    rows = new Set();
    ctx.rows.set(song.id, rows);
  }
  rows.add(row);
  if (!onRemove) return row;
  // Remove-from-playlist cannot live inside the row any more — the row is one button — so it sits
  // beside it, in a wrapper that keeps the two on one line.
  return h('div', { class: 'row-shell' }, [
    row,
    h('button', { class: 'row-remove', 'aria-label': `Remove ${song.title} from this playlist`, onclick: onRemove }, [
      icon(ICONS.close, 16),
    ]),
  ]);
}

/**
 * The playing track is marked wherever it appears in a list. Cheap and to the point: one
 * class toggle per visible row, driven from the player-bar update that already runs.
 */
function updateRowHighlight(ctx: AppContext, shell: Shell, status?: EngineStatus): void {
  const current = ctx.queue?.currentSong?.id ?? null;
  /*
   * v1.9.0: while a tap is being answered, the row it landed on says so. The loading state has to
   * be visible *in the paint the tap produces* — a tap that shows nothing for seconds reads as a
   * dead screen — and `queue.isLoading` is true from that same synchronous paint until the engine
   * has the stream.
   *
   * v1.9.7 — the status is *handed in* when the caller has one. `updatePlayerBar` is called with the
   * status on every event the engine emits (a dozen a second while playing) and then asked the
   * engine for the same object again here; the render paths that call this without one still read
   * it for themselves, because they have no status to pass.
   */
  const loading = (ctx.queue?.isLoading ?? false) || (status ?? ctx.engine.status()).state === 'loading';
  if (current === shell.highlighted && loading === shell.highlightedLoading) {
    if (current !== null) markRows(ctx, current);
    return;
  }
  for (const [id, rows] of ctx.rows) {
    for (const row of rows) {
      row.classList.toggle('playing', id === current);
      row.classList.toggle('loading', id === current && loading);
    }
  }
  shell.highlighted = current;
  shell.highlightedLoading = loading;
}

function markRows(ctx: AppContext, id: string): void {
  for (const row of ctx.rows.get(id) ?? []) row.classList.add('playing');
}

/* ------------------------------------------------------------- player bar */

function updatePlayerBar(ctx: AppContext, shell: Shell, status: EngineStatus): void {
  const song = ctx.queue?.currentSong ?? null;
  const visible = song != null;
  /*
   * v1.9.0: the loading state is a thing the screen shows, not a thing that is inferred from a
   * stalled transport. `queue.isLoading` is set by the tap's own synchronous paint, so the row,
   * the bar and the now screen carry it from the instant of the tap until the engine has the
   * stream. Nothing here waits on the network: this function reads state and writes classes.
   */
  const loading = (ctx.queue?.isLoading ?? false) || status.state === 'loading';
  /**
   * v1.9.0 — the cap, where the owner can see it.
   *
   * *"never silently cap quality"*: when the app is asking Navidrome for a smaller stream (because
   * the link measured slow) the bar says so, next to the mode. On a fast link this is `null` and
   * nothing is shown because nothing is capped — the original file plays.
   */
  const cap = ctx.queue?.streamKbps ?? null;
  shell.playerBar.classList.toggle('loading', loading);
  shell.nowOverlay.classList.toggle('loading', loading);
  shell.playerBar.classList.toggle('hidden', !visible);
  updateRowHighlight(ctx, shell, status);
  if (!visible) return;

  const coverUrl = ctx.library?.coverUrl(song.coverArt ?? song.albumId, 256) ?? null;
  const durationMs = status.durationMs || (song.duration ?? 0) * 1000;
  const positionMs = Math.min(status.positionMs, durationMs || status.positionMs);

  if (shell.barCover.dataset.song !== song.id) {
    shell.barCover.dataset.song = song.id;
    replace(shell.barCover, cover(coverUrl, 'pb-art', song.album ?? song.title));
    replace(shell.nowCover, cover(ctx.library?.coverUrl(song.coverArt ?? song.albumId, 512) ?? null, 'now-art', song.album ?? song.title));
    shell.lyrics.show(shell.nowMode === 'lyrics' ? song : null);
  }

  shell.barTitle.textContent = song.title;
  shell.barSubtitle.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  shell.nowTitle.textContent = song.title;
  shell.nowSubtitle.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  shell.nowContext.textContent = contextLine(ctx.queue);

  /*
   * v1.9.7 — **the play glyph is rebuilt only when the playing-ness changed.**
   *
   * This runs on every status event, and while a track plays the player reports a dozen of those a
   * second: two `replace()` calls (a `replaceChildren` and a fresh SVG each) to draw the same glyph
   * again. The repeat button below already shows the pattern — the state is kept in `dataset` and the
   * icon is rebuilt on the change, not on the event.
   */
  const playing = status.state === 'playing';
  if (shell.barPlay.dataset.playing !== String(playing)) {
    shell.barPlay.dataset.playing = String(playing);
    replace(shell.barPlay, playIcon(playing));
    replace(shell.nowPlay, playIcon(playing, 26));
  }

  // Shuffle and repeat are state, not icons that lie: pressed = on, and repeat cycles
  // off → all → one with the icon following.
  const shuffle = ctx.queue?.shuffle ?? false;
  shell.nowShuffle.classList.toggle('on', shuffle);
  shell.nowShuffle.setAttribute('aria-pressed', String(shuffle));
  const repeat = ctx.queue?.repeat ?? 'off';
  shell.nowRepeat.classList.toggle('on', repeat !== 'off');
  shell.nowRepeat.setAttribute('aria-pressed', String(repeat !== 'off'));
  shell.nowRepeat.setAttribute('aria-label', repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one');
  if (shell.nowRepeat.dataset.mode !== repeat) {
    shell.nowRepeat.dataset.mode = repeat;
    replace(shell.nowRepeat, icon(repeat === 'one' ? ICONS.repeatOne : ICONS.repeat, 20));
  }

  if (shell.scrubbing && shell.scrubMs !== null) {
    /*
     * A finger is on a seek bar: the label is the *destination*, not the position (v1.7.2). Written
     * here as well as on every move, so a status event that lands mid-drag cannot pull the number
     * back out from under the thumb.
     */
    const text = formatTime(shell.scrubMs / 1000);
    shell.barPosition.textContent = text;
    shell.nowPosition.textContent = text;
  } else if (!shell.scrubbing) {
    const ratio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
    shell.barProgress.value = String(Math.round(ratio * 1000));
    shell.nowProgress.value = String(Math.round(ratio * 1000));
    shell.barPosition.textContent = formatTime(positionMs / 1000);
    shell.nowPosition.textContent = formatTime(positionMs / 1000);
  }
  shell.barDuration.textContent = formatTime((durationMs || 0) / 1000);
  shell.nowDuration.textContent = formatTime((durationMs || 0) / 1000);

  /*
   * v1.9.6 — **the chip's third word.**
   *
   * `status.spectrum` is false for a fraction of a second at every track change: the track that is
   * handed over to has its own tap installed, and until that tap produces its first live frame there
   * are no bars. Two words for three states meant that window printed *native audio* — the owner's
   * report word for a whole track's worth of no bars, coming back at every boundary. `arming` is the
   * engine's own statement that the tap is installed, the player is playing, and no frame has come
   * back yet: the spectrum is coming, so the chip says so and the colour sits between the two.
   */
  const chipWord = status.spectrum ? 'spectrum' : status.spectrumArming ? 'spectrum…' : status.backend === 'native' ? 'native audio' : 'theme';
  shell.barChip.textContent = loading ? 'loading…' : `${chipWord}${cap === null ? '' : ` · ${cap} kbps`}`;
  shell.barChip.className = `mode-chip ${status.spectrum ? 'live' : status.spectrumArming ? 'arming' : 'fallback'}${cap === null ? '' : ' capped'}`;

  /*
   * v1.9.5 — **the app says its own reason, on the screen.**
   *
   * The boundary failure this release exists for reproduces only on the owner's phone, and three
   * rounds of diagnosis were made from source alone — which is why the chip's own evidence was
   * never available: `native audio` is what this chip says for *every* state that is not playing,
   * so `paused`, `ended`, `interrupted`, "no tap" and "the adoption failed" are the same word on
   * screen. `modeReason` has been written in seventeen places and read by no screen at all.
   *
   * So the line carries the whole account at once: the machine's state, the engine that is behind
   * it, whether the spectrum is actually fed, what the *player* last said (its own state, its own
   * reason, and where it thinks it is against its own duration), what the boundary's adoption did,
   * and how many of the bridge's own events were discarded and why. Every one of those is a fact
   * this app already had and never showed.
   *
   * It is shown whenever the state is not a healthy, playing, spectrum-fed track, so it costs the
   * layout nothing in the case that is working and is on the screen in every case that is not. The
   * chip's tooltip carries it always.
   */
  const detail =
    `${status.state} · ${status.backend} · spectrum ${status.spectrum ? 'live' : 'off'} · ` +
    `${status.pluginState === null ? 'player: nothing reported yet' : `player: ${status.pluginState}`} · ` +
    `adopt: ${status.adoptOutcome} · warm: ${status.warmedIds.length} · ` +
    // v1.9.8 — the native player's own boundary: how many slots it will play by itself while the
    // app is away, how many tracks it has taken, and the sentence naming which state it is in.
    `native: ${status.nativeBoundary.armed} armed, ${status.nativeBoundary.advances} taken, ` +
    `${status.nativeBoundary.failures} refused, ${status.nativeBoundary.ignored} ignored · ` +
    `dropped: ${status.droppedEvents.inaudible} inaudible, ${status.droppedEvents.slotGrace} in a slot write · ${status.modeReason}`;
  const abnormal = status.state !== 'playing' || !status.spectrum;
  /*
   * v1.9.7 — **both writes are made only when the sentence changed.**
   *
   * This function runs on every status event and the player emits a dozen of them a second, so a
   * playing track rewrote the same tooltip and the same (hidden) reason line sixty times a minute.
   * The string itself is assembled in memory and costs nothing; the *writes* are what cost — the
   * tooltip is one attribute write and the reason line is a text mutation the moment it is visible,
   * which is exactly the state the reason line exists for. Compared against what is already set, and
   * assigned only on a difference.
   */
  if (shell.barChip.title !== detail) shell.barChip.title = detail;
  const reason = abnormal ? detail : '';
  if (shell.barReason.textContent !== reason) shell.barReason.textContent = reason;
  shell.barReason.classList.toggle('hidden', !abnormal);

  shell.lyrics.position(positionMs);
}

/** `Playing from {playlist} (x/y)` — x is the track's position in that playlist. */
function contextLine(queue: PlaybackQueue | null): string {
  if (!queue) return '';
  const context = queue.queueContext;
  const name = context?.name ?? 'your queue';
  const total = queue.length;
  const at = queue.songPosition;
  if (total === 0 || at < 0) return `Playing from ${name}`;
  return `Playing from ${name} (${at + 1}/${total})`;
}
