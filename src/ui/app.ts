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
import { SubsonicClient, SubsonicError, isTransportFailure } from '../api/subsonic.ts';
import { LyricsRoute, type SidecarSource } from '../api/sidecar.ts';
import { sameSong, structuredToBody } from '../api/lyrics.ts';
import type { Album, Artist, Playlist, PlaylistWithEntries, QueueContext, QueueItem, Song } from '../api/types.ts';
import { DEFAULT_SERVER_URL, SERVER_URL_PLACEHOLDER } from '../config.ts';
import { AudioEngine } from '../player/engine.ts';
import { attachVisualizer } from '../player/visualizer.ts';
import { DEFAULT_PALETTE, paletteFromArtwork, type Palette } from '../player/palette.ts';
import { platformInfo, type PlatformInfo } from '../platform.ts';
import { LyricsService } from '../lyrics/service.ts';
import { PlaybackQueue } from '../state/queue.ts';
import { Library, type AlbumListType } from '../state/library.ts';
import { OfflineStore, estimateBytes, formatBytes, type DownloadedPlaylist, type PlaylistBadge, type PlaylistDownloadState, type SizeEstimate } from '../state/offline.ts';
import { fillSong } from '../state/song-metadata.ts';
import { createDownloadsBridge, localFileSrc } from '../player/native.ts';
import { LyricsCache } from '../storage/lyrics.ts';
import { createSecretStore, type SecretStore } from '../storage/secret.ts';
import { loadSettings, saveSettings, type Settings } from '../storage/settings.ts';
import { loadSnapshot } from '../storage/session.ts';
import { CHANGELOG } from './changelog.ts';
import { ICONS, cover, formatDuration, formatTime, h, icon, playIcon, replace, starIcon } from './dom.ts';
import { createLyricsView, type LyricsView } from './lyrics.ts';
import { createPager, type Pager } from './pager.ts';
import { updatePlayerBar, updateRowHighlight } from './player-bar.ts';

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
    () => ctx.offline,
  );
  const ctx: AppContext = {
    platform,
    settings,
    secrets,
    engine,
    library: null,
    queue: null,
    offline: null,
    sidecar: null,
    lyrics,
    rows: new Map(),
    palette: DEFAULT_PALETTE,
    render: () => renderRoute(ctx, shell),
    toast: (message, kind = 'info') => toast(shell, message, kind),
  };
  /*
   * Offline downloads (v1.9.12). The store is built once and its resolver handed to `Library` when
   * `connect` runs, so the audible path and the download store are the same object. Hydration is
   * kicked off here and re-run on the way back to the foreground — the reconcile that makes a
   * download finished in the background visible.
   */
  const offline = new OfflineStore(await createDownloadsBridge(platform.os), {
    downloadUrl: (song) => ctx.library?.client.downloadUrl(song.id) ?? `download?id=${song.id}`,
    lyricsUrl: (song) => ctx.sidecar?.urlFor?.(song) ?? null,
    lyricsFallback: async (song) => {
      /*
       * The route had nothing for this track — no URL at all, or a `404` (v1.9.14). Ask Navidrome
       * in the order `fetchLyrics` asks it: the id-keyed structured answer first, then the legacy
       * blob behind the same artist/title guard. A structured answer with timings comes back as an
       * LRC body, so the highlight survives the round trip; the store keeps it raw either way.
       */
      const client = ctx.library?.client ?? null;
      if (!client) return null;
      try {
        const structured = await client.getLyricsBySongId(song.id);
        const body = structuredToBody(structured);
        if (body !== null) return body;
      } catch {
        // Not implemented, not found, offline — the older call below still gets its turn.
      }
      try {
        const blob = await client.getLyrics({ artist: song.artist, title: song.title });
        if (!blob || typeof blob.value !== 'string' || blob.value === '') return null;
        return sameSong(blob, song) ? blob.value : null;
      } catch {
        return null;
      }
    },
    /*
     * The art axis (v1.9.20): the cover route, asked once per distinct cover id at the size the
     * spectrum page draws (512 — the same file serves the palette's 256 read and the list thumbs).
     * Handed in as a factory, like the two above: the store relays URLs, it does not mint them.
     */
    artUrl: (coverArtId) => ctx.library?.client.coverArtUrl(coverArtId, 512) ?? null,
    /*
     * …and the one platform call, injected for the same reason: `convertFileSrc` is what makes a
     * file in the app's own container readable from the page's origin, so the cover renders and the
     * palette can read it without a tainted canvas. `player/native.ts` owns the Capacitor import.
     */
    toLocalSrc: localFileSrc,
    /*
     * The metadata repair's second source (v1.9.22): the library's own answer for one song id, for a
     * row a 1.9.19 build wrote whose playlist record is no longer here. Injected like the factories
     * above — the store relays ids and Songs, it does not own a client — and read through `ctx` so
     * it is the client of the session that connects, not of the moment this store was built.
     */
    songLookup: (songId) => ctx.library?.client.getSong(songId) ?? Promise.resolve(null),
  });
  ctx.offline = offline;
  void offline.hydrate();
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
  let lateRestore: Promise<boolean> | null = null;
  if (await restoreSession(ctx, shell, applyPalette)) {
    /*
     * v1.9.18 — the first screen is never held by a round trip.
     *
     * The device's own snapshot is local, so it is read here and the queue is exact and instant. The
     * server's saved queue is the fallback for a launch with *no* snapshot, and that is a network
     * call: it used to be awaited before `renderRoute`, so a tailnet that is up but not answering
     * left the app on a blank screen for the full request timeout. The round trip now happens after
     * the first paint, and if it lands on a launch the owner has not touched, it still lands on the
     * spectrum exactly as before.
     */
    restored = await restorePlayQueue(ctx, { server: false });
    if (!restored) lateRestore = restorePlayQueue(ctx);
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
    // §S4: on the way back, `list()` is the truth — a download that finished in the background is
    // picked up here, not from a progress event that may never have arrived.
    else void ctx.offline?.hydrate();
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
  const launchRoute = location.hash;
  renderRoute(ctx, shell);
  if (restored) updatePlayerBar(ctx, shell, engine.status());
  /*
   * The server's saved queue, when there was no snapshot to restore from: adopted whenever it
   * arrives, and it takes the owner to the spectrum only on a launch he has not touched (v1.9.18).
   */
  if (lateRestore) {
    void lateRestore.then((adopted) => {
      if (!adopted) return;
      if (location.hash === launchRoute) location.hash = NOW_ROUTE;
      updatePlayerBar(ctx, shell, engine.status());
    });
  }

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

/**
 * Did this failure mean "there is no server", rather than "the server said no"? (v1.9.18)
 *
 * The engine of the owner's report: with the tailnet down, a downloaded playlist's song list was
 * fetched anyway, the `fetch` rejected, and the rejection text was rendered *as the view*. Anything
 * that draws a screen asks this first, so an unreachable server degrades to what the app can
 * actually show instead of a message about a URL.
 *
 * The classification itself lives in `api/subsonic.ts` (v1.9.19), next to the flag it reads, so that
 * every caller answers the same way — and so it can be tested without a DOM. **It is deliberately
 * not "any `TypeError`"**: a genuine `TypeError` thrown inside a view (`Cannot read properties of
 * undefined`) used to be drawn as the `Offline` pill with its message going to the console, which is
 * the app blaming the network for its own bug. Only the transport's own messages qualify, so a real
 * error still reaches the screen.
 */
function isUnreachable(error: unknown): boolean {
  return isTransportFailure(error);
}

/** The inline "no connection" badge. Deliberately small: it belongs on a row or in a header. */
function offlinePill(label = 'Offline'): HTMLElement {
  return h('span', { class: 'offline-pill', role: 'status', text: label });
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
async function restorePlayQueue(ctx: AppContext, options: { server?: boolean } = {}): Promise<boolean> {
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
    /*
     * **And the launch stops there (v1.9.9).**
     *
     * This used to start the restored track again when the snapshot said it was playing — *"open the
     * app and, if a track was playing when you left, it opens on the spectrum for that track"*. It
     * is also the second half of the crash: a launch that plays is a launch that prepares, and the
     * prepare was what reached `preroll` on an item that had not resolved yet. The app comes up
     * restored — the same queue, the same cursor, the same second, the same "playing" on the chip —
     * and it is inert until the listener asks for sound: one tap on play, in the bar or on a row,
     * starts it from exactly that second. Nothing is fetched, nothing is prepared and nothing is
     * played before that tap.
     *
     * The snapshot's own `playing` flag is not thrown away: it is why the restored track shows as
     * paused-but-ready rather than as a track that was never started, which is what `pendingStartMs`
     * carries into the first play.
     */
    return true;
  }
  /*
   * No snapshot: the server's saved queue is a convenience for a fresh install, not a gate on the
   * first screen (v1.9.18). The launch asks for it in two halves — `{ server: false }` now, the
   * round trip after the first paint — because the round trip is the one thing here that can hang:
   * on a tailnet that is up but not answering, `getPlayQueue` used to hold the *whole app* on a
   * blank screen for the request timeout (20 s). Nothing about the library, the downloaded
   * playlists or the transport needs it.
   */
  return options.server === false ? false : restoreServerQueue(ctx);
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
    /*
     * Whether it is *adopted* is the queue's answer, not this function's (v1.9.19): by the time this
     * round trip lands the owner may already have started something — a downloaded track plays with
     * no server at all, which is the whole point of the offline work — and replacing his queue with
     * the last session's is what made the bar, the now screen and the highlight jump while the audio
     * played on. `restore()` declines in that case and this reports it as "nothing was restored", so
     * the launch screen stays where he put it.
     */
    return queue.restore(items, found === -1 ? 0 : found, saved?.position ?? 0, {
      kind: 'song',
      name: 'your last session',
    });
  } catch (error) {
    // A server that is not there has no saved queue. Not an error the owner needs to see: the launch
    // simply has nothing to restore onto.
    console.warn('[navilite] could not read the server’s saved queue', error);
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
  // The offline resolver is the one `streamUrl` consults first (local-first playback, v1.9.12), and
  // — since v1.9.20 — the art resolver is what `coverUrl` consults first, so the cover that came down
  // with a song is what the spectrum page draws and what the palette reads offline.
  const library = new Library(
    client,
    (songId) => ctx.offline?.pathFor(songId) ?? null,
    (coverArtId) => ctx.offline?.artPathFor(coverArtId) ?? null,
  );
  const queue = new PlaybackQueue(ctx.engine, library, {
    /*
     * A failed start for a track the library resolved to a `file://` path is the app's only evidence
     * that the download's file has gone (v1.9.17): the row is voided, so the next start of that
     * track streams it instead of asking for a file that is not there.
     */
    onLocalFileUnplayable: (songId) => void ctx.offline?.voidMissingFile(songId),
  });
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
  // The view is about to be replaced: drop last render's offline redraws with it. The store's
  // listeners are a list, so the settings row and a playlist control coexist while both are on
  // screen — and neither outlives the node it paints.
  clearOfflineSubscriptions();
  /*
   * v1.9.20 — the download marks the render below draws are repainted **in place** when the store
   * changes, never by a `ctx.render()`: a re-render would drop the scroll offset and the highlighted
   * row, and the playlists screen carries a live control already (the same reasoning as the download
   * control, `#/app.ts:2185-2203`). `songRow`/`playlistRow` register their own repaint as they are
   * built; this one listener walks them, and the list is emptied per render because the nodes it
   * names do not outlive it.
   */
  clearStoreRepaints();
  subscribeOffline(ctx.offline, () => {
    repaintStoreRows();
    /*
     * v1.9.23 — **and the queue's own copies of its songs, wherever the owner is.**
     *
     * This listener is on every route, not only on the list the rows are drawn in, and that is the
     * point: the repair runs for a while after the screen it started on is gone (its second pass is
     * one `getSong` at a time), so the track he tapped while its row was still blank has to be named
     * in the player bar even if he has moved on to the Library since. `applyMetadata` fills only what
     * is missing, so a song that came from the server is untouched and a queue with nothing to learn
     * costs one pass over its own items.
     *
     * It reads through `ctx.offline` at call time rather than capturing the store: the session that
     * connects can build a new one, and a listener pointed at the old one would go quiet.
     */
    ctx.queue?.applyMetadata((songId) => ctx.offline?.songFor(songId) ?? null);
  });
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
    /*
     * A rejection is a paint as much as an answer is, and it can land just as late (v1.9.21): the
     * view that failed may be two screens back, so an error box drawn here would replace whatever
     * the owner is actually looking at with a message about a screen he has left.
     */
    if (overtaken(shell, routeKey)) return;
    /*
     * A view that needs the server, with no server, degrades (v1.9.18). This is the second half of
     * the owner's report — the raw transport message ("could not reach https://…: (TypeError: Load
     * failed)") was rendered as the content of the view. Anything unreachable now draws the offline
     * state instead: what is downloaded, tappable, plus an Offline badge. Every other failure is a
     * real answer from a server that is there, and keeps the message it gave.
     */
    if (isUnreachable(error)) {
      renderOffline(ctx, shell, head, error);
      return;
    }
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
    case 'downloads':
      // v1.9.20 — "On this phone": the downloaded tracks, drawn from the store alone. A route and a
      // filter, never an entity: there is nothing here to name, create, rename or delete (§4.2).
      drawn(renderDownloads(ctx, shell));
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

/**
 * Has this render been overtaken? (v1.9.20)
 *
 * Every view that awaits the library paints *after* the await, and by then the router may already
 * have drawn whatever the owner navigated to — so a late answer writes the old screen over the new
 * one. He sees a screen that will not open, with the two screens' parts mixed together (the
 * playlists list's subtitle inside the playlist page's header), and it needs only a slow answer.
 * This release's own acceptance check found it: waiting for the playlists screen's rows, it was
 * shown the playlist page it had just left.
 *
 * `shell.viewRoute` is the route the router drew for the view that is on screen now, set
 * synchronously before that view renders, so it is the honest answer to "am I still the view?".
 * Data work — remembering a playlist's name, say — is not a paint and is deliberately not guarded.
 *
 * v1.9.21 guards the rest of the class. The paint is what is guarded, in the view that started the
 * work, and the route is captured **once per render** (never per request): a second search while the
 * first is in flight is the same render, and its answer is a current one and must land.
 *
 *   - the views that paint into `shell.view` itself — `renderAlbum` (`replace`), `renderArtist` and
 *     `renderFavourites` (`pageTitle` + the rows below it) — are the ones where a stale answer is
 *     *visible*, and they are checked in `tools/offline-check.mjs`;
 *   - `renderSearch` is guarded too, for uniformity, though its paint goes into the results host its
 *     own render created — a node the next render has already detached, so that one cannot corrupt
 *     the screen (its check says as much: it passes with or without the guard);
 *   - the router's own failure fallback (`fail`, below) is guarded as well: a *rejection* that lands
 *     after the owner has moved on used to draw its error box over the screen he moved to.
 */
function overtaken(shell: Shell, route: string): boolean {
  return shell.viewRoute !== route;
}

/* ------------------------------------------------------- offline (v1.9.18) */

/** What each server-only route was drawn as, so the offline state can keep its own heading. */
const OFFLINE_TITLES: Record<string, string> = {
  artists: 'Library',
  albums: 'Albums',
  playlists: 'Playlists',
  favourites: 'Favourites',
  search: 'Search',
  artist: 'Artist',
  album: 'Album',
  playlist: 'Playlist',
};

/**
 * The state a screen that needs the server shows when there is no server (v1.9.18).
 *
 * Two things are wrong with what the app did before this, and they are the owner's two reports
 * about being offline: the screen was *empty of anything he could use*, and the one thing it did
 * put on it was the transport's own text — `could not reach https://alienlab.tailbed832.ts.net:9443
 * (TypeError: Load failed). Over Tailscale, check the tailnet is up …` — as the content of the view.
 * A URL and a developer's diagnosis are not a screen.
 *
 * So this draws what is actually true and actually usable: an `Offline` badge in the header, the
 * playlists the app holds locally (each one tappable, and playing with no connection), and a plain
 * sentence about what does need the server. If nothing is downloaded it says that instead, and says
 * how to fix it. The message the transport produced is not rendered anywhere — it goes to the
 * console, where a developer can still see it.
 *
 * `head` is the route that failed, and it decides one more thing (v1.9.21): when it is the Library's
 * own head, the Library's entry row into the downloaded music is drawn here as well, at the top of
 * the same list. That row is not a degrade of anything — it is the Library's own door to what is on
 * this phone, promised "whether or not the server answers" (design §4.1), and it is drawn from the
 * store alone; without it the only way in while offline was Settings → `Downloaded music: … →`.
 */
function renderOffline(ctx: AppContext, shell: Shell, head: string, error: unknown): void {
  console.warn('[navilite] a view that needs the server was reached with no server', error);
  const downloaded = ctx.offline?.downloadedPlaylists() ?? [];
  const retry = h('button', { class: 'button', text: 'Try again' });
  retry.addEventListener('click', () => ctx.render());
  pageTitle(
    shell,
    OFFLINE_TITLES[head] ?? 'Navilite',
    /*
     * v1.9.19: the plain title, not the id. This read `“pl-not-downloaded” is not downloaded` —
     * the owner was being shown a Subsonic identifier in quotes, which is not a sentence and not
     * something he can act on, and it appeared in the harness output as well.
     */
    head === 'playlist' ? 'This playlist is not downloaded on this phone' : 'no connection to your library',
    [offlinePill(), retry],
  );
  const host = h('div', { class: 'list' });
  shell.view.append(host);
  /*
   * v1.9.21 — the Library's own entry row into the downloaded music stays on this page.
   *
   * `renderArtists` draws it synchronously, before it awaits anything, and this page used to be
   * `shell.view` replaced whole — so the row the design promises "whether or not the server answers"
   * (design §4.1) was thrown away in exactly the case the downloaded music exists for, and the only
   * other way in was Settings → `Downloaded music: … →`. It goes above the playlists in this page's
   * own list — never a second rows list, and the transport's message is still not on the screen.
   */
  if (head === 'artists') host.append(downloadsEntryRow(ctx));
  host.append(h('h2', { class: 'section', text: 'Downloaded' }));
  if (downloaded.length === 0) {
    host.append(
      h('p', {
        class: 'muted',
        text: 'Nothing is downloaded on this phone yet. Open a playlist while you have a connection and press ↓ in its header — it stays here, and it stays playable with no connection.',
      }),
    );
    return;
  }
  host.append(...downloaded.map((entry) => playlistRow(ctx, storePlaylistInput(ctx, entry))));
  host.append(h('p', { class: 'muted', text: 'These play here with no connection. Everything else needs your library.' }));
}

/* -------------------------------------------- downloaded playlists, one row each (v1.9.20) */

/**
 * What the one playlist row needs. Every field is optional except the id and the name — both
 * sources fill the same slots, which is the whole of why there is one renderer rather than two
 * (§2.2): the server supplies `songCount`/`duration`/`coverArt` online, and the store's manifest
 * supplies the same three offline.
 */
export interface PlaylistRowInput {
  id: string;
  name: string;
  /** The playlist's length: the server's `songCount`, or the manifest's length offline. */
  songCount?: number;
  /** Its runtime: the server's `duration`, or the sum of the manifest's own `Song.duration`. */
  duration?: number;
  /** Its cover: the server's `coverArt`, or a manifest song's — whatever is in hand. */
  coverArt?: string;
}

/**
 * The store's own facts in the row's shape (§2.2) — the same slots, filled from the manifest.
 *
 * This is what makes the offline list and the server's list one list: offline there is no server row
 * to annotate, so the store *is* the row, and it is drawn by the same function.
 */
function storePlaylistInput(ctx: AppContext, entry: DownloadedPlaylist): PlaylistRowInput {
  const first = entry.record.songs[0];
  return {
    id: entry.id,
    name: entry.name,
    songCount: entry.record.total,
    // The server's `duration` is not available offline, so it is summed from the rows — the same
    // arithmetic the playlist page does on the same songs.
    duration: entry.record.songs.reduce((total, song) => total + (song.duration ?? 0), 0),
    coverArt: first?.coverArt ?? first?.albumId ?? ctx.offline?.playlistBadge(entry.id).coverArt,
  };
}

/**
 * The figures a download row prints: **n of m**, where `n` is what is actually on the phone and `m`
 * is the playlist in front of the owner.
 *
 * `badge.total` is the **manifest's** length — what was asked for when the playlist was downloaded —
 * and the row is drawn beside the playlist the server has just described, which may be longer: the
 * owner adds a track to a playlist he downloaded, and the row read `270 tracks · 269 of 269 on this
 * phone` under the hollow mark while that same playlist's own page said `269 of 270 · retry`. One
 * fact, two numbers (v1.9.21). So the denominator is the playlist's own length — the server's
 * `songCount` where the server has answered, the manifest's otherwise — and the numerator is
 * unchanged: the complete files among the manifest's songs, which is what actually plays from here.
 *
 * Both the row's sub-line and its accessible name read their numbers from here, because `… of …
 * downloaded` is also what VoiceOver says out loud. `test/offline-browse.test.ts` asserts this pair
 * against the one the playlist page's own control prints for the same playlist.
 *
 * The playlist page's own control reads this same function with the same two inputs — the record it
 * already holds and the playlist in front of the owner — so there is one arithmetic behind both
 * screens (`controlFigures`), not two that have to be kept in step by hand.
 */
export function downloadedFigures(
  figures: { done: number; total: number },
  songCount?: number,
): { done: number; total: number } {
  return { done: figures.done, total: Math.max(figures.total, songCount ?? figures.total) };
}

/**
 * Every fact the download control's sentence is made of, resolved from the store and from the
 * playlist in front of the owner — so the sentence itself is a pure function of them
 * (`downloadControlLabel`) and a node test can read what the button really prints, in each state.
 */
export interface DownloadControlFacts {
  /** The store's record state, or `none` for a playlist nothing was ever asked of. */
  state: PlaylistDownloadState | 'none';
  /** Complete files among the manifest's songs (`record.done`). */
  done: number;
  /** The **manifest's** length — what was asked for when the playlist was downloaded. */
  total: number;
  /** The playlist in front of the owner, which may be longer than the manifest. */
  songs: Song[];
  /** The size the button prints, already formatted (`up to 312 MB` / `312 MB`). */
  size: string;
  /** Tracks this download does not cover (`missingCount`). */
  missing: number;
  /** Covers this download has not got (`missingCovers`). */
  missingCovers: number;
}

/**
 * The pair the playlist page's own control prints while its download is not yet `complete` —
 * **n of m**, and the same pair the Playlists row prints about the same playlist.
 *
 * `record.total` is the **manifest's** length — what was asked for when the playlist was downloaded
 * — and it is not the length of a playlist the owner has added to since. The control's `downloading`
 * and `partial` branches used to print it, so a download that stopped at one of two files and whose
 * playlist has grown to three read `1 of 2 · retry` on its own page while the row under the same
 * hollow mark read `3 tracks · 1 of 3 on this phone`: one fact, two numbers, in exactly the state
 * `7453ebd` did not reach (v1.9.21's own leftover, closed here). The `complete` branch already
 * agreed with the row (`grownControlLabel`), and all three read the denominator the same way now.
 */
function controlFigures(facts: { done: number; total: number; songs: Song[] }): string {
  const { done, total } = downloadedFigures(facts, facts.songs.length);
  return `${done} of ${total}`;
}

/**
 * The playlist page's own download control, as one sentence per state — §5's machine, and §5.8's
 * covers-only fetch inside `complete`.
 *
 * It is a function of `facts` alone because `test/offline-browse.test.ts` has to be able to read the
 * sentence the button prints: **this is the formatter the two screens' agreement is about**, and
 * before it was one, the control's own text could not be asserted anywhere (`downloadControl` needs
 * a DOM). `complete` is where the two screens can differ and where the pair is therefore the row's
 * own (`grownControlLabel`, `downloadedFigures`); `partial` and `downloading` are the same claim for
 * a download that is not finished (`controlFigures`).
 */
export function downloadControlLabel(facts: DownloadControlFacts): string {
  const { state } = facts;
  if (state === 'none' || state === 'idle') {
    return facts.songs.length === 0 ? 'Nothing to download' : `↓ ${facts.size}`;
  }
  switch (state) {
    case 'estimating':
      return '…';
    case 'downloading':
      return `${controlFigures(facts)} · ${facts.size}`;
    case 'partial':
      return `${controlFigures(facts)} · retry`;
    case 'complete': {
      // The playlist changed after it was downloaded: not complete any more, and it says so.
      if (facts.missing > 0) return grownControlLabel(facts.songs, facts.missing);
      // All the music is here, a cover is not: one tap fetches the covers and nothing else.
      if (facts.missingCovers > 0) return `✓ ${facts.size} · ↓ covers`;
      return `✓ ${facts.size}`;
    }
    case 'failed':
      return 'Retry';
  }
}

/**
 * A playlist row's sub-line, from the store's verdict and the figures in hand.
 *
 * `complete` prints the **measured** size and says where it is (`on this phone`); a partial or live
 * download says `n of m on this phone` instead, which is the one sentence the owner's screenshot
 * needed and did not have — with `m` the playlist's own length, never the manifest's alone
 * (`downloadedFigures`). Nothing here ever prints `record.bytes` — that is a ceiling for a download
 * that has not happened, which is exactly the confusion the screenshot shows (`5 GB` next to
 * `269 on this phone`).
 */
export function playlistSubLine(input: PlaylistRowInput, badge: PlaylistBadge): string {
  const tracks = input.songCount ?? badge.total;
  const tracksText = `${tracks} track${tracks === 1 ? '' : 's'}`;
  if (badge.state === 'complete') {
    return [tracksText, formatDuration(input.duration), `${formatBytes(badge.bytes)} on this phone`].filter(Boolean).join(' · ');
  }
  if (badge.state === 'partial' || badge.state === 'downloading') {
    const { done, total } = downloadedFigures(badge, input.songCount);
    return `${tracksText} · ${done} of ${total} on this phone`;
  }
  return [tracksText, formatDuration(input.duration)].filter(Boolean).join(' · ');
}

/**
 * The row's accessible name — the same figures as the sub-line, spoken.
 *
 * A row with nothing of it here is a plain `Open <name>`; a marked one says whether the whole
 * playlist is here (`downloaded`) or how much of it is (`n of m downloaded`, from
 * `downloadedFigures`, so the number VoiceOver reads is the number on the row).
 */
export function playlistRowLabel(input: PlaylistRowInput, badge: PlaylistBadge): string {
  if (badge.state === 'none') return `Open ${input.name}`;
  if (badge.state === 'complete') return `Open ${input.name}, downloaded`;
  const { done, total } = downloadedFigures(badge, input.songCount);
  return `Open ${input.name}, ${done} of ${total} downloaded`;
}

/** The mark's glyph: solid when the file is here, hollow when part of it is or it is on its way. */
function downloadMarkIcon(state: 'partial' | 'downloading' | 'complete'): SVGSVGElement {
  return icon(state === 'complete' ? ICONS.download : ICONS.downloadPartial, 15);
}

/**
 * **The one playlist row** (§A3). Online it is the server's row with the store's knowledge drawn
 * *on* it — badge, measured size, and art through `Library.coverUrl`, so it is local when local art
 * exists and the server's when it does not. Offline it is the same row with the store's own facts in
 * the same slots. No view may paint a playlist twice, and one renderer is what makes that checkable.
 *
 * The mark is a `<span>` inside the row's own button: no second tap target, and its state is on the
 * row's accessible name instead.
 */
function playlistRow(ctx: AppContext, input: PlaylistRowInput): HTMLElement {
  const mark = h('span', { class: 'row-dl hidden', 'aria-hidden': 'true' });
  const sub = h('span', { class: 'row-sub' });
  const row = bindTap(
    h('button', { class: 'row', 'aria-label': '' }, [
      cover(ctx.library!.coverUrl(input.coverArt, 128), 'thumb', input.name),
      h('div', { class: 'row-text' }, [h('span', { class: 'row-title', text: input.name }), sub]),
      mark,
    ]),
    () => (location.hash = `#/playlist/${encodeURIComponent(input.id)}`),
  );
  const paint = (): void => {
    const badge = ctx.offline?.playlistBadge(input.id, input.songCount) ?? { state: 'none' as const, done: 0, total: 0, bytes: 0 };
    sub.textContent = playlistSubLine(input, badge);
    const marked = badge.state !== 'none';
    mark.className = marked ? `row-dl${badge.state === 'complete' ? '' : ' partial'}` : 'row-dl hidden';
    replace(mark, ...(marked ? [downloadMarkIcon(badge.state === 'complete' ? 'complete' : 'partial')] : []));
    row.setAttribute('aria-label', playlistRowLabel(input, badge));
  };
  paint();
  trackStoreRepaint(paint);
  return row;
}

/*
 * **What the store feeds on the view that is on screen, as repaint closures** (v1.9.20, v1.9.23).
 *
 * Registered by the row builders as they run and emptied by every render, because the nodes it names
 * are replaced with the view. One store listener walks it (`renderRoute`), which is how a download
 * that finishes while a list is on screen flips its own mark — and how the metadata repair a 1.9.19
 * row needs reaches the row's own text (v1.9.23) — and only its own parts.
 */
let storeRepaints: Array<() => void> = [];

function trackStoreRepaint(paint: () => void): void {
  storeRepaints.push(paint);
}

function clearStoreRepaints(): void {
  storeRepaints = [];
}

function repaintStoreRows(): void {
  for (const paint of storeRepaints) {
    try {
      paint();
    } catch {
      // A repaint that throws is a UI bug, never a reason to stop repainting the others.
    }
  }
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
  // The route this render answers for: a late answer paints only if it is still the view (v1.9.20).
  const route = location.hash || DEFAULT_ROUTE;
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
  /*
   * v1.9.20 — **"On this phone"** stands at the top of the Library, above the artists, drawn from the
   * store alone: the one place the owner browses the songs that are downloaded, and it is there
   * whether or not the server answers (§4.1). It is a view, never a playlist — see `renderDownloads`.
   */
  shell.view.append(h('div', { class: 'list' }, [downloadsEntryRow(ctx)]), listHost);
  const artists = await ctx.library!.artists();
  if (overtaken(shell, route)) return;
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

/**
 * The Library's entry row into the downloaded music (v1.9.20).
 *
 * Drawn from the store alone — `totalTracks`/`totalBytes` are reads of the in-memory index — so it
 * paints before anything is asked of the server and stays correct with no connection. It is a
 * **door to a view**, not a playlist row: it carries no id, nothing on the server is named by it, and
 * tapping it navigates to `#/downloads`.
 */
function downloadsEntryRow(ctx: AppContext): HTMLElement {
  const sub = h('span', { class: 'row-sub' });
  const row = bindTap(
    h('button', { class: 'row row-entry', 'aria-label': 'Open On this phone' }, [
      h('span', { class: 'row-play' }, [icon(ICONS.download, 18)]),
      h('div', { class: 'row-text' }, [h('span', { class: 'row-title', text: 'On this phone' }), sub]),
    ]),
    () => (location.hash = '#/downloads'),
  );
  const paint = (): void => {
    const tracks = ctx.offline?.totalTracks() ?? 0;
    const bytes = ctx.offline?.totalBytes() ?? 0;
    sub.textContent =
      tracks === 0 ? 'nothing downloaded yet' : `${tracks} track${tracks === 1 ? '' : 's'} · ${formatBytes(bytes)}`;
  };
  paint();
  trackStoreRepaint(paint);
  return row;
}

/**
 * **On this phone** (v1.9.20, §4): the tracks that are downloaded, browsable with no connection.
 *
 * Why this is not the defect the owner reported — and why it cannot become it:
 *
 *   - it has **no id, no name and no server object**: nothing in `getPlaylists`, nothing in the
 *     Playlists list, nothing creatable, renamable, deletable or shareable, and no code path that
 *     could ever POST it to the library;
 *   - it is a **filter's result over rows that already exist** (`downloadedSongs`), and its
 *     membership is the same `pathFor` predicate as the badge — so a track cannot be in this list and
 *     unbadged, or badged and absent from it;
 *   - it is a **route**, and a route is a view the app can draw. The forbidden thing is a
 *     playlist-shaped row under the Playlists tab; a screen that exists only on the phone cannot be
 *     confused with something on the server;
 *   - and it says where it lives: the title is **On this phone**, the same words the rows, the badge
 *     and the offline pill already use.
 *
 * The body is the app's existing `songRow`, so the rows carry the badge, the tap-to-play behaviour
 * and the highlight the rest of the app has; the queue's context is its own kind (`downloads`), so
 * the now-playing line cannot claim these came from a playlist.
 */
async function renderDownloads(ctx: AppContext, shell: Shell): Promise<void> {
  const songs = ctx.offline?.downloadedSongs() ?? [];
  const items: QueueItem[] = songs.map((song) => ({ song, context: { kind: 'downloads', name: 'On this phone' } }));
  const playAll = h('button', { class: 'button primary', text: 'Play all' }, [icon(ICONS.play, 16)]);
  playAll.disabled = items.length === 0;
  playAll.addEventListener('click', () => {
    if (items.length > 0) void ctx.queue!.play(items, 0, items[0]?.context ?? null);
  });
  const tracks = songs.length;
  const bytes = ctx.offline?.totalBytes() ?? 0;
  pageTitle(
    shell,
    'On this phone',
    tracks === 0 ? 'nothing downloaded yet' : `${tracks} track${tracks === 1 ? '' : 's'} · ${formatBytes(bytes)}`,
    [playAll],
  );
  const host = h('div', { class: 'list' });
  shell.view.append(host);
  if (songs.length === 0) {
    host.append(
      h('p', {
        class: 'muted',
        text: 'Nothing is downloaded on this phone yet. Open a playlist while you have a connection and press ↓ in its header — it stays here, and it stays playable with no connection.',
      }),
    );
    return;
  }
  replace(
    host,
    ...songs.map((song, index) => songRow(ctx, song, index, items, items[0]?.context ?? null, true)),
  );
  updateRowHighlight(ctx, shell);
  /*
   * v1.9.22 — **the rows are repaired after they are drawn, never before.** Everything above is
   * local and synchronous (`downloadedSongs()` answers from a map), and a row a 1.9.19 build wrote
   * has no title and no duration to draw: `repairMetadata` fills them in from the download's own
   * record on the phone and then from the server, writes them back to the store, and the re-draw
   * arrives through the store's own `onChange`. What must not happen again is the first paint
   * waiting on a `bridge.list()` round trip, which is the 1.9.19 defect this view was built to
   * avoid (§4.2), or a plausible-looking stand-in for a title nobody has asked for yet.
   *
   * v1.9.23 — **and that re-draw is the row's own text.** The repair was reaching the store and
   * nothing else: the rows had captured their title and their time at build, so he opened this list
   * and read his screenshot until he left the screen and came back. The rows `songRow` builds
   * register their own repaint (`paintText`), which is walked by the same store listener they were
   * always registered with. `items` above is built from **those same `Song` objects** (one item per
   * `downloadedSongs()` entry, and the rows are drawn from that same array), so filling one fills the
   * queue's copy with it: the bar of the track he is playing, and the track a tap a moment later
   * carries, come out of the same fill.
   */
  void ctx.offline?.repairMetadata();
}

async function renderArtist(ctx: AppContext, shell: Shell, id: string): Promise<void> {
  // The route this render answers for: a late answer paints only if it is still the view (v1.9.21).
  const route = location.hash || DEFAULT_ROUTE;
  loading(shell);
  const artist = await ctx.library!.artist(id);
  if (overtaken(shell, route)) return;
  pageTitle(shell, artist.name, `${artist.albumCount ?? artist.album?.length ?? 0} albums`);
  const host = h('div', { class: 'grid' });
  const albums = artist.album ?? [];
  replace(host, ...albums.map((album) => albumCard(ctx, album)));
  shell.view.append(host);
  if (albums.length === 0) shell.view.append(h('p', { class: 'muted', text: 'No albums returned for this artist.' }));
}

async function renderAlbum(ctx: AppContext, shell: Shell, id: string): Promise<void> {
  // The route this render answers for: a late answer paints only if it is still the view (v1.9.21).
  const route = location.hash || DEFAULT_ROUTE;
  loading(shell);
  const album = await ctx.library!.album(id);
  if (overtaken(shell, route)) return;
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
    try {
      const playlists = await ctx.library!.playlists();
      for (const playlist of playlists) playlistPicker.append(h('option', { value: playlist.id, text: playlist.name }));
    } catch {
      // Offline (v1.9.18): the picker keeps only its placeholder. An album page that is otherwise
      // on screen is not worth an unhandled rejection over a control that could not have worked.
    }
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

/**
 * The playlists screen (v1.9.18 — local first, like the playlist page itself).
 *
 * With no connection this screen used to be one sentence about a URL. The playlists the phone holds
 * are not a network question at all: they are in the durable manifests, with their names and their
 * song lists, so they are drawn before the server is asked and kept when it cannot answer. The
 * server's list replaces them when it does answer — that is where a playlist's *current* name and
 * contents come from, and the name is remembered against the manifest as it arrives.
 */
async function renderPlaylists(ctx: AppContext, shell: Shell): Promise<void> {
  // The route this render answers for: a late answer paints only if it is still the view (v1.9.20).
  const route = location.hash || DEFAULT_ROUTE;
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
  const pill = offlinePill();
  pill.classList.add('hidden');
  /*
   * v1.9.20 — the subtitle is the facts, not the endpoints.
   *
   * It read `getPlaylists / createPlaylist`: a developer's note rendered on the owner's screen, and
   * visible in the screenshot he sent (the same defect 1.9.19's item 5 fixed — "the header uses
   * words, not the id"). The count is written once the answer is in, so it is never a lie about what
   * is on the screen.
   */
  pageTitle(shell, 'Playlists', 'Loading…', [nameInput, createButton, pill]);
  const downloaded = ctx.offline?.downloadedPlaylists() ?? [];
  /*
   * **One list, and the server's rows are it.** The store's own list used to be painted beside this
   * one under a `Downloaded` heading — one playlist, two rows, which the owner read as a duplicated
   * playlist. It is drawn only where there is no server row to annotate: the catch below (§I1).
   */
  const serverHost = h('div', { class: 'list' }, [h('p', { class: 'muted', text: 'Loading playlists…' })]);
  shell.view.append(serverHost);
  let playlists: Playlist[];
  try {
    playlists = await ctx.library!.playlists();
  } catch (error) {
    /*
     * Nothing downloaded: let the router draw the offline state, which explains where these come
     * from. With downloads in hand there is something to show — and here, with no server row at all,
     * the store *is* the list, drawn through the same renderer.
     */
    if (!isUnreachable(error) || downloaded.length === 0) throw error;
    if (overtaken(shell, route)) return;
    pill.classList.remove('hidden');
    setSubtitle(shell, `${downloaded.length} on this phone`);
    replace(
      serverHost,
      ...downloaded.map((entry) => playlistRow(ctx, storePlaylistInput(ctx, entry))),
      h('p', { class: 'muted', text: 'These are the playlists on this phone. Your library’s full list needs a connection.' }),
    );
    return;
  }
  for (const playlist of playlists) ctx.offline?.rememberPlaylistName(playlist.id, playlist.name);
  // The names above are data and are kept; the paint below only happens if this is still the view.
  if (overtaken(shell, route)) return;
  setSubtitle(shell, `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`);
  if (playlists.length === 0) {
    replace(serverHost, h('p', { class: 'muted', text: 'No playlists yet — name one above.' }));
    return;
  }
  replace(
    serverHost,
    ...playlists.map((playlist) =>
      playlistRow(ctx, {
        id: playlist.id,
        name: playlist.name,
        songCount: playlist.songCount,
        duration: playlist.duration,
        coverArt: playlist.coverArt ?? playlist.id,
      }),
    ),
  );
}

/** Rewrite the page's own subtitle, for the views whose second line is a fact they learn late. */
function setSubtitle(shell: Shell, text: string): void {
  const node = shell.view.querySelector('.page-head .muted');
  if (node) node.textContent = text;
}

/**
 * The offline store's subscribers are a **list** (v1.9.12's fix): the playlist page's download
 * control and the settings row are both alive, and with a single `onChange` slot whichever
 * subscribed last silently replaced the other. Each render registers its own listener and the
 * previous render's are dropped here, so navigating away does not leave a redraw pointed at a
 * detached node.
 */
let offlineSubscriptions: Array<() => void> = [];

function subscribeOffline(store: OfflineStore | null, listener: () => void): void {
  if (!store) return;
  offlineSubscriptions.push(store.onChange(listener));
}

function clearOfflineSubscriptions(): void {
  for (const unsubscribe of offlineSubscriptions) {
    try {
      unsubscribe();
    } catch {
      // Nothing to do — a listener that is already gone.
    }
  }
  offlineSubscriptions = [];
}

/**
 * The playlist page's own control, for a playlist that grew after it was downloaded: **n of m · retry**,
 * with `m` the playlist in front of the owner and `n` what the download covers.
 *
 * It is one function because the Playlists row prints the *same* pair (`n of m on this phone`, from
 * `downloadedFigures`) about the same playlist, and two screens disagreeing about one fact is the
 * defect both of these exist to prevent (v1.9.21). `test/offline-browse.test.ts` asserts that the row
 * and this agree.
 */
export function grownControlLabel(songs: Song[], missing: number): string {
  return `${songs.length - missing} of ${songs.length} · retry`;
}

/**
 * The playlist page's download control (v1.9.12): one compact button in the header action row that
 * shows the total size and drives the §5 state machine. It renders its label from the index
 * synchronously and updates only its own label from the store's change listener — never a poll, and
 * never a re-render of the list behind it. The estimate is recomputed inside `paint()`, not captured
 * at render: the same page reads `up to 312 MB` before a download and the exact figure after it.
 */
function downloadControl(ctx: AppContext, playlistId: string, songs: Song[], name: string): HTMLElement {
  const offline = ctx.offline;
  const estimate = (): SizeEstimate => (offline ? offline.estimate(songs) : estimateBytes(songs));
  const button = h('button', { class: 'button', 'aria-label': '' });
  const sizeLabel = (): string => {
    const current = estimate();
    const prefix = current.exact ? '' : 'up to ';
    return `${prefix}${formatBytes(current.total)}`;
  };
  /** Tracks the downloaded set does not cover — a playlist a song was added to afterwards. */
  const missing = (): number => offline?.missingCount(playlistId, songs) ?? 0;
  /**
   * Covers this playlist's download has not got (v1.9.20, §5.8).
   *
   * This is what gives a playlist downloaded by 1.9.19 — one with its audio and lyrics but no art —
   * a way back to a cover that costs one tap and no audio: the label says `↓ covers` and the tap
   * calls the same `download()`, which re-enqueues only what is absent.
   */
  const missingCovers = (): number => offline?.missingCovers(songs) ?? 0;
  /**
   * The button's own sentence — the state machine lives in `downloadControlLabel`, which is a
   * function of these facts alone so the same sentence can be read in a test.
   */
  const label = (): string => {
    const record = offline?.record(playlistId);
    return downloadControlLabel({
      state: record?.state ?? 'none',
      done: record?.done ?? 0,
      total: record?.total ?? 0,
      songs,
      size: sizeLabel(),
      missing: missing(),
      missingCovers: missingCovers(),
    });
  };
  const paint = (): void => {
    const text = label();
    button.textContent = text;
    button.setAttribute('aria-label', text);
    button.disabled = songs.length === 0;
  };
  paint();
  button.addEventListener('click', () => {
    if (!offline || songs.length === 0) return;
    const record = offline.record(playlistId);
    // A `complete` record whose playlist has grown is a resume, not a removal.
    const grown = record?.state === 'complete' && missing() > 0;
    /*
     * …and a `complete` record with a cover missing is a **covers-only** fetch (v1.9.20): the tap
     * goes through the same `download()`, which skips every `complete` audio row and every resolved
     * lyric, so no music byte is re-fetched and the label returns to `✓ 312 MB` when the covers land.
     */
    const coversOnly = record?.state === 'complete' && !grown && missingCovers() > 0;
    if (
      !record ||
      record.state === 'idle' ||
      record.state === 'failed' ||
      record.state === 'partial' ||
      grown ||
      coversOnly
    ) {
      void (async () => {
        // Wi-Fi only by default: the native side enforces `allowsCellularAccess = false`.
        // The name goes with the request: it is the one fact about this download that cannot be
        // rebuilt from the files afterwards, and the offline browse list needs it (v1.9.18).
        const result = await offline.download(playlistId, songs, { allowsCellular: false, name });
        if (result.kind === 'no-space') ctx.toast(`Not enough free space — ${formatBytes(result.needed)} needed`, 'error');
      })();
    } else if (record.state === 'downloading' || record.state === 'estimating') {
      void offline.cancel(playlistId);
    } else if (record.state === 'complete') {
      void offline.remove(playlistId);
    }
  });
  subscribeOffline(offline, paint);
  return button;
}

/**
 * The playlist page (v1.9.18 — local first).
 *
 * The owner's report, verbatim: with the playlist already downloaded and no connection, opening its
 * song list *"renders a full-screen error instead of the songs"* — `could not reach https://…
 * (TypeError: Load failed)`. The songs were on the phone the whole time; the page simply asked the
 * server for them first and had nothing to draw when the answer never came.
 *
 * So the order is inverted. If the store holds a manifest for this playlist, its song list is drawn
 * **synchronously, from local state**, and only then is the server asked — for the current list, and
 * for the name. A server that does not answer costs nothing: the rows already on screen are the
 * playlist as it was downloaded, every one of them plays from its local file, and the header grows
 * an `Offline` badge. Nothing about the page waits on the network.
 *
 * `removable` is false on that local path: removing a track from a playlist is a server write, and
 * offering a control that cannot work is worse than leaving it out.
 */
async function renderPlaylist(ctx: AppContext, shell: Shell, id: string): Promise<void> {
  const store = ctx.offline;
  // The route this render answers for: a late answer paints only if it is still the view (v1.9.20).
  const route = location.hash || DEFAULT_ROUTE;
  const record = store?.record(id) ?? null;
  const localSongs = record !== null && record.done > 0 ? record.songs : [];
  const pill = offlinePill();
  pill.classList.add('hidden');
  let painted = localSongs.length > 0;
  if (painted) {
    paintPlaylist(ctx, shell, id, record?.name ?? 'Downloaded playlist', localSongs, {
      pill,
      removable: false,
      // The manifest is what was *asked for*; only the index knows what is on the phone (v1.9.19).
      local: true,
    });
  } else {
    loading(shell);
  }
  let playlist: PlaylistWithEntries;
  try {
    playlist = await ctx.library!.playlist(id);
  } catch (error) {
    if (!painted) throw error;
    // The list on screen is the one on the phone: keep it, and say why it is not the server's.
    if (isUnreachable(error)) pill.classList.remove('hidden');
    else ctx.toast(errorText(error), 'error');
    return;
  }
  if (playlist.name) store?.rememberPlaylistName(id, playlist.name);
  // The owner may have left this screen while the answer was in flight: the name above is data and
  // is kept, the paint is not (`overtaken`).
  if (overtaken(shell, route)) return;
  paintPlaylist(ctx, shell, id, playlist.name, playlist.entry ?? [], { pill, removable: true });
}

/**
 * Draw the playlist page from a song list — the one body both answers use (the local manifest's and
 * the server's), so the offline page is the same page rather than a second rendering of it.
 */
function paintPlaylist(
  ctx: AppContext,
  shell: Shell,
  id: string,
  name: string,
  songs: Song[],
  options: { pill: HTMLElement; removable: boolean; local?: boolean },
): void {
  /*
   * `local` says this list is the **manifest**, i.e. the songs the download was asked for — not the
   * songs that are on the phone (v1.9.19).
   *
   * `record.done` counts only the complete files, and a download the owner cancelled (or a playlist
   * that grew after it was downloaded) leaves `record.songs` longer than the index. Drawing that list
   * unexamined painted tracks with no file as ordinary rows: offline a tap on one was silence and
   * nothing on the screen said why, and "play the playlist" walked onto them. The resolver is
   * synchronous, so every row is checked against the index as it is drawn — the ones that are not
   * here are marked and stay out of the queue. On the server's own answer there is nothing to check:
   * every track is streamable, so `onPhone` is null and the page is exactly as it was.
   */
  const onPhone = options.local === true ? (song: Song): boolean => ctx.offline?.pathFor(song.id) !== null : null;
  const playable = onPhone ? songs.filter((song) => onPhone(song)) : songs;
  const items: QueueItem[] = playable.map((song) => ({ song, context: { kind: 'playlist', id, name } }));
  const playAll = h('button', { class: 'button primary', text: 'Play playlist' }, [icon(ICONS.play, 16)]);
  playAll.disabled = items.length === 0;
  playAll.addEventListener('click', () => {
    if (items.length > 0) void ctx.queue!.play(items, 0, items[0]?.context ?? null);
  });
  // Offline the server's own `duration` is not available, so the figure is summed from the rows —
  // the same arithmetic, on the same songs.
  const duration = songs.reduce((total, song) => total + (song.duration ?? 0), 0);
  const partial = onPhone !== null && playable.length < songs.length;
  pageTitle(
    shell,
    name,
    partial ? `${songs.length} tracks · ${playable.length} on this phone` : `${songs.length} tracks · ${formatDuration(duration)}`,
    [playAll, options.pill, downloadControl(ctx, id, songs, name)],
  );
  const removeAt = options.removable
    ? (index: number) => (): void => {
        void (async () => {
          try {
            await ctx.library!.removeFromPlaylist(id, index);
            ctx.toast('Removed from the playlist');
            ctx.render();
          } catch (error) {
            ctx.toast(errorText(error), 'error');
          }
        })();
      }
    : null;
  // The rows are built in the playlist's own order, and the index a row plays is its position among
  // the tracks that are actually here — so a queue drawn from this page never contains a file the
  // phone does not have.
  let playableIndex = 0;
  const rows = songs.map((song) => {
    const here = onPhone === null || onPhone(song);
    if (!here) return notOnPhoneRow(ctx, song);
    const index = playableIndex;
    playableIndex += 1;
    return songRow(ctx, song, index, items, items[0]?.context ?? null, true, removeAt?.(index));
  });
  replace(
    shell.view,
    shell.view.firstElementChild ?? h('div'),
    h('div', { class: 'list' }, songs.length === 0 ? h('p', { class: 'muted', text: 'This playlist is empty.' }) : rows),
  );
  updateRowHighlight(ctx, shell);
}

/**
 * A track this phone does not have, on the offline playlist page (v1.9.19).
 *
 * Deliberately **not** a play row: offline it resolves to nothing, and it used to look exactly like
 * one — the tap was silence with no explanation at all. It says what it is, it stays out of the
 * queue (`paintPlaylist` never puts it in `items`), and a tap explains how to get it.
 */
function notOnPhoneRow(ctx: AppContext, song: Song): HTMLElement {
  return bindTap(
    h('button', { class: 'row song not-on-phone', 'aria-label': `${song.title} — not on this phone` }, [
      h('span', { class: 'row-play' }, [icon(ICONS.close, 18)]),
      h('div', { class: 'row-text' }, [
        h('span', { class: 'row-title', text: song.title }),
        h('span', { class: 'row-sub', text: [song.artist, 'not on this phone'].filter(Boolean).join(' · ') }),
      ]),
      h('span', { class: 'row-time', text: formatDuration(song.duration) }),
    ]),
    () => ctx.toast('Not on this phone — open the playlist and press ↓ when you have a connection'),
  );
}

async function renderFavourites(ctx: AppContext, shell: Shell): Promise<void> {
  // The route this render answers for: a late answer paints only if it is still the view (v1.9.21).
  const route = location.hash || DEFAULT_ROUTE;
  loading(shell);
  const starred = await ctx.library!.starred();
  if (overtaken(shell, route)) return;
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
  /*
   * The route this render answers for (v1.9.21), captured **once per render and never per request**:
   * `submit` runs again on every Enter, and a second search while the first is in flight is still
   * this render — its answer is a current one and must paint. What the guard rules out is the answer
   * that arrives after the owner has left the screen.
   */
  const route = location.hash || DEFAULT_ROUTE;
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
        // The owner may have left the screen while this was in flight (v1.9.21): the results host
        // below belongs to a render that is no longer the view.
        if (overtaken(shell, route)) return;
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
        // A failure is a paint too (v1.9.21): the badge and the message belong to a screen he is no
        // longer on, and a stale one would land in the results host of a dead render.
        if (overtaken(shell, route)) return;
        /*
         * Offline, the result pane is not the place for the transport's own text either (v1.9.18):
         * the whole view is still here — the field, the button, the header — so it degrades to the
         * same small badge and a sentence about what search needs.
         */
        if (isUnreachable(error)) {
          replace(results, h('div', { class: 'row' }, [offlinePill(), h('span', { class: 'muted', text: ' — searching needs your library' })]));
        } else {
          replace(results, h('p', { class: 'muted', text: errorText(error) }));
        }
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

  // §S11: how much the owner's downloaded music takes, and the one action that removes all of it.
  /*
   * v1.9.20 — this line is the door to **On this phone**, and it already prints the figures that view
   * lists: the count and the size are the same two numbers, read from the same store. Nothing about
   * the text moves; it becomes tappable.
   */
  const downloadSummary = h('button', { class: 'button downloads-link', 'aria-label': 'Browse the music on this phone' });
  const paintDownloads = (): void => {
    const bytes = ctx.offline?.totalBytes() ?? 0;
    const tracks = ctx.offline?.totalTracks() ?? 0;
    downloadSummary.textContent = `Downloaded music: ${formatBytes(bytes)} · ${tracks} track${tracks === 1 ? '' : 's'} →`;
  };
  paintDownloads();
  downloadSummary.addEventListener('click', () => (location.hash = '#/downloads'));
  const removeDownloads = h('button', { class: 'button danger', text: 'Remove all downloads' });
  removeDownloads.addEventListener('click', () => {
    void ctx.offline?.removeAll().then(() => ctx.toast('All downloads removed'));
  });
  subscribeOffline(ctx.offline, paintDownloads);

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
      h('h2', { class: 'section', text: 'Downloads' }),
      downloadSummary,
      h('div', { class: 'row' }, [removeDownloads]),
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
  const mark = h('span', { class: 'row-dl hidden', 'aria-hidden': 'true' });
  /** The row's second line: the artist, and the album where this list is not already an album. */
  const subLine = (): string => [song.artist, showAlbum ? song.album : null].filter(Boolean).join(' · ');
  /*
   * v1.9.23 — **the row's text is three nodes, not a snapshot.**
   *
   * They used to be written once, at build, from the `Song` the view was handed — so the repair
   * filled the store and the row went on drawing a blank title and `--:--` for as long as the owner
   * stayed on the screen (`paintText` below is what re-reads it). The `Song` object is **shared with
   * the queue** by construction (`renderDownloads` builds its items out of these very objects and
   * hands them to `queue.select`), which is why filling it in place also puts the name in the player
   * bar and why a tap a moment later carries it.
   */
  const titleNode = h('span', { class: 'row-title', text: song.title });
  const subNode = h('span', { class: 'row-sub', text: subLine() });
  const timeNode = h('span', { class: 'row-time', text: formatDuration(song.duration) });
  const row = bindTap(
    h(
      'button',
      {
        class: 'row song',
        'aria-label': `Play ${song.title}`,
      },
      [
        h('span', { class: 'row-play' }, [icon(ICONS.play, 18)]),
        h('div', { class: 'row-text' }, [titleNode, subNode]),
        /*
         * v1.9.20 — the download mark, immediately before the time. It is a glyph, not a control:
         * the whole row is the one tap target (v1.5), so the state goes on the row's accessible name
         * instead, and the mark itself is `aria-hidden`.
         */
        mark,
        timeNode,
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
  /*
   * The mark is painted from the store's own predicate — `pathFor`, the same one that decides
   * whether this row is playable at all — and repainted in place when the store changes, so a
   * download that finishes while this list is on screen flips its own mark with no re-render.
   */
  const paintMark = (): void => {
    const downloaded = (ctx.offline?.pathFor(song.id) ?? null) !== null;
    if (mark.dataset.on !== String(downloaded)) {
      mark.dataset.on = String(downloaded);
      mark.className = downloaded ? 'row-dl' : 'row-dl hidden';
      replace(mark, ...(downloaded ? [icon(ICONS.download, 15)] : []));
    }
    /*
     * …and the accessible name is written on **every** pass, not only when the glyph changed
     * (v1.9.23): it carries the title, and the title can be filled in later by `paintText` below.
     * The row's name is the only place a screen reader hears which track this is.
     */
    row.setAttribute('aria-label', downloaded ? `Play ${song.title}, downloaded` : `Play ${song.title}`);
  };
  /**
   * v1.9.23 — **the name, the sub-line and the length, re-read from the store's own answer.**
   *
   * `songFor` is the store's row for this id as a `Song`; only what is *missing* is filled from it
   * ({@link fillSong}), so a row the library answered for is never overwritten by the phone's copy,
   * and a row nobody can name yet keeps drawing exactly what it drew — an empty title, `--:--` —
   * rather than its id in the title slot or a zero drawn as a length.
   *
   * This is the whole of the owner's screenshot: he opened **On this phone**, the store named every
   * one of his 497 tracks in the same tick, and the rows went on showing blanks until he left the
   * screen and came back.
   */
  const paintText = (): void => {
    const known = ctx.offline?.songFor(song.id) ?? null;
    if (known === null || fillSong(song, known) === 0) return;
    titleNode.textContent = song.title;
    subNode.textContent = subLine();
    timeNode.textContent = formatDuration(song.duration);
  };
  paintMark();
  /*
   * **The text pass is registered first, and that order is load-bearing.**
   *
   * The mark pass writes the row's accessible name *from* `song.title` (`:3170`), so it has to run
   * after the pass that fills the title out of the store — otherwise the one store pass that both
   * fills the title and writes the name (the repair's **server** pass, which is the only notify a row
   * with no manifest beside it gets) leaves the row announced as `Play , downloaded` while its title
   * is legibly on the screen. The legacy case looked fine only because the record pass notifies
   * twice, so a second pass repaired the name. A screen reader hears this row through its name and
   * nothing else.
   *
   * Both stay registered, and the name is still written on **every** pass: the title can arrive
   * later than the glyph, and neither pass writes the other's node.
   */
  trackStoreRepaint(paintText);
  trackStoreRepaint(paintMark);
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

