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
import { loadSettings, saveSettings, type PlaybackPreference, type Settings } from '../storage/settings.ts';
import { CHANGELOG } from './changelog.ts';
import { ICONS, cover, formatDuration, formatTime, h, icon, playIcon, replace, starIcon } from './dom.ts';
import { createLyricsView, type LyricsView } from './lyrics.ts';

const PASSWORD_KEY = 'subsonic-password';
const BUILD_ID = '__BUILD_ID__';
/** Where the now-playing screen sends a left swipe, and where "close" goes if nowhere else. */
const PLAYLISTS_ROUTE = '#/playlists';
const DEFAULT_ROUTE = '#/artists';

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
  pillSpectrum: HTMLButtonElement;
  pillLyrics: HTMLButtonElement;
  nowMode: NowMode;
  lyrics: LyricsView;
  /** Song id currently marked as playing in a list, so the toggle only runs when it changes. */
  highlighted: string | null;
  /** The last non-now route, so closing the now screen returns where you were. */
  lastBrowseRoute: string;
  scrubbing: boolean;
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
  engine.setPreference(settings.playback);

  const shell = buildShell(root);
  const visualizer = attachVisualizer(shell.canvas, engine, DEFAULT_PALETTE);

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
    applyPaletteVars(shell, palette);
    visualizer.setPalette(palette);
  };
  applyPalette(DEFAULT_PALETTE);

  let restored = false;
  if (await restoreSession(ctx, shell, applyPalette)) {
    restored = await restorePlayQueue(ctx);
    if (!location.hash) location.hash = restored ? '#/now' : DEFAULT_ROUTE;
  }

  window.addEventListener('hashchange', () => renderRoute(ctx, shell));
  engine.subscribe((status) => updatePlayerBar(ctx, shell, status));
  document.addEventListener('visibilitychange', () => {
    void ctx.engine.handleVisibility(document.hidden);
  });
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
    route: () => location.hash,
    nowMode: () => shell.nowMode,
    playingRow: () => document.querySelector('.row.song.playing .row-title')?.textContent ?? null,
    /** What theme the app is holding — so a harness can prove the palette was applied at all. */
    palette: () => ctx.palette,
    context: () => shell.nowContext.textContent,
    // Visible lyrics, so an end-to-end check can read what the panel actually shows.
    lyrics: () => Array.from(document.querySelectorAll('.lyric-line')).map((node) => node.textContent),
    activeLyric: () => document.querySelector('.lyric-line.active')?.textContent ?? null,
    lyricsMessage: () => document.querySelector('.lyrics-empty')?.textContent ?? null,
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
    h('div', { class: 'pb-progress' }, [barPosition, barProgress, barDuration]),
    barChip,
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

  const lyricsHost = h('div', { class: 'now-lyrics hidden' });
  const nowOverlay = h('section', { class: 'now hidden', 'aria-label': 'Now playing' }, [
    h('div', { class: 'now-top' }, [
      h('button', { class: 'icon-button now-close', 'aria-label': 'Close now playing', onclick: () => closeNow() }, [
        icon(ICONS.close),
      ]),
      pill,
    ]),
    nowCover,
    visualizerHost,
    lyricsHost,
    nowTitle,
    nowSubtitle,
    nowContext,
    h('div', { class: 'now-progress' }, [nowPosition, nowProgress, nowDuration]),
    h('div', { class: 'now-bar', 'aria-label': 'Playback controls' }, [nowShuffle, h('button', {
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
    pillSpectrum,
    pillLyrics,
    nowMode: 'spectrum',
    lyrics: null as unknown as LyricsView,
    highlighted: null,
    lastBrowseRoute: DEFAULT_ROUTE,
    scrubbing: false,
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
  bindSwipe(nowOverlay, (direction) => {
    if (direction === 'left') location.hash = PLAYLISTS_ROUTE;
  });

  root.replaceChildren(header, viewScroll, playerBar, nowOverlay, toastNode);
  return shell;
}

/** The queue is created after the shell, so the shell's buttons read it lazily. */
let queueRef: PlaybackQueue | null = null;

function togglePlayback(): void {
  void queueRef?.toggle();
}

/** The logo, and the mini player, both land here. */
function openNow(): void {
  if (location.hash !== '#/now') location.hash = '#/now';
}

function closeNow(): void {
  const target = queueRefRef.lastBrowseRoute || DEFAULT_ROUTE;
  if (location.hash === '#/now') location.hash = target;
}

/** The shell needs to be reachable from the module-level routing helpers. */
let queueRefRef: Shell = null as unknown as Shell;

/** Swipe left/right on an element; used on the now-playing screen. */
function bindSwipe(element: HTMLElement, onSwipe: (direction: 'left' | 'right') => void): void {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  element.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    },
    { passive: true },
  );
  element.addEventListener(
    'touchend',
    (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      onSwipe(dx < 0 ? 'left' : 'right');
    },
    { passive: true },
  );
}

function setNowMode(mode: NowMode): void {
  const shell = queueRefRef;
  shell.nowMode = mode;
  const lyrics = mode === 'lyrics';
  shell.pillSpectrum.classList.toggle('active', !lyrics);
  shell.pillLyrics.classList.toggle('active', lyrics);
  shell.pillSpectrum.setAttribute('aria-selected', String(!lyrics));
  shell.pillLyrics.setAttribute('aria-selected', String(lyrics));
  shell.visualizerHost.classList.toggle('hidden', lyrics);
  shell.lyricsHost.classList.toggle('hidden', !lyrics);
  // v1.2: the class the stylesheet hangs the text-screen layout off — it hides the album art
  // and gives the freed height to the lines instead of leaving the column at its 88 px minimum.
  shell.nowOverlay.classList.toggle('lyrics-mode', lyrics);
  // Load on first view rather than on every track change: fewer requests, same result.
  if (lyrics) shell.lyrics.show(queueRef?.currentSong ?? null);
}

function bindSeek(input: HTMLInputElement, shell: Shell, getQueue: () => PlaybackQueue | null): void {
  input.addEventListener('pointerdown', () => {
    shell.scrubbing = true;
  });
  input.addEventListener('input', () => {
    const queue = getQueue();
    if (!queue) return;
    const duration = queueDurationMs(getQueue());
    if (duration > 0) {
      const seconds = (Number(input.value) / 1000) * (duration / 1000);
      input.setAttribute('aria-valuetext', formatTime(seconds));
    }
  });
  input.addEventListener('change', () => {
    shell.scrubbing = false;
    const queue = getQueue();
    const duration = queueDurationMs(queue);
    if (!queue || duration <= 0) return;
    void queue.seek((Number(input.value) / 1000) * duration);
  });
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
}

/* ------------------------------------------------------------------- state */

/*
 * The palette hook is a plain callback, not an object with an `apply` method.
 *
 * It was `interface PaletteHooks { apply(palette: Palette): void }` until v1.4.1, and that shape is
 * a trap: **a function satisfies it structurally**, because `(palette: Palette) => void` already
 * has an `apply` — `Function.prototype.apply`. So `restoreSession(ctx, shell, applyPalette)` — the
 * cold-start path, i.e. every normal launch — type-checked fine, `hooks.apply(DEFAULT_PALETTE)`
 * then ran `applyPalette(undefined)`, and `applyPaletteVars` threw on `palette.primary` inside a
 * floating promise: no theme, no error anyone could see, from v1.1 to v1.4. Passing the function
 * itself removes the shape that made the mistake possible, in both directions.
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
 * The queue the server saved for us (`savePlayQueue` on every track change), put back
 * without starting playback. This is what makes a cold start land on the spectrum screen
 * for the track that was playing, as the owner asked.
 */
async function restorePlayQueue(ctx: AppContext): Promise<boolean> {
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
  shell.nowOverlay.classList.toggle('hidden', !nowOpen);
  // v1.4: the overlay freezes what is under it, and closing it puts that view back where it was.
  setScrollLock(shell, nowOpen);
  if (!nowOpen && head !== 'connect') shell.lastBrowseRoute = location.hash || DEFAULT_ROUTE;
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
    ...artists.map((artist) =>
      h('button', { class: 'row', onclick: () => (location.hash = `#/artist/${encodeURIComponent(artist.id)}`) }, [
        cover(ctx.library!.coverUrl(artist.coverArt ?? artist.id, 128), 'thumb', artist.name),
        h('div', { class: 'row-text' }, [
          h('span', { class: 'row-title', text: artist.name }),
          h('span', { class: 'row-sub', text: `${artist.albumCount ?? 0} album${artist.albumCount === 1 ? '' : 's'}` }),
        ]),
      ]),
    ),
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
  return h('button', { class: 'card', onclick: () => (location.hash = `#/album/${encodeURIComponent(album.id)}`) }, [
    cover(ctx.library!.coverUrl(album.coverArt ?? album.id, 256), 'card-cover', album.name),
    h('span', { class: 'card-title', text: album.name }),
    h('span', { class: 'card-sub', text: album.artist ?? '' }),
  ]);
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
  return h('button', { class: 'row', onclick: () => (location.hash = `#/playlist/${encodeURIComponent(playlist.id)}`) }, [
    cover(ctx.library!.coverUrl(playlist.coverArt ?? playlist.id, 128), 'thumb', playlist.name),
    h('div', { class: 'row-text' }, [
      h('span', { class: 'row-title', text: playlist.name }),
      h('span', { class: 'row-sub', text: `${playlist.songCount ?? 0} tracks · ${formatDuration(playlist.duration)}` }),
    ]),
  ]);
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
    shell.view.append(h('p', { class: 'muted', text: 'Nothing starred yet. Use the star on any album or track.' }));
    return;
  }

  if (artists.length > 0) {
    shell.view.append(
      h('h2', { class: 'section', text: 'Artists' }),
      h(
        'div',
        { class: 'grid' },
        ...artists.map((artist: Artist) =>
          h('button', { class: 'card', onclick: () => (location.hash = `#/artist/${encodeURIComponent(artist.id)}`) }, [
            cover(ctx.library!.coverUrl(artist.coverArt ?? artist.id, 256), 'card-cover', artist.name),
            h('span', { class: 'card-title', text: artist.name }),
          ]),
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
            h('button', { class: 'row', onclick: () => (location.hash = `#/artist/${encodeURIComponent(artist.id)}`) }, [
              h('div', { class: 'row-text' }, [h('span', { class: 'row-title', text: artist.name })]),
            ]),
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
  const preferenceSelect = h('select', { class: 'field inline' }, [
    ...(
      [
        ['auto', 'Automatic — real spectrum in the foreground, native engine in the background'],
        ['web', 'Web Audio only — always the real spectrum (background playback depends on the platform)'],
        ['native', 'Native engine only — background and lock screen first, visualiser is the album-art theme'],
      ] as Array<[PlaybackPreference, string]>
    ).map(([value, label]) => {
      const option = h('option', { value, text: label });
      if (ctx.settings.playback === value) option.selected = true;
      return option;
    }),
  ]);
  preferenceSelect.addEventListener('change', () => {
    const preference = preferenceSelect.value as PlaybackPreference;
    ctx.settings = { ...ctx.settings, playback: preference };
    saveSettings(ctx.settings);
    ctx.engine.setPreference(preference);
    ctx.toast('Playback preference saved');
  });

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
      preferenceSelect,
      h('p', { class: 'muted small', text: 'Web Audio does not survive backgrounding on iOS, so the real spectrum is a foreground feature there. Android keeps Web Audio alive while playing.' }),
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
  const row = h('div', { class: 'row song' }, [
    h(
      'button',
      {
        class: 'row-play',
        'aria-label': `Play ${song.title}`,
        onclick: () => {
          void ctx.queue!.play(items, index, context);
          openNow();
        },
      },
      [icon(ICONS.play, 18)],
    ),
    h('div', { class: 'row-text' }, [
      h('span', { class: 'row-title', text: song.title }),
      h('span', { class: 'row-sub', text: [song.artist, showAlbum ? song.album : null].filter(Boolean).join(' · ') }),
    ]),
    h('span', { class: 'row-time', text: formatDuration(song.duration) }),
    h(
      'button',
      {
        class: 'row-star',
        'aria-label': song.starred ? 'Remove from favourites' : 'Add to favourites',
        onclick: () => {
          void (async () => {
            try {
              await ctx.library!.setStarred(song.id, 'song', !song.starred);
              song.starred = song.starred ? undefined : new Date().toISOString();
              replace(starHost, starIcon(Boolean(song.starred)));
            } catch (error) {
              ctx.toast(errorText(error), 'error');
            }
          })();
        },
      },
      [],
    ),
  ]);
  const starHost = row.querySelector('button.row-star') as HTMLButtonElement;
  starHost.append(starIcon(Boolean(song.starred)));
  if (onRemove) {
    row.append(
      h('button', { class: 'row-remove', 'aria-label': 'Remove from playlist', onclick: onRemove }, [icon(ICONS.close, 16)]),
    );
  }
  let rows = ctx.rows.get(song.id);
  if (!rows) {
    rows = new Set();
    ctx.rows.set(song.id, rows);
  }
  rows.add(row);
  return row;
}

/**
 * The playing track is marked wherever it appears in a list. Cheap and to the point: one
 * class toggle per visible row, driven from the player-bar update that already runs.
 */
function updateRowHighlight(ctx: AppContext, shell: Shell): void {
  const current = ctx.queue?.currentSong?.id ?? null;
  if (current === shell.highlighted) {
    if (current !== null) markRows(ctx, current);
    return;
  }
  for (const [id, rows] of ctx.rows) for (const row of rows) row.classList.toggle('playing', id === current);
  shell.highlighted = current;
}

function markRows(ctx: AppContext, id: string): void {
  for (const row of ctx.rows.get(id) ?? []) row.classList.add('playing');
}

/* ------------------------------------------------------------- player bar */

function updatePlayerBar(ctx: AppContext, shell: Shell, status: EngineStatus): void {
  const song = ctx.queue?.currentSong ?? null;
  const visible = song != null;
  shell.playerBar.classList.toggle('hidden', !visible);
  updateRowHighlight(ctx, shell);
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

  replace(shell.barPlay, playIcon(status.state === 'playing'));
  replace(shell.nowPlay, playIcon(status.state === 'playing', 26));

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

  if (!shell.scrubbing) {
    const ratio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
    shell.barProgress.value = String(Math.round(ratio * 1000));
    shell.nowProgress.value = String(Math.round(ratio * 1000));
    shell.barPosition.textContent = formatTime(positionMs / 1000);
    shell.nowPosition.textContent = formatTime(positionMs / 1000);
  }
  shell.barDuration.textContent = formatTime((durationMs || 0) / 1000);
  shell.nowDuration.textContent = formatTime((durationMs || 0) / 1000);

  shell.barChip.textContent = status.spectrum ? 'spectrum' : status.backend === 'native' ? 'native audio' : 'theme';
  shell.barChip.className = `mode-chip ${status.spectrum ? 'live' : 'fallback'}`;

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
