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
 *   5. *"the track is still highlighted when i press to drag … or just remove the fact that tapping
 *      without releasing highlights the track at all"* — v1.6.2's own report, and the reason this
 *      harness reads **paint** and not just end state: **a press and hold of a second, then a drag,
 *      paints no row at any point in the gesture** — not while the finger is still, not during the
 *      drag, not after the release. What painted it was a CSS `:active` rule, and `:active` is on for
 *      as long as the finger is, so end state was never going to show it. The same shape of gesture
 *      is why the tap allowance moved to the documented 8 px in this release, which is why a
 *      *wobbling* tap (7 px of drift under a 900 ms press) is checked too: tightening that line is
 *      how taps get eaten again.
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

/**
 * A tap the way a thumb makes one: on the row for most of a second, and *drifting* while it is there.
 *
 * The drift tops out at 7 px of straight-line travel — inside the 8 px the app now calls a tap, and
 * about what a real thumb does while it rests. This is the check that guards the one risky edit of
 * v1.6.2, the move from 10 px per axis to the documented 8 px straight-line: tightening that line is
 * how a tap starts being refused, so the shape of gesture that goes first has to be in here.
 */
async function jitterTap(cdp, point, holdMs = 900) {
  await touchStart(cdp, point.x, point.y);
  const wander = [[0, 0], [1, 1], [2, 1], [3, 2], [4, 3], [5, 5]];
  const step = holdMs / (wander.length + 1);
  for (const [dx, dy] of wander) {
    await wait(step);
    await touchMove(cdp, point.x + dx, point.y + dy);
  }
  await wait(step);
  await touchEnd(cdp);
  await wait(280);
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

/**
 * Every row that is *painted* right now — a background of its own, or an inset ring. A row at rest is
 * `background: transparent` and `box-shadow: none` (`.row` in src/styles.css), so anything in this
 * list is paint that somebody put there on purpose.
 *
 * This is the read v1.6.1 had no way of making: the highlight he was complaining about lived entirely
 * *between* `touchstart` and `touchend` (a CSS `:active` rule), so a harness that only ever looked at
 * the screen after a gesture — which this one did, and which is why the four checks above all passed
 * while the bug shipped — could not see it.
 */
const PAINT = `(() => {
  const painted = [];
  for (const row of document.querySelectorAll('.row')) {
    const style = getComputedStyle(row);
    if (style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.boxShadow === 'none') continue;
    const box = row.getBoundingClientRect();
    painted.push({
      title: (row.querySelector('.row-title') || {}).textContent || null,
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
      playing: row.classList.contains('playing'),
      hovered: row.matches(':hover'),
      pressed: row.matches(':active'),
      y: Math.round(box.top + box.height / 2),
    });
  }
  return painted;
})()`;
const paint = (cdp) => evaluate(cdp, PAINT);

/**
 * The painted rows that are not the currently-playing one. `.row.song.playing` — "this is the track
 * playing" — is a different statement from "you are touching this row", and the card for this release
 * is explicit that it stays exactly as it is, so it is excluded rather than asserted on.
 */
const pressPaint = (rows) => rows.filter((row) => !row.playing);

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

/**
 * Item 5, the report that opened v1.6.2: **pressing a row must not paint it.**
 *
 * The gesture is his, exactly: a finger down on a track, held *still* for a full second, and only then
 * dragged to scroll. Paint is sampled while the finger is still — that is where the old
 * `.row.song:active` plate appeared, before the thumb had moved a pixel — and again at every step of
 * the drag and after the release, so the check covers the whole gesture rather than its aftermath.
 */
async function pressHoldThenDragScenario(cdp) {
  const route = '#/playlist/pl-stress-long';
  await evaluate(cdp, `location.hash = '${route}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '${route}' && document.querySelectorAll('.row.song').length > 10", 'the playlist rows')`,
  );
  await wait(160);
  /*
   * Take the desktop mouse out of the picture first, and do not read the row before that: it stays
   * wherever the last `trustedClick` left it, and this Chrome is a desktop — it matches
   * `@media (hover: hover) and (pointer: fine)`, so the row under the parked cursor is *already*
   * painted `rgb(20, 20, 28)` before any finger arrives (measured: the first run of this check failed
   * on exactly that, `hovered: true`, with no touch involved). A finger is `hover: none` / `pointer:
   * coarse`, where that rule does not exist at all — and Chrome will not pretend otherwise for a page,
   * `Emulation.setEmulatedMedia`'s `features` list not covering `hover`/`pointer` (tried: accepted, no
   * effect). So the mouse is parked in the top bar instead, which leaves the harness *stricter* than
   * the phone rather than looser: Chrome keeps the hover rule live and the check still requires that
   * nothing paints while a finger is down.
   */
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 6, button: 'none' });
  await wait(80);
  const before = await state(cdp);
  const row = visibleRow(before, 2);
  const resting = pressPaint(await paint(cdp));
  const samples = [];

  await touchStart(cdp, row.x, row.y);
  await wait(1000);
  samples.push({ at: 'held for 1 s, never moved', painted: pressPaint(await paint(cdp)) });
  for (let index = 1; index <= 6; index += 1) {
    await wait(16);
    await touchMove(cdp, row.x, row.y + index * 34);
    samples.push({ at: `dragged ${index * 34} px`, painted: pressPaint(await paint(cdp)) });
  }
  await wait(16);
  samples.push({ at: 'still down, drag over', painted: pressPaint(await paint(cdp)) });
  await touchEnd(cdp);
  await wait(240);
  samples.push({ at: 'after the release', painted: pressPaint(await paint(cdp)) });

  const after = await state(cdp);
  const lit = samples.filter((sample) => sample.painted.length > 0);
  stages.pressHoldThenDrag = {
    row: row.title,
    at: { x: Math.round(row.x), y: Math.round(row.y) },
    holdMs: 1000,
    travelPx: 6 * 34,
    paintedAtRest: resting,
    samples,
    route: after.route,
    playing: after.playing,
  };
  check(
    'pressing a row paints nothing — a 1 s hold then a drag highlights no row at any point',
    resting.length === 0 && lit.length === 0,
    lit.length === 0
      ? `${samples.length} samples over a 1 s hold and ${6 * 34} px of travel: ${row.title} and every other row stayed unpainted`
      : `painted at ${lit.map((sample) => `${sample.at} → ${sample.painted.map((row) => `${row.title} [${row.background}${row.pressed ? ', :active' : ''}${row.hovered ? ', hovered' : ''}]`).join(', ')}`).join('; ')}`,
  );
  check(
    'the held press that turns into a drag still starts nothing',
    after.route === route && after.playing === before.playing,
    `route ${after.route} · playing ${String(after.playing)} (was ${String(before.playing)})`,
  );
  return route;
}

