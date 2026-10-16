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
 *      tap it again and you get the spectrum… if the song is already on the screen, one tap takes
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
import { withChromePage, evaluate, navigate, findChrome } from './layout-audit.mjs';

const args = process.argv.slice(2);
const url = args[args.indexOf('--url') + 1];
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!url) {
  console.error('usage: node tools/container-tap-check.mjs --url http://127.0.0.1:PORT [--json report.json]');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    playingRowTitle: nav.playingRow(),
    playingRow: boxOf(row),
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

/* ------------------------------------------------------------------ reports */

const failures = [];
const stages = {};

function check(ok, message, detail) {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}${detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
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

async function seed(cdp) {
  await clearSavedQueue();
  await navigate(cdp, url);
  await evaluate(
    cdp,
    `(() => {
      localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(url)}, username: 'navidrome', playback: 'web' }));
      localStorage.setItem('navilite.subsonic-password', 'navidrome');
      return true;
    })()`,
  );
  await navigate(cdp, url);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library')`);
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

const report = { url, chrome, ms: Date.now() - started, stages, failures };
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

console.log('');
if (failures.length === 0) {
  console.log('RESULT: the bottom container behaves: transport taps act and do not navigate, the dead regions are dead, and the song block follows the two-tap rule.');
  process.exit(0);
}
console.log(`RESULT: ${failures.length} check(s) failed:`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
