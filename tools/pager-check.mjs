#!/usr/bin/env node
/**
 * The v1.5 pager check: does a swipe *pull* the next screen in, and does it stay out of the way of
 * a scroll?
 *
 * The owner's words: *"swiping left or right should transition the screens smoothly and appear like
 * it is pulling in the screen from the side rather than a sudden change in the screen after the
 * scroll"*, with the order **playlist | spectrum | lyrics**.
 *
 * So the evidence has to be geometric and it has to be taken *during* the gesture. An end state can
 * always be produced by an animation after the fact; a pane that has moved exactly as far as the
 * finger has, with the layers still tiling edge to edge, cannot. Every drag here is a real finger
 * through the input pipeline (`Input.dispatchTouchEvent`: touchStart, touchMove…, touchEnd) and the
 * geometry is read between moves, with the finger still down.
 *
 * What it checks, and why each one is here:
 *
 *   1. **The axis lock.** A diagonal gesture that is mostly vertical (200 px across, 240 px down)
 *      must scroll the pane and not turn a page — the owner's recurring bug in its worst form,
 *      because that drag carries more than the 32 % of a pane that commits. It is run on the
 *      playlist (the list scrolls) and on the lyrics (the panel scrolls).
 *   2. **Finger-following.** Inside the now screen the strip's transform must equal
 *      `-(offset - pane) × width` at every sample, and the offset must equal the finger's own
 *      travel, within a couple of pixels. This is the claim "it is pulled in", as a number.
 *   3. **Tiling.** While the playlist and the now screen trade places, `list.right` must equal
 *      `now.left` at every sample: the two move together, so the incoming screen is attached to the
 *      outgoing one and no empty space is ever exposed between them.
 *   4. **Snap.** Past the commit point it lands on the next pane; a short drag snaps back to the one
 *      it started on; a flick commits on velocity even though it never travelled far.
 *   5. **The ring.** Left from the spectrum is the lyrics, left again is the playlist he is on, and
 *      left from the playlist is the spectrum — plus right from the playlist, which is the lyrics.
 *   6. **The pill goes through the same pager** — sampled mid-flight, so a cut would fail.
 *   7. **The (x/y) line, the transport, the pill and the progress bar are still hit-testable with
 *      the finger down**, which is the point of their living outside the strip; and the lyric
 *      highlight still advances mid-drag.
 *   8. **History** walks the panes (the owner's "optional but nice").
 *   9. **The seek bar owns its own drag** (v1.7.1, tightened in v1.7.4). A finger that starts on the
 *      bar and travels most of the screen must seek the track and move no pane — the owner could not
 *      drag it at all. v1.7.4 adds what a tap-vs-drag report needs: the bar's own value is read with
 *      the finger *still down* and must track it (a fifth of the bar → four fifths), and the track
 *      must be left at that proportion of its length, not merely "somewhere else".
 *  10. **The lyrics follow** leads by one line, never scrolls past the end of the song, and leaves a
 *      hand scroll alone for a few seconds — and the first line is not in the panel's faded band,
 *      which is the v1.5 clipping report.
 *
 *   node tools/mock-subsonic.mjs --port 4651 --stress --dist dist
 *   node tools/pager-check.mjs --url http://127.0.0.1:4651 [--json report.json]
 *
 * ## The device driver (v1.5 follow-up)
 *
 * Every check above goes through `Input.dispatchTouchEvent`, which is CDP, which is Chrome — so
 * whether the axis lock survives *Safari's* own gesture arbitration on a real finger was reasoned
 * about rather than measured. There is no CDP against a simulator's Safari, and no WebDriver for it
 * either, so the second driver runs the same sweep as `TouchEvent`s dispatched **inside** the page
 * (`tools/device-probe.mjs --scenario gesture`, which builds its own probe copy and opens it in the
 * simulator's Safari) and judges the readings with `judgeDeviceGestures` — the same ten questions,
 * the same labels:
 *
 *   node tools/pager-check.mjs --device <simulator-udid> [--dist dist] [--wait 240] [--json report.json]
 *
 * What that path can and cannot show is stated where it is implemented (the note above `fingerDrag`
 * in tools/layout-probe-browser.js): it measures the app's own listeners in the shipping engine,
 * and it cannot reproduce a *default action*, so the native scroll a vertical drag produces and
 * Safari's edge-swipe are still Chrome's and the owner's thumb's to confirm.
 *
 * Exit code is non-zero when a check fails.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withChromePage, navigate, evaluate, judgeDeviceGestures } from './layout-audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const IN_PAGE = 'window.__naviliteLayoutAudit.';
const GEOMETRY = `${IN_PAGE}nowGeometry()`;
/** What the seek bar itself says, so a drag can be judged on the bar's own number. */
const SEEK_VALUE = `Number(document.querySelector('.now-progress .progress').value)`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const pagerOf = (geometry) => (geometry && geometry.pager) || null;
/** The x of a `matrix(1, 0, 0, 1, x, 0)` transform, or 0 for `none`. */
const translateX = (value) => {
  const match = /matrix\(1, 0, 0, 1, (-?[\d.]+), 0\)/.exec(String(value));
  return match ? Number(match[1]) : 0;
};

async function touch(cdp, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y), id: 1 }],
  });
}

/**
 * One finger, sampled as it travels: down at `fromX`, `steps` even moves to `toX`, the geometry read
 * after every move (finger still down), then lifted. `rest` is the geometry after the snap.
 */