/**
 * The other direction, and the guard on this release's one risky edit: the tap allowance moved from
 * 10 px *per axis* to the documented 8 px straight-line, and refusing clicks is precisely how v1.6
 * broke tapping. A thumb that rests on a row for 900 ms and drifts 7 px is still a tap, and it has to
 * play the song it was on.
 */
async function jitterTapScenario(cdp, route) {
  await evaluate(cdp, `location.hash = '${route}'; true`);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor("location.hash === '${route}' && document.querySelectorAll('.row.song').length > 10", 'the playlist rows')`,
  );
  await wait(120);
  const row = visibleRow(await state(cdp), 3);
  await jitterTap(cdp, { x: row.x, y: row.y }, 900);
  const after = await state(cdp);
  stages.jitterTap = { title: row.title, holdMs: 900, driftPx: 7, route: after.route, playing: after.playing, nowTitle: after.nowTitle };
  check(
    'a tap that drifts 7 px under a 900 ms press still plays the row it was on',
    after.playing !== null && after.nowTitle === row.title,
    `route ${after.route} · playing ${String(after.playing)} · now showing ${String(after.nowTitle)} vs row ${String(row.title)}`,
  );
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
  // v1.6.2: the same surface, read for *paint* rather than for end state — he presses and holds
  // before he swipes, and the row under his thumb must not light up while it waits.
  const stressPlaylist = await pressHoldThenDragScenario(cdp);
  await jitterTapScenario(cdp, stressPlaylist);
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
lines.push('v1.6 — rows take taps, settings is not a pane, and a press paints nothing');
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
lines.push(`    hold 1 s + drag:    ${JSON.stringify(report.stages.pressHoldThenDrag)}`);
lines.push(`    jitter tap:         ${JSON.stringify(report.stages.jitterTap)}`);
lines.push(`    settings left:      ${JSON.stringify(report.stages.settingsLeftDrag)}`);
lines.push(`    settings right:     ${JSON.stringify(report.stages.settingsRightDrag)}`);
lines.push(
  failed.length === 0
    ? 'RESULT: a scroll selects nothing and a tap plays; a press paints nothing; settings is not part of the pager.'
    : `RESULT: ${failed.length} check(s) failed.`,
);
console.log(lines.join('\n'));
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
