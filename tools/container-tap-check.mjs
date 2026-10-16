#!/usr/bin/env node
/**
 * The bottom container's tap regions, and the two-tap rule (v2.0-beta, items 3 and 4).
 *
 * Two of the owner's reports live here, and both are about *where a finger landed*:
 *
 *   1. *"the bottom bar no longer sends you somewhere you did not ask to go"* — the bar's click
 *      handler guarded on `closest('button, input')`, a **tag list rather than a region**, so every
 *      part of the container that is not a button navigated to the now screen: the elapsed and
 *      duration labels beside the seek bar, the 12 px gap inside `.pb-main`, the gaps around
 *      `.pb-controls`, the chip, the reason line, the footer's padding. Checks 1-4 below: the three
 *      transport buttons and the seek bar still do their job **and the screen does not move**, and
 *      the two proven dead regions (a time label, the gap beside the transport row) do nothing at
 *      all;
 *
 *   2. *"tap the song in the bottom bar while you are in a playlist and the list scrolls to it…
 *      tap it again and you get the spectrum… if the song is already on screen, one tap takes
 *      you straight there"* — the two-tap rule. Check 5 centres, check 6 opens on the second tap,
 *      check 7 opens on the first tap when the row is already on screen, check 8 opens on a view
 *      that has no row for the song at all (`#/artists`), which is today's behaviour;
 *
 *   3. and check 9, the one that is easy to forget: the pager claims a gesture that *starts* on the
 *      bar (its `OWN_GESTURE` list does not name `.pb-main`), so the click a pane swipe leaves
 *      behind used to open the spectrum view — and after item 4 it would have scrolled his list.
 *      The bar therefore inherits the list's press/refusal authority: a real 100 px drag
 *      (`Input.dispatchTouchEvent`, so it is a real gesture) starting on the song block must move
 *      neither the route nor the scroll offset, and the pager must settle.
 *
 * **beta.3 adds the states the owner's report is actually about** (design §4.3), each one a scene with
 * its own numbers, and every one of them run through the harness's own probes rather than the app's
 * word for it — a `scroll` listener on `.view-scroll` (one event per move of the list) and a
 * `MutationObserver` on `.view` (how many times the drawn view has had a list and song rows added):
 *
 *   10. **search after two submits** — `submit` registers a fresh row for every hit on every Enter,
 *       so a song returned twice in one visit has a detached first row. The check proves the host was
 *       painted twice before it taps, then the two-tap accounting;
 *   11. **a playlist this phone has downloaded, with the server answering** — `renderPlaylist` paints
 *       the manifest's list and then the server's answer, which is the state the shipped bytes failed
 *       in: two paints, one of which the screen no longer has, and a tap that has to resolve the row
 *       the *view marks* rather than the first row the registry ever saw;
 *   12. **the first row of that list, with the list scrolled down** — clamped at `scrollTop 0`, fully
 *       on screen, one move, and the second tap opens;
 *   13. **the last row, with the list at the top** — clamped at the list's own maximum, and asserted
 *       clear of the player bar *there*, which is what decides whether the view's end padding is
 *       enough on a screen with a home indicator;
 *   14. **an album page** — a view whose order is not the queue's: the playing song's position in this
 *       list and in the queue are different numbers, so a target resolved by index would answer with
 *       another row. Four rows fit on one screen, so it is also the one-tap case: it opens and moves
 *       nothing;
 *   15. **the same downloaded playlist with the API refused** — the other half of the pair: one paint,
 *       the same tap, and it must still centre and open. Same list, same tap, opposite result on the
 *       shipped bytes, which *is* the reproduction.
 *
 * Every tap here goes through Chrome's own input pipeline, so the clicks are trusted — which is the
 * only kind of click the bar's refusal reads. The one exception is starting playback (a row click in
 * the page), which this app has always allowed an untrusted click to do.
 *
 *   node tools/mock-subsonic.mjs --port 4651 --dist dist
 *   node tools/container-tap-check.mjs --url http://127.0.0.1:4651 [--json report.json]
 *
 * Chrome runs **muted** (`--mute-audio`): this check really plays, and it is not allowed to make a
 * noise on the desk it runs on. Exit code is non-zero when any check fails.
 */
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { withChromePage, evaluate, navigate, findChrome } from './layout-audit.mjs';

const args = process.argv.slice(2);
const url = args[args.indexOf('--url') + 1];
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!url) {
  console.error('usage: node tools/container-tap-check.mjs --url http://127.0.0.1:PORT [--json report.json]');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The one playlist every scene in this check is about: the mock's long one (`--stress`). */
const PLAYLIST_ID = 'pl-stress-long';
const PLAYLIST_ROUTE = `playlist/${PLAYLIST_ID}`;
const PLAYLIST_NAME = '夜のドライブのためにえらんだ長いプレイリスト（第一集・全三十五曲・これでもかというほど長い名前）';

/* ------------------------------------------------------------------ fingers */

async function touchStart(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 6, radiusY: 6, force: 1 }],
  });
}
async function touchMove(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 6, radiusY: 6, force: 1 }],
  });
}
async function touchEnd(cdp) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** A tap: down and up on one pixel, which is what Chrome turns into a trusted click. */
async function tap(cdp, point) {
  await touchStart(cdp, point.x, point.y);
  await wait(40);
  await touchEnd(cdp);
  await wait(280);
}

