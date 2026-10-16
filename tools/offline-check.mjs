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
 */
import { createServer } from 'node:http';
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
      mark: badgeOf(row),
      label: row.getAttribute('aria-label'),
    })),
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

const seed = (appUrl, apiUrl, online) => `(() => {
  localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(apiUrl)}, username: 'navidrome', playback: 'web' }));
  localStorage.setItem('navilite.subsonic-password', 'navidrome');
  localStorage.setItem('navilite.offline', ${JSON.stringify(mirrorJson(appUrl, online))});
  return true;
})()`;

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
      const answer = await fetch(`${app}/__state`);
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
    await fetch(`${app}/__reset`);
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
          const expected = [...TITLES, 'Only this one is here'].sort((a, b) => a.localeCompare(b));
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
      },
      { width: 393, height: 852, deviceScaleFactor: 3 },
    );
  } finally {
    hole.close();
  }

  say('');
  say(failures.length === 0 ? 'RESULT: a downloaded playlist is browsable with no connection, one row per playlist, a mark on what is on this phone, and nothing prints a URL at him.' : `RESULT: ${failures.length} offline check(s) failed.`);
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
