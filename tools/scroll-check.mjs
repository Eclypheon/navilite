#!/usr/bin/env node
/**
 * The scroll-containment check (v1.4): what moves when you scroll, in a real browser.
 *
 * The owner's two reports are both about movement:
 *
 *   "if i'm in my playlist then i go to my spectrum view, when i scroll, it seems to scroll the
 *    playlist behind it."
 *   "next, i should not be able to scroll the top bar of the main app such that it takes up more
 *    space"
 *
 * A DOM assertion cannot catch either one, because both defects are about the *scroll pipeline*:
 * a gesture over the fixed now-playing overlay chaining into a document that is still the scroll
 * context, and a document-level rubber-band dragging the header with it. So this driver fires real
 * scroll gestures through the input pipeline (`Input.synthesizeScrollGesture` with a touch source,
 * and a real wheel event) and reads positions around them:
 *
 *   1. the list is scrolled, then a real gesture scrolls it further — the control that proves the
 *      gesture mechanism works at all, and the case the top bar has to survive;
 *   2. the top bar's `getBoundingClientRect()` is identical before and after every gesture;
 *   3. the spectrum is opened over the list, gestures are fired at the overlay, and the list's
 *      `scrollTop` **and** the document's must both be exactly where they were;
 *   4. closing the spectrum puts the list back at exactly the offset it was left at;
 *   5. the layout guard still bites: a deliberately too-wide element is injected into the app's
 *      scroll container and the 393 px audit has to report it — otherwise making the shell stop
 *      scrolling would have quietly disarmed the owner's own regression test.
 *
 * Everything runs at 393 x 852, dpr 3, with `Emulation.setSafeAreaInsetsOverride` (top 59,
 * bottom 34): the iPhone 15 Pro's own numbers.
 *
 *   node tools/mock-subsonic.mjs --port 4631 --stress --dist dist
 *   node tools/scroll-check.mjs --url http://127.0.0.1:4631 [--json report.json]
 *
 * Exit code is non-zero when anything moved that should not have.
 */
import { writeFileSync } from 'node:fs';
import { withChromePage, navigate, evaluate } from './layout-audit.mjs';

const IN_PAGE = 'window.__naviliteLayoutAudit.';

/** A real touch scroll, through the compositor — not a dispatched event that moves nothing. */
async function touchScroll(cdp, x, y, distance, speed = 900) {
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(x),
    y: Math.round(y),
    xDistance: 0,
    yDistance: distance,
    gestureSourceType: 'touch',
    speed,
    preventFling: true,
  });
}

/** A real wheel event, likewise: it goes through the same scroll chaining a finger would. */
async function wheelScroll(cdp, x, y, deltaY) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX: 0,
    deltaY,
    pointerType: 'mouse',
    button: 'none',
  });
}

