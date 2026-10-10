/**
 * The application shell: routing, views, the player bar and the now-playing screen.
 *
 * Plain DOM, no framework. The whole UI is element building and a router over the URL
 * hash — a virtual DOM would buy nothing here, and the visualiser wants a canvas it
 * owns rather than a tree that gets re-rendered underneath it.
 */
import { SubsonicClient, SubsonicError } from '../api/subsonic.ts';
import type { Album, Artist, Playlist, QueueContext, QueueItem, Song } from '../api/types.ts';
import { AudioEngine, type EngineStatus } from '../player/engine.ts';
import { attachVisualizer } from '../player/visualizer.ts';
import { DEFAULT_PALETTE, paletteFromArtwork, type Palette } from '../player/palette.ts';
import { platformInfo, type PlatformInfo } from '../platform.ts';
import { PlaybackQueue } from '../state/queue.ts';
import { Library, type AlbumListType } from '../state/library.ts';
import { createSecretStore, type SecretStore } from '../storage/secret.ts';
import { loadSettings, saveSettings, type PlaybackPreference, type Settings } from '../storage/settings.ts';
import { ICONS, cover, formatDuration, formatTime, h, icon, playIcon, replace, starIcon } from './dom.ts';

const PASSWORD_KEY = 'subsonic-password';
const BUILD_ID = '__BUILD_ID__';

interface Shell {
  header: HTMLElement;
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
  nowChip: HTMLElement;
  nowReason: HTMLElement;
  nowTheme: HTMLElement;
  scrubbing: boolean;
}

interface AppContext {
  platform: PlatformInfo;
  settings: Settings;
  secrets: SecretStore;
  engine: AudioEngine;
  library: Library | null;
  queue: PlaybackQueue | null;
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

  const ctx: AppContext = {
    platform,
    settings,
    secrets,
    engine,
    library: null,
    queue: null,
    palette: DEFAULT_PALETTE,
    render: () => renderRoute(ctx, shell),
    toast: (message, kind = 'info') => toast(shell, message, kind),
  };

  const applyPalette = (palette: Palette): void => {
    ctx.palette = palette;
    shell.visualizerHost.style.setProperty('--accent-primary', palette.primary);
    shell.visualizerHost.style.setProperty('--accent-secondary', palette.secondary);
    shell.visualizerHost.style.setProperty('--accent-tertiary', palette.accent);
    visualizer.setPalette(palette);
    shell.nowTheme.textContent = palette.fromArt
      ? 'Theme from the album art'
      : 'Default theme (no cover art colours available)';
  };
  applyPalette(DEFAULT_PALETTE);

  if (await restoreSession(ctx, shell, applyPalette)) {
    if (!location.hash) location.hash = '#/artists';
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
  const tabDefs: Array<[string, string]> = [
    ['artists', 'Library'],
    ['albums', 'Albums'],
    ['playlists', 'Playlists'],
    ['favourites', 'Favourites'],
    ['search', 'Search'],
  ];
  const nav = h(
    'nav',
    { class: 'tabs' },
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
  const header = h('header', { class: 'topbar' }, [
    h('div', { class: 'brand' }, [h('span', { class: 'brand-mark', text: '◧' }), h('span', { text: 'Navilite' })]),
    nav,
    h('button', { class: 'icon-button', 'aria-label': 'Settings', onclick: () => (location.hash = '#/settings') }, [
      icon(ICONS.settings),
    ]),
  ]);

  const view = h('main', { class: 'view', id: 'view' });

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
    playIcon(false, 28),
  ]);
  const nowChip = h('span', { class: 'mode-chip', text: 'idle' });
  const nowReason = h('p', { class: 'now-reason', text: '' });
  const nowTheme = h('p', { class: 'now-theme', text: '' });
  const nowOverlay = h('section', { class: 'now hidden', 'aria-label': 'Now playing' }, [
    visualizerHost,
    h('div', { class: 'now-content' }, [
      h('button', { class: 'icon-button now-close', 'aria-label': 'Close now playing', onclick: () => closeNow() }, [
        icon(ICONS.close),
      ]),
      nowCover,
      nowTitle,
      nowSubtitle,
      nowContext,
      h('div', { class: 'now-progress' }, [nowPosition, nowProgress, nowDuration]),
      h('div', { class: 'now-controls' }, [
        h('button', { class: 'transport', 'aria-label': 'Previous', onclick: () => void queueRef?.previous() }, [
          icon(ICONS.previous, 26),
        ]),
        nowPlay,
        h('button', { class: 'transport', 'aria-label': 'Next', onclick: () => void queueRef?.next() }, [icon(ICONS.next, 26)]),
      ]),
      h('div', { class: 'now-mode' }, [nowChip, nowReason, nowTheme]),
    ]),
  ]);

