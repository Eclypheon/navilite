#!/usr/bin/env node
/**
 * The check for what a *finger* is allowed to do on a row, and what it may not do on settings.
 *
 * Three of the owner's reports live here, and each is about a gesture's *shape* rather than its end
 * state, so none can be judged from the DOM after the fact:
 *
 *   1. *"i'm not even able to tap to go into my playlist now"* — v1.6 refused the click a scroll
 *      leaves behind so thoroughly that it refused plain taps: **a plain tap on a playlist row opens
 *      that playlist**, a plain tap on a song row plays it, and a tap whose press lasted 900 ms — a
 *      deliberate tap, which WebKit answers *after* `touchend` — is still a tap. This is the direction
 *      v1.6 shipped without testing, which is why it shipped broken.
 *
 *   2. *"when in playlist, trying to swipe to scroll seems to highlight the song i don't want this,
 *      only if i tap the song without dragging or swiping should the song be selected"* — a real
 *      200 px vertical drag through Chrome's own input pipeline (`Input.dispatchTouchEvent`, so the
 *      scroll is a real scroll and not an in-page `TouchEvent`) must select **nothing**, and the click
 *      the browser delivers at the end of such a drag must be refused too. That click is a *trusted*
 *      one — WebKit produces it, Chrome does not, so the harness asks Chrome's input pipeline for a
 *      trusted click at the row's coordinates rather than dispatching an event by hand.
 *
 *   3. After all of that, **the next plain tap still works**: the refusal is a one-shot, consumed by
 *      the click it belongs to, so nothing may be left over to eat the tap that follows.
 *
 *   4. *"when im in settings, swiping left or right seems to bring me to the spectrum or lyrics.
 *      this should not be the case, i should only be able to swipe right to return to the previous
 *      screen which i accessed settings from"* — from settings a left drag moves nothing (route
 *      unchanged, offset 0, no transform written by the pager) and a right drag returns to the
 *      *opener*: the playlist the gear was tapped on, not `#/now`.
 *
 *   node tools/mock-subsonic.mjs --port 4651 --stress --dist dist
 *   node tools/v16-check.mjs --url http://127.0.0.1:4651 [--json report.json]
 *
 * Exit code is non-zero when a check fails.
 */
import { writeFileSync } from 'node:fs';
import { withChromePage, navigate, evaluate } from './layout-audit.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (a, b, tolerance = 0.51) => Math.abs(a - b) <= tolerance;

const checks = {};
const stages = {};
function check(label, ok, detail) {
  checks[label] = { ok: Boolean(ok), detail };
  return Boolean(ok);
}

const args = process.argv.slice(2);
const url = args[args.indexOf('--url') + 1];
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!url) {
  console.error('usage: node tools/v16-check.mjs --url http://127.0.0.1:PORT [--json report.json]');
  process.exit(2);
}

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

/** One finger from `from` to `to`, `steps` moves, so the browser reads a real gesture. */
async function drag(cdp, from, to, steps = 8, gapMs = 16) {
  await touchStart(cdp, from.x, from.y);
  for (let index = 1; index <= steps; index += 1) {
    await wait(gapMs);
    await touchMove(cdp, from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps);
  }
  await wait(gapMs);
  await touchEnd(cdp);
  await wait(220);
}

/** A tap: down and up on the same pixel, which is what Chrome turns into a click. */
async function tap(cdp, point) {
  await touchStart(cdp, point.x, point.y);
  await wait(40);
  await touchEnd(cdp);
  await wait(260);
}

/**
 * The same tap, held down. A deliberate tap is still a tap — v1.6 refused a click whose press had
 * lasted more than 700 ms, and WebKit delivers the click *after* `touchend`, so this is the shape of
 * tap that went dead on the phone while a synthetic 40 ms tap kept passing here.
 */
async function slowTap(cdp, point, holdMs = 900) {
  await touchStart(cdp, point.x, point.y);
  await wait(holdMs);
  await touchEnd(cdp);
  await wait(260);
}