/** A finger from `from` to `to` in `steps` moves — a real drag, not a synthesised event. */
async function drag(cdp, from, to, steps = 10, gapMs = 14) {
  await touchStart(cdp, from.x, from.y);
  for (let index = 1; index <= steps; index += 1) {
    await wait(gapMs);
    await touchMove(cdp, from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
  }
  await wait(gapMs);
  await touchEnd(cdp);
  await wait(400);
}

/* --------------------------------------------------------------- page reads */

/**
 * Everything this check asserts on, read in one round trip: the route, what the bar says, where the
 * playing song's own row is, where the scroll box is, and the boxes of the regions a finger can land
 * in (each with the element that is *actually painted* at its centre, so a "tap in the gap" is
 * provably a tap in a gap rather than in the title block).
 */
const READ = `(() => {
  const nav = window.__navilite;
  const boxOf = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      x: b.left + b.width / 2,
      y: b.top + b.height / 2,
      top: b.top,
      bottom: b.bottom,
      left: b.left,
      right: b.right,
      width: b.width,
      height: b.height,
    };
  };
  const scroll = document.querySelector('.view-scroll');
  const row = document.querySelector('.row.song.playing');
  const meta = document.querySelector('.pb-meta');
  const controls = document.querySelector('.pb-controls');
  const gap = meta && controls ? { x: (meta.getBoundingClientRect().right + controls.getBoundingClientRect().left) / 2, y: boxOf(meta).y } : null;
  const timeLabel = document.querySelector('.pb-progress .time');
  const at = (point) => (point ? (document.elementFromPoint(point.x, point.y) || {}) : {});
  const describe = (point) => {
    if (!point) return null;
    const el = at(point);
    return {
      tag: el.tagName || null,
      /** The container region the element painted at that point belongs to, if any. */
      region: el.closest ? (el.closest('.pb-cover') ? 'cover' : el.closest('.pb-meta') ? 'meta' : el.closest('.pb-controls') ? 'controls' : el.closest('.pb-progress') ? 'progress' : el.closest('.playerbar') ? 'bar-other' : 'outside') : 'outside',
      inSongBlock: Boolean(el.closest && el.closest('.pb-cover, .pb-meta')),
    };
  };
  return {
    route: location.hash,
    barTitle: (document.querySelector('.pb-title') || {}).textContent || null,
    chip: (document.querySelector('.mode-chip') || {}).textContent || null,
    barHidden: document.querySelector('.playerbar').classList.contains('hidden'),
    glyph: document.querySelector('.playerbar button[aria-label="Play or pause"]').dataset.playing || null,
    engineState: nav.status().state,
    nowMode: nav.nowMode(),
    nowHidden: document.querySelector('.now').classList.contains('hidden'),
    scrollTop: scroll ? Math.round(scroll.scrollTop) : 0,
    scrollBox: boxOf(scroll),
    scrollMax: scroll ? Math.max(Math.round(scroll.scrollHeight - scroll.clientHeight), 0) : 0,
    playingRowTitle: nav.playingRow(),
    playingRow: boxOf(row),
    /**
     * Where the marked row sits in the list's own DOM order, and what the queue says its position is.
     * The pair is what pins "resolved by id, never by index": a view whose order differs from the
     * queue is where an index-based target would answer with the wrong row.
     */
    playingRowIndex: Array.from(document.querySelectorAll('.row.song')).indexOf(row),
    playingRowMarks: document.querySelectorAll('.row.song.playing').length,
    bar: boxOf(document.querySelector('.playerbar')),
    /**
     * What the bar is worth as a band, and what the view reserves for it — the pair that decides
     * whether the last row of a list can be clear of the bar at the list's own limit (design §3.3).
     */
    barBox: (() => {
      const bar = document.querySelector('.playerbar');
      const view = document.querySelector('.view');
      if (!bar || !view) return null;
      return {
        height: bar.getBoundingClientRect().height,
        minHeight: getComputedStyle(bar).minHeight,
        paddingBottom: getComputedStyle(bar).paddingBottom,
        viewPaddingBottom: getComputedStyle(view).paddingBottom,
      };
    })(),
    /** The app's own now-playing line: "Playing from X (n/m)" — the queue's position, not the view's. */
    queueContext: nav.context(),
    rowCount: document.querySelectorAll('.row.song').length,
    meta: boxOf(meta),
    metaRegion: describe(boxOf(meta)),
    controls: boxOf(controls),
    timeLabel: boxOf(timeLabel),
    timeLabelRegion: describe(boxOf(timeLabel)),
    gap,
    gapRegion: describe(gap),
    pager: nav.pager(),
    pagerSettled: nav.pager().offset === 0,
  };
})()`;

const read = (cdp) => evaluate(cdp, READ);

/* --------------------------------------------------------- the check's own probes */

/**
 * Two facts this check refuses to take the app's word for, counted **in the page by the page's own
 * events** — no app hook, no debug surface, nothing to go stale:
 *
 *   - `scrolls` — one `scroll` event on `.view-scroll` per move of the list. This is the assertion
 *     that separates the three readings of "it walked in chunks": a refused tap moves the list zero
 *     times, one wrong target moves it once, and a walk would show two or more from one tap;
 *   - `lists`/`rows` — how many `.list` hosts and song rows the drawn view has **ever** had added to
 *     it. A playlist the phone has downloaded paints its list from the manifest and then again from
 *     the server's answer, so the visible list is the second batch and twice the rows have been
 *     added; a view that painted once has exactly one batch. `lists >= 2` is therefore the harness's
 *     own proof that the fixture is standing in the state the owner's report is about (§4.2's guard:
 *     a fixture that cannot show this must report SKIPPED, never pass).
 */
async function installProbe(cdp) {
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("Boolean(document.querySelector('.view') && document.querySelector('.view-scroll'))", 'the shell')`,
  );
  await evaluate(
    cdp,
    `(() => {
      if (window.__tapProbeInstalled) return true;
      window.__tapProbeInstalled = true;
      window.__tapProbe = { lists: 0, rows: 0, scrolls: 0 };
      const view = document.querySelector('.view');
      const scroller = document.querySelector('.view-scroll');
      if (!view || !scroller) return false;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!node || node.nodeType !== 1) continue;
            if (node.classList.contains('list')) window.__tapProbe.lists += 1;
            if (node.classList.contains('row') && node.classList.contains('song')) window.__tapProbe.rows += 1;
          }
        }
      }).observe(view, { childList: true, subtree: true });
      scroller.addEventListener('scroll', () => { window.__tapProbe.scrolls += 1; }, { passive: true });
      return true;
    })()`,
  );
}

const probe = (cdp) => evaluate(cdp, `({ ...(window.__tapProbe ?? { lists: -1, rows: -1, scrolls: -1 }) })`);

/** Between the taps of one scene: the counts are cumulative, so a scene reads them before it taps. */
async function resetProbe(cdp) {
  await evaluate(cdp, `(window.__tapProbe = { lists: 0, rows: 0, scrolls: 0 }, true)`);
}

/** Scroll the one scroller without a gesture — no scene here is about the gesture. */
const scrollTo = (cdp, top) => evaluate(cdp, `document.querySelector('.view-scroll').scrollTop = ${top}; true`);

/* ------------------------------------------------- the downloaded-playlist fixture */

/**
 * The mock's own long playlist, as the server answers it.
 *
 * The mirror below has to hold the **same songs in the same order** as the server's answer, or the
 * two paints would not be the same list and the fixture would be testing something else. It is read
 * with the plaintext password the mock accepts (`authorized`, `tools/mock-subsonic.mjs:364-370`).
 */
async function playlistEntries(appUrl) {
  const target = new URL('/rest/getPlaylist.view', appUrl);
  target.searchParams.set('id', PLAYLIST_ID);
  target.searchParams.set('u', 'navidrome');
  target.searchParams.set('p', 'navidrome');
  target.searchParams.set('v', '1.16.1');
  target.searchParams.set('c', 'navilite');
  target.searchParams.set('f', 'json');
  const answer = await (await fetch(target)).json();
  const entries = answer?.['subsonic-response']?.playlist?.entry;
  if (!Array.isArray(entries) || entries.length < 20) {
    throw new Error(`the mock answered ${Array.isArray(entries) ? entries.length : 0} entries for ${PLAYLIST_ID} — run tools/mock-subsonic.mjs --stress`);
  }
  return entries;
}

/**
 * A downloaded playlist, as a real download leaves it (`src/storage/offline.ts`'s mirror, written the
 * way `tools/offline-check.mjs` writes it): one `complete` row per song, and the manifest the
 * download was asked for. This is the state `renderPlaylist` paints twice in — the manifest's list
 * the moment the page opens, then the server's answer over the top of it.
 */
function mirrorJson(appUrl, entries) {
  const rows = entries.map((song) => [
    song.id,
    {
      path: `${appUrl}/offline-art/${song.id}.opus`,
      bytes: 8_000_000,
      state: 'complete',
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverArt: song.coverArt,
      durationSec: song.duration,
      lyrics: { state: 'none', bytes: 0, fetchedAt: Date.now() },
      art: { state: 'present', file: `${song.coverArt}.art`, bytes: 41_230, fetchedAt: Date.now() },
    },
  ]);
  return JSON.stringify({
    v: 1,
    hydratedAt: Date.now(),
    rows: Object.fromEntries(rows),
    playlists: {
      [PLAYLIST_ID]: { name: PLAYLIST_NAME, requestedAt: Date.now(), state: 'complete', songs: entries },
    },
  });
}

/**
 * The playlist page with a song playing from `rowIndex`, drawn as many times as the fixture makes it
 * draw (`expect`), and the check proves each paint happened before it measures anything.
 *
 * The wait for the last paint is not decoration: a row of the *manifest's* list resolves to a local
 * file, and this check is not about local files — clicking in the window between the two paints
 * would start a track that never reaches `playing`, and the run would fail for a reason that is not
 * this card's. `lists >= expect` is read from the harness's own probe, never from the app.
 */
async function openPlaylistWith(cdp, rowIndex, expect) {
  /*
   * Leave the route first, always. Setting `location.hash` to the value it already has fires no
   * hash change and re-renders nothing, and the previous scene may well have ended on this very
   * playlist (a scene that fails leaves the route where it was) — so the navigation this scene
   * depends on has to be a *change*, not a restatement. The probe is reset after that step, so this
   * route's own list is not counted as one of the target's paints.
   */
  await evaluate(cdp, `location.hash = '#/artists'; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '#/artists' && document.querySelectorAll('.row').length > 0", 'a route to leave from')`);
  await resetProbe(cdp);
  await evaluate(cdp, `location.hash = '#/${PLAYLIST_ROUTE}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '#/${PLAYLIST_ROUTE}' && document.querySelectorAll('.row.song').length > 20", 'the song rows')`,
  );
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__tapProbe.lists >= ${expect}", 'the ${expect === 2 ? 'second' : 'first'} paint of the list')`);
  await evaluate(cdp, `document.querySelectorAll('.row.song')[${rowIndex}].click(); true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__navilite.status().state === 'playing'", 'playback')`);
  // The scene's own window opens here: everything before this was setting the scene up.
  await resetProbe(cdp);
  await evaluate(cdp, `location.hash = '#/${PLAYLIST_ROUTE}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '#/${PLAYLIST_ROUTE}' && document.querySelector('.row.song.playing') !== null", 'the playlist, with the playing row in it')`,
  );
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__tapProbe.lists >= ${expect}", 'the ${expect === 2 ? 'second' : 'first'} paint of the list')`);
  await wait(400);
}