  const toastNode = h('div', { class: 'toast' });

  const shell: Shell = {
    header,
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
    nowChip,
    nowReason,
    nowTheme,
    scrubbing: false,
  };

  bindSeek(shell.barProgress, shell, () => queueRef);
  bindSeek(shell.nowProgress, shell, () => queueRef);
  playerBar.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button, input')) return;
    openNow(shell);
  });

  root.replaceChildren(header, view, playerBar, nowOverlay, toastNode);
  return shell;
}

/** The queue is created after the shell, so the shell's buttons read it lazily. */
let queueRef: PlaybackQueue | null = null;

function togglePlayback(): void {
  void queueRef?.toggle();
}

function openNow(shell: Shell): void {
  shell.nowOverlay.classList.remove('hidden');
  shell.visualizerHost.style.setProperty('--accent-primary', shell.visualizerHost.style.getPropertyValue('--accent-primary'));
}

function closeNow(): void {
  document.querySelector('.now')?.classList.add('hidden');
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

/* ------------------------------------------------------------------- state */

interface PaletteHooks {
  apply(palette: Palette): void;
}

let currentPaletteSong: string | null = null;

async function restoreSession(ctx: AppContext, shell: Shell, hooks: PaletteHooks): Promise<boolean> {
  const { serverUrl, username } = ctx.settings;
  if (!username) return false;
  const password = await ctx.secrets.get(PASSWORD_KEY);
  if (password === null) return false;
  connect(ctx, shell, { serverUrl, username, password }, hooks, { silent: true });
  return true;
}

interface Credentials {
  serverUrl: string;
  username: string;
  password: string;
}

function connect(ctx: AppContext, shell: Shell, credentials: Credentials, hooks: PaletteHooks, options: { silent?: boolean } = {}): void {
  const client = new SubsonicClient(credentials);
  const library = new Library(client);
  const queue = new PlaybackQueue(ctx.engine, library);
  ctx.library = library;
  ctx.queue = queue;
  queueRef = queue;
  queue.onChanged = () => {
    updatePlayerBar(ctx, shell, ctx.engine.status());
    void syncPalette(ctx, hooks);
  };
  if (!options.silent) {
    queue.onChanged();
  }
}

async function syncPalette(ctx: AppContext, hooks: PaletteHooks): Promise<void> {
  const song = ctx.queue?.currentSong ?? null;
  if (!song || song.id === currentPaletteSong) return;
  currentPaletteSong = song.id;
  const url = ctx.library?.coverUrl(song.coverArt ?? song.albumId, 256) ?? null;
  hooks.apply(DEFAULT_PALETTE);
  const palette = await paletteFromArtwork(url);
  if (ctx.queue?.currentSong?.id === song.id) hooks.apply(palette);
}

/* ----------------------------------------------------------------- router */

function routeParts(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

function renderRoute(ctx: AppContext, shell: Shell): void {
  const [head = 'artists', id] = routeParts();
  setActiveTab(shell, head);
  shell.playerBar.classList.toggle('hidden', ctx.queue?.currentSong == null);
  if (!ctx.library || !ctx.queue) {
    void renderConnect(ctx, shell);
    return;
  }
  const fail = (error: unknown) => {
    replace(shell.view, h('div', { class: 'empty' }, [h('p', { text: errorText(error) })]));
  };
  switch (head) {
    case 'artists':
      void renderArtists(ctx, shell).catch(fail);
      break;
    case 'albums':
      void renderAlbums(ctx, shell).catch(fail);
      break;
    case 'playlists':
      void renderPlaylists(ctx, shell).catch(fail);
      break;
    case 'favourites':
      void renderFavourites(ctx, shell).catch(fail);
      break;
    case 'search':
      void renderSearch(ctx, shell).catch(fail);
      break;
    case 'artist':
      void renderArtist(ctx, shell, id ?? '').catch(fail);
      break;
    case 'album':
      void renderAlbum(ctx, shell, id ?? '').catch(fail);
      break;
    case 'playlist':
      void renderPlaylist(ctx, shell, id ?? '').catch(fail);
      break;
    case 'settings':
      renderSettings(ctx, shell);
      break;
    case 'connect':
      void renderConnect(ctx, shell);
      break;
    default:
      replace(
        shell.view,
        h('div', { class: 'empty' }, [
          h('p', { text: `No such screen: ${head}` }),
          h('button', { class: 'button', text: 'Back to the library', onclick: () => (location.hash = '#/artists') }),
        ]),
      );
  }
}

function setActiveTab(shell: Shell, head: string): void {
  const alias = head === 'artist' ? 'artists' : head === 'album' ? 'albums' : head === 'playlist' ? 'playlists' : head;
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
      h('div', {}, [h('h1', { text: title }), subtitle ? h('p', { class: 'muted', text: subtitle }) : null]),
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
    autocomplete: 'off',
    placeholder: 'https://alienlab.tailbed832.ts.net (or leave blank for same origin)',
    value: ctx.settings.serverUrl,
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
    serverUrl: urlInput.value.trim(),
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
        connect(ctx, shell, credentials, { apply: (palette) => applyPaletteGlobal(ctx, shell, palette) });
        location.hash = '#/artists';
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
      h('p', { class: 'muted small', text: 'Leave the URL blank only if this app is served from the same origin as Navidrome (the recommended deployment).' }),
    ]),
  );
}