/**
 * The click a drag leaves behind, delivered the way the browser delivers it: through the input
 * pipeline, at the row's own coordinates, and therefore *trusted*.
 *
 * Chrome never produces this click for a touch scroll (that is WebKit's behaviour, and the reason
 * v1.6 had to refuse anything with a touch phase behind it), so the harness asks its own pipeline for
 * a mouse click there instead of dispatching an event by hand. The difference matters: the app refuses
 * a *trusted* click that follows a drag and ignores one a script synthesises, so a hand-made
 * `MouseEvent` would prove nothing about the refusal.
 */
async function trustedClick(cdp, point) {
  const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  await wait(240);
}

/* --------------------------------------------------------------- page reads */

const STATE = `(() => {
  const nav = window.__navilite;
  const boxes = Array.from(document.querySelectorAll('.row.song')).map((row) => {
    const box = row.getBoundingClientRect();
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      top: box.top,
      title: (row.querySelector('.row-title') || {}).textContent || null,
      transform: getComputedStyle(row).transform,
    };
  });
  const scroll = document.querySelector('.view-scroll');
  return {
    route: location.hash,
    playing: nav.tracks().playing,
    nowTitle: (document.querySelector('.now-title') || {}).textContent || null,
    pager: nav.pager(),
    listTransform: scroll ? getComputedStyle(scroll).transform : null,
    overlayTransform: getComputedStyle(document.querySelector('.now')).transform,
    scrollTop: scroll ? scroll.scrollTop : 0,
    rows: boxes,
    rowCount: boxes.length,
  };
})()`;

const state = (cdp) => evaluate(cdp, STATE);

/** The playlist *list* — `#/playlists`, where a row opens a playlist rather than playing a song. */
const PLAYLISTS = `(() => {
  const rows = Array.from(document.querySelectorAll('button.row:not(.song)')).map((row) => {
    const box = row.getBoundingClientRect();
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      top: box.top,
      title: (row.querySelector('.row-title') || {}).textContent || null,
    };
  });
  return { route: location.hash, rows, playing: window.__navilite.tracks().playing };
})()`;

/* ----------------------------------------------------------------- scenarios */

