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
 */
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { withChromePage, navigate, evaluate } from './layout-audit.mjs';

const IN_PAGE = 'window.__naviliteLayoutAudit.';
const PLAYLIST_ID = 'pl-offline-1';
const PLAYLIST_NAME = 'Late night driving';
const TITLES = ['海底、月明かり', '夜に駆ける', 'A very long unbroken track title for the 393 px audit'];

/** The saved playlist as a real download leaves it: a manifest, and one row per complete file. */
const MIRROR = {
  v: 1,
  hydratedAt: Date.now(),
  rows: Object.fromEntries(
    TITLES.map((title, index) => [
      `song-${index}`,
      `__PLACEHOLDER__${index}`,
    ]),
  ),
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
      })),
    },
  },
};

/** The rows, with the real shape the mirror writes (`file://` path + measured bytes). */
function mirrorJson() {
  const copy = JSON.parse(JSON.stringify(MIRROR));
  for (const [index, songId] of Object.keys(copy.rows).entries()) {
    copy.rows[songId] = {
      path: `file:///var/mobile/Containers/Data/Application/navilite-offline/${songId}.opus`,
      bytes: 8123456,
      state: 'complete',
      lyrics: { state: 'none', bytes: 0, fetchedAt: Date.now() - 1000 - index },
    };
  }
  return JSON.stringify(copy);
}

/** What the page is actually showing, read the way a person reads it. */
const READING = `(() => {
  const rows = [...document.querySelectorAll('.row.song .row-title')].map((node) => node.textContent);
  const pill = document.querySelector('.offline-pill');
  const text = document.body.textContent || '';
  const measure = window.${IN_PAGE.replace('window.', '')}measure();
  return {
    route: location.hash,
    title: document.querySelector('.page-head h1') ? document.querySelector('.page-head h1').textContent : null,
    subtitle: document.querySelector('.page-head .muted') ? document.querySelector('.page-head .muted').textContent : null,
    rows,
    downloadedRows: [...document.querySelectorAll('.list .row:not(.song) .row-title')].map((node) => node.textContent),
    pill: pill ? { visible: !pill.classList.contains('hidden'), text: pill.textContent } : null,
    emptyBox: document.querySelector('.view .empty') ? document.querySelector('.view .empty').textContent : null,
    leaked: ['could not reach', 'Load failed', 'Over Tailscale'].filter((needle) => text.includes(needle)),
    overflow: measure.horizontalOverflow,
    scrollSurface: measure.scrollSurface,
  };
})()`;

/** Poll a page expression, so a route's own render has time to land without a blind sleep. */
async function waitFor(cdp, expression, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
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

const seed = (appUrl, apiUrl) => `(() => {
  localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(apiUrl)}, username: 'navidrome', playback: 'web' }));
  localStorage.setItem('navilite.subsonic-password', 'navidrome');
  localStorage.setItem('navilite.offline', ${JSON.stringify(mirrorJson())});
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

  try {
    await withChromePage(
      async ({ cdp, safeArea }) => {
        /* ------------------------------------ 0. the online control, when there is an API */
        if (onlinePlaylist) {
          await navigate(cdp, app);
          await evaluate(cdp, seed(app, app));
          await coldRoute(cdp, app, `/playlist/${onlinePlaylist}`);
          await waitFor(cdp, `document.querySelectorAll('.row.song').length > 0`, 'the online playlist to draw');
          const online = await evaluate(cdp, READING);
          readings.states.playlistOnline = online;
          say(`Online control — ${app} (the same origin serves the API), playlist ${onlinePlaylist}:`);
          say(`  h1 “${online.title}”, ${online.rows.length} song row(s), badge ${online.pill?.visible ?? false}`);
          check(
            'with the server up the same route draws the server’s list, unbadged (the local path did not replace it)',
            online.rows.length > 0 && online.pill?.visible === false && online.title !== 'Downloaded playlist',
            `${online.rows.length} rows · h1 “${online.title}” · badge ${online.pill?.visible ?? false}`,
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
        say('');

        /* --------------------------------- 2. a route that only the server can fill */
        await evaluate(cdp, `location.hash = '#/playlists'`);
        await waitFor(cdp, `Boolean(document.querySelector('.offline-pill'))`, 'the playlists route to draw');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const browse = await evaluate(cdp, READING);
        readings.states.playlistsOffline = browse;
        say(`The playlists screen with no server: “${browse.subtitle}”, ${browse.downloadedRows.length} downloaded row(s): ${JSON.stringify(browse.downloadedRows)}`);
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

        await evaluate(cdp, `location.hash = '#/artists'`);
        await waitFor(cdp, `Boolean(document.querySelector('.offline-pill'))`, 'the library route to draw');
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
  say(failures.length === 0 ? 'RESULT: a downloaded playlist is browsable with no connection, and nothing prints a URL at him.' : `RESULT: ${failures.length} offline check(s) failed.`);
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