/** One-off palette application when the shell's own hooks are not in scope. */
function applyPaletteGlobal(ctx: AppContext, shell: Shell, palette: Palette): void {
  ctx.palette = palette;
  shell.visualizerHost.style.setProperty('--accent-primary', palette.primary);
  shell.visualizerHost.style.setProperty('--accent-secondary', palette.secondary);
  shell.visualizerHost.style.setProperty('--accent-tertiary', palette.accent);
  shell.nowTheme.textContent = palette.fromArt ? 'Theme from the album art' : 'Default theme (no cover art colours available)';
}

async function renderArtists(ctx: AppContext, shell: Shell): Promise<void> {
  pageTitle(shell, 'Library', 'Artists, from getArtists');
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
}

async function renderSearch(ctx: AppContext, shell: Shell): Promise<void> {
  const input = h('input', {
    class: 'field inline',
    type: 'search',
    placeholder: 'Search the library',
    autocomplete: 'off',
    enterkeyhint: 'search',
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

  const forget = h('button', { class: 'button danger', text: 'Forget credentials' });
  forget.addEventListener('click', () => {
    void (async () => {
      await ctx.secrets.remove(PASSWORD_KEY);
      ctx.settings = { ...ctx.settings, username: '' };
      saveSettings(ctx.settings);
      ctx.library = null;
      ctx.queue = null;
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
      h('p', { class: 'muted', text: `Server: ${serverLabel}` }),
      h('p', { class: 'muted', text: `User: ${ctx.settings.username || '—'}` }),
      h('h2', { class: 'section', text: 'Credential storage' }),
      h('p', { class: 'muted', text: ctx.secrets.description }),
      h('p', { class: ctx.secrets.secure ? 'ok small' : 'warn small', text: ctx.secrets.secure
        ? 'Stored by the operating system (Keychain / Android Keystore), not in web storage.'
        : 'Plain web storage. That is the honest limit of an installable PWA on iOS and Android — the wrapped builds avoid it.' }),
      h('h2', { class: 'section', text: 'Playback and visualiser' }),
      preferenceSelect,
      h('p', { class: 'muted small', text: 'Web Audio does not survive backgrounding on iOS, so the real spectrum is a foreground feature there. Android keeps Web Audio alive while playing.' }),
      h('h2', { class: 'section', text: 'About' }),
      h('p', { class: 'muted', text: `Navilite ${BUILD_ID} · Subsonic API 1.16.1 · ${ctx.platform.native ? `wrapped ${ctx.platform.os} build` : 'browser / PWA'}` }),
      h('div', { class: 'row' }, [forget]),
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
          openNowViaDom();
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
  return row;
}

function openNowViaDom(): void {
  document.querySelector('.now')?.classList.remove('hidden');
}

/* ------------------------------------------------------------- player bar */

function updatePlayerBar(ctx: AppContext, shell: Shell, status: EngineStatus): void {
  const song = ctx.queue?.currentSong ?? null;
  const visible = song != null;
  shell.playerBar.classList.toggle('hidden', !visible);
  if (!visible) return;

  const coverUrl = ctx.library?.coverUrl(song.coverArt ?? song.albumId, 256) ?? null;
  const durationMs = status.durationMs || (song.duration ?? 0) * 1000;
  const positionMs = Math.min(status.positionMs, durationMs || status.positionMs);

  if (shell.barCover.dataset.song !== song.id) {
    shell.barCover.dataset.song = song.id;
    replace(shell.barCover, cover(coverUrl, 'pb-art', song.album ?? song.title));
    replace(shell.nowCover, cover(ctx.library?.coverUrl(song.coverArt ?? song.albumId, 512) ?? null, 'now-art', song.album ?? song.title));
  }

  shell.barTitle.textContent = song.title;
  shell.barSubtitle.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  shell.nowTitle.textContent = song.title;
  shell.nowSubtitle.textContent = [song.artist, song.album].filter(Boolean).join(' · ');
  const context = ctx.queue?.queueContext;
  shell.nowContext.textContent = context ? `Playing from ${context.name}` : '';

  replace(shell.barPlay, playIcon(status.state === 'playing'));
  replace(shell.nowPlay, playIcon(status.state === 'playing', 28));

  if (!shell.scrubbing) {
    const ratio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
    shell.barProgress.value = String(Math.round(ratio * 1000));
    shell.nowProgress.value = String(Math.round(ratio * 1000));
    shell.barPosition.textContent = formatTime(positionMs / 1000);
    shell.nowPosition.textContent = formatTime(positionMs / 1000);
  }
  shell.barDuration.textContent = formatTime((durationMs || 0) / 1000);
  shell.nowDuration.textContent = formatTime((durationMs || 0) / 1000);

  const chip = status.spectrum ? 'Real spectrum' : 'Album-art theme';
  shell.barChip.textContent = status.spectrum ? 'spectrum' : status.backend === 'native' ? 'native audio' : 'theme';
  shell.barChip.className = `mode-chip ${status.spectrum ? 'live' : 'fallback'}`;
  shell.nowChip.textContent = chip;
  shell.nowChip.className = `mode-chip ${status.spectrum ? 'live' : 'fallback'}`;
  shell.nowReason.textContent = status.modeReason;
  shell.nowReason.className = `now-reason ${status.spectrum ? 'ok' : 'warn'}`;

  if (status.state === 'error' && status.error) {
    shell.nowReason.textContent = status.error;
    shell.nowReason.className = 'now-reason warn';
  }
}