async function drag(cdp, { fromX, toX, y, steps = 5, stepDelayMs = 24, afterReleaseMs = 460, sampleEvery = 1 }) {
  await touch(cdp, 'touchStart', fromX, y);
  const samples = [];
  for (let step = 1; step <= steps; step += 1) {
    const x = fromX + ((toX - fromX) * step) / steps;
    await touch(cdp, 'touchMove', x, y);
    await wait(stepDelayMs);
    // `sampleEvery: 0` reads the geometry at the last move only: reading between moves costs a round
    // trip, which would slow the gesture down and hide the velocity a flick is made of.
    if (sampleEvery === 0 ? step === steps : step % sampleEvery === 0) {
      samples.push({
        x: Math.round(x),
        geometry: await evaluate(cdp, GEOMETRY),
        // The bar's own value, read with the finger still down: v1.7.4 is judged on this, because
        // "the drag seeks" means the value followed the finger *during* the gesture, not that a
        // release happened to land somewhere. Not read on the `sampleEvery: 0` path: that one exists
        // to time a flick down to the millisecond, and a round trip before the release is exactly
        // what it is avoiding.
        value: sampleEvery === 0 ? null : await evaluate(cdp, SEEK_VALUE),
      });
    }
  }
  await touch(cdp, 'touchEnd', 0, 0);
  await wait(afterReleaseMs);
  return { samples, rest: await evaluate(cdp, GEOMETRY) };
}

/** A mostly-vertical, 200 px-wide drag: the shape of the owner's scroll-that-turns-a-page bug. */
async function diagonal(cdp, width) {
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(width / 2),
    y: 500,
    xDistance: -200,
    yDistance: -240,
    gestureSourceType: 'touch',
    speed: 900,
    preventFling: true,
  });
}

