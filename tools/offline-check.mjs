#!/usr/bin/env node
/**
 * The offline check (v1.9.18): what the app shows with no connection, in a real browser.
 *
 * The owner's report is about a phone with no tailnet: a downloaded playlist's song list rendered
 * *"a full-screen error instead of the songs"* — `could not reach https://… (TypeError: Load
 * failed)`. No harness can put his phone in airplane mode, so this reproduces the one part that
 * matters exactly: **the API cannot be reached at all**, from a real page, with a real `fetch` that
 * really rejects, in Chrome at 393 x 852 (his iPhone 15 Pro) with the safe-area insets applied.
 *
 * What stands in for "a playlist that was downloaded" is the app's own offline mirror in
 * `localStorage` — the exact structure a real install has after a download, written by
 * `src/storage/offline.ts` and read back by `src/state/offline.ts`. The native downloads plugin is
 * not in the browser, so seeding the mirror is the only honest way to reproduce the state; the code
 * path from there on is the shipping one (no test hooks, no stubs inside the app).
 *
 * Two servers, because two different failures matter:
 *
 *   - a **refused** port (`ECONNREFUSED`, instant) — the phone in airplane mode, and what the owner
 *     saw: the failure arrives at once and the view has to have something to draw;
 *   - a **black hole** (accepts the connection, never answers) — the tailnet that is up but not
 *     serving. This is the one that proves the view does not *wait*: the app's own request timeout is
 *     20 s, so a view that blocked on the round trip would show no songs for 20 s. The check requires
 *     the songs on screen inside 3 s, with the request still in flight.
 *
 *   node tools/offline-check.mjs --app http://127.0.0.1:4633 [--json report.json]
 *
 * `--app` is any origin serving a built `dist/` (the mock in static mode does: `node
 * tools/mock-subsonic.mjs --port 4633 --dist dist`). Exit code is non-zero when anything that
 * should be shown offline is missing, or when the transport's own text is on the screen.
 *
 * **v1.9.20 adds the downloaded-content acceptance to the same run** (the design's §8.3), rather
 * than a second harness:
 *
 *   - one row per playlist, with the server **up** and with it **refused** — every name appears
 *     exactly once, and the playlist that is on both sides is marked on the server's own row;
 *   - the mark is per track too, and a **partially** downloaded playlist reads partial, never
 *     complete;
 *   - `#/downloads` ("On this phone") draws every downloaded track by title with no connection, and
 *     does not wait for a server that never answers;
 *   - the cover a downloaded row draws comes from the **device copy**, not the API, with the API
 *     refused — and it drives the shell's palette (a value other than `DEFAULT_PALETTE`'s), which is
 *     the difference between "the art themes the spectrum offline" and "it silently fell back".
 *
 * The `/offline-art/` route the mock serves is this harness's stand-in for a file in the app's own
 * container; the real one (`Capacitor.convertFileSrc` → Application Support) is only checkable on
 * the phone, and is stated as such in the design's §10.
 *
 * **v1.9.21 adds the race this release is about** (§5 of the run): every view that awaits the library
 * paints when the answer arrives, so an answer that lands after the owner has navigated away used to
 * write the old screen over the new one. The mock can now hold its API answers (`GET /__slow?ms=N`,
 * see `apiDelayMs` in `tools/mock-subsonic.mjs`), which is the one thing needed to drive it
 * deliberately rather than by luck: visit the view, leave it while the answer is still held, then
 * read the screen you moved to. Five cases — the album page, the artist page, Favourites, Search, and
 * the router's own failure fallback (an error that lands late) — each with a control that visits the
 * same route and stays, because a view that never paints cannot paint over another one.
 *
 * **…and it adds two readings to the same run** (v1.9.21): the Library's own entry row into the
 * downloaded music is still on the screen with the connection refused — the offline page used to
 * replace the whole view and take the row with it, against the design's §4.1 ("whether or not the
 * server answers") — and tapping that row opens `#/downloads`. The grown-playlist arithmetic is
 * asserted where it can be exact (in `test/offline-browse.test.ts`, against the row's own formatters)
 * rather than in a browser reading.
 *
 * **v1.9.23 adds the two readings the metadata repair was missing.** v1.9.22 filled the *store* and
 * nothing that draws from it, so the owner opened **On this phone** and read his own screenshot back —
 * blank titles, `--:--` — until he left the screen and returned. The first reading is that screen with
 * a store a 1.9.19 build wrote: the rows' own titles, sub-lines and lengths, taken on the route it
 * painted, once as it drew and once when the store had spoken, **with no navigation between them**;
 * a row nobody can name is read beside them, still drawing `--:--`. The second is the player bar,
 * whose title is the `Song` the queue holds and whose total is built from the same object: a row the
 * *server* names, the mock holding every answer (`/__slow`) so the tap lands while the row is still
 * blank, and then the list **left** — so the only thing that can name the bar is the queue's own copy
 * being filled. Both are driven with the app's real code path; no test hooks, no stubs.
 *
 * **…and the row's accessible name, read beside its text** (the follow-up finding on v1.9.23): the name
 * carries the title, and on a row only the *server* can name the two are written by the same store pass,
 * so a name painted before the title it carries left the row announced as `Play , downloaded` while its
 * title was on the screen. Read on the route it was drawn on, in one reading, with no navigation.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { withChromePage, navigate, evaluate } from './layout-audit.mjs';

const IN_PAGE = 'window.__naviliteLayoutAudit.';
const PLAYLIST_ID = 'pl-offline-1';
const PLAYLIST_NAME = 'Late night driving';
const TITLES = ['海底、月明かり', '夜に駆ける', 'A very long unbroken track title for the 393 px audit'];
/**
 * A playlist the store holds only **part** of (v1.9.20): three tracks asked for, one on disk. It is
 * what the badge's honesty rule is checked against in a real browser — a partial download must not
 * read as complete — and it exists nowhere on the server.
 */
const PARTIAL_ID = 'pl-partial-1';
const PARTIAL_NAME = 'Half downloaded';
/**
 * The Library's own entry row into the downloaded music (v1.9.20, §4.1) — the title the app prints
 * on it. v1.9.21 asserts it survives the *offline* page too, so the title is a constant here rather
 * than a string typed twice.
 */
const ENTRY_TITLE = 'On this phone';
/**
 * Every track the downloaded-songs view holds in this run: the mirror's three plus the one complete
 * file of the half-downloaded playlist. It is what `#/downloads` must still read *after* another
 * view's late answer has landed — the assertion the race block below is made of.
 */
const DOWNLOAD_TITLES = [...TITLES, 'Only this one is here'].sort((a, b) => a.localeCompare(b));

/**
 * The device-copy stand-in (v1.9.20). On the phone the audio and the cover sit side by side in
 * `Library/Application Support/navilite-offline/` and reach the page through
 * `Capacitor.convertFileSrc` — a URL on the **app's own origin**, not the API's. The browser has no
 * such container, so the mock serves `/offline-art/` and the rows below point at it: same-origin
 * with the page, exactly as the converted device path is, and reachable with the API refused.
 */
const ART_DIR = '/offline-art/';
const COVER_ID = 'cover-album-1-1';
const SERVER_COVER_ID = 'cover-album-1-2';
/** The default palette's primary, so "the art actually themed the shell" is a comparison, not a claim. */
const DEFAULT_PRIMARY = '#7cd2ff';

/** How long the mock holds every API answer during the race block (v1.9.21). */
const RACE_DELAY_MS = 1800;
/** How long after leaving a screen the answer is still held — i.e. it has demonstrably not landed. */
const RACE_AWAY_MS = 250;
/** How long past the hold the block waits before reading, so the answer has certainly landed. */
const RACE_SETTLE_MS = 700;
/** The mock's own defaults, as `seed()` already assumes when it writes the app's settings. */
const API_USER = 'navidrome';
const API_PASSWORD = 'navidrome';

/** How long the mock holds every API answer during the bar case (v1.9.23). */
const LEGACY_HOLD_MS = 2000;
/** The manifest's own length in the legacy store below, in seconds — `formatDuration` reads it as `3:34`. */
const LEGACY_DURATION_SEC = 214;
/** …and the same length as the row prints it (`formatDuration(214)`). */
const LEGACY_TIME = '3:34';