async function seed(cdp) {
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

/**
 * A row whose centre is comfortably inside the screen, so a finger at those coordinates really
 * lands on it (the list is 2,000 px tall and scrolls, so "the third row" is not always visible).
 */
function visibleRow(snapshot, index = 0) {
  const usable = snapshot.rows.filter((row) => row.y > 140 && row.y < 660);
  return usable[Math.min(index, usable.length - 1)] ?? snapshot.rows[0];
}

/**
 * Item 1, the report that opened this card: **a plain tap on a playlist row opens that playlist.**
 *
 * The owner: *"i'm not even able to tap to go into my playlist now"*. A playlist row is the plainest
 * activation there is — no queue, no transport, just a route — so it is the one to test first, and it
 * is the one v1.6 broke.
 */
async function playlistRowsScenario(cdp) {
  const route = '#/playlists';
  await evaluate(cdp, `location.hash = '${route}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '${route}' && document.querySelectorAll('button.row:not(.song)').length > 0", 'the playlist rows')`,
  );
  const before = await evaluate(cdp, PLAYLISTS);
  const row = visibleRow(before, 0);
  await tap(cdp, { x: row.x, y: row.y });
  const after = await state(cdp);
  stages.tapOnPlaylistRow = { title: row.title, route: after.route, playing: after.playing };
  check(
    'a plain tap on a playlist row opens that playlist',
    after.route.startsWith('#/playlist/') && after.route !== route,
    `tapped ${String(row.title)} → route ${after.route}`,
  );
}

/** Item 1: a drag that scrolls the list selects nothing; a tap plays. */
async function rowsScenario(cdp) {
  // The card's own screen: a playlist long enough that a thumb drag really scrolls it (35 rows,
  // ~2,000 px at 393 px wide — see the `--stress` fixture in tools/mock-subsonic.mjs).
  const route = '#/playlist/pl-stress-long';
  await evaluate(cdp, `location.hash = '${route}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '${route}' && document.querySelectorAll('.row.song').length > 10", 'the playlist rows')`,
  );
  const before = await state(cdp);
  const routeBefore = before.route;
  const row = visibleRow(before, 2);

  // 200 px of vertical travel, one finger, through Chrome's own input pipeline.
  await drag(cdp, { x: row.x, y: row.y }, { x: row.x, y: row.y + 200 });
  const afterDrag = await state(cdp);
  stages.touchDragOnRow = { from: { x: row.x, y: row.y }, travel: 200, route: afterDrag.route, playing: afterDrag.playing };
  check(
    'a 200 px touch drag over a song row starts nothing',
    afterDrag.route === routeBefore && afterDrag.playing === null,
    `route ${afterDrag.route} · playing ${String(afterDrag.playing)}`,
  );

  // The same 200 px as a *scrolling* gesture, so the list provably moves: this is what the owner's
  // thumb does when he means to scroll, and it must select nothing either.
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(row.x),
    y: Math.round(row.y),
    xDistance: 0,
    yDistance: -200,
    gestureSourceType: 'touch',
    speed: 900,
    preventFling: true,
  });
  await wait(300);
  const afterScroll = await state(cdp);
  stages.scrollOnRows = { yDistance: -200, scrollTop: afterScroll.scrollTop, route: afterScroll.route, playing: afterScroll.playing };
  check(
    'the same drag scrolls the list and still starts nothing',
    afterScroll.scrollTop > 40 && afterScroll.route === routeBefore && afterScroll.playing === null,
    `scrollTop ${afterScroll.scrollTop.toFixed(0)} · route ${afterScroll.route} · playing ${String(afterScroll.playing)}`,
  );

  /*
   * And the click WebKit puts at the end of that drag — the one Chrome never produces for a
   * scrolling gesture, and so the one this harness has to deliver itself. It goes to the row the drag
   * started on (which moved up the screen with the list), and it is delivered as a *trusted* click,
   * which is the only kind the app may refuse. The row must refuse it.
   */
  const draggedRow = (await state(cdp)).rows[2];
  await trustedClick(cdp, { x: draggedRow.x, y: draggedRow.y });
  const afterLateClick = await state(cdp);
  stages.lateClick = { at: { x: draggedRow.x, y: draggedRow.y }, row: draggedRow.title, route: afterLateClick.route, playing: afterLateClick.playing };
  check(
    'the click a scroll leaves behind is refused',
    afterLateClick.route === routeBefore && afterLateClick.playing === null,
    `route ${afterLateClick.route} · playing ${String(afterLateClick.playing)}`,
  );

  /*
   * Item 4 — **the tap after a drag has to work too.** The refusal the drag armed is a one-shot: the
   * click above consumed it, and nothing may be left over to eat this tap. This is the direction v1.6
   * shipped without testing, and it is the one the owner is complaining about.
   */
  const tapped = visibleRow(await state(cdp), 2);
  await tap(cdp, { x: tapped.x, y: tapped.y });
  const afterTap = await state(cdp);
  stages.tapOnRow = { title: tapped.title, route: afterTap.route, playing: afterTap.playing, nowTitle: afterTap.nowTitle };
  check(
    'after a drag, the next plain tap still works',
    afterTap.route === '#/now' && afterTap.playing !== null,
    `route ${afterTap.route} · playing ${String(afterTap.playing)}`,
  );
  check(
    'that tap played the song it was on and opened the now screen',
    afterTap.playing !== null && afterTap.nowTitle === tapped.title,
    `playing ${String(afterTap.playing)} · now showing ${String(afterTap.nowTitle)} vs row ${String(tapped.title)}`,
  );

  /*
   * And the refusal v1.6 laid over the top of all of this: a press it judged *slow*. WebKit delivers
   * the click after `touchend`, so any duration threshold can refuse a tap that was never a drag.
   * 900 ms on one pixel is still a tap.
   */
  await evaluate(cdp, `location.hash = '${routeBefore}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '${routeBefore}' && document.querySelectorAll('.row.song').length > 10", 'the playlist rows again')`,
  );
  const slow = visibleRow(await state(cdp), 3);
  await slowTap(cdp, { x: slow.x, y: slow.y }, 900);
  const afterSlow = await state(cdp);
  stages.slowTap = { title: slow.title, holdMs: 900, route: afterSlow.route, playing: afterSlow.playing, nowTitle: afterSlow.nowTitle };
  check(
    'a deliberate 900 ms tap is not refused for being slow',
    afterSlow.playing !== null && afterSlow.nowTitle === slow.title,
    `route ${afterSlow.route} · playing ${String(afterSlow.playing)} · now showing ${String(afterSlow.nowTitle)} vs row ${String(slow.title)}`,
  );
  return routeBefore;
}