/** A port nothing is listening on: every API call refused at once (`tools/offline-check.mjs`'s method). */
async function refusedPort() {
  const probeServer = createServer();
  await new Promise((resolve) => probeServer.listen(0, '127.0.0.1', resolve));
  const { port } = probeServer.address();
  await new Promise((resolve) => probeServer.close(resolve));
  return port;
}

/**
 * **The two taps, measured** — the accounting §2 gives for rows 1, 2, 3, 7, 8 and 10: the first tap
 * moves the list **once** and does not navigate; the second opens the now screen on the spectrum pane
 * and moves nothing.
 *
 * `clamp` is the offset the row's own end of the list asks for — `0` for the first row of a list, or
 * `'max'` for the last — where "centred" and "as far as the list allows" are different assertions, or
 * `null` for the ordinary centre. Both are asserted against the row's *own* rectangle inside the
 * band the eye has (the scroll box above the player bar), because the end cases are exactly where a
 * row can be centred by the arithmetic and still be under the bar.
 *
 * The scene reads the harness's own counters around each tap, so "one move" is an event count and
 * not an inference from two offsets: a tap that opens must move the list zero times.
 */
async function twoTapScene(cdp, { label, clamp = null }) {
  const before = await read(cdp);
  const probeBefore = await probe(cdp);
  const rowCentreBefore = before.playingRow === null ? null : before.playingRow.top + before.playingRow.height / 2;
  const boxCentreBefore = (before.scrollBox.top + before.scrollBox.bottom) / 2;
  const off =
    before.playingRow !== null &&
    (before.playingRow.top > before.scrollBox.bottom || before.playingRow.bottom < before.scrollBox.top);
  check(off, `${label}: the playing row starts off the screen (otherwise the scene proves nothing)`, {
    row: before.playingRow && { top: Math.round(before.playingRow.top), bottom: Math.round(before.playingRow.bottom) },
    box: { top: Math.round(before.scrollBox.top), bottom: Math.round(before.scrollBox.bottom) },
    scrollTop: before.scrollTop,
  });

  await tap(cdp, before.meta);
  const after = await read(cdp);
  const probeAfter = await probe(cdp);
  const firstMoves = probeAfter.scrolls - probeBefore.scrolls;
  const rowCentreAfter = after.playingRow === null ? null : after.playingRow.top + after.playingRow.height / 2;
  const boxCentreAfter = (after.scrollBox.top + after.scrollBox.bottom) / 2;
  const onScreen =
    after.playingRow !== null &&
    after.playingRow.top >= after.scrollBox.top &&
    after.playingRow.bottom <= after.scrollBox.bottom &&
    after.playingRow.bottom <= (after.bar && after.bar.height > 0 ? after.bar.top : after.scrollBox.bottom);
  check(same(after.route, before.route), `${label}: the first tap does not navigate`, after.route);
  check(after.nowHidden, `${label}: and does not open the now screen`);
  check(
    firstMoves === 1,
    `${label}: and moves the list exactly once — never in chunks`,
    `${firstMoves} scroll event(s), ${before.scrollTop} → ${after.scrollTop}`,
  );
  if (clamp === null) {
    check(
      rowCentreAfter !== null && Math.abs(rowCentreAfter - boxCentreAfter) <= 6,
      `${label}: and centres that row in the scroll box`,
      `row centre ${rowCentreAfter === null ? 'no row' : Math.round(rowCentreAfter)} vs box centre ${Math.round(boxCentreAfter)}; before ${Math.round(rowCentreBefore ?? NaN)} vs ${Math.round(boxCentreBefore)}`,
    );
  } else {
    const wanted = clamp === 'max' ? after.scrollMax : 0;
    check(
      after.scrollTop === wanted,
      `${label}: and lands clamped at the list's own limit (${wanted})`,
      `scrollTop ${after.scrollTop}, max ${after.scrollMax}`,
    );
  }
  check(
    onScreen,
    `${label}: with that row fully on screen above the player bar`,
    after.playingRow && {
      top: Math.round(after.playingRow.top),
      bottom: Math.round(after.playingRow.bottom),
      box: [Math.round(after.scrollBox.top), Math.round(after.scrollBox.bottom)],
      barTop: after.bar && Math.round(after.bar.top),
    },
  );

  await tap(cdp, after.meta);
  const opened = await read(cdp);
  const probeOpened = await probe(cdp);
  check(same(opened.route, '#/now'), `${label}: the second tap opens the now screen`, opened.route);
  check(opened.nowMode === 'spectrum', `${label}: on the spectrum pane`, opened.nowMode);
  check(
    probeOpened.scrolls - probeAfter.scrolls === 0,
    `${label}: and the tap that opens moves the list zero times`,
    `${probeOpened.scrolls - probeAfter.scrolls} scroll event(s)`,
  );
  return { before, after, opened };
}