const seed = (url) => `(() => {
  localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(url)}, username: 'navidrome', playback: 'web' }));
  localStorage.setItem('navilite.subsonic-password', 'navidrome');
  return true;
})()`;

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
  const url = argv.get('url') ?? 'http://127.0.0.1:4651';
  const jsonPath = argv.get('json');

  const lines = [];
  const failures = [];
  const readings = { url, checks: {}, stages: {} };
  const say = (text) => lines.push(text);
  const check = (label, ok, detail) => {
    readings.checks[label] = { ok, detail };
    if (!ok) failures.push(`${label} — ${detail}`);
    say(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
    if (detail) say(`      ${detail}`);
    return ok;
  };

  /*
   * The device driver. Not a second implementation of the checks: the sweep runs in the simulator's
   * Safari (device-probe builds the probe copy and opens it), and the same `judgeDeviceGestures`
   * that prints that run's verdict is called here, so both drivers report the same behaviours under
   * the same labels — and this one's exit code is pager-check's.
   */
  const device = argv.get('device');
  if (device) {
    const gestureJson = join(tmpdir(), `navilite-gesture-device-${Date.now()}.json`);
    const child = spawnSync(
      process.execPath,
      [
        join(here, 'device-probe.mjs'),
        '--device', String(device),
        '--dist', String(argv.get('dist') ?? join(root, 'dist')),
        '--scenario', 'gesture',
        '--port', String(argv.get('port') ?? 4597),
        '--wait', String(argv.get('wait') ?? 240),
        '--json', gestureJson,
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    if (child.stdout) say(child.stdout.trimEnd());
    if (child.stderr) say(child.stderr.trimEnd());
    let sweep = null;
    try {
      sweep = JSON.parse(readFileSync(gestureJson, 'utf8')).gestures;
    } catch {
      sweep = null;
    }
    if (!sweep) {
      check('the device run produced a gesture sweep', false, `device-probe exited ${child.status}; its output is above`);
    } else {
      readings.device = sweep;
      say('');
      say(
        `judged from the device's own readings — engine ${sweep.device?.width ?? '?'}x${sweep.device?.height ?? '?'} CSS px, ` +
          `input ${sweep.inputSupport ? `Touch ${sweep.inputSupport.Touch}, TouchEvent ${sweep.inputSupport.TouchEvent}` : 'unknown'}:`,
      );
      for (const judged of judgeDeviceGestures(sweep)) check(judged.label, judged.ok, judged.detail);
    }
    say(failures.length === 0 ? 'RESULT: the pager pulls its panes, and nothing else moved — on the device too.' : `RESULT: ${failures.length} pager check(s) failed.`);
    for (const failure of failures) say(`  - ${failure}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    if (jsonPath) {
      writeFileSync(jsonPath, JSON.stringify(readings, null, 2));
      process.stdout.write(`\nraw measurements: ${jsonPath}\n`);
    }
    process.exitCode = failures.length === 0 ? 0 : 1;
    return;
  }

  try {
    await withChromePage(
      async ({ cdp, safeArea }) => {
      await navigate(cdp, url);
      await evaluate(cdp, seed(url));
      await navigate(cdp, url);
      await evaluate(
        cdp,
        `${IN_PAGE}waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library to connect')`,
      );

      const device = await evaluate(cdp, `${IN_PAGE}environment()`);
      const width = device.innerWidth;
      say(`The v1.5 swipe pager — ${url}`);
      say(
        `  device: ${width} x ${device.innerHeight} CSS px, dpr ${device.devicePixelRatio}, mobile emulation; safe-area emulation: ${safeArea ?? 'NOT applied'}`,
      );
      say('');

      const openSpectrum = async () => {
        await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
        return evaluate(cdp, `${IN_PAGE}openNowFromList()`);
      };
      const openPane = async (pane) => {
        await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
        await evaluate(cdp, `${IN_PAGE}openNowFromList()`);
        await evaluate(cdp, `${IN_PAGE}setPillMode(${pane === 2 ? 1 : 0})`);
        return evaluate(cdp, GEOMETRY);
      };

      /* ------------------------------------------------------- 1. the axis lock */
      const beforeList = await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
      const before = await evaluate(cdp, GEOMETRY);
      await diagonal(cdp, width);
      const afterDiagonal = await evaluate(cdp, GEOMETRY);
      readings.stages.diagonalOnList = { scrollTop: beforeList.scrollTop, after: pagerOf(afterDiagonal), list: afterDiagonal.list };
      check(
        'a mostly-vertical diagonal drag scrolls the list',
        afterDiagonal.list.scrollTop > before.list.scrollTop + 100,
        `list scrollTop ${beforeList.scrollTop} -> ${afterDiagonal.list.scrollTop} (of ${afterDiagonal.list.scrollHeight - afterDiagonal.list.clientHeight} px scrollable)`,
      );
      check(
        'and turns no page: the pager never moved and wrote no transform at all',
        pagerOf(afterDiagonal).position === 0 && pagerOf(afterDiagonal).offset === 0 && translateX(afterDiagonal.list.translate) === 0,
        `pager pane ${pagerOf(afterDiagonal).position} offset ${pagerOf(afterDiagonal).offset} · .view-scroll transform ${afterDiagonal.list.translate}`,
      );
      say('');

      /* ------------------------------------- 2. finger-following, spectrum -> lyrics */
      const spectrum = await openSpectrum().then(() => evaluate(cdp, GEOMETRY));
      readings.stages.opened = { route: spectrum.route, pager: pagerOf(spectrum), scrollTop: spectrum.list.scrollTop };
      check(
        'the now screen opens on the spectrum pane with the pager at rest',
        pagerOf(spectrum).position === 1 && pagerOf(spectrum).settled === true && translateX(spectrum.pages.translate) === 0,
        `route ${spectrum.route} · pane ${pagerOf(spectrum).position}, strip ${spectrum.pages.translate}`,
      );

      const travelled = 0.45 * width;
      const follow = await drag(cdp, { fromX: 330, toX: 330 - travelled, y: 300 });
      const expected = follow.samples.map((sample) => 1 + (330 - sample.x) / width);
      const offsetError = Math.max(...follow.samples.map((sample, index) => Math.abs(pagerOf(sample.geometry).offset - expected[index])));
      const strip = follow.samples.map((sample) => translateX(sample.geometry.pages.translate));
      const stripError = Math.max(...strip.map((value, index) => Math.abs(value + (expected[index] - 1) * width)));
      const monotonic = follow.samples.every(
        (sample, index) => index === 0 || pagerOf(sample.geometry).offset > pagerOf(follow.samples[index - 1].geometry).offset,
      );
      readings.stages.follow = {
        samples: follow.samples.map((sample, index) => ({ x: sample.x, offset: pagerOf(sample.geometry).offset, expected: expected[index], strip: strip[index] })),
        offsetErrorPx: offsetError * width,
        stripErrorPx: stripError,
      };
      check(
        'the panes follow the finger: the offset is the finger’s own travel, move by move',
        offsetError * width < 2 && monotonic,
        `offset vs -finger/width over ${follow.samples.length} samples: worst error ${(offsetError * width).toFixed(1)} px, monotonic ${monotonic} — ${readings.stages.follow.samples.map((s) => s.offset).join(' → ')}`,
      );
      check(
        'the strip is transformed by exactly that travel, and the window does not move with it',
        stripError < 2 && follow.samples.every((sample) => translateX(sample.geometry.now.translate) === 0),
        `strip x vs expected: worst error ${stripError.toFixed(1)} px · strip samples ${strip.map((v) => Math.round(v)).join(' → ')} · .now x ${follow.samples.map((s) => translateX(s.geometry.now.translate)).join(', ')}`,
      );
      check(
        'the two panes still tile while the finger is down: no gap, no overlap, and the window still covers the screen',
        follow.samples.every(
          (sample) =>
            near(sample.geometry.spectrum.right, sample.geometry.lyricsPane.left, 1) &&
            near(sample.geometry.now.left, 0, 1) &&
            near(sample.geometry.now.right, width, 1),
        ),
        `spectrum.right ${follow.samples.map((s) => s.geometry.spectrum.right).join(', ')} vs lyrics.left ${follow.samples.map((s) => s.geometry.lyricsPane.left).join(', ')} · window [${follow.samples.map((s) => `${s.geometry.now.left},${s.geometry.now.right}`).join('] [')}]`,
      );
      check(
        'the drag is committed and lands on the lyrics, with the route following the pane',
        pagerOf(follow.rest).position === 2 && pagerOf(follow.rest).settled === true && follow.rest.route === '#/now/lyrics',
        `rest: pane ${pagerOf(follow.rest).position} on ${follow.rest.route}, strip ${follow.rest.pages.translate}`,
      );

      /* ----------------------------------------------------- 3. snapping both ways */
      const short = await drag(cdp, { fromX: 330, toX: 330 - 0.12 * width, y: 300, steps: 2, stepDelayMs: 30 });
      check(
        'a short drag moves the pane under the finger and then snaps back to the same pane',
        short.samples.some((sample) => pagerOf(sample.geometry).offset > 2.05) &&
          pagerOf(short.rest).position === 2 &&
          pagerOf(short.rest).settled === true,
        `offsets ${short.samples.map((s) => pagerOf(s.geometry).offset).join(' → ')} → rest pane ${pagerOf(short.rest).position}`,
      );

      // The control for the flick below: the *same* shallow distance, released slowly — and the slow
      // release is measurable, because the input pipeline that drives it costs a round trip per move
      // (the pager reads its velocity from `performance.now()`, so a "fast" CDP gesture is no such
      // thing: measured, it comes out at 0.0003 panes/ms). A shallow, slow release snaps back.
      const slow = await drag(cdp, { fromX: 330, toX: 330 - 0.2 * width, y: 300, steps: 3, stepDelayMs: 6, afterReleaseMs: 520, sampleEvery: 0 });
      const slowOffsets = slow.samples.map((sample) => pagerOf(sample.geometry).offset);
      check(
        'the same shallow distance, released slowly, snaps back to the pane it started on',
        Math.max(...slowOffsets) < 2.32 && pagerOf(slow.rest).position === 2,
        `deepest sample ${Math.max(...slowOffsets).toFixed(3)} panes (the commit point is 0.32 past the pane) · rest pane ${pagerOf(slow.rest).position}`,
      );

      // The flick: identical distance, a finger's cadence. Committing at 0.2 panes can only be the
      // velocity projection — nothing else in the pager can carry it past the commit point.
      const flick = await evaluate(cdp, `${IN_PAGE}flickPager({ fromX: 330, toX: ${330 - 0.2 * width}, steps: 3, gapMs: 8 })`);
      await wait(600);
      const flickRest = await evaluate(cdp, GEOMETRY);
      readings.stages.flick = { ...flick, rest: pagerOf(flickRest).position, route: flickRest.route };
      check(
        'a flick commits on velocity: the same 0.2 panes, released fast, turn the page',
        flick !== null &&
          flick.offsets.length > 0 &&
          Math.max(...flick.offsets) < 2.32 &&
          pagerOf(flickRest).position === 0,
        flick === null
          ? 'the page could not drive a flick (no Touch/TouchEvent in the page)'
          : `offsets under the finger ${flick.offsets.map((v) => v.toFixed(3)).join(' → ')} over ${flick.ms} ms, then released · rest pane ${pagerOf(flickRest).position} on ${flickRest.route}`,
      );

      /* --------------------------------------------------------------- 4. the ring */
      await openPane(1);
      const firstLeft = await drag(cdp, { fromX: 340, toX: 40, y: 300, steps: 5, stepDelayMs: 20 });
      const secondLeft = await drag(cdp, { fromX: 340, toX: 40, y: 300, steps: 5, stepDelayMs: 20 });
      readings.stages.ring = {
        first: { pane: pagerOf(firstLeft.rest).position, route: firstLeft.rest.route },
        second: { pane: pagerOf(secondLeft.rest).position, route: secondLeft.rest.route },
      };
      check(
        'left from the spectrum is the lyrics; left again is the playlist he is on',
        pagerOf(firstLeft.rest).position === 2 &&
          firstLeft.rest.route === '#/now/lyrics' &&
          pagerOf(secondLeft.rest).position === 0 &&
          String(secondLeft.rest.route).startsWith('#/playlist'),
        `panes 1 → ${pagerOf(firstLeft.rest).position} → ${pagerOf(secondLeft.rest).position}, landing on ${secondLeft.rest.route}`,
      );
      check(
        'the playlist and the now screen tile while they trade places: their edges meet exactly',
        secondLeft.samples.every((sample) => near(sample.geometry.list.left, sample.geometry.now.right, 1)),
        `list.left vs now.right over ${secondLeft.samples.length} samples: ${secondLeft.samples.map((s) => `${s.geometry.list.left}/${s.geometry.now.right}`).join(' ')}`,
      );

      await evaluate(cdp, `${IN_PAGE}prepareScroll()`);
      const fromList = await drag(cdp, { fromX: 340, toX: 40, y: 400, steps: 5, stepDelayMs: 20 });
      check(
        'left from the playlist pulls the spectrum in, the list and the window moving together',
        pagerOf(fromList.rest).position === 1 &&
          fromList.rest.route === '#/now' &&
          fromList.samples.every((sample) => near(sample.geometry.list.right, sample.geometry.now.left, 1)),
        `pane ${pagerOf(fromList.rest).position}; offsets ${fromList.samples.map((s) => pagerOf(s.geometry).offset).join(' → ')}; list.right ${fromList.samples.map((s) => s.geometry.list.right).join(', ')} vs now.left ${fromList.samples.map((s) => s.geometry.now.left).join(', ')}`,
      );
      const backToPlaylist = await drag(cdp, { fromX: 40, toX: 340, y: 300, steps: 5, stepDelayMs: 20 });
      check(
        'right from the spectrum is the playlist he is on',
        pagerOf(backToPlaylist.rest).position === 0 && String(backToPlaylist.rest.route).startsWith('#/playlist'),
        `pane ${pagerOf(backToPlaylist.rest).position} on ${backToPlaylist.rest.route}`,
      );
      const toLyricsRight = await drag(cdp, { fromX: 40, toX: 340, y: 400, steps: 5, stepDelayMs: 20 });
      check(
        'right from the playlist is the lyrics — the ring goes both ways',
        pagerOf(toLyricsRight.rest).position === 2 && toLyricsRight.rest.route === '#/now/lyrics',
        `pane ${pagerOf(toLyricsRight.rest).position} on ${toLyricsRight.rest.route}`,
      );
      say('');

      /* ------------------------------------------- 5. the pill goes through the pager */
      await evaluate(cdp, `document.querySelectorAll('.pill-option')[0].click()`);
      const pillSamples = [];
      for (let i = 0; i < 8; i += 1) {
        pillSamples.push(await evaluate(cdp, GEOMETRY));
        await wait(35);
      }
      const pillStrip = pillSamples.map((sample) => translateX(sample.pages.translate));
      const midFlight = pillStrip.filter((value) => value < -2 && value > -width + 2);
      readings.stages.pill = { strip: pillStrip, pills: pillSamples.map((s) => s.activePill) };
      check(
        'the Spectrum/Lyrics pill slides the strip through the same pager instead of cutting',
        midFlight.length > 0 && pillSamples[0].activePill === 'Spectrum',
        `strip x sampled every ~35 ms: ${pillStrip.map((v) => Math.round(v)).join(' → ')} · the pill read “${pillSamples[0].activePill}” from the first sample`,
      );
      await evaluate(cdp, `${IN_PAGE}waitForPane(1)`);
      await evaluate(cdp, `${IN_PAGE}settlePager()`);
      const atSpectrum = await evaluate(cdp, GEOMETRY);
      check(
        'and it comes to rest on the spectrum, with the route still #/now',
        pagerOf(atSpectrum).position === 1 && atSpectrum.route === '#/now' && pagerOf(atSpectrum).settled === true,
        `pane ${pagerOf(atSpectrum).position} on ${atSpectrum.route}, settled ${pagerOf(atSpectrum).settled}`,
      );

      /* --------------------- 6. the seek bar owns a horizontal drag (v1.7.1) */
      /*
       * The owner: *"i can't drag the seek bar because it registers as im trying to swipe to a
       * different pane. swipes on the seek bar should allow me to seek through the audio
       * seamlessly."*
       *
       * So: a real finger through the input pipeline, starting *on the bar* (a fifth of the way
       * along it) and dragging right across most of the screen — the exact shape that would turn a
       * page anywhere else on this screen. The pager must not move a pixel, and the position must
       * follow the finger, including in the middle of the drag rather than only at release.
       */
      const bar = atSpectrum.progress;
      if (!bar) throw new Error('the seek bar is not in the now screen geometry');
      /*
       * From a known early position, on purpose. A 20-second track that has been playing for the
       * length of this run can already be sitting where an 80 % drag lands, and then "the position
       * moved" is a claim about nothing — the first run of v1.7.4's check failed on exactly that.
       * Two seconds in, a drag to four fifths of the bar is a sixteen-second move.
       */
      await evaluate(cdp, `${IN_PAGE}seekAudio(2)`);
      await wait(300);
      const positionBefore = await evaluate(cdp, `window.__navilite.status().positionMs`);
      /*
       * The pane the screen is resting on is the baseline, not zero: a rest on the spectrum leaves
       * `.view-scroll` translated by a whole screen — that is the pose, and it must be *the same
       * pose* after every move. ("The pager never moved" is equality with the resting state, not
       * equality with zero, which is only true on the playlist.)
       */
      const poseOf = (geometry) =>
        [
          Math.round(pagerOf(geometry).offset * 1000),
          translateX(geometry.now.translate),
          translateX(geometry.pages.translate),
          translateX(geometry.list.translate),
        ].join(':');
      const restingPose = poseOf(atSpectrum);
      const seekDrag = await drag(cdp, {
        fromX: bar.left + bar.width * 0.2,
        toX: bar.left + bar.width * 0.8,
        y: bar.top + bar.height / 2,
        steps: 6,
        stepDelayMs: 32,
        afterReleaseMs: 600,
      });
      const posesWhileSeeking = seekDrag.samples.map((sample) => poseOf(sample.geometry));
      const afterSeek = await evaluate(
        cdp,
        `({
          value: Number(document.querySelector('.now-progress .progress').value),
          positionMs: window.__navilite.status().positionMs,
          durationMs: window.__navilite.status().durationMs,
          route: location.hash,
          pane: window.__navilite.pager().position,
          barWidth: ${Math.round(bar.width)},
        })`,
      );
      readings.stages.seekDrag = { bar, restingPose, posesWhileSeeking, afterSeek, positionBefore };
      check(
        'a drag that starts on the seek bar never moves the pager',
        posesWhileSeeking.every((pose) => pose === restingPose) &&
          afterSeek.pane === atSpectrum.pager.position &&
          afterSeek.route === '#/now',
        `pose at rest ${restingPose} · pose during the drag ${[...new Set(posesWhileSeeking)].join(' / ')} · ` +
          `after: pane ${afterSeek.pane} on ${afterSeek.route}`,
      );
      /*
       * The proof is the *proportion*, not the distance travelled (v1.7.4).
       *
       * A tap already seeked, so "the position moved" proves nothing about dragging — and the old
       * check here asked only that it moved by more than three seconds, which a *tap* at the far end
       * of a 20-second track satisfies whenever the track happens to be playing near that end. The
       * finger goes from a fifth of the bar to four fifths of it, so the track must be left at four
       * fifths of its length — and, because this is the whole of the owner's report, the bar must
       * have been saying so *while the finger was still down*.
       */
      const valuesWhileDown = seekDrag.samples.map((sample) => sample.value);
      check(
        'the bar follows the finger while the drag is still happening',
        valuesWhileDown.length >= 5 &&
          valuesWhileDown.every((value) => typeof value === 'number') &&
          valuesWhileDown.every((value, index) => index === 0 || value >= valuesWhileDown[index - 1]) &&
          Math.abs(valuesWhileDown[valuesWhileDown.length - 1] - 800) <= 60,
        `bar value while the finger was down: ${valuesWhileDown.join(' → ')} (released at 80 % of the bar)`,
      );
      check(
        'and the drag seeks the track to the proportion it was dragged to',
        Math.abs(afterSeek.value - 800) <= 60 &&
          Math.abs(afterSeek.positionMs - (afterSeek.durationMs * afterSeek.value) / 1000) <= 1200 &&
          Math.abs(afterSeek.positionMs - positionBefore) > 1000,
        `${Math.round(positionBefore / 1000)} s → ${Math.round(afterSeek.positionMs / 1000)} s ` +
          `(slider at ${afterSeek.value}/1000 of ${Math.round(afterSeek.durationMs / 1000)} s: expected ` +
          `${Math.round((afterSeek.durationMs * afterSeek.value) / 1_000_000)} s)`,
      );
      // Put the track back where it was: the checks that follow walk the lyrics from a known
      // position, and a track parked at 80 % of its length is a different walk.
      await evaluate(cdp, `${IN_PAGE}seekAudio(${Math.max(1, Math.round(positionBefore / 1000))})`);
      await wait(300);
      say('');

      /* ------------------------------------- 7. the controls, with the finger still down */
      await touch(cdp, 'touchStart', 330, 300);
      await touch(cdp, 'touchMove', 170, 300);
      await wait(80);
      const midDrag = await evaluate(cdp, GEOMETRY);
      const controls = await evaluate(cdp, `${IN_PAGE}controlHitTest()`);
      const activeBefore = await evaluate(cdp, `window.__navilite.activeLyric()`);
      // The highlight keeps advancing mid-drag, and it is advanced the way the player does it: by
      // seeking the real element, so the app's own progress path lights the line. Pause first: a track
      // left to run to its end rolls onto the next one, which re-renders the screen and disturbs every
      // check after this one. A position at the end of the track lights its last line.
      await evaluate(cdp, `${IN_PAGE}pauseAudio()`);
      await evaluate(cdp, `${IN_PAGE}seekAudio(1e6)`);
      await wait(260);
      const activeAfter = await evaluate(cdp, `window.__navilite.activeLyric()`);
      await touch(cdp, 'touchEnd', 0, 0);
      await wait(420);
      readings.stages.controlsMidDrag = { offset: pagerOf(midDrag).offset, controls };
      check(
        'the (x/y) line, the transport, the pill and the progress bar are hit-testable mid-drag',
        controls.every((control) => control.found && control.insideControl && control.insideNow),
        controls.map((control) => `${control.selector} → ${control.hit}${control.insideControl ? '' : ' (MISS)'}`).join(' · '),
      );
      check(
        'the lyric highlight still advances while the finger is down',
        activeBefore !== null && activeAfter !== null && activeBefore !== activeAfter,
        `mid-drag (offset ${pagerOf(midDrag).offset}): “${activeBefore}” → seeking the track → “${activeAfter}”`,
      );

      /* ------------------------------------------------------------- 8. history */
      // Tolerant on purpose: the check is the *numbers* recorded below, not the wait. A pane the app
      // refuses to settle on has to show up as a reading, not as a hang.
      await evaluate(cdp, `${IN_PAGE}setPillMode(1).catch(function () { return null; })`);
      await wait(600);
      const onLyrics = await evaluate(cdp, GEOMETRY);
      await evaluate(cdp, `history.back(); true`);
      await wait(800);
      const back = await evaluate(cdp, GEOMETRY);
      await evaluate(cdp, `history.forward(); true`);
      await wait(800);
      const forward = await evaluate(cdp, GEOMETRY);
      readings.stages.history = {
        onLyrics: { route: onLyrics.route, pane: pagerOf(onLyrics).position },
        back: { route: back.route, pane: pagerOf(back).position },
        forward: { route: forward.route, pane: pagerOf(forward).position },
      };
      check(
        'back leaves the lyrics pane and forward returns to it',
        pagerOf(onLyrics).position === 2 &&
          back.route !== '#/now/lyrics' &&
          pagerOf(back).position !== 2 &&
          forward.route === '#/now/lyrics' &&
          pagerOf(forward).position === 2,
        `from ${onLyrics.route} (pane ${pagerOf(onLyrics).position}) · back → ${back.route} (pane ${pagerOf(back).position}) · forward → ${forward.route} (pane ${pagerOf(forward).position})`,
      );

      /* ------------------------------------------------- 9. the lyrics themselves */
      // A song whose sidecar is longer than the panel: the twelve long lines of the stress album,
      // played from the album's own screen, so the tap is the one the owner makes.
      await evaluate(cdp, `location.hash = '#/album/album-ja-1'; true`);
      await evaluate(
        cdp,
        `${IN_PAGE}waitFor("location.hash === '#/album/album-ja-1' && document.querySelectorAll('.row.song').length > 0", 'the stress album')`,
      );
      await evaluate(cdp, `${IN_PAGE}playRow(0)`);
      await evaluate(cdp, `${IN_PAGE}waitFor("location.hash === '#/now'", 'the now screen')`);
      await evaluate(cdp, `${IN_PAGE}settlePager(1).catch(function () { return null; })`);
      await evaluate(cdp, `${IN_PAGE}setPillMode(1).catch(function () { return null; })`);
      // Paused on purpose: with the track playing, a line that lasts half a second has moved on by the
      // time the reading is taken. A seek drives the same progress path the player does, so the
      // highlight still follows — it just stays where it is put.
      await evaluate(cdp, `${IN_PAGE}pauseAudio()`);
      await wait(400);

      const audio = await evaluate(cdp, `${IN_PAGE}audioState()`);
      const lineCount = await evaluate(cdp, `document.querySelectorAll('.lyric-line').length`);
      const density = await evaluate(cdp, `${IN_PAGE}lyricsDensity()`);
      readings.stages.lyricsDensity = density;
      readings.stages.lyricsSong = { ...audio, lines: lineCount };
      check(
        'the first lyric line is drawn whole, past the panel’s faded band',
        density !== null && density.firstLineFullyInside === true && density.firstLineInFade === false,
        density
          ? `${density.visibleLines} of ${density.lines} lines fit whole · first line ${(density.firstLineTop - density.panelTop).toFixed(1)} px below the panel top (the mask is transparent for the first 16 px)`
          : 'no lyric lines to measure',
      );
      check(
        'the song has more lyric than the panel can show, so the follow has real scrolling to do',
        density !== null && lineCount > 1 && density.lines > density.visibleLines,
        `${lineCount} lines in a ${density ? Math.round(density.panelHeight) : '?'} px panel, ${density?.visibleLines ?? '?'} of them fit whole over ${Math.round(audio?.duration ?? 0)} s`,
      );

      // The mock times its sidecars evenly across the song, so the line starts are derivable — and
      // the app's own highlight is what proves the derivation: a position that lights the wrong line
      // is reported rather than silently accepted. The walk runs *backwards* down the track, seeking,
      // so the playhead never reaches the end of the song and rolls onto the next one mid-check.
      const durationMs = Math.round((audio?.duration ?? 0) * 1000);
      const lineStartMs = (index) => Math.round((index * durationMs) / lineCount);
      const walk = [];
      if (durationMs > 0 && lineCount > 1) {
        for (let index = lineCount - 1; index >= 0; index -= 1) {
          const ms = lineStartMs(index) + 300;
          await evaluate(cdp, `${IN_PAGE}seekAudio(${ms / 1000})`);
          await wait(320);
          const state = await evaluate(cdp, `${IN_PAGE}lyricsFollowState()`);
          walk.push({
            index,
            ms,
            activeIndex: state.activeIndex,
            scrollTop: state.scrollTop,
            maxScroll: state.maxScroll,
            atEnd: state.atEnd,
            upcoming: state.upcoming,
          });
        }
      }
      readings.stages.lyricsWalk = walk;
      const lit = walk.filter((step) => step.activeIndex === step.index);
      check(
        'the highlight follows the song, line by line, over the whole track',
        walk.length > 1 && lit.length === walk.length,
        walk.length === 0
          ? 'no timed lyrics to walk (the song or the sidecar never arrived)'
          : `${lit.length} of ${walk.length} positions lit the line they belong to (song ${Math.round(durationMs / 1000)} s, ${lineCount} lines)`,
      );
      const overshot = walk.filter((step) => step.scrollTop > step.maxScroll + 0.5);
      check(
        'the follow never scrolls the panel past its own end',
        walk.length > 1 && overshot.length === 0,
        `panel scrollTop vs its maximum over the walk: worst excess ${overshot.length === 0 ? '0' : Math.max(...overshot.map((step) => step.scrollTop - step.maxScroll)).toFixed(1)} px`,
      );
      const lead = walk.filter((step) => step.upcoming && step.upcoming.index === step.index + 1);
      // Two cases where the upcoming line legitimately cannot be shown whole: the panel is already at
      // the end of its own scroll (there is nothing below it to give), or the line is taller than the
      // panel itself. Everything else has to fit — that is the whole point of leading by a line.
      const ledWhole = lead.filter((step) => step.upcoming.fullyVisible || step.atEnd);
      const clamped = lead.filter((step) => !step.upcoming.fullyVisible && step.atEnd);
      check(
        'and it leads by one line: the upcoming line is on screen when the current one lights',
        lead.length > 0 && ledWhole.length === lead.length,
        lead.length === 0
          ? 'no lit line had an upcoming line to measure'
          : `${ledWhole.length} of ${lead.length} lit lines had the next one fully visible (deepest ${Math.max(...lead.map((step) => Math.round(step.upcoming.bottom)))} px down a ${density ? Math.round(density.panelHeight) : '?'} px panel), ${clamped.length} of them because the panel was already at its end`,
      );

      /* -------------------------------------------------- 10. the grace period */
      const middle = walk.find((step) => step.index === Math.floor(lineCount / 2)) ?? walk[0];
      const beforeHand = await evaluate(cdp, `${IN_PAGE}lyricsFollowState()`);
      await cdp.send('Input.synthesizeScrollGesture', {
        x: Math.round(width / 2),
        y: 300,
        xDistance: 0,
        yDistance: 140,
        gestureSourceType: 'touch',
        speed: 900,
        preventFling: true,
      });
      await wait(300);
      const afterHand = await evaluate(cdp, `${IN_PAGE}lyricsFollowState()`);
      const handMoved = afterHand.scrollTop - beforeHand.scrollTop;
      // The song moves on by one line while he is reading somewhere else: that must be left alone.
      await evaluate(cdp, `${IN_PAGE}seekAudio(${(lineStartMs(middle.index + 1) + 300) / 1000})`);
      await wait(300);
      const duringGrace = await evaluate(cdp, `${IN_PAGE}lyricsFollowState()`);
      readings.stages.grace = {
        handMoved,
        afterHand: afterHand.scrollTop,
        duringGrace: duringGrace.scrollTop,
        activeAtMiddle: duringGrace.activeIndex,
      };
      check(
        'a hand scroll is left alone: the follow does not fight the reader',
        Math.abs(handMoved) > 20 && near(duringGrace.scrollTop, afterHand.scrollTop, 6),
        `a real gesture moved the panel ${handMoved.toFixed(0)} px; moving the song on one line then moved it ${(duringGrace.scrollTop - afterHand.scrollTop).toFixed(0)} px`,
      );
      await wait(4400);
      await evaluate(cdp, `${IN_PAGE}seekAudio(${(lineStartMs(Math.min(lineCount - 1, middle.index + 2)) + 300) / 1000})`);
      await wait(420);
      const afterGrace = await evaluate(cdp, `${IN_PAGE}lyricsFollowState()`);
      check(
        'and the follow resumes once the grace period is over',
        Math.abs(afterGrace.scrollTop - duringGrace.scrollTop) > 2 || afterGrace.scrollTop >= afterGrace.maxScroll - 1,
        `panel scrollTop ${duringGrace.scrollTop} → ${afterGrace.scrollTop} after the 4 s grace (max ${afterGrace.maxScroll}, active line ${duringGrace.activeIndex} → ${afterGrace.activeIndex})`,
      );
      say('');

      /*
       * 11. the same drag on the **touch** channel alone (v1.8.0), and last on purpose.
       *
       * The seek-bar check above drives CDP's touch input, which feeds Chrome's own input pipeline —
       * and Chrome synthesizes PointerEvents from it, which a real finger on a native `<input
       * type=range>` in WebKit does not produce. That is exactly why it passed for two releases while
       * the owner could not drag the bar at all. So this stage dispatches **only** touch events, built
       * in the page and sent at the element found by hit-testing the finger's own coordinates: they
       * travel up through `#app`, the ancestor whose touch listeners read a drag on the bar as a page
       * turn, and its handlers run on the way. Nothing here produces a pointer event, so the only
       * writer that can move the value is the bar's own touch path — which, before v1.8.0, did not
       * exist (the value stayed exactly where it was for all six moves: that is the number this check
       * was written to catch).
       *
       * It runs *after* the lyric stages because the app's own follow is deliberately sensitive to
       * touches — a hand on the panel takes hold of the scroll — and the walk above measures animated
       * positions. A synthetic touch sequence issued in the middle of it perturbs those readings, so
       * this stage is the last thing the run does and nothing is measured after it.
       */
      await evaluate(cdp, `${IN_PAGE}setPillMode(0)`);
      await evaluate(cdp, `${IN_PAGE}settlePager(1)`);
      const touchGeometry = await evaluate(cdp, GEOMETRY);
      if (!touchGeometry.progress) throw new Error('the seek bar is not in the now screen geometry');
      const touchRestingPose = poseOf(touchGeometry);
      const touchDrag = await evaluate(
        cdp,
        `(() => {
          const audit = window.__naviliteLayoutAudit;
          const app = document.getElementById('app');
          const bar = document.querySelector('.now-progress .progress');
          const rect = bar.getBoundingClientRect();
          const y = rect.top + rect.height / 2;
          const xAt = (fraction) => rect.left + rect.width * fraction;
          const targetAt = (x) => document.elementFromPoint(x, y) || bar;
          const touchAt = (x) => new Touch({
            identifier: 7,
            target: targetAt(x),
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            screenX: x,
            screenY: y,
            radiusX: 4,
            radiusY: 4,
            rotationAngle: 0,
            force: 1,
          });
          const fire = (type, x) => {
            const list = type === 'touchend' ? [] : [touchAt(x)];
            targetAt(x).dispatchEvent(new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              touches: list,
              targetTouches: list,
              changedTouches: [touchAt(x)],
            }));
          };
          const pose = () => {
            const geometry = audit.nowGeometry();
            const translateX = (value) => {
              const match = /matrix\\(1, 0, 0, 1, (-?[\\d.]+), 0\\)/.exec(String(value));
              return match ? Number(match[1]) : 0;
            };
            return [
              Math.round(((geometry.pager && geometry.pager.offset) || 0) * 1000),
              translateX(geometry.now.translate),
              translateX(geometry.pages.translate),
              translateX(geometry.list.translate),
            ].join(':');
          };
          // Counted, so "dispatched through the ancestor" is a number in the report rather than an
          // assumption about where the events went.
          let ancestorSaw = 0;
          const probe = () => { ancestorSaw += 1; };
          app.addEventListener('touchstart', probe);
          app.addEventListener('touchmove', probe);
          app.addEventListener('touchend', probe);
          const values = [];
          const poses = [];
          const fromX = xAt(0.2);
          const toX = xAt(0.8);
          fire('touchstart', fromX);
          for (let step = 1; step <= 6; step += 1) {
            fire('touchmove', fromX + ((toX - fromX) * step) / 6);
            values.push(Number(bar.value));
            poses.push(pose());
          }
          fire('touchend', toX);
          app.removeEventListener('touchstart', probe);
          app.removeEventListener('touchmove', probe);
          app.removeEventListener('touchend', probe);
          return {
            values,
            poses,
            ancestorSaw,
            targetWasInsideTheBar: bar.contains(targetAt(fromX)),
          };
        })()`,
      );
      readings.stages.seekTouchDrag = { ...touchDrag, restingPose: touchRestingPose };
      check(
        'a drag delivered as touch events only seeks the bar, with the pager never moving',
        touchDrag.values.length >= 6 &&
          touchDrag.targetWasInsideTheBar &&
          touchDrag.values.every((value, index) => index === 0 || value >= touchDrag.values[index - 1]) &&
          Math.abs(touchDrag.values[touchDrag.values.length - 1] - 800) <= 60,
        `bar value after each touchmove: ${touchDrag.values.join(' → ')} (the finger went to 80 % of the bar; ` +
          `the events were hit-tested onto the bar itself: ${touchDrag.targetWasInsideTheBar})`,
      );
      check(
        'and it passes through the ancestor that used to take the gesture, which does not move a pane',
        touchDrag.ancestorSaw === 8 && touchDrag.poses.every((pose) => pose === touchRestingPose),
        `#app saw ${touchDrag.ancestorSaw} of those touch events; the pager pose stayed ` +
        `${[...new Set(touchDrag.poses)].join(' / ')} (at rest ${touchRestingPose})`,
        );
        },
        { width: 393, height: 852, deviceScaleFactor: 3 },
    );
  } catch (error) {
    // The report still has to land: a harness that dies without writing its measurements leaves
    // nothing to debug with.
    check('the run reached the end of its checks', false, `${error?.message ?? error}`);
  }

  say(failures.length === 0 ? 'RESULT: the pager pulls its panes, and nothing else moved.' : `RESULT: ${failures.length} pager check(s) failed.`);
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