/** The rows, with the real shape the mirror writes (`file://` path + measured bytes + metadata). */
function mirrorJson(appUrl, online) {
  const copy = JSON.parse(JSON.stringify(MIRROR));
  for (const [index, songId] of Object.keys(copy.rows).entries()) {
    copy.rows[songId] = rowFor(appUrl, { id: songId, title: TITLES[index], coverId: COVER_ID, index });
  }
  copy.playlists[PARTIAL_ID] = {
    name: PARTIAL_NAME,
    requestedAt: Date.now() - 20_000,
    state: 'partial',
    songs: [
      { id: 'partial-0', title: 'Only this one is here', artist: 'ヨルシカ', album: '盗作', duration: 200, suffix: 'opus', size: 8000000 },
      { id: 'partial-1', title: 'Not on this phone', artist: 'ヨルシカ', album: '盗作', duration: 210, suffix: 'opus', size: 8000000 },
      { id: 'partial-2', title: 'Nor this one', artist: 'ヨルシカ', album: '盗作', duration: 220, suffix: 'opus', size: 8000000 },
    ],
  };
  copy.rows['partial-0'] = rowFor(appUrl, { id: 'partial-0', title: 'Only this one is here', coverId: COVER_ID, index: 3 });
  /*
   * The playlist the **server also has** (v1.9.20, item 1's acceptance): with the server answering,
   * its name must appear on exactly one row — the server's — and that row must carry the download
   * mark. This is the state the owner's screenshot was taken in, where the name appeared twice.
   *
   * The manifest is the server's own track list (`songIds` from the mock's state), because the
   * badge's honesty rule compares the two: a manifest shorter than the playlist it is drawn beside
   * reads `partial`, which is the correct answer and would make this control vacuous.
   */
  if (online?.id) {
    const ids = online.songIds?.length ? online.songIds : ['server-song-0'];
    copy.playlists[online.id] = {
      name: 'seeded copy of the server’s playlist',
      requestedAt: Date.now() - 5_000,
      state: 'complete',
      songs: ids.map((id, index) => ({
        id,
        title: `Server track ${index + 1}`,
        artist: 'Alien Lab',
        album: 'Transmission',
        duration: 180,
        suffix: 'wav',
        size: 9000000,
        coverArt: SERVER_COVER_ID,
        albumId: 'album-1-2',
      })),
    };
    for (const [index, id] of ids.entries()) {
      copy.rows[id] = rowFor(appUrl, { id, title: `Server track ${index + 1}`, coverId: SERVER_COVER_ID, index: 4 + index });
    }
  }
  return JSON.stringify(copy);
}

/** One mirror row as a real download leaves it: the file URL, the measured bytes, the art beside it. */
function rowFor(appUrl, { id, title, coverId, index }) {
  return {
    // Beside the cover, in the same directory — which is how `artPathFor` derives the art URL.
    path: `${appUrl}${ART_DIR}${id}.opus`,
    bytes: 8123456,
    state: 'complete',
    title,
    artist: 'ヨルシカ',
    album: '盗作',
    coverArt: coverId,
    durationSec: 214,
    lyrics: { state: 'none', bytes: 0, fetchedAt: Date.now() - 1000 - index },
    art: { state: 'present', file: `${coverId}.art`, bytes: 41230, fetchedAt: Date.now() - 1000 - index },
  };
}

/** The saved playlist as a real download leaves it: a manifest, and one row per complete file. */
const MIRROR = {
  v: 1,
  hydratedAt: Date.now(),
  rows: Object.fromEntries(TITLES.map((title, index) => [`song-${index}`, `__PLACEHOLDER__${index}`])),
  playlists: {
    [PLAYLIST_ID]: {
      name: PLAYLIST_NAME,
      requestedAt: Date.now(),
      state: 'complete',
      songs: TITLES.map((title, index) => ({
        id: `song-${index}`,
        title,
        artist: 'ヨルシカ',
        album: '盗作',
        duration: 214,
        suffix: 'opus',
        size: 8123456,
        // As the server sends a song, and as the manifest therefore holds it: the cover id travels
        // with the song, which is what the store annotates a row with.
        coverArt: COVER_ID,
        albumId: 'album-1-1',
      })),
    },
  },
};

/**
 * The mirror a **1.9.19 build** left behind (v1.9.23): `path`, `bytes` and `state` on every row and no
 * metadata key anywhere (`src/storage/offline.ts`'s fields arrived in v1.9.20, and `parseMirror` reads
 * a row without them), beside the manifest the download wrote — which is where the names and the
 * lengths live, on the phone, with no connection needed.
 *
 * `orphan-1` is the residue case: complete on disk, named by no manifest, and the API is refused in
 * this block, so nothing can name it. It is what the honesty rule is read against — a row that is
 * still metadata-less must draw what it drew (an empty title, `--:--`) and never its own id or a 0.
 */
function legacyMirrorJson(appUrl) {
  const rows = {};
  for (const [index, _title] of TITLES.entries()) {
    rows[`song-${index}`] = {
      path: `${appUrl}${ART_DIR}song-${index}.opus`,
      bytes: 8123456,
      state: 'complete',
      lyrics: { state: 'none', bytes: 0, fetchedAt: Date.now() - index },
      art: { state: 'present', file: `${COVER_ID}.art`, bytes: 41230, fetchedAt: Date.now() - index },
    };
  }
  rows['orphan-1'] = { path: `${appUrl}${ART_DIR}orphan-1.opus`, bytes: 123456, state: 'complete' };
  return JSON.stringify({
    v: 1,
    hydratedAt: Date.now(),
    rows,
    playlists: {
      [PLAYLIST_ID]: {
        name: PLAYLIST_NAME,
        requestedAt: Date.now(),
        state: 'complete',
        songs: TITLES.map((title, index) => ({
          id: `song-${index}`,
          title,
          artist: 'ヨルシカ',
          album: '盗作',
          duration: LEGACY_DURATION_SEC,
          suffix: 'opus',
          size: 8123456,
          coverArt: COVER_ID,
          albumId: 'album-1-1',
        })),
      },
    },
  });
}

/**
 * One complete, **unnamed** row for a song the *server* knows, and no manifest at all (v1.9.23).
 *
 * This is the case where only the server's pass of the repair can name the row, which is what makes
 * the player-bar reading below a reading about the queue: the row fills over a round trip, so the tap
 * can land while it is still blank, and the answer arrives after the list has been left.
 */
function serverNamedMirrorJson(appUrl, songId) {
  return JSON.stringify({
    v: 1,
    hydratedAt: Date.now(),
    rows: { [songId]: { path: `${appUrl}${ART_DIR}${songId}.opus`, bytes: 4096, state: 'complete' } },
  });
}