/* ------------------------------------------------------------------ reports */

const failures = [];
const skips = [];
const stages = {};

function check(ok, message, detail) {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}${detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
}

/**
 * A check whose *precondition* the fixture cannot make, reported as `SKIP` with the reason and never
 * as a pass (design §4.2): a green run must mean the state was reached, not that it was never tried.
 */
function skip(message, reason) {
  skips.push({ message, reason });
  console.log(`  skip ${message}  — ${reason}`);
  return false;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ----------------------------------------------------------------- scenarios */

/**
 * Start from the state this check asserts on: no play queue on the mock (the app restores one on
 * boot otherwise, `restorePlayQueue`), the mock's own credentials in the app's storage, and the
 * library drawn.
 */
async function clearSavedQueue() {
  const reset = await fetch(new URL('/__reset', url), { method: 'POST' });
  if (!reset.ok) throw new Error(`POST /__reset answered ${reset.status} — this check needs tools/mock-subsonic.mjs`);
  const mock = await (await fetch(new URL('/__state', url))).json();
  if (mock.playQueue) throw new Error('the mock still holds a play queue after /__reset');
}

async function seed(cdp, { mirror = null, api = url } = {}) {
  await clearSavedQueue();
  await navigate(cdp, url);
  await evaluate(
    cdp,
    `(() => {
      localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(api)}, username: 'navidrome', playback: 'web' }));
      localStorage.setItem('navilite.subsonic-password', 'navidrome');
      /* The mirror a real install has after a download, or none at all — a fresh profile. The API url
         above is the app's own serverUrl: the page is always served from the live mock, and only the
         API is ever pointed at a port nothing answers on. The queue is *not* seeded: the page that is
         standing here writes its own resume snapshot on the way out, which is the app's real path. */
      ${mirror === null ? `localStorage.removeItem('navilite.offline');` : `localStorage.setItem('navilite.offline', ${JSON.stringify(mirror)});`}
      const raw = localStorage.getItem('navilite.offline');
      return raw === null ? 0 : Object.keys(JSON.parse(raw).rows || {}).length;
    })()`,
  );
  await navigate(cdp, url);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library')`);
  await installProbe(cdp);
}

/** The playlist page this whole check happens on, with a song playing from a row far down the list. */
async function openPlaylistPlayingRow(cdp, rowIndex) {
  /*
   * The mock's *long* playlist (`--stress`): every track in its library, which is what makes a row
   * far down the list reachable and, more to the point, scrollable off the screen for check 5.
   */
  await evaluate(cdp, `location.hash = '#/playlist/pl-stress-long'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '#/playlist/pl-stress-long' && document.querySelectorAll('.row.song').length > 20", 'the song rows')`,
  );
  /*
   * The click is untrusted and deliberately so: this app has always activated a row on a plain
   * click, and it is not the subject of this check. It also navigates to the now screen — the app
   * has done that since v1.5 (`openNow()` beside `queue.select` in `songRow`) — so the playlist is
   * put back on the screen before anything below is measured.
   */
  await evaluate(cdp, `document.querySelectorAll('.row.song')[${rowIndex}].click(); true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__navilite.status().state === 'playing'", 'playback')`);
  await evaluate(cdp, `location.hash = '#/playlist/pl-stress-long'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '#/playlist/pl-stress-long' && document.querySelector('.row.song.playing') !== null", 'the playlist, with the playing row in it')`,
  );
  await wait(400);
}

async function run(cdp) {
  await seed(cdp);
  await openPlaylistPlayingRow(cdp, 12);

  const playlistRoute = (await read(cdp)).route;
  console.log(`the playlist page: ${playlistRoute}`);
  if (playlistRoute.indexOf('#/playlist/') !== 0) throw new Error(`not on a playlist page: ${playlistRoute}`);

  /* ---------------------------------------------------------------- item 3 */

  /*
   * 1. Play/pause on the bar: the transport does its job and the screen does not move. This is the
   *    report's first half — pause/play, next and previous all work *and he stays where he is*.
   */
  const beforePause = await read(cdp);
  await tap(cdp, beforePause.controls);
  const afterPause = await read(cdp);
  stages.pause = { before: beforePause, after: afterPause };
  check(same(afterPause.route, playlistRoute), 'a tap on play/pause leaves the route alone', afterPause.route);
  check(afterPause.nowHidden, 'and does not bring the now screen up');
  check(afterPause.engineState === 'paused', 'and it really paused the transport', afterPause.engineState);
  check(afterPause.glyph !== beforePause.glyph, 'with the play glyph following the state', `${beforePause.glyph} → ${afterPause.glyph}`);
  check(afterPause.rowCount === beforePause.rowCount, 'and the playlist is still the rendered view', `${afterPause.rowCount} rows`);
  check(afterPause.pagerSettled, 'and the pager did not move', afterPause.pager);

  await tap(cdp, afterPause.controls);
  const afterResume = await read(cdp);
  check(same(afterResume.route, playlistRoute), 'and playing again leaves it alone too', afterResume.route);
  check(afterResume.engineState === 'playing', 'with the transport playing', afterResume.engineState);

  /*
   * 2. Next and previous: the bar's title follows the track, and the route and the scroll offset do
   *    not move. `next` then `previous` lands back on the track this run started on.
   */
  const titleBeforeSkip = afterResume.barTitle;
  const scrollBeforeSkip = afterResume.scrollTop;
  await tap(cdp, { x: afterResume.controls.left + 20, y: afterResume.controls.y }); // the previous button
  const afterPrevious = await read(cdp);
  await tap(cdp, { x: afterPrevious.controls.right - 20, y: afterPrevious.controls.y }); // the next button
  const afterNext = await read(cdp);
  stages.skip = { titleBeforeSkip, afterPrevious: afterPrevious.barTitle, afterNext: afterNext.barTitle };
  check(afterPrevious.barTitle !== titleBeforeSkip, 'previous changes the song on the bar', `${titleBeforeSkip} → ${afterPrevious.barTitle}`);
  check(afterNext.barTitle !== afterPrevious.barTitle, 'and next changes it again', `${afterPrevious.barTitle} → ${afterNext.barTitle}`);
  check(same(afterNext.route, playlistRoute), 'both skips leave the route alone', afterNext.route);
  check(afterNext.nowHidden, 'and neither brings the now screen up');
  check(afterNext.scrollTop === scrollBeforeSkip, 'and neither scrolls a list it was not asked to scroll', `${scrollBeforeSkip} → ${afterNext.scrollTop}`);

  /*
   * 3. **The proven defect: a tap on a time label beside the seek bar.** That `span` is not a button,
   *    so the tag-list guard let it through and it opened the now screen. It is inert now.
   */
  const afterLabelTap = await read(cdp);
  stages.timeLabel = afterLabelTap.timeLabelRegion;
  check(
    afterLabelTap.timeLabelRegion.inSongBlock === false && afterLabelTap.timeLabelRegion.tag === 'SPAN',
    'the seek bar’s own time label is a span outside the song block (so the tap below is a real one)',
    afterLabelTap.timeLabelRegion,
  );
  await tap(cdp, afterLabelTap.timeLabel);
  const afterLabel = await read(cdp);
  check(same(afterLabel.route, playlistRoute), 'a tap on the time label does nothing at all', afterLabel.route);
  check(afterLabel.nowHidden, 'and still does not open the now screen');

  /*
   * 4. And the gap: inside the bar, between the title block and the transport buttons, there is a
   *    12 px gutter. The old guard navigated from it; nothing happens there now.
   */
  stages.gap = afterLabel.gapRegion;
  check(afterLabel.gapRegion.region === 'bar-other', 'the point between the song block and the transport row is the bar’s own gutter', afterLabel.gapRegion);
  await tap(cdp, afterLabel.gap);
  const afterGap = await read(cdp);
  check(same(afterGap.route, playlistRoute), 'a tap in that gutter does nothing at all', afterGap.route);
  check(afterGap.nowHidden, 'and does not open the now screen');

  /* ---------------------------------------------------------------- item 4 */

  /*
   * 5. A long playlist, scrolled so the playing row is off the screen: **one tap centres it and does
   *    not navigate.** The offset is read synchronously after the click's own task (the tap helper
   *    waits, and the app writes `scrollTop` in the click handler, so this is not a race).
   */
  await evaluate(cdp, `document.querySelector('.view-scroll').scrollTop = 0; true`);
  await wait(200);
  const beforeCentre = await read(cdp);
  const box = beforeCentre.scrollBox;
  const off = beforeCentre.playingRow !== null && (beforeCentre.playingRow.top > box.bottom || beforeCentre.playingRow.bottom < box.top);
  check(off, 'the playing row starts off the screen (otherwise check 5 could not prove anything)', {
    row: beforeCentre.playingRow && { top: Math.round(beforeCentre.playingRow.top), bottom: Math.round(beforeCentre.playingRow.bottom) },
    box: { top: Math.round(box.top), bottom: Math.round(box.bottom) },
  });
  await tap(cdp, beforeCentre.meta);
  const afterCentre = await read(cdp);
  stages.centre = { before: beforeCentre, after: afterCentre };
  const rowCentre = afterCentre.playingRow ? afterCentre.playingRow.top + afterCentre.playingRow.height / 2 : null;
  const boxCentre = (box.top + box.bottom) / 2;
  check(same(afterCentre.route, playlistRoute), 'a tap on the song block while the row is off-screen does not navigate', afterCentre.route);
  check(afterCentre.nowHidden, 'and does not open the now screen');
  check(
    rowCentre !== null && Math.abs(rowCentre - boxCentre) <= 6,
    'and it centres the playing row in the scroll box',
    `row centre ${rowCentre === null ? 'no row' : Math.round(rowCentre)} vs box centre ${Math.round(boxCentre)}`,
  );
  check(afterCentre.scrollTop !== beforeCentre.scrollTop, 'by scrolling, which is the only thing that changed', `${beforeCentre.scrollTop} → ${afterCentre.scrollTop}`);

  /*
   * 6. The second tap: the row is on screen in full now, so the same tap opens the now screen on the
   *    spectrum pane.
   */
  await tap(cdp, afterCentre.meta);
  const afterOpen = await read(cdp);
  stages.secondTapOpens = afterOpen;
  check(same(afterOpen.route, '#/now'), 'the second tap opens the now screen', afterOpen.route);
  check(afterOpen.nowHidden === false, 'the now overlay is up');
  check(afterOpen.nowMode === 'spectrum', 'on the spectrum pane', afterOpen.nowMode);

  /*
   * 7. Back on the playlist with the playing row already fully visible: **one tap** opens the now
   *    screen. The scroll is set so the row is in the middle of the box, which is what the rule calls
   *    visible (and it is the state check 5 left the list in).
   */
  await evaluate(cdp, `location.hash = ${JSON.stringify(playlistRoute)}; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '${playlistRoute}' && document.querySelector('.row.song.playing') !== null", 'the playlist again')`);
  await wait(300);
  const visible = await read(cdp);
  await tap(cdp, visible.meta);
  const afterVisibleTap = await read(cdp);
  stages.visibleOpensOnFirstTap = { before: visible, after: afterVisibleTap };
  check(
    visible.playingRow !== null && visible.playingRow.top >= visible.scrollBox.top && visible.playingRow.bottom <= visible.scrollBox.bottom,
    'the playing row is fully on screen before that tap (which is what makes it a one-tap case)',
    visible.playingRow && { top: Math.round(visible.playingRow.top), bottom: Math.round(visible.playingRow.bottom) },
  );
  check(same(afterVisibleTap.route, '#/now'), 'one tap opens the now screen when the row is already visible', afterVisibleTap.route);
  check(afterVisibleTap.nowMode === 'spectrum', 'again on the spectrum pane', afterVisibleTap.nowMode);

  /*
   * 8. And a view with no row for the song at all — the Library tab lists artists. There is nothing
   *    to centre, so one tap opens the now screen, which is today's behaviour and the decision this
   *    item records.
   */
  await evaluate(cdp, `location.hash = '#/artists'; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '#/artists' && document.querySelectorAll('.row').length > 0", 'the artists')`);
  await wait(300);
  const noRows = await read(cdp);
  check(noRows.rowCount === 0, 'the Library tab has no song rows at all', `${noRows.rowCount} song rows`);
  await tap(cdp, noRows.meta);
  const afterArtistsTap = await read(cdp);
  stages.artistsOpens = afterArtistsTap;
  check(same(afterArtistsTap.route, '#/now'), 'one tap opens the now screen on a view with no row to centre', afterArtistsTap.route);

  /*
   * 9. **The drag.** A finger that goes down on the song block and travels 100 px to the right: the
   *    pager is entitled to that gesture, and the click it leaves behind must be refused — no route
   *    change and no scroll from the tap handler.
   */
  await evaluate(cdp, `location.hash = ${JSON.stringify(playlistRoute)}; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '${playlistRoute}' && document.querySelector('.row.song.playing') !== null", 'the playlist once more')`);
  await wait(300);
  await evaluate(cdp, `document.querySelector('.view-scroll').scrollTop = 240; true`);
  await wait(200);
  const beforeDrag = await read(cdp);
  await drag(cdp, { x: beforeDrag.meta.x, y: beforeDrag.meta.y }, { x: beforeDrag.meta.x + 100, y: beforeDrag.meta.y });
  await wait(400);
  const afterDrag = await read(cdp);
  stages.drag = { before: beforeDrag, after: afterDrag };
  check(same(afterDrag.route, playlistRoute), 'a 100 px drag starting on the song block changes no route', afterDrag.route);
  check(afterDrag.nowHidden, 'and does not open the now screen');
  check(afterDrag.scrollTop === beforeDrag.scrollTop, 'and the click it left behind did not scroll the list', `${beforeDrag.scrollTop} → ${afterDrag.scrollTop}`);
  check(afterDrag.pagerSettled, 'and the pager settled', afterDrag.pager);

  /* ======================================================================= */
  /* beta.3 · design §4.3 — the rows the shipped harness never covered        */
  /* ======================================================================= */

  /*
   * 10. **A song found by two searches in one visit** (acceptance row 10). `submit`
   *     (`src/ui/app.ts:1960-2008`) refills the same results host on every Enter and registers a
   *     fresh row for every hit, so the first result set is left detached in the registry the tap
   *     used to read — a ghost the DOM the eye reads cannot show. The check proves its own
   *     precondition before it measures anything: more song rows have been added than are on screen.
   */
  /*
   * The pane the now screen opens on is the route's own (`paneOfRoute`), and the scenes above leave
   * the strip wherever their own gestures left it: put it back on the spectrum *from the route* first,
   * so the pane this scene asserts is this scene's own fact and not the previous scene's.
   */
  await evaluate(cdp, `location.hash = '#/now'; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '#/now'", 'the now route')`);
  await evaluate(cdp, `location.hash = '#/search'; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '#/search' && document.querySelector('.field.inline') !== null", 'the search screen')`);
  await wait(250);
  await resetProbe(cdp);
  const submitSearch = `(() => {
    const input = document.querySelector('.field.inline');
    const button = Array.from(document.querySelectorAll('.page-head .button')).find((node) => node.textContent.trim() === 'Search');
    if (!input || !button) return false;
    input.value = 'track';
    button.click();
    return true;
  })()`;
  if ((await evaluate(cdp, submitSearch)) !== true) throw new Error('the search screen has no field and no button to submit with');
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("document.querySelectorAll('.row.song').length > 10", 'the first result set')`);
  await evaluate(cdp, submitSearch);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("window.__tapProbe.rows >= 2 * document.querySelectorAll('.row.song').length", 'the second result set')`,
  );
  await wait(300);
  await scrollTo(cdp, 0);
  await wait(250);
  const searchBefore = await read(cdp);
  const searchProbe = await probe(cdp);
  check(
    searchBefore.playingRowMarks === 1,
    'the search results carry exactly one mark — the playing song’s own row',
    `${searchBefore.playingRowMarks} marked of ${searchBefore.rowCount} rows`,
  );
  check(
    searchBefore.playingRowTitle !== null && searchBefore.playingRowTitle === searchBefore.barTitle,
    'and the row the app marks is the track the bar says is playing',
    `${searchBefore.playingRowTitle} vs ${searchBefore.barTitle}`,
  );
  check(
    searchProbe.rows >= 2 * searchBefore.rowCount,
    'the results host has been painted twice — the precondition a ghost needs',
    `${searchProbe.rows} song row(s) ever added, ${searchBefore.rowCount} on screen`,
  );
  stages.searchTwoSubmits = await twoTapScene(cdp, { label: 'search after two submits' });

  /*
   * 11. **The downloaded playlist, online** (acceptance row 7) — the population the owner lives in:
   *     a playlist the phone has downloaded, with the server answering. `renderPlaylist` paints the
   *     manifest's list first and the server's answer second, so the live rows are the second batch
   *     and the first one is detached — the ghost. The check reads the paint count from its own
   *     probe before it taps, and the scene itself then asserts the two taps.
   */
  const entries = await playlistEntries(url);
  const mirror = mirrorJson(url, entries);
  await seed(cdp, { mirror });
  await openPlaylistWith(cdp, 12, 2);
  await scrollTo(cdp, 0);
  await wait(250);
  const ghostBefore = await read(cdp);
  const ghostProbe = await probe(cdp);
  check(
    ghostProbe.lists === 2,
    'the downloaded playlist painted its list twice — the precondition a ghost needs',
    `${ghostProbe.lists} list(s), ${ghostProbe.rows} song row(s) ever added, ${ghostBefore.rowCount} on screen`,
  );
  stages.ghostPaints = ghostProbe;
  stages.ghostOnline = await twoTapScene(cdp, { label: 'downloaded playlist, online (row 13 of 35)' });

  /*
   * 12. **The first row of the list, with the list scrolled down** (acceptance row 2): the case the
   *     owner singles out. The row asks for an offset below the list's own top, so the tap must land
   *     clamped at `0` — fully visible, once — and the second tap must open.
   */
  await openPlaylistWith(cdp, 0, 2);
  await scrollTo(cdp, 600);
  await wait(250);
  stages.ghostFirstRow = await twoTapScene(cdp, { label: 'downloaded playlist, first row', clamp: 0 });

  /*
   * 13. **The last row, with the list at the top** (acceptance row 3): the same clamp at the other
   *     end, plus the assertion the design leaves open — the row must be clear of the player bar at
   *     the list's own limit, which is what says whether the view's end padding is enough.
   */
  await openPlaylistWith(cdp, entries.length - 1, 2);
  await scrollTo(cdp, 0);
  await wait(250);
  stages.ghostLastRow = await twoTapScene(cdp, { label: 'downloaded playlist, last row', clamp: 'max' });

  /*
   * 14. **A view whose order is not the queue's** (acceptance row 4). The album page of the song that
   *     is playing: its rows are in album order while the queue is the playlist's, so the playing
   *     song's position here and its position in the queue are different numbers — the only state in
   *     which "the row this view marks, by id" and "the row at the queue's index" are different rows.
   *     The check refuses to be vacuous: it makes sure the two positions differ before it taps, and
   *     reports SKIP with the reason when this fixture cannot show it rather than passing on nothing.
   */
  await openPlaylistWith(cdp, 12, 2);
  const albumId = entries[12].albumId;
  await evaluate(cdp, `location.hash = '#/album/${encodeURIComponent(albumId)}'; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '#/album/${albumId}' && document.querySelectorAll('.row.song').length > 0", 'the album page')`);
  await wait(300);
  const albumBefore = await read(cdp);
  const albumQueueAt = /\((\d+)\/(\d+)\)/.exec(albumBefore.queueContext || '');
  if (albumQueueAt !== null && albumBefore.playingRowIndex >= 0 && Number(albumQueueAt[1]) !== albumBefore.playingRowIndex + 1) {
    check(
      true,
      'the album page holds the playing song at a different position than the queue does (so the target cannot be an index)',
      `row ${albumBefore.playingRowIndex + 1} of ${albumBefore.rowCount} here, ${albumQueueAt[1]} of ${albumQueueAt[2]} in the queue`,
    );
  } else {
    skip(
      'the album page holds the playing song at a different position than the queue does',
      `row ${albumBefore.playingRowIndex + 1} of ${albumBefore.rowCount} here, ${albumQueueAt === null ? 'no position in' : `position ${albumQueueAt[1]} of ${albumQueueAt[2]} in`} the queue`,
    );
  }
  check(
    albumBefore.playingRowMarks === 1 && albumBefore.playingRowTitle === albumBefore.barTitle,
    'and the row this view marks is the track the bar says is playing',
    `${albumBefore.playingRowTitle} vs ${albumBefore.barTitle}`,
  );
  /*
   * A four-track album fits on one screen, so this is the one-tap case on a view whose order is not
   * the queue's: it opens, and it moves the list nothing at all.
   */
  const albumProbe = await probe(cdp);
  await tap(cdp, albumBefore.meta);
  const albumAfter = await read(cdp);
  stages.albumOrder = { before: albumBefore, after: albumAfter };
  check(same(albumAfter.route, '#/now'), 'one tap on the album page opens the now screen', albumAfter.route);
  check(albumAfter.nowMode === 'spectrum', 'on the spectrum pane', albumAfter.nowMode);
  check(
    (await probe(cdp)).scrolls - albumProbe.scrolls === 0,
    'and the tap moves the list zero times',
    `${(await probe(cdp)).scrolls - albumProbe.scrolls} scroll event(s)`,
  );

  /*
   * 15. **The same downloaded playlist with the API refused** (acceptance row 8) — the other half of
   *     the pair the design asks for. The same list, the same tap, one paint instead of two: if the
   *     fixture's failure were about *what is on the list* rather than about the second paint, this
   *     half would fail too. It must not, on either build. The app is still served from the live mock
   *     — only its API is pointed at a port nothing answers on — and the track on the bar comes from
   *     the app's **own** resume snapshot: the page standing when the dead API is seeded writes it on
   *     its way out, and the next load restores it with no server at all. A bar with no track is
   *     `display: none` and cannot be tapped, so this step is what makes this half measurable.
   */
  await openPlaylistWith(cdp, 12, 2);
  const dead = await refusedPort();
  await seed(cdp, { mirror, api: `http://127.0.0.1:${dead}` });
  await resetProbe(cdp);
  await evaluate(cdp, `location.hash = '#/${PLAYLIST_ROUTE}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '#/${PLAYLIST_ROUTE}' && document.querySelector('.row.song.playing') !== null", 'the downloaded playlist with no server')`,
  );
  await wait(600);
  await scrollTo(cdp, 0);
  await wait(250);
  const refusedProbe = await probe(cdp);
  check(
    refusedProbe.lists === 1,
    'the same playlist with the API refused paints its list once — the pair’s other half',
    `${refusedProbe.lists} list(s), ${refusedProbe.rows} song row(s) ever added`,
  );
  stages.refusedPaints = refusedProbe;
  stages.refusedServer = await twoTapScene(cdp, { label: 'downloaded playlist, API refused' });

  return { playlistRoute };
}

/* --------------------------------------------------------------------- main */

const chrome = findChrome();
if (!chrome) {
  console.error('no Chrome/Chromium binary found');
  process.exit(2);
}

const started = Date.now();
let summary = null;
try {
  await withChromePage(
    async ({ cdp }) => {
      summary = await run(cdp);
    },
    { args: ['--mute-audio'] },
  );
} catch (error) {
  failures.push(`the run threw: ${error.message}`);
  console.error(`the run threw: ${error.message}`);
}

const report = { url, chrome, ms: Date.now() - started, stages, skips, failures };
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

console.log('');
if (failures.length === 0) {
  console.log('RESULT: the bottom container behaves: transport taps act and do not navigate, the dead regions are dead, and the song block follows the two-tap rule.');
  process.exit(0);
}
console.log(`RESULT: ${failures.length} check(s) failed:`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