/** Item 2: settings is not a pane; only a right drag does anything, and it goes back. */
async function settingsScenario(cdp, opener) {
  // Leave the now screen the way the app does, then walk to the album screen and open settings with
  // the gear — the app's own path, so the opener is recorded the way a thumb would record it.
  await evaluate(cdp, `location.hash = '${opener}'; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '${opener}'", 'the opener screen')`);
  await evaluate(cdp, `document.querySelector('.topbar .icon-button[aria-label="Settings"]').click(); true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '#/settings'", 'settings')`);
  await wait(120);
  const onSettings = await state(cdp);

  // A left drag: nothing may move — not the route, not the pager, not a transform.
  await drag(cdp, { x: 330, y: 420 }, { x: 90, y: 416 });
  const afterLeft = await state(cdp);
  stages.settingsLeftDrag = {
    route: afterLeft.route,
    pager: afterLeft.pager,
    listTransform: afterLeft.listTransform,
    overlayTransform: afterLeft.overlayTransform,
  };
  check(
    'a left drag on settings moves nothing',
    afterLeft.route === '#/settings' &&
      afterLeft.pager.position === 0 &&
      near(afterLeft.pager.offset, 0) &&
      afterLeft.listTransform === 'none' &&
      (afterLeft.overlayTransform === 'none' || afterLeft.overlayTransform === ''),
    `route ${afterLeft.route} · pager ${JSON.stringify(afterLeft.pager)} · list ${afterLeft.listTransform} · overlay ${afterLeft.overlayTransform}`,
  );
  check(
    'settings left nothing half-translated',
    onSettings.route === '#/settings' && afterLeft.rows.length === 0,
    `rows on the settings screen: ${afterLeft.rows.length}`,
  );

  // A right drag: back to the screen settings was opened from — the album, not the playlist.
  await drag(cdp, { x: 70, y: 420 }, { x: 330, y: 416 });
  const afterRight = await state(cdp);
  stages.settingsRightDrag = { route: afterRight.route, opener };
  check(
    'a right drag on settings returns to the screen it was opened from',
    afterRight.route === opener,
    `route ${afterRight.route}, expected the opener ${opener}`,
  );
}

/* --------------------------------------------------------------------- run */

const report = await withChromePage(async ({ cdp, safeArea }) => {
  await seed(cdp);
  await playlistRowsScenario(cdp);
  const opener = await rowsScenario(cdp);
  // The row tap left the app on the now screen; the opener for settings is the album.
  await settingsScenario(cdp, opener);
  return {
    tool: 'tools/v16-check.mjs',
    device: { width: 393, height: 852, deviceScaleFactor: 3 },
    safeArea,
    checks,
    stages,
    pager: await evaluate(cdp, `window.__navilite.pager()`),
  };
});

const failed = Object.entries(report.checks).filter(([, value]) => !value.ok);
const lines = [];
lines.push('v1.6 — rows take taps, settings is not a pane');
lines.push(`  device: 393x852 CSS px, dpr 3 (${report.safeArea ?? 'no safe-area override'})`);
for (const [label, value] of Object.entries(report.checks)) {
  lines.push(`  ${value.ok ? 'ok  ' : 'FAIL'} ${label} — ${value.detail ?? ''}`);
}
lines.push('');
lines.push('  measured:');
lines.push(`    tap on a playlist row: ${JSON.stringify(report.stages.tapOnPlaylistRow)}`);
lines.push(`    drag on a row:      ${JSON.stringify(report.stages.touchDragOnRow)}`);
lines.push(`    click after drag:   ${JSON.stringify(report.stages.lateClick)}`);
lines.push(`    tap after the drag: ${JSON.stringify(report.stages.tapOnRow)}`);
lines.push(`    slow tap (900 ms):  ${JSON.stringify(report.stages.slowTap)}`);
lines.push(`    settings left:      ${JSON.stringify(report.stages.settingsLeftDrag)}`);
lines.push(`    settings right:     ${JSON.stringify(report.stages.settingsRightDrag)}`);
lines.push(
  failed.length === 0
    ? 'RESULT: a scroll selects nothing and a tap plays; settings is not part of the pager.'
    : `RESULT: ${failed.length} check(s) failed.`,
);
console.log(lines.join('\n'));
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