/** Seconds as the app's own `formatTime` writes them (`src/ui/dom.ts`): `m:ss` below the hour. */
function mmss(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** What the page is actually showing, read the way a person reads it. */
const READING = `(() => {
  const rows = [...document.querySelectorAll('.row.song .row-title')].map((node) => node.textContent);
  const pill = document.querySelector('.offline-pill');
  const text = document.body.textContent || '';
  const measure = window.${IN_PAGE.replace('window.', '')}measure();
  const badgeOf = (row) => {
    const mark = row.querySelector('.row-dl');
    if (!mark || mark.classList.contains('hidden')) return 'none';
    return mark.classList.contains('partial') ? 'partial' : 'complete';
  };
  return {
    route: location.hash,
    title: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').textContent : null,
    subtitle: document.querySelector('.page-head .muted') ? document.querySelector('.page-head .muted').textContent : null,
    rows,
    downloadedRows: [...document.querySelectorAll('.list .row:not(.song) .row-title')].map((node) => node.textContent),
    playlistRows: [...document.querySelectorAll('.list .row:not(.song)')].map((row) => ({
      title: row.querySelector('.row-title') ? row.querySelector('.row-title').textContent : null,
      sub: row.querySelector('.row-sub') ? row.querySelector('.row-sub').textContent : null,
      mark: badgeOf(row),
      label: row.getAttribute('aria-label'),
    })),
    songMarks: [...document.querySelectorAll('.row.song')].map((row) => ({
      title: row.querySelector('.row-title') ? row.querySelector('.row-title').textContent : null,
      // v1.9.23 — the row's other two pieces of text, which the metadata repair has to reach.
      sub: row.querySelector('.row-sub') ? row.querySelector('.row-sub').textContent : null,
      time: row.querySelector('.row-time') ? row.querySelector('.row-time').textContent : null,
      mark: badgeOf(row),
      label: row.getAttribute('aria-label'),
    })),
    /*
     * The player bar (v1.9.23): the title it prints is the Song the queue holds, and its total is
     * "status.durationMs || (song.duration ?? 0) * 1000" — so a queue holding a blank song is a blank
     * title with 0:00 beside it, which is the other half of the owner's screenshot. Read as the
     * screen reads: the last .time in the progress row is the total, the first is the position.
     */
    bar: (() => {
      const footer = document.querySelector('.playerbar');
      const times = footer ? [...footer.querySelectorAll('.pb-progress .time')] : [];
      return {
        hidden: footer ? footer.classList.contains('hidden') : true,
        title: footer && footer.querySelector('.pb-title') ? footer.querySelector('.pb-title').textContent : null,
        sub: footer && footer.querySelector('.pb-sub') ? footer.querySelector('.pb-sub').textContent : null,
        position: times.length > 0 ? times[0].textContent : null,
        total: times.length > 1 ? times[times.length - 1].textContent : null,
      };
    })(),
    artSrcs: [...document.querySelectorAll('img.thumb, img.now-art, img.pb-art, img.detail-cover, img.card-cover')]
      .map((node) => node.getAttribute('src')),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim(),
    pill: pill ? { visible: !pill.classList.contains('hidden'), text: pill.textContent } : null,
    emptyBox: document.querySelector('.view .empty') ? document.querySelector('.view .empty').textContent : null,
    leaked: ['could not reach', 'Load failed', 'Over Tailscale'].filter((needle) => text.includes(needle)),
    overflow: measure.horizontalOverflow,
    scrollSurface: measure.scrollSurface,
  };
})()`;

/**
 * The screen, as the race block reads it (v1.9.21): what is on it *now*, and which of an old view's
 * parts are on it. `detail` is the album page's header, `cards` are its/its artists' album art,
 * `sections` are Favourites' and Search's headings, `emptyBox` is the router's error fallback — so one
 * reading distinguishes all five cases' stale paints from the destination they must not replace.
 */
const RACE_READING = `(() => ({
  route: location.hash,
  h1: document.querySelector('.view h1') ? document.querySelector('.view h1').textContent : null,
  subtitle: document.querySelector('.view .muted') ? document.querySelector('.view .muted').textContent : null,
  sections: [...document.querySelectorAll('.view h2.section')].map((node) => node.textContent),
  songs: [...document.querySelectorAll('.view .row.song .row-title')].map((node) => node.textContent),
  cards: document.querySelectorAll('.view .card').length,
  detail: document.querySelector('.view .detail') !== null,
  emptyBox: document.querySelector('.view .empty') ? document.querySelector('.view .empty').textContent : null,
  text: (document.querySelector('.view') ? document.querySelector('.view').textContent : '').slice(0, 240),
  leaked: ['could not reach', 'Load failed', 'Over Tailscale'].filter((needle) => (document.body.textContent || '').includes(needle)),
}))()`;

/**
 * Poll a page expression, so a route's own render has time to land without a blind sleep.
 *
 * The timeout carries **what the page was showing** rather than only the label it was waiting for: a
 * wait that expires is almost always a view that threw or drew something else, and the sentence it
 * died with is the difference between a five-minute diagnosis and a re-run with a debugger.
 */
async function waitFor(cdp, expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return;
    if (Date.now() > deadline) {
      const where = await evaluate(
        cdp,
        `(() => ({
          route: location.hash,
          h1: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').textContent : null,
          view: (document.querySelector('.view') ? document.querySelector('.view').textContent : '').slice(0, 400),
        }))()`,
      );
      throw new Error(
        `timed out waiting for ${label} — the page is on ${where.route}, h1 ${JSON.stringify(where.h1)}, showing: ${where.view}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A cold start at a route.
 *
 * A hash-only change is a *same-document* navigation: the browser fires no load event, and the app
 * boots nothing — it reroutes in place, which is not what a phone does when the app is opened. The
 * counter in the query makes each of these a real navigation, so every route below is measured from
 * a real boot (exactly the state the owner's report is about: cold, and with nothing in memory).
 */
let bootCounter = 0;
async function coldRoute(cdp, app, route) {
  bootCounter += 1;
  await navigate(cdp, `${app}/?boot=${bootCounter}#${route}`);
}

/**
 * The settings, the password and the offline mirror, written in one page (`seed` below is this, with
 * the ordinary mirror). v1.9.23 split it out because two blocks seed a mirror the app never writes:
 * one a 1.9.19 build left behind, and one a single unnamed row for a song the server knows.
 *
 * `mirror` is the mirror **as JSON text**, the way `storage/offline.ts` writes it and the way
 * `mirrorJson` above returns it (`JSON.stringify` of a string is what makes it a string *in the page*:
 * a bare object literal would reach `setItem` as `[object Object]`, and the store would read no rows
 * at all — measured, this harness, v1.9.23).
 */
const seedScript = (apiUrl, mirror) => `(() => {
  localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(apiUrl)}, username: 'navidrome', playback: 'web' }));
  localStorage.setItem('navilite.subsonic-password', 'navidrome');
  localStorage.setItem('navilite.offline', ${JSON.stringify(mirror)});
  // Read back what was written: a block that seeds a mirror the app never writes has to be able to
  // say whether the page it is standing on actually holds it (v1.9.23).
  const raw = localStorage.getItem('navilite.offline');
  return { bytes: raw ? raw.length : -1, rows: raw ? Object.keys(JSON.parse(raw).rows || {}).length : -1 };
})()`;

const seed = (appUrl, apiUrl, online) => seedScript(apiUrl, mirrorJson(appUrl, online));

/** A port nothing is listening on: the phone with no tailnet. */
async function refusedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A port that accepts and never answers: the tailnet that is up but serving nothing. */
async function blackHole() {
  const sockets = new Set();
  const server = createServer(() => {
    // Deliberately no response — not even headers.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/* --------------------------------------- the library, read by the harness itself (v1.9.21) */

/**
 * The harness's own small Subsonic client.
 *
 * The race block needs three facts it refuses to invent: the id and the name of the album and the
 * artist it is about to visit. They are read out of the library through its **real API** (token auth
 * and all), for the same reason `--online-playlist` reads a playlist's own name from `/__state`: a
 * fixture that stops matching the app's library then fails the check instead of quietly testing a
 * screen nobody can reach.
 */
function apiUrl(app, method, params = {}) {
  const salt = randomBytes(6).toString('hex');
  const token = createHash('md5').update(`${API_PASSWORD}${salt}`).digest('hex');
  const query = new URLSearchParams({
    ...params,
    u: API_USER,
    s: salt,
    t: token,
    v: '1.16.1',
    c: 'navilite-offline-check',
    f: 'json',
  });
  return `${app}/rest/${method}.view?${query}`;
}

/** One API call, unwrapped and status-checked. */
async function api(app, method, params = {}) {
  const answer = await (await mockFetch(apiUrl(app, method, params))).json();
  const payload = answer?.['subsonic-response'];
  if (payload?.status !== 'ok') throw new Error(`${method} answered ${JSON.stringify(answer).slice(0, 200)}`);
  return payload;
}

/** An album and an artist to visit, with the names the pages will have to show. */
async function readCatalogue(app) {
  const albums = (await api(app, 'getAlbumList2', { type: 'alphabeticalByName', size: '1' })).albumList2?.album ?? [];
  const artists = ((await api(app, 'getArtists')).artists?.index ?? []).flatMap((entry) => entry.artist ?? []);
  if (!albums[0] || !artists[0]) throw new Error('the library answered with no album or no artist to visit');
  return { album: albums[0], artist: artists[0] };
}

/**
 * The first track of the first album, as the library itself reports it (v1.9.23).
 *
 * Read out of the library rather than hard-coded, for the reason `--online-playlist` reads a name from
 * `/__state`: the bar reading below compares the name and the total on the bar against the library's
 * own answer, and a fixture that stops matching it must fail the check rather than quietly assert
 * nothing.
 */
async function readFirstSong(app) {
  const albums = (await api(app, 'getAlbumList2', { type: 'alphabeticalByName', size: '1' })).albumList2?.album ?? [];
  if (!albums[0]) throw new Error('the library answered with no album');
  const album = await api(app, 'getAlbum', { id: albums[0].id });
  const song = (album.album?.song ?? [])[0];
  if (!song) throw new Error(`the library’s album ${albums[0].id} answered with no songs`);
  return { id: song.id, title: song.title, duration: song.duration };
}

/** The mock's own state, when this origin has one (`null` for a static-only origin). */
async function mockState(app) {
  try {
    const state = await (await mockFetch(`${app}/__state`)).json();
    return Array.isArray(state?.requests) ? state : null;
  } catch {
    return null;
  }
}

/**
 * Ask the mock to hold every API answer for `ms` (0 clears it) and read back what it holds.
 *
 * The read-back is the point of the function. `null` means there is no `/__slow` at this origin, and
 * a race check driven against a library that answers instantly passes on nothing at all — so the
 * caller turns that into a failure rather than a quiet pass.
 */
async function holdAnswers(app, ms) {
  try {
    const answer = await (await mockFetch(`${app}/__slow?ms=${ms}`)).json();
    return typeof answer?.slowMs === 'number' ? answer.slowMs : null;
  } catch {
    return null;
  }
}

/**
 * Every call this harness makes to the mock, bounded (v1.9.21).
 *
 * The loopback mock answers in a couple of milliseconds; what `fetch` does without a signal is
 * unbounded — a stalled connection holds the whole run open with **nothing printed at all** (the
 * output is buffered until the end), which is the least diagnosable failure this harness can have.
 * A bounded call turns that into a named error the same run.
 */
async function mockFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
}

async function main() {
  const argv = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token?.startsWith('--')) continue;
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      argv.set(token.replace(/^--/, ''), next);
      i += 1;
    } else {
      argv.set(token.replace(/^--/, ''), 'true');
    }
  }
  const app = argv.get('app') ?? 'http://127.0.0.1:4633';
  const jsonPath = argv.get('json');
  /** When the app origin *also* serves the API (the mock does), this runs the online control. */
  const onlinePlaylist = argv.get('online-playlist');

  const lines = [];
  const failures = [];
  const readings = { app, playlist: PLAYLIST_ID, checks: {}, states: {} };
  const say = (text) => lines.push(text);
  const check = (label, ok, detail) => {
    readings.checks[label] = { ok, detail };
    if (!ok) failures.push(`${label} — ${detail}`);
    say(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
    if (detail) say(`      ${detail}`);
    return ok;
  };

  const hole = await blackHole();
  const dead = await refusedPort();
  const deadUrl = `http://127.0.0.1:${dead}`;
  /*
   * The server's own name for the playlist the store also holds — read from the mock's state rather
   * than invented here, so "the name appears exactly once" is asserted against the real name.
   */
  let onlineInfo = null;
  if (onlinePlaylist) {
    try {
      const answer = await mockFetch(`${app}/__state`);
      const state = await answer.json();
      const entry = state.playlists?.find((item) => item.id === onlinePlaylist);
      onlineInfo = { id: onlinePlaylist, name: entry?.name ?? null, songIds: entry?.songIds ?? [] };
    } catch {
      // Not fatal: the control below reports which name it looked for.
      onlineInfo = { id: onlinePlaylist, name: null, songIds: [] };
    }
  }
  const onlineName = onlineInfo?.name ?? null;

  try {
    /*
     * The mock's own state, cleared before the run.
     *
     * This harness now **taps a row** (the palette check), and a tap makes the app save its queue to
     * the server — which the next boot restores, opening the now screen on a run that expects a list.
     * `/__reset` is the mock's documented way to clear that, and it is what keeps a run independent
     * of the one before it; an origin that does not serve the mock simply answers nothing and the
     * line is a no-op.
     */
    await mockFetch(`${app}/__reset`);
  } catch {
    // A static-only origin: there is no mock state to clear.
  }

  try {
    await withChromePage(
      async ({ cdp, safeArea }) => {
        /* ------------------------------------ 0. the online control, when there is an API */
        if (onlinePlaylist) {
          await navigate(cdp, app);
          await evaluate(cdp, seed(app, app, onlineInfo));
          await coldRoute(cdp, app, `/playlist/${onlinePlaylist}`);
          /*
           * Wait for the **server's** answer, not merely for rows: with a manifest in hand the local
           * list is painted first (that is the 1.9.18 local-first order), so "there are song rows"
           * is true a moment before the server's own list, name and length replace it — and a
           * reading taken in that window would compare the manifest's name with the server's.
           */
          await waitFor(
            cdp,
            `document.querySelectorAll('.row.song').length > 0 && document.querySelector('.page-head h1')?.textContent !== 'seeded copy of the server’s playlist'`,
            'the online playlist to draw',
          );
          const online = await evaluate(cdp, READING);
          readings.states.playlistOnline = online;
          say(`Online control — ${app} (the same origin serves the API), playlist ${onlinePlaylist}:`);
          say(`  h1 “${online.title}”, ${online.rows.length} song row(s), badge ${online.pill?.visible ?? false}`);
          check(
            'with the server up the same route draws the server’s list, unbadged (the local path did not replace it)',
            online.rows.length > 0 && online.pill?.visible === false && online.title !== 'Downloaded playlist',
            `${online.rows.length} rows · h1 “${online.title}” · badge ${online.pill?.visible ?? false}`,
          );

          /*
           * **Item 1's acceptance, with the server answering** (v1.9.20).
           *
           * The store used to paint its own row for every downloaded playlist *beside* the server's
           * list, so one playlist appeared twice under a single heading — the owner's screenshot. The
           * check is exact: every name once, and the row the server drew for the playlist that is also
           * on this phone carries the download mark.
           */
          await evaluate(cdp, `location.hash = '#/playlists'`);
          await waitFor(
            cdp,
            `document.querySelector('.page-head h1')?.textContent === 'Playlists' && document.querySelectorAll('.list .row').length > 0`,
            'the playlists screen to draw',
          );
          await new Promise((resolve) => setTimeout(resolve, 400));
          const onlinePlaylists = await evaluate(cdp, READING);
          readings.states.playlistsOnline = onlinePlaylists;
          const onlineTitles = onlinePlaylists.playlistRows.map((row) => row.title);
          const repeated = [...new Set(onlineTitles.filter((title, index) => onlineTitles.indexOf(title) !== index))];
          const marked = onlinePlaylists.playlistRows.filter((row) => row.mark !== 'none');
          say(`The playlists screen with the server up drew ${onlineTitles.length} row(s):`);
          for (const row of onlinePlaylists.playlistRows) say(`    · [${row.mark}] ${row.title}  —  ${row.sub}`);
          check(
            'no playlist name appears twice on the playlists screen with the server up (item 1)',
            repeated.length === 0,
            repeated.length === 0 ? `${onlineTitles.length} rows, every name once` : `repeated: ${JSON.stringify(repeated)}`,
          );
          check(
            'the downloaded playlist is marked on the one row the server draws for it',
            marked.length === 1 &&
              marked[0].mark === 'complete' &&
              (onlineName === null || marked[0].title === onlineName) &&
              /on this phone/.test(String(marked[0].sub)),
            `${marked.length} marked row(s) of ${onlineTitles.length}; expected “${onlineName}” marked complete — got ${JSON.stringify(
              marked.map((row) => [row.title, row.mark, row.sub]),
            )}`,
          );
          say('');
        }

        /* ------------------------- 1. the playlist, no connection, refused at once */
        await navigate(cdp, app);
        await evaluate(cdp, seed(app, deadUrl));
        const started = Date.now();
        await coldRoute(cdp, app, `/playlist/${PLAYLIST_ID}`);
        await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0 || Boolean(document.querySelector('.view .empty'))`, 'the playlist route to draw');
        const shown = await evaluate(cdp, READING);
        readings.states.playlistOffline = { ...shown, ms: Date.now() - started };
        say(`Offline check — ${app}, API at ${deadUrl} (nothing listening)`);
        say(`  device: 393 x 852 CSS px, dpr 3, mobile emulation; safe-area emulation: ${safeArea ?? 'NOT applied'}`);
        say(`  the saved playlist is “${PLAYLIST_NAME}” (${TITLES.length} tracks), from the app's own offline mirror`);
        say('');
        say(`The playlist route drew ${shown.rows.length} song row(s) in ${readings.states.playlistOffline.ms} ms with no server:`);
        for (const row of shown.rows) say(`    · ${row}`);
        say('');

        check(
          'a downloaded playlist’s song list is drawn from the local manifest with no connection',
          JSON.stringify(shown.rows) === JSON.stringify(TITLES),
          `${shown.rows.length} of ${TITLES.length} rows, in order: ${JSON.stringify(shown.rows)}`,
        );
        check(
          'the header names the playlist the store has, not a placeholder',
          shown.title === PLAYLIST_NAME,
          `h1 “${shown.title}”`,
        );
        check(
          'the transport’s own message is nowhere on the screen',
          shown.leaked.length === 0,
          shown.leaked.length === 0 ? 'no “could not reach” / “Load failed” / “Over Tailscale” in the document' : `found: ${shown.leaked.join(', ')}`,
        );
        check(
          'no full-screen error box stands in for the view',
          shown.emptyBox === null,
          `the empty/error box reads: ${JSON.stringify(shown.emptyBox)}`,
        );
        check(
          'the header carries the offline badge once the request has failed',
          shown.pill?.visible === true,
          `the badge is ${shown.pill ? (shown.pill.visible ? 'visible' : 'hidden') : 'absent'} (${shown.pill?.text ?? '-'})`,
        );
        check(
          'and the 393 px layout is still clean on that screen',
          shown.overflow === 0,
          `${shown.overflow} px of overflow on ${shown.scrollSurface}`,
        );
        /*
         * **Item 2, per track** (v1.9.20): every track on this page is a complete file on disk, so
         * every row must carry the mark — read from the store's own `pathFor` predicate, which is the
         * same one that decided these rows were playable in the first place.
         */
        check(
          'every downloaded track carries its mark with the server refused (item 2)',
          shown.songMarks.length === TITLES.length &&
            shown.songMarks.every((row) => row.mark === 'complete' && /, downloaded$/.test(String(row.label))),
          `${shown.songMarks.filter((row) => row.mark === 'complete').length} of ${shown.songMarks.length} marked — ${JSON.stringify(
            shown.songMarks.map((row) => [row.title, row.mark]),
          )}`,
        );
        say('');

        /* --------------------------------- 2. a route that only the server can fill */
        await evaluate(cdp, `location.hash = '#/playlists'`);
        await waitFor(cdp, `document.querySelector('.page-head h1')?.textContent === 'Playlists'`, 'the playlists route to draw');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const browse = await evaluate(cdp, READING);
        readings.states.playlistsOffline = browse;
        say(`The playlists screen with no server: “${browse.subtitle}”, ${browse.downloadedRows.length} downloaded row(s): ${JSON.stringify(browse.downloadedRows)}`);
        for (const row of browse.playlistRows) say(`    · [${row.mark}] ${row.title}  —  ${row.sub}`);
        check(
          'the playlists screen still lists the downloaded playlist, by name',
          browse.downloadedRows.includes(PLAYLIST_NAME),
          `rows: ${JSON.stringify(browse.downloadedRows)}`,
        );
        check(
          'it badges the screen rather than printing the failure',
          browse.pill?.visible === true && browse.leaked.length === 0 && browse.emptyBox === null,
          `badge ${browse.pill?.visible ?? false} · leaked ${JSON.stringify(browse.leaked)} · error box ${JSON.stringify(browse.emptyBox)}`,
        );
        /*
         * **Item 1's acceptance with the server refused, and item 2's honesty rule** (v1.9.20).
         *
         * Offline there is no server row to annotate, so the store *is* the list — and it must still
         * print each playlist once, mark the complete one complete, and mark the playlist it holds
         * only part of as **partial** ("the downloaded indicator must be honest for a partial").
         */
        {
          const offlineTitles = browse.playlistRows.map((row) => row.title);
          const repeatedOffline = [...new Set(offlineTitles.filter((title, index) => offlineTitles.indexOf(title) !== index))];
          const complete = browse.playlistRows.find((row) => row.title === PLAYLIST_NAME);
          const partial = browse.playlistRows.find((row) => row.title === PARTIAL_NAME);
          check(
            'no playlist name appears twice on the playlists screen with the server refused (item 1)',
            repeatedOffline.length === 0 && offlineTitles.length === 2,
            `${offlineTitles.length} row(s): ${JSON.stringify(offlineTitles)}${repeatedOffline.length ? ` — repeated: ${JSON.stringify(repeatedOffline)}` : ''}`,
          );
          check(
            'a fully downloaded playlist reads as downloaded on its own row',
            complete?.mark === 'complete' && /on this phone/.test(String(complete?.sub)),
            `“${PLAYLIST_NAME}” → mark ${complete?.mark}, sub “${complete?.sub}”`,
          );
          check(
            'a partially downloaded playlist does not read as complete',
            partial?.mark === 'partial' && /1 of 3 on this phone/.test(String(partial?.sub)),
            `“${PARTIAL_NAME}” → mark ${partial?.mark}, sub “${partial?.sub}”`,
          );
          check(
            'the covers on those rows are served from the device copy, with the API refused',
            browse.artSrcs.length > 0 &&
              browse.artSrcs.every((src) => String(src).includes(ART_DIR)) &&
              !browse.artSrcs.some((src) => String(src).includes(deadUrl)),
            `art URLs: ${JSON.stringify(browse.artSrcs)}`,
          );
        }

        await evaluate(cdp, `location.hash = '#/artists'`);
        await waitFor(cdp, `document.querySelector('.page-head h1')?.textContent === 'Library'`, 'the library route to draw');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const library = await evaluate(cdp, READING);
        readings.states.libraryOffline = library;
        say(`The library screen with no server: h1 “${library.title}” — “${library.subtitle}”, ${library.downloadedRows.length} downloaded row(s)`);
        check(
          'the library screen degrades to the downloads it can browse, not to an error',
          library.pill?.visible === true &&
            library.downloadedRows.includes(PLAYLIST_NAME) &&
            library.leaked.length === 0 &&
            library.emptyBox === null,
          `badge ${library.pill?.visible ?? false} · downloaded ${JSON.stringify(library.downloadedRows)} · leaked ${JSON.stringify(library.leaked)}`,
        );

        /*
         * **…and its own way into the downloaded music survives that page** (v1.9.21, §4.1's "whether
         * or not the server answers").
         *
         * `renderArtists` draws the entry row synchronously, before it awaits anything — and the
         * router's `fail` then handed the whole screen to `renderOffline`, which replaced
         * `shell.view` and took the row with it. Offline, the only other way in was Settings →
         * `Downloaded music: … →`; the music itself was always reachable from the playlist rows
         * below, so this is discoverability, missing in exactly the case the view exists for.
         *
         * Read as the page reads: the row's own sub-line, its accessible name, and the list it is in
         * (the same one the downloaded playlists are in — no second rows list).
         */
        const entryRow = await evaluate(
          cdp,
          `(() => {
            const row = [...document.querySelectorAll('.view .row')].find(
              (node) => node.querySelector('.row-title')?.textContent === ${JSON.stringify(ENTRY_TITLE)},
            );
            if (!row) return null;
            const list = row.closest('.list');
            return {
              sub: row.querySelector('.row-sub')?.textContent ?? null,
              label: row.getAttribute('aria-label'),
              listRows: [...(list ? list.querySelectorAll('.row:not(.song)') : [])].map(
                (node) => node.querySelector('.row-title')?.textContent ?? null,
              ),
            };
          })()`,
        );
        readings.states.libraryEntryRowOffline = entryRow;
        say(`  its entry row: ${entryRow ? `“${ENTRY_TITLE}” — “${entryRow.sub}” (${entryRow.label})` : 'NOT DRAWN'}`);
        check(
          'the Library’s “On this phone” entry row is on the offline page too, in the same list as the downloads (v1.9.21, §4.1)',
          entryRow !== null &&
            /^\d+ track/.test(String(entryRow.sub)) &&
            entryRow.label === `Open ${ENTRY_TITLE}` &&
            entryRow.listRows.includes(ENTRY_TITLE) &&
            entryRow.listRows.includes(PLAYLIST_NAME),
          entryRow === null
            ? 'the offline page carries no entry row at all'
            : `sub “${entryRow.sub}” · label “${entryRow.label}” · the list it is in: ${JSON.stringify(entryRow.listRows)}`,
        );

        const tapped = await evaluate(
          cdp,
          `(() => {
            const row = [...document.querySelectorAll('.view .row')].find(
              (node) => node.querySelector('.row-title')?.textContent === ${JSON.stringify(ENTRY_TITLE)},
            );
            if (!row) return false;
            row.click();
            return true;
          })()`,
        );
        /*
         * Bounded, and *answered* rather than thrown: when the row is not there (which is the defect
         * this check is for) there is nothing to tap and nothing to wait for, and a thrown wait would
         * take the rest of the run down with it instead of reporting one failure.
         */
        const opened = await (async () => {
          if (!tapped) return false;
          const deadline = Date.now() + 5000;
          for (;;) {
            if (await evaluate(cdp, `location.hash === '#/downloads'`)) return true;
            if (Date.now() > deadline) return false;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const throughEntry = await evaluate(cdp, READING);
        readings.states.libraryEntryRowTap = throughEntry;
        check(
          'and that row taps through to the downloaded music (#/downloads) with no connection',
          tapped === true &&
            opened === true &&
            throughEntry.route === '#/downloads' &&
            throughEntry.title === ENTRY_TITLE &&
            JSON.stringify([...throughEntry.rows].sort((a, b) => a.localeCompare(b))) === JSON.stringify(DOWNLOAD_TITLES),
          `${tapped ? (opened ? 'tapped' : 'tapped but the address did not move') : 'no row to tap'} → address ${throughEntry.route}, h1 “${throughEntry.title}”, ${throughEntry.rows.length} row(s)`,
        );

        await evaluate(cdp, `location.hash = '#/playlist/pl-not-downloaded'`);
        await new Promise((resolve) => setTimeout(resolve, 800));
        const missing = await evaluate(cdp, READING);
        readings.states.playlistNotDownloaded = missing;
        say(`A playlist that is not downloaded: h1 “${missing.title}” — “${missing.subtitle}”`);
        check(
          'a playlist that is not downloaded degrades too, and still prints no failure text',
          missing.rows.length === 0 &&
            missing.pill?.visible === true &&
            missing.leaked.length === 0 &&
            missing.emptyBox === null &&
            /not downloaded/.test(String(missing.subtitle)),
          `${missing.rows.length} rows · badge ${missing.pill?.visible ?? false} · subtitle “${missing.subtitle}” · leaked ${JSON.stringify(missing.leaked)}`,
        );

        /*
         * Search: the one view that cannot degrade to downloads — it needs the library. What it must
         * not do is print the transport's text into its result pane, which is what a failure of the
         * search call used to put on the screen.
         */
        await evaluate(cdp, `location.hash = '#/search'`);
        await waitFor(cdp, `Boolean(document.querySelector('.page-head input'))`, 'the search screen');
        await evaluate(
          cdp,
          `(() => {
            const input = document.querySelector('.page-head input');
            input.value = 'yorushika';
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
            return true;
          })()`,
        );
        await waitFor(cdp, `Boolean(document.querySelector('.list .offline-pill:not(.hidden)'))`, 'the search result pane to degrade', 5000);
        const search = await evaluate(cdp, READING);
        readings.states.searchOffline = search;
        say(`Search with no server: “${search.subtitle}”, result pane badged ${search.pill?.visible ?? false}`);
        check(
          'search degrades to the badge too, and never to the failure text',
          search.pill?.visible === true && search.leaked.length === 0 && search.emptyBox === null,
          `badge ${search.pill?.visible ?? false} · leaked ${JSON.stringify(search.leaked)} · error box ${JSON.stringify(search.emptyBox)}`,
        );
        say('');

        /* --------------------------- 2b. "On this phone", with no server (item 3 + item 4) */
        await evaluate(cdp, `location.hash = '#/downloads'`);
        await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the downloaded tracks to be drawn');
        const downloads = await evaluate(cdp, READING);
        readings.states.downloadsOffline = downloads;
        say(`“On this phone” with no server: h1 “${downloads.title}”, “${downloads.subtitle}”, ${downloads.rows.length} row(s):`);
        for (const row of downloads.songMarks) say(`    · [${row.mark}] ${row.title}`);
        {
          const expected = DOWNLOAD_TITLES;
          const drawn = [...downloads.rows].sort((a, b) => a.localeCompare(b));
          check(
            'the downloaded songs are browsable by title with no connection, and it is a view (item 3)',
            downloads.title === 'On this phone' &&
              JSON.stringify(drawn) === JSON.stringify(expected) &&
              downloads.playlistRows.length === 0 &&
              downloads.leaked.length === 0 &&
              downloads.emptyBox === null,
            `h1 “${downloads.title}” · ${downloads.rows.length} rows ${JSON.stringify(drawn)} · playlist-shaped rows ${downloads.playlistRows.length} · leaked ${JSON.stringify(downloads.leaked)}`,
          );
          check(
            'every track on it carries its mark, and it needs no round trip to draw',
            downloads.songMarks.length === expected.length && downloads.songMarks.every((row) => row.mark === 'complete'),
            `${downloads.songMarks.filter((row) => row.mark === 'complete').length} of ${downloads.songMarks.length} marked`,
          );

          /*
           * **The art themes the shell, offline** (item 4's second half).
           *
           * Tapping a row puts that track in the queue, and the palette is read from its cover — the
           * *local* one, with the API refused. `--accent-primary` is what the shell wears, and
           * `DEFAULT_PRIMARY` is what it wears when no art was read at all, so a value that differs
           * from it is the evidence that the cover on disk drove the theme rather than the fallback.
           * This is the failure the app's own history warns about: a silent fallback to
           * `DEFAULT_PALETTE` looks exactly like "it does not theme from the art".
           */
          const before = downloads.primary;
          await evaluate(cdp, `(() => { const row = document.querySelector('.row.song'); if (row) row.click(); return Boolean(row); })()`);
          let painted = '';
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            painted = await evaluate(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim()`);
            if (painted !== '' && painted !== DEFAULT_PRIMARY) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          readings.states.paletteOffline = { before, after: painted };
          check(
            'the cover on disk drives the shell’s palette with the API refused (item 4)',
            painted !== '' && painted !== DEFAULT_PRIMARY,
            `--accent-primary “${before}” → “${painted}” (the no-art default is ${DEFAULT_PRIMARY})`,
          );
          await evaluate(cdp, `location.hash = '#/downloads'`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        say('');

        /* ------ 2c. a row a 1.9.19 build wrote, on the screen it was reported on (v1.9.23) */
        /*
         * The owner's screenshot, driven. A mirror a 1.9.19 build wrote — `path`, `bytes`, `state`,
         * and no metadata key anywhere — beside the download's own manifest, which is where the names
         * and the lengths are, on the phone. The store's half of this is v1.9.22 and is asserted in
         * `test/offline-browse.test.ts`; what this block asserts is that the repair reaches **the
         * screen he is looking at, without leaving it**: the rows' own titles, sub-lines and lengths,
         * read on the route it painted — once as the route drew, once when the store had spoken — with
         * no navigation between the two readings. Before v1.9.23 the second reading was identical to
         * the first until he left the screen and came back, which is what his report says.
         */
        await navigate(cdp, app);
        const legacySeeded = await evaluate(cdp, seedScript(deadUrl, legacyMirrorJson(app)));
        readings.states.legacySeeded = legacySeeded;
        say(`  (the page was seeded with a 1.9.19 store: ${JSON.stringify(legacySeeded)})`);
        await coldRoute(cdp, app, '/downloads');
        await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the rows a 1.9.19 build wrote');
        const legacyStarted = Date.now();
        const legacyAsDrawn = await evaluate(cdp, READING);
        let legacy = legacyAsDrawn;
        const legacyDeadline = Date.now() + 5000;
        for (;;) {
          if (legacy.songMarks.filter((row) => row.time === LEGACY_TIME).length === TITLES.length) break;
          if (Date.now() > legacyDeadline) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          legacy = await evaluate(cdp, READING);
        }
        readings.states.downloadsLegacyAsDrawn = legacyAsDrawn;
        readings.states.downloadsLegacyRepaired = { ...legacy, ms: Date.now() - legacyStarted };
        const legacyNamed = legacy.songMarks.filter((row) => row.title !== '');
        const legacyUnnamed = legacy.songMarks.filter((row) => row.title === '');
        say('A store a 1.9.19 build wrote, on “On this phone”, with no server:');
        say(`    as the route drew it: ${JSON.stringify(legacyAsDrawn.songMarks.map((row) => [row.title, row.time]))}`);
        say(
          `    and once the store had spoken, on the same route (${readings.states.downloadsLegacyRepaired.ms} ms): ` +
            JSON.stringify(legacyNamed.map((row) => [row.title, row.sub, row.time])),
        );
        check(
          'a row a 1.9.19 build wrote is named and timed on the screen it was reported on, without leaving it (v1.9.23)',
          legacy.route === '#/downloads' &&
            JSON.stringify(legacy.songMarks.map((row) => row.title).sort()) === JSON.stringify([...TITLES, ''].sort()) &&
            legacyNamed.length === TITLES.length &&
            legacyNamed.every((row) => row.time === LEGACY_TIME && /ヨルシカ/.test(String(row.sub))),
          `route ${legacy.route} · ${legacy.songMarks.length} rows · ${JSON.stringify(
            legacy.songMarks.map((row) => [row.title, row.time]),
          )}`,
        );
        check(
          'a row nobody can name keeps drawing what it drew — no song id in the title slot, no invented length',
          legacyUnnamed.length === 1 &&
            legacyUnnamed[0].time === '--:--' &&
            !String(legacyUnnamed[0].label).includes('orphan') &&
            legacyUnnamed[0].title === '',
          `${legacyUnnamed.length} unnamed row(s): ${JSON.stringify(legacyUnnamed.map((row) => [row.title, row.time, row.label]))}`,
        );
        say('');

        /* -------------- 2d. …and the track he is playing is named with it (v1.9.23) */
        /*
         * The other half of his screenshot: the player bar beside that list. The bar's title is the
         * `Song` the queue holds and its total is built out of the same object, so a row that was blank
         * when he tapped it was a blank bar with `0:00` for the length of the track.
         *
         * Driven so that only the queue's own copy can be what fills it: the row is one the **server**
         * names (no manifest names it, so the phone's pass has nothing to say), the mock holds every
         * API answer for `LEGACY_HOLD_MS`, so the tap lands while the row is still blank and sets off
         * on a genuinely nameless song, and the list is **left** before the answer arrives — there is
         * no row on screen by then for a repaint to reach.
         */
        const firstSong = await readFirstSong(app).catch((error) => {
          readings.states.barCaseSong = String(error);
          return null;
        });
        const heldForBar = await holdAnswers(app, LEGACY_HOLD_MS);
        const barDriverReady = check(
          'the bar case can be driven: the library names a track and the mock can hold its answer (/__slow)',
          firstSong !== null && heldForBar === LEGACY_HOLD_MS,
          firstSong === null
            ? `the library named no track (${readings.states.barCaseSong ?? 'no album'})`
            : heldForBar !== LEGACY_HOLD_MS
              ? `no /__slow at ${app}: every answer lands at once, so the tap cannot be made to land on a blank row`
              : `${firstSong.id} “${firstSong.title}” (${firstSong.duration} s), every API answer held for ${heldForBar} ms`,
        );

        if (!barDriverReady) {
          say('The bar reading was not driven.');
          await holdAnswers(app, 0);
        } else {
          readings.states.barCaseSong = firstSong;
          await navigate(cdp, app);
          await evaluate(cdp, seedScript(app, serverNamedMirrorJson(app, firstSong.id)));
          /*
           * A **real navigation**, not a hash change: the app reads its settings once, at boot, and
           * builds the client they name — so the document that asks the server for this row's name has
           * to be one that was opened *after* the settings were seeded. (A same-document route change
           * keeps the client the last block pointed at a refused port, and then nothing can name the
           * row at all: measured, this harness, v1.9.23.)
           */
          await coldRoute(cdp, app, '/downloads');
          await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the one unnamed row to be drawn');
          /*
           * The tap he makes, and where it lands: the whole row is the tap target, and the row selects
           * its song synchronously before anything reaches the network (`queue.select`), so the bar is
           * already carrying this song — with nothing on it — before the ask for its name is answered.
           */
          await evaluate(cdp, `(() => { const row = document.querySelector('.row.song'); if (row) row.click(); return Boolean(row); })()`);
          // …and he moves on, which is what takes the row repaint off the table: the list is gone.
          await evaluate(cdp, `location.hash = '#/artists'`);
          await new Promise((resolve) => setTimeout(resolve, 200));
          const barAsTapped = (await evaluate(cdp, READING)).bar;
          let bar = barAsTapped;
          const barDeadline = Date.now() + 8000;
          for (;;) {
            if (bar.title !== '') break;
            if (Date.now() > barDeadline) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
            bar = (await evaluate(cdp, READING)).bar;
          }
          readings.states.barAsTapped = barAsTapped;
          readings.states.barWhenNamed = bar;
          // What the store itself ended up holding, so a failure can say which half did not happen.
          readings.states.barCaseStore = await evaluate(
            cdp,
            `(() => {
              const raw = localStorage.getItem('navilite.offline');
              const row = raw ? (JSON.parse(raw).rows || {})[${JSON.stringify(firstSong.id)}] : null;
              return row ? { title: row.title ?? null, durationSec: row.durationSec ?? null } : null;
            })()`,
          );
          say(`The player bar, for a track that was already playing while its row was still blank (${firstSong.id}):`);
          say(`    as the tap landed: title ${JSON.stringify(barAsTapped.title)}, total ${barAsTapped.total}`);
          say(`    once the store could name it, with the list replaced by the Library: title ${JSON.stringify(bar.title)}, total ${bar.total}`);
          check(
            'the bar of a track that was already playing carries its name, with the list it was tapped from gone (v1.9.23)',
            barAsTapped.title === '' && bar.title === firstSong.title,
            `${JSON.stringify(barAsTapped.title)} → ${JSON.stringify(bar.title)} (the library calls it ${JSON.stringify(firstSong.title)})`,
          );
          check(
            'and its real total, instead of 0:00',
            barAsTapped.total === '0:00' && bar.total === mmss(firstSong.duration),
            `${barAsTapped.total} → ${bar.total} (${firstSong.duration} s)`,
          );
          await holdAnswers(app, 0);
        }
        say('');

        /* ---- 2e. the name a reader hears is the row's own title (v1.9.23, the card's acceptance) */
        /*
         * The row's accessible name carries its title (`Play <title>, downloaded`), and for a row the
         * **server** names, the title and the name are written by the *same* store pass: with no
         * manifest in this mirror `repairFromRecords` has nothing to say, so the notify after the
         * record pass never fires and `repairMetadata` notifies **once**, at the end of the server
         * pass — the pass that fills the title.
         *
         * The name used to be painted *before* the pass that fills the title (`songRow` registered its
         * mark pass first), so this row — its title legibly on the screen beside it — was announced as
         * `Play , downloaded`: no name at all, for as long as the owner stayed on the screen, healing
         * only on the next unrelated store notify. A screen reader hears this row only through its
         * name, so this is the whole of what a blind owner gets from the screen.
         *
         * Read the way a person perceives it: the row's **rendered text** and its **accessible name**
         * in one reading (`READING.songMarks` carries both), on the route, with the first reading
         * taken as the route drew (blank — the state the owner's screenshot is in) and the second once
         * the store could name the row, and **no navigation between the two**.
         */
        if (firstSong !== null) {
          // The hold is what makes "blank when the route drew" a fact rather than a hope: the ask for
          // this row's name cannot have been answered before the reading below is taken.
          await holdAnswers(app, LEGACY_HOLD_MS);
          await navigate(cdp, app);
          await evaluate(cdp, seedScript(app, serverNamedMirrorJson(app, firstSong.id)));
          await coldRoute(cdp, app, '/downloads');
          await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the one unnamed row to be drawn');
          const namedAsDrawn = await evaluate(cdp, READING);
          let named = namedAsDrawn;
          const namedDeadline = Date.now() + 8000;
          for (;;) {
            if ((named.songMarks[0]?.title ?? '') !== '') break;
            if (Date.now() > namedDeadline) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
            named = await evaluate(cdp, READING);
          }
          readings.states.downloadsServerNamedAsDrawn = namedAsDrawn;
          readings.states.downloadsServerNamed = named;
          // The store's own row for it, so a failure can say which half did not happen.
          readings.states.downloadsServerNamedStore = await evaluate(
            cdp,
            `(() => {
              const raw = localStorage.getItem('navilite.offline');
              const row = raw ? (JSON.parse(raw).rows || {})[${JSON.stringify(firstSong.id)}] : null;
              return row ? { title: row.title ?? null, durationSec: row.durationSec ?? null } : null;
            })()`,
          );
          const namedRow = named.songMarks[0] ?? null;
          const heard = String(namedRow?.label ?? '');
          const asDrawn = [namedAsDrawn.songMarks[0]?.title ?? null, namedAsDrawn.songMarks[0]?.label ?? null];
          say('The row the server named, read on the route it was drawn on, with no navigation:');
          say(`    as the route drew it: ${JSON.stringify(asDrawn)}`);
          say(`    once the store had named it: ${JSON.stringify([namedRow?.title ?? null, namedRow?.time ?? null, heard])}`);
          check(
            'the row the server named reads as its title and its accessible name in the same reading, on the route (v1.9.23)',
            named.route === '#/downloads' &&
              named.songMarks.length === 1 &&
              namedAsDrawn.songMarks[0]?.title === '' &&
              namedRow?.title === firstSong.title &&
              heard === `Play ${firstSong.title}, downloaded`,
            `route ${named.route} · as drawn ${JSON.stringify(asDrawn)} · named ${JSON.stringify([
              namedRow?.title ?? null,
              heard,
            ])} (the library calls it ${JSON.stringify(firstSong.title)})`,
          );
          await holdAnswers(app, 0);
        }
        say('');

        /* ------------- 3. the round trip is never waited on (accepts, never answers) */
        await evaluate(cdp, seed(app, `${hole.url}`));
        const hungStarted = Date.now();
        await coldRoute(cdp, app, `/playlist/${PLAYLIST_ID}`);
        await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the songs to be drawn while the request hangs', 3000);
        const hung = await evaluate(cdp, READING);
        readings.states.playlistWithPendingRequest = { ...hung, ms: Date.now() - hungStarted };
        say(`With the API accepting and never answering (the app's own request timeout is 20 s), the song list was on screen in ${readings.states.playlistWithPendingRequest.ms} ms:`);
        say(`    ${hung.rows.length} rows — the request was still in flight, and the view did not wait for it.`);
        check(
          'the playlist view does not wait for a server that never answers',
          JSON.stringify(hung.rows) === JSON.stringify(TITLES) && readings.states.playlistWithPendingRequest.ms < 3000,
          `${hung.rows.length} rows in ${readings.states.playlistWithPendingRequest.ms} ms (well inside the 20 s request timeout)`,
        );
        /*
         * …and the same claim for the downloaded-songs view (v1.9.20, item 3): it is drawn from the
         * store's in-memory rows, so a server that accepts the connection and never answers costs it
         * nothing at all. A round-trip *count* would be the wrong assertion here — boot asks for the
         * saved queue by design — so the claim is made the way this harness makes it: as time.
         */
        await evaluate(cdp, `location.hash = '#/downloads'`);
        const downloadsStarted = Date.now();
        await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the downloaded tracks while the request hangs', 3000);
        const hungDownloads = await evaluate(cdp, READING);
        readings.states.downloadsWithPendingRequest = { ...hungDownloads, ms: Date.now() - downloadsStarted };
        say(`“On this phone” with the API accepting and never answering: ${hungDownloads.rows.length} rows in ${readings.states.downloadsWithPendingRequest.ms} ms`);
        check(
          'the downloaded-songs view does not wait for a server that never answers (item 3)',
          hungDownloads.rows.length === TITLES.length + 1 && readings.states.downloadsWithPendingRequest.ms < 3000,
          `${hungDownloads.rows.length} rows in ${readings.states.downloadsWithPendingRequest.ms} ms`,
        );
        say('');

        /* -------------------- 4. the control: with no mirror, there is nothing to draw */
        await evaluate(cdp, seed(app, deadUrl));
        await evaluate(cdp, `localStorage.removeItem('navilite.offline'); true`);
        await coldRoute(cdp, app, `/playlist/${PLAYLIST_ID}`);
        await waitFor(cdp, `Boolean(document.querySelector('.offline-pill:not(.hidden)'))`, 'the offline state to be drawn', 5000);
        const empty = await evaluate(cdp, READING);
        readings.states.playlistWithoutMirror = empty;
        check(
          'the control: with the offline mirror gone the same route draws no songs — so the rows above came from the store',
          empty.rows.length === 0 && empty.pill?.visible === true && empty.leaked.length === 0,
          `${empty.rows.length} rows · badge ${empty.pill?.visible ?? false} · leaked ${JSON.stringify(empty.leaked)}`,
        );
        say('');

        /* ------------------- 5. the view he left does not paint over the one he is on (v1.9.21) */
        /*
         * Every view that awaits the library paints when the answer arrives, and by then the router
         * may already have drawn whatever the owner navigated to — so a slow answer writes the old
         * screen over the new one. v1.9.20 guarded the three views its own acceptance depended on;
         * this block is the same claim for the rest of the class, driven on purpose rather than by
         * luck: the mock holds every API answer for `RACE_DELAY_MS` (`GET /__slow`, v1.9.21), so a
         * screen can be left mid-answer every time, and each case is read once the answer has landed.
         *
         * Each case has a **control** — the same route, the same held answer, visited and *stayed on*
         * — because a view that never paints cannot paint over another one; the control is what makes
         * the negative reading below mean something. Each case then boots cold before it is raced: the
         * library caches an album, an artist and the starred set for the session (`state/library.ts`),
         * and a second visit inside one page load would answer from memory, land before anyone could
         * leave, and pass on nothing.
         */
        await mockFetch(`${app}/__reset`).catch(() => {});
        await evaluate(cdp, seed(app, app));
        await coldRoute(cdp, app, '/downloads');
        const onDownloads = `document.querySelector('.page-head h1')?.textContent === 'On this phone'`;
        await waitFor(cdp, onDownloads, 'the downloaded-songs screen to boot');
        let catalogue = null;
        try {
          catalogue = await readCatalogue(app);
        } catch (error) {
          readings.states.raceCatalogue = String(error);
        }
        const heldMs = await holdAnswers(app, RACE_DELAY_MS);
        const driverReady = check(
          'the mock can hold an API answer open, so this block is about a **late** answer (/__slow)',
          heldMs === RACE_DELAY_MS,
          heldMs === null
            ? `no /__slow at ${app} — no answer can be made late here, and a race asserted against a library that answers instantly passes on nothing`
            : `every API answer at ${app} is held for ${heldMs} ms`,
        );
        /*
         * And the other half of the same rule: an undriven check is a failure, not a skip. This one
         * reads the ids and the names the pages will have to show out of the library itself, so a
         * fixture that stops offering them is reported instead of quietly testing nothing.
         */
        const catalogueReady = check(
          'the library names an album and an artist to visit, so the race cases can be driven',
          catalogue !== null,
          catalogue === null
            ? `nothing answered (${readings.states.raceCatalogue ?? 'no album and no artist'})`
            : `${catalogue.album.id} “${catalogue.album.name}”, ${catalogue.artist.id} “${catalogue.artist.name}”`,
        );

        if (!driverReady || !catalogueReady) {
          say(`The race checks were not driven: ${!driverReady ? 'the mock is not holding answers' : 'the library named no album and artist to visit'}.`);
          await holdAnswers(app, 0);
        } else {
          /** …and the search route, used both as a case and as the current-search control below. */
          const searchRoute = `#/search/${encodeURIComponent(catalogue.artist.name)}`;

          /**
           * `drawn` is the control's assertion, `waiting` is what the screen looks like while its
           * answer is still held, and `parts` names what that view contributes — so a failure can say
           * which screen's parts it found on the wrong one, not merely that something was wrong.
           */
          const cases = [
            {
              name: 'album page',
              route: `#/album/${catalogue.album.id}`,
              method: 'getAlbum',
              drawn: `document.querySelector('.view h1')?.textContent === ${JSON.stringify(catalogue.album.name)}`,
              waiting: `document.querySelector('.view .empty p')?.textContent === 'Loading…'`,
              parts: 'album header, cover and song rows',
            },
            {
              name: 'artist page',
              route: `#/artist/${catalogue.artist.id}`,
              method: 'getArtist',
              drawn: `document.querySelector('.view h1')?.textContent === ${JSON.stringify(catalogue.artist.name)}`,
              waiting: `document.querySelector('.view .empty p')?.textContent === 'Loading…'`,
              parts: 'artist header and album cards',
            },
            {
              name: 'Favourites',
              route: '#/favourites',
              method: 'getStarred2',
              drawn: `document.querySelector('.view h1')?.textContent === 'Favourites'`,
              waiting: `document.querySelector('.view .empty p')?.textContent === 'Loading…'`,
              parts: 'Favourites header and sections',
            },
            {
              name: 'Search',
              route: searchRoute,
              method: 'search3',
              drawn: `document.querySelector('.view h1')?.textContent === 'Search' && document.querySelectorAll('.view .card, .view .row.song').length > 0`,
              waiting: `(document.querySelector('.view')?.textContent ?? '').includes('Searching…')`,
              parts: 'Search header and result sections',
            },
            {
              name: 'router’s failure fallback',
              route: '#/album/not-a-real-album',
              method: 'getAlbum',
              drawn: `Boolean(document.querySelector('.view .empty')?.textContent) && document.querySelector('.view .empty').textContent !== 'Loading…'`,
              waiting: `document.querySelector('.view .empty p')?.textContent === 'Loading…'`,
              parts: 'error box',
            },
          ];

          /** `waitFor`, answered instead of thrown: a control that never drew is a finding, not a wall. */
          const drew = async (expression, label, timeoutMs = RACE_DELAY_MS + 6000) => {
            try {
              await waitFor(cdp, expression, label, timeoutMs);
              return true;
            } catch {
              return false;
            }
          };

          /** Is the screen the destination — On this phone — with none of the old view's parts on it? */
          const destinationIntact = (reading) => {
            const songs = [...(reading.songs ?? [])].sort((a, b) => a.localeCompare(b));
            const wrong = [];
            if (reading.route !== '#/downloads') wrong.push(`the address is ${reading.route}`);
            if (reading.h1 !== 'On this phone') wrong.push(`the heading is “${reading.h1}”`);
            if (JSON.stringify(songs) !== JSON.stringify(DOWNLOAD_TITLES)) wrong.push(`${songs.length} song rows, ${JSON.stringify(songs)}`);
            if (reading.detail) wrong.push('an album page’s header is drawn');
            if (reading.cards > 0) wrong.push(`${reading.cards} album or artist card(s) are drawn`);
            if ((reading.sections ?? []).length > 0) wrong.push(`the sections ${JSON.stringify(reading.sections)} are drawn`);
            if (reading.emptyBox !== null) wrong.push(`an error box reads ${JSON.stringify(reading.emptyBox)}`);
            return { ok: wrong.length === 0, why: wrong.join('; ') };
          };

          /* 5a — the control: the same routes, the same held answers, visited and stayed on. */
          const controls = [];
          for (const one of cases) {
            await evaluate(cdp, `location.hash = ${JSON.stringify(one.route)}`);
            const at = Date.now();
            const ok = await drew(one.drawn, `the ${one.name} to draw from a held answer`);
            controls.push(`${one.name}: ${ok ? `drew ${Date.now() - at} ms after the route changed` : 'did NOT draw'}`);
            if (ok) readings.states[`raceControl: ${one.name}`] = await evaluate(cdp, RACE_READING);
          }
          check(
            'the control: every one of these views draws from the very answer the block then holds open — without this, the readings below would prove nothing',
            controls.every((line) => line.includes('drew')),
            controls.join(' · '),
          );
          say('');

          /* 5b — and each of them, left while its own answer is still in the air. */
          for (const one of cases) {
            const before = (await mockState(app))?.requests.filter((entry) => entry.method === one.method).length ?? 0;
            await evaluate(cdp, seed(app, app));
            await coldRoute(cdp, app, '/downloads');
            await waitFor(cdp, onDownloads, 'the destination to boot', 15000);
            await evaluate(cdp, `location.hash = ${JSON.stringify(one.route)}`);
            await new Promise((resolve) => setTimeout(resolve, RACE_AWAY_MS));
            const holding = await evaluate(cdp, RACE_READING);
            const stillAsking = await evaluate(cdp, one.waiting);
            await evaluate(cdp, `location.hash = '#/downloads'`);
            await waitFor(cdp, onDownloads, 'the destination he moved to', 10000);
            await new Promise((resolve) => setTimeout(resolve, RACE_DELAY_MS - RACE_AWAY_MS + RACE_SETTLE_MS));
            const after = await evaluate(cdp, RACE_READING);
            const served = ((await mockState(app))?.requests.filter((entry) => entry.method === one.method).length ?? 0) - before;
            const reached = destinationIntact(after);
            readings.states[`raceAway: ${one.name}`] = after;
            say(`  · ${one.name} — ${one.route}, left ${RACE_AWAY_MS} ms in, ${served} ${one.method} answered by the mock:`);
            say(`      while the answer was held: ${stillAsking ? 'the view is asking, nothing drawn yet' : `NOT that view any more — ${JSON.stringify(holding.text)}`}`);
            say(`      once it had landed: ${reached.ok ? `still “${after.h1}”, ${after.songs.length} rows, no ${one.parts} on screen` : reached.why}`);
            check(
              `the ${one.name} does not paint over the screen he moved to (its answer held for ${RACE_DELAY_MS} ms)`,
              stillAsking && reached.ok,
              stillAsking
                ? reached.ok
                  ? `#/downloads intact after the ${one.method} answer landed: h1 “${after.h1}”, ${after.songs.length} rows, no ${one.parts} on it`
                  : `the screen he moved to now reads: ${reached.why} — on screen: ${JSON.stringify(after.text)}`
                : `the view had already drawn or was not asking at +${RACE_AWAY_MS} ms, so its answer was not held: ${JSON.stringify(holding.text)}`,
            );
          }
          say('');

          /*
           * 5c — the caution on the card, kept as a check of its own: the guard is keyed to the
           * **render**, not to the request, so a second Enter while the first search is still in the
           * air is the same render and both answers are allowed to land. The route does not move here;
           * what a wrong guard would do is make a *current* answer unsendable, and this says it does
           * not. (The route's own `submit` is the first search; the event below is the second.)
           */
          await evaluate(cdp, seed(app, app));
          await coldRoute(cdp, app, '/downloads');
          await waitFor(cdp, onDownloads, 'the destination before the current-search control', 15000);
          await evaluate(cdp, `location.hash = ${JSON.stringify(searchRoute)}`);
          await evaluate(
            cdp,
            `(() => {
              const input = document.querySelector('.page-head input');
              if (!input) return false;
              input.value = ${JSON.stringify(catalogue.artist.name)};
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
              return true;
            })()`,
          );
          const secondSeen = await drew(
            `document.querySelectorAll('.view .card, .view .row.song').length > 0`,
            'the search that is still the view to draw after a second Enter',
          );
          const twice = await evaluate(cdp, RACE_READING);
          readings.states.raceSecondEnter = twice;
          check(
            'a search that is still the screen still draws after a second Enter while the first answer is held (the guard is keyed to the render, not to the request)',
            secondSeen,
            secondSeen
              ? `drew with h1 “${twice.h1}”, ${twice.cards} card(s), ${twice.songs.length} song row(s), while every answer was held for ${RACE_DELAY_MS} ms`
              : `nothing drew: ${JSON.stringify(twice.text)}`,
          );
          say('');
          await holdAnswers(app, 0);
        }
      },
      { width: 393, height: 852, deviceScaleFactor: 3 },
    );
  } finally {
    hole.close();
  }

  say('');
  say(
    failures.length === 0
      ? 'RESULT: a downloaded playlist is browsable with no connection, one row per playlist, a mark on what is on this phone, the Library keeps its own door into the downloaded music with no server, nothing prints a URL at him, a view left mid-answer does not paint over the screen he moved to, and a store a 1.9.19 build wrote is named on the list he is looking at and on the bar of the track he is playing.'
      : `RESULT: ${failures.length} offline check(s) failed.`,
  );
  for (const failure of failures) say(`  - ${failure}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(readings, null, 2));
    process.stdout.write(`\nraw readings: ${jsonPath}\n`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