const state = (cdp) => evaluate(cdp, `${IN_PAGE}scrollState()`);
const sameRect = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  const url = argv.get('url') ?? 'http://127.0.0.1:4631';
  const jsonPath = argv.get('json');
  const username = argv.get('username') ?? 'navidrome';
  const password = argv.get('password') ?? 'navidrome';

  const lines = [];
  const failures = [];
  const readings = { url, gestures: [], states: {}, checks: {} };
  const say = (text) => lines.push(text);

  const check = (label, ok, detail) => {
    readings.checks[label] = { ok, detail };
    if (!ok) failures.push(`${label} — ${detail}`);
    say(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
    if (detail) say(`      ${detail}`);
    return ok;
  };

  await withChromePage(
    async ({ cdp, safeArea }) => {
      await navigate(cdp, url);
      await evaluate(
        cdp,
        `(() => {
          localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(url)}, username: ${JSON.stringify(username)}, playback: 'web' }));
          localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(password)});
          return true;
        })()`,
      );
      await navigate(cdp, url);
      await evaluate(cdp, `${IN_PAGE}waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library to connect')`);

      const env = await evaluate(cdp, `${IN_PAGE}environment()`);
      say(`Scroll containment check — ${url}`);
      say(`  device: 393 x 852 CSS px, dpr 3, mobile emulation; safe-area emulation: ${safeArea ?? 'NOT applied'}`);
      say(`  reported by the page: innerWidth ${env.innerWidth} · innerHeight ${env.innerHeight} · visualViewport ${env.visualViewportWidth}`);
      say('');

      /* ------------------------------------------------- 1. the list, and its top bar */
      const opened = await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
      readings.states.opened = opened;
      say(`The list (${opened.scrollSurface}) put at scrollTop ${opened.scrollTop} of ${opened.scrollable} px scrollable.`);
      say(`  top bar: top ${opened.header.top} · height ${opened.header.height} (${opened.headerPosition})`);
      say(`  document: scrollTop ${opened.documentScrollTop} · scrollable ${opened.documentScrollable} px · window.scrollY ${opened.windowScrollY}`);
      say('');

      // A real gesture while browsing, at the middle of the list. This must move the list — it is
      // the control that says the gesture mechanism works — and must not move the top bar.
      await touchScroll(cdp, 196, 500, -260);
      await wheelScroll(cdp, 196, 500, 300);
      const browsed = await state(cdp);
      readings.states.browsed = browsed;
      readings.gestures.push({ at: 'the playlist, browsing', surface: browsed.scrollSurface, before: opened.scrollTop, after: browsed.scrollTop, documentBefore: opened.documentScrollTop, documentAfter: browsed.documentScrollTop, headerBefore: opened.header, headerAfter: browsed.header });
      check(
        'a real touch + wheel gesture scrolls the list (the gesture mechanism works)',
        browsed.scrollTop > opened.scrollTop,
        `scrollTop ${opened.scrollTop} -> ${browsed.scrollTop} on ${browsed.scrollSurface}`,
      );
      check(
        'the top bar does not move, grow or shrink when the list scrolls',
        sameRect(browsed.header, opened.header),
        `top ${opened.header.top} height ${opened.header.height} -> top ${browsed.header.top} height ${browsed.header.height}`,
      );
      check(
        'the document does not scroll while the list does',
        browsed.documentScrollTop === 0 && browsed.windowScrollY === 0,
        `document scrollTop ${browsed.documentScrollTop} · window.scrollY ${browsed.windowScrollY} · document scrollable ${browsed.documentScrollable} px`,
      );
      say('');

      /* ------------------------------------------- 2. the spectrum over the list */
      const beforeOpen = await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
      const spectrum = await evaluate(cdp, `${IN_PAGE}openNowFromList()`);
      readings.states.spectrumOpen = spectrum;
      say(`The spectrum was opened from the list (scrollTop ${beforeOpen.scrollTop} left behind).`);
      check(
        'the list does not move when the spectrum opens',
        spectrum.scrollTop === beforeOpen.scrollTop,
        `scrollTop ${spectrum.scrollTop} (was ${beforeOpen.scrollTop})`,
      );
      const hit = await evaluate(cdp, `${IN_PAGE}hitTest()`);
      readings.states.hitTest = hit;
      check(
        'every point of the screen hit-tests into the now-playing view, not the list behind it',
        hit.allInsideNow,
        `${hit.points.filter((point) => point.insideNow).length} of ${hit.points.length} points land inside .now` + (hit.allInsideNow ? '' : ` — first miss: ${JSON.stringify(hit.points.find((point) => !point.insideNow))}`),
      );

      // The gesture he described: scroll while the spectrum is up.
      await touchScroll(cdp, 196, 520, -420);
      await wheelScroll(cdp, 196, 520, 420);
      await touchScroll(cdp, 196, 760, -300);
      const afterSpectrumGesture = await state(cdp);
      readings.states.afterSpectrumGesture = afterSpectrumGesture;
      readings.gestures.push({ at: 'the spectrum, over the overlay', surface: afterSpectrumGesture.scrollSurface, before: beforeOpen.scrollTop, after: afterSpectrumGesture.scrollTop, documentBefore: beforeOpen.documentScrollTop, documentAfter: afterSpectrumGesture.documentScrollTop, headerBefore: beforeOpen.header, headerAfter: afterSpectrumGesture.header });
      check(
        'scrolling the spectrum does not scroll the playlist behind it',
        afterSpectrumGesture.scrollTop === beforeOpen.scrollTop,
        `list scrollTop ${beforeOpen.scrollTop} -> ${afterSpectrumGesture.scrollTop}`,
      );
      check(
        'scrolling the spectrum does not move the header',
        sameRect(afterSpectrumGesture.header, beforeOpen.header),
        `top ${beforeOpen.header.top} height ${beforeOpen.header.height} -> top ${afterSpectrumGesture.header.top} height ${afterSpectrumGesture.header.height}`,
      );
      check(
        'scrolling the spectrum does not scroll the document either',
        afterSpectrumGesture.documentScrollTop === 0 && afterSpectrumGesture.windowScrollY === 0,
        `document scrollTop ${afterSpectrumGesture.documentScrollTop} · window.scrollY ${afterSpectrumGesture.windowScrollY}`,
      );
      check(
        'the covered list is frozen (overflow hidden) while the spectrum is up',
        afterSpectrumGesture.overflowY === 'hidden' && afterSpectrumGesture.overscrollY === 'none',
        `scroll container overflow-y ${afterSpectrumGesture.overflowY}, overscroll-behavior-y ${afterSpectrumGesture.overscrollY}`,
      );
      const controls = await evaluate(cdp, `${IN_PAGE}overlayControlsCheck()`);
      readings.states.controls = controls;
      check(
        'the (x/y) line, the transport and the Spectrum/Lyrics pill still work while the view is open',
        controls.transport === 5 && controls.mode === 'spectrum' && /^Playing from .+\(\d+\/\d+\)$/.test(String(controls.context)),
        `“${controls.context}” · ${controls.transport} transport buttons · pill back to ${controls.mode} · engine ${controls.engineState}`,
      );

      /* -------------------------------- 3. lyrics mode: the overlay's own scroller */
      const lyrics = await evaluate(cdp, `${IN_PAGE}setPillMode(1)`);
      /*
       * The pilot track's six-line sidecar does not overflow the lyrics panel, and a scroll test
       * against a panel with nothing to scroll proves nothing — so the harness dresses the panel
       * with 40 extra lines of its own. They are filler, they are removed again below, and the
       * point is that this is a *real* scroller inside the overlay, moving under a real gesture.
       */
      const filler = await evaluate(
        cdp,
        `(() => {
          const host = document.querySelector('.lyrics');
          if (!host) return null;
          const before = host.scrollHeight - host.clientHeight;
          for (let i = 0; i < 40; i += 1) {
            const line = document.createElement('p');
            line.className = 'lyric-line v14-filler';
            line.textContent = 'filler line ' + (i + 1);
            host.appendChild(line);
          }
          return { before: before, after: host.scrollHeight - host.clientHeight };
        })()`,
      );
      readings.states.lyricsFiller = filler;
      await touchScroll(cdp, 196, 420, -320);
      await wheelScroll(cdp, 196, 420, 320);
      const lyricsGestured = await state(cdp);
      readings.states.lyricsGestured = lyricsGestured;
      readings.gestures.push({ at: 'lyrics mode, over the lyrics panel', surface: lyricsGestured.scrollSurface, before: beforeOpen.scrollTop, after: lyricsGestured.scrollTop, documentBefore: beforeOpen.documentScrollTop, documentAfter: lyricsGestured.documentScrollTop, headerBefore: beforeOpen.header, headerAfter: lyricsGestured.header });
      say(`Lyrics mode: the panel scrolls under the same gesture (scrollable ${filler.before} -> ${filler.after} px of filler, scrollTop ${lyrics.lyricsScrollTop} -> ${lyricsGestured.lyricsScrollTop}) — that one is meant to move.`);
      check(
        'the lyrics panel itself takes the gesture (so the check below is not vacuous)',
        lyricsGestured.lyricsScrollTop > 0,
        `lyrics panel scrollTop ${lyricsGestured.lyricsScrollTop} with ${filler.after} px of scrollable filler`,
      );
      check(
        'a gesture in lyrics mode does not scroll the playlist behind it either',
        lyricsGestured.scrollTop === beforeOpen.scrollTop,
        `list scrollTop ${beforeOpen.scrollTop} -> ${lyricsGestured.scrollTop}`,
      );
      check(
        'a gesture in lyrics mode does not move the header',
        sameRect(lyricsGestured.header, beforeOpen.header),
        `top ${beforeOpen.header.top} height ${beforeOpen.header.height} -> top ${lyricsGestured.header.top} height ${lyricsGestured.header.height}`,
      );
      check(
        'the document is still frozen with the lyrics view open',
        lyricsGestured.documentScrollTop === 0 && lyricsGestured.windowScrollY === 0,
        `document scrollTop ${lyricsGestured.documentScrollTop} · window.scrollY ${lyricsGestured.windowScrollY}`,
      );
      await evaluate(cdp, `(() => { for (const node of document.querySelectorAll('.v14-filler')) node.remove(); return true; })()`);

      /* ------------------------------------------------- 4. coming back */
      await evaluate(cdp, `${IN_PAGE}setPillMode(0)`);
      const restored = await evaluate(cdp, `${IN_PAGE}closeNow()`);
      readings.states.restored = restored;
      check(
        'closing the spectrum puts the list back at exactly the offset it was left at',
        restored.scrollTop === beforeOpen.scrollTop,
        `scrollTop ${beforeOpen.scrollTop} -> ${restored.scrollTop} (route ${restored.route}, .row.song rows back: ${restored.scrollable} px scrollable)`,
      );
      check(
        'the list is scrollable again once the spectrum is closed',
        restored.overflowY === 'auto' && restored.scrollable > 0,
        `overflow-y ${restored.overflowY} · ${restored.scrollable} px scrollable`,
      );

      /* ------------------------------------------------- 5. the swipe still works */
      await evaluate(cdp, `${IN_PAGE}openNowFromList()`);
      const swiped = await evaluate(cdp, `${IN_PAGE}swipeLeftToPlaylists()`);
      readings.states.swipe = swiped;
      check(
        'the swipe from the spectrum to the playlists is still a swipe, not a scroll',
        swiped.route === '#/playlists',
        `route after a leftward touch drag on the spectrum: ${swiped.route}`,
      );

      /* ------------------------------- 6. the 393 px layout guard still bites */
      await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
      const guard = await evaluate(
        cdp,
        `(() => {
          const view = document.querySelector('.view');
          const probe = document.createElement('div');
          probe.id = 'v14-wide-probe';
          probe.textContent = 'deliberately too wide';
          probe.style.cssText = 'width:600px;height:24px';
          view.appendChild(probe);
          const measured = window.__naviliteLayoutAudit.measure();
          probe.remove();
          return { overflow: measured.horizontalOverflow, surface: measured.scrollSurface, surfaceOverflow: measured.surfaceOverflow, documentOverflow: measured.documentOverflow, named: measured.actualOffenders.concat(measured.overflowersInsideScrollers).map((item) => item.selector) };
        })()`,
      );
      const after = await evaluate(cdp, `${IN_PAGE}measure()`);
      readings.states.layoutGuard = { injected: guard, clean: { overflow: after.horizontalOverflow, surface: after.scrollSurface } };
      check(
        'a deliberately 600 px-wide element is still reported by the 393 px layout audit',
        guard.overflow > 0 && guard.named.some((selector) => selector.includes('v14-wide-probe')),
        `overflow +${guard.overflow} px on ${guard.surface} (document ${guard.documentOverflow} px) · named as ${guard.named.join(', ') || 'nothing'}`,
      );
      check(
        'and with it removed the same measurement is 0 px again',
        after.horizontalOverflow === 0,
        `overflow ${after.horizontalOverflow} px on ${after.scrollSurface}`,
      );
      say('');
    },
    { width: 393, height: 852, deviceScaleFactor: 3 },
  );

  say(failures.length === 0 ? 'RESULT: nothing moved that should not have.' : `RESULT: ${failures.length} scroll-containment check(s) failed.`);
  for (const failure of failures) say(`  - ${failure}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(readings, null, 2));
    process.stdout.write(`\nraw measurements: ${jsonPath}\n`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
