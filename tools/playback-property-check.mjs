#!/usr/bin/env node
/**
 * The two v2.0-beta properties that need a real page: **P3, backgrounded playback** and **P4, time
 * to first sound** (docs/design-v2.0-beta.md §5, and the card's rule 2 — before *and* after, same
 * fixture, same method, muted).
 *
 * Neither property has a simulator here (the owner's rule), so both are driven in Chrome at
 * 393 x 852 over the mock library, through the app's own code path. Nothing is stubbed inside the
 * app: the page is the built `dist/`, and the only seam used is `window.__navilite`, which is
 * read-only.
 *
 * **P3 — backgrounded playback.** The app decides what to do from `document.hidden` when a
 * `visibilitychange` arrives, so this drives exactly that: force the flag false and dispatch, play,
 * flip the flag true and dispatch, hold 8 s, flip it back and read what the return looks like. The
 * flag is forced with `Object.defineProperty` because headless Chrome loads with
 * `document.hidden === true` (measured in the design session) — a probe that does not force it is
 * measuring a backgrounded app while believing it is a foreground one. What is read: the engine's
 * state through the gap (no `paused` flash), the position on return, the chip's word and tone, and
 * whether the bars are fed again. The design's stated limitation holds: a faked flag is the app's
 * own path, not WebKit's suspension, so the phone's real round trip is a Simulator run this card
 * does not do.
 *
 * **P4 — time to first sound.** Nine taps: three tracks, each tapped cold, then the row next to it,
 * then the item already playing again. `t0` is read synchronously at `row.click()`; first sound is
 * the app's own media element reporting `currentTime > 0` while not paused — the detached `new
 * Audio()` the engine builds, captured by `tools/layout-probe-browser.js`'s constructor wrap as
 * `window.__naviliteMediaElement`, which is the handle `docs/verification.md`'s audio readings
 * already use. The pill's word is **not** used as the signal: after item 2 the arming window also
 * reads `spectrum`, so "first reads spectrum" fires before sound exists.
 *
 *   node tools/mock-subsonic.mjs --port 4652 --stress --dist dist
 *   node tools/playback-property-check.mjs --url http://127.0.0.1:4652 --label after [--json report.json]
 *
 * Chrome runs muted (`--mute-audio`) — this really plays, and it is not allowed to make a noise on
 * the desk it runs on. Exit code is non-zero when P3's invariants are broken.
 */
import { writeFileSync } from 'node:fs';
import { withChromePage, evaluate, navigate } from './layout-audit.mjs';

const argv = process.argv.slice(2);
const url = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : null;
const jsonPath = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : 'unlabelled';
if (!url) {
  console.error('usage: node tools/playback-property-check.mjs --url http://127.0.0.1:PORT [--label before|after] [--json report.json]');
  process.exit(2);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PLAYLIST = '#/playlist/pl-stress-long';

const failures = [];
function check(ok, message, detail) {
  if (!ok) failures.push(message);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}${detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return ok;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}
function p90(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
}

/** The mock's own credentials into the app's storage, then the library drawn — as the other harnesses do. */
async function seed(cdp) {
  const reset = await fetch(new URL('/__reset', url), { method: 'POST' });
  if (!reset.ok) throw new Error(`POST /__reset answered ${reset.status} — this check needs tools/mock-subsonic.mjs`);
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
  await evaluate(cdp, `location.hash = ${JSON.stringify(PLAYLIST)}; true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("location.hash === '${PLAYLIST}' && document.querySelectorAll('.row.song').length > 20", 'the song rows')`);
}

/**
 * The app's own media element.
 *
 * The engine builds it with `new Audio()` (engine.ts:673) and never appends it to the document, so
 * no selector can reach it. `tools/layout-probe-browser.js` already wraps the constructor before the
 * app's bundle runs and parks the element on `window.__naviliteMediaElement` — that is the same
 * handle `docs/verification.md`'s audio readings use, and it is the fact this probe times against
 * rather than the pill's word (which, after item 2, also reads `spectrum` while arming).
 */
async function mediaElement(cdp) {
  return await evaluate(cdp, `(() => { const el = window.__naviliteMediaElement; return el ? { currentTime: el.currentTime, paused: el.paused } : null; })()`);
}

/** One tap on a row, timed in the page: `t0` synchronously at the click, first sound at `currentTime > 0`. */
async function tapAndTime(cdp, rowIndex, kind) {
  return await evaluate(
    cdp,
    `(async () => {
      const rows = document.querySelectorAll('.row.song');
      const row = rows[${rowIndex}];
      const el = window.__naviliteMediaElement;
      const title = row.querySelector('.row-title')?.textContent ?? null;
      const warmed = window.__navilite.status().warmedIds;
      const t0 = performance.now();
      row.click();
      const ms = await new Promise((resolve) => {
        const tick = () => {
          const now = performance.now();
          if (el && el.currentTime > 0 && !el.paused) return resolve(now - t0);
          if (now - t0 > 15000) return resolve(-1);
          return requestAnimationFrame(tick);
        };
        tick();
      });
      return { kind: ${JSON.stringify(kind)}, row: ${rowIndex}, title, warmedBefore: warmed, ms: Math.round(ms), state: window.__navilite.status().state };
    })()`,
  );
}

/** Play one row and wait for the engine to be playing; returns the row's own title. */
async function playRow(cdp, rowIndex) {
  await evaluate(cdp, `document.querySelectorAll('.row.song')[${rowIndex}].click(); true`);
  await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__navilite.status().state === 'playing'", 'playback')`);
  await wait(1500);
}

/**
 * P4: three tracks, three cases each — a **cold** tap on a row this run has not played, the **next**
 * row (the neighbour the app would advance to), and a **repeat** tap on the item already playing.
 *
 * The design's third case was "warm — the row the queue had warmed ahead". On the web path there is
 * no such row and there cannot be: `prepareNext` returns at its first line without a native platform
 * (`if (!this.nativePlatform) return false`), so the pool is empty on every web build — the probe
 * prints `status().warmedIds` beside each tap as the evidence, reads `[]` every time, and reads it
 * as `next` instead. That is a correction to §5's P4, not a skipped measurement: the case the design
 * meant (a prefetched neighbour) is the native path's, and this card does not run the native path.
 */
async function timeToFirstSound(cdp) {
  const taps = [];
  for (let round = 0; round < 3; round += 1) {
    const coldRow = 2 + round * 4;
    taps.push(await tapAndTime(cdp, coldRow, 'cold'));
    await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__navilite.status().state === 'playing'", 'the cold tap to start')`);
    await wait(2500); // the queue's own warm-ahead window, which is where a native build would have a warm row

    taps.push(await tapAndTime(cdp, coldRow + 1, 'next'));
    await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__navilite.status().state === 'playing'", 'the next tap to start')`);
    await wait(1200);
    taps.push(await tapAndTime(cdp, coldRow + 1, 'repeat'));
    await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor("window.__navilite.status().state === 'playing'", 'the repeat tap to start')`);
    await wait(1200);
  }
  const of = (kind) => taps.filter((tap) => tap.kind === kind && tap.ms >= 0).map((tap) => tap.ms);
  const shape = (kind) => ({ n: of(kind).length, ms: of(kind), median: median(of(kind)), p90: p90(of(kind)) });
  return { taps, cold: shape('cold'), next: shape('next'), repeat: shape('repeat'), warmedOnTheWeb: taps.every((tap) => tap.warmedBefore.length === 0) };
}

/**
 * P3: the same page, one foreground track, eight seconds behind a faked `document.hidden`, and what
 * the return looks like. One in-page block, so no CDP round trip can land inside the gap.
 */
async function backgroundedPlayback(cdp) {
  const loadedHidden = await evaluate(cdp, 'document.hidden');
  const reading = await evaluate(
    cdp,
    `(async () => {
      const nav = window.__navilite;
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sample = (what) => ({
        what,
        hidden: document.hidden,
        state: nav.status().state,
        positionMs: nav.status().positionMs,
        word: nav.status().visualiser.word,
        tone: nav.status().visualiser.tone,
        arming: nav.status().spectrumArming,
        bars: (() => { const bands = nav.spectrumBands(); return bands ? bands.reduce((sum, value) => sum + value, 0) : null; })(),
      });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await sleep(1200);
      const foreground = sample('foreground, playing');
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      await sleep(4000);
      const midway = sample('four seconds into the gap');
      await sleep(4000);
      const late = sample('eight seconds into the gap');
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await sleep(1500);
      const returned = sample('back in the foreground');
      const el = window.__naviliteMediaElement;
      return { foreground, midway, late, returned, element: el ? { currentTime: el.currentTime, paused: el.paused } : null };
    })()`,
  );
  return { loadedHidden, ...reading };
}

async function main() {
  const report = await withChromePage(
    async ({ cdp }) => {
      await seed(cdp);
      const grabbed = await mediaElement(cdp);
      console.log(`  the app's media element: ${JSON.stringify(grabbed)}`);
      if (!grabbed) throw new Error('no media element in the page — the engine has not created one');

      console.log('P4 — time to first sound');
      const p4 = await timeToFirstSound(cdp);

      // Back to a plain, foreground, playing page for P3.
      await evaluate(cdp, `location.hash = ${JSON.stringify(PLAYLIST)}; true`);
      await playRow(cdp, 2);
      console.log('P3 — backgrounded playback');
      const p3 = await backgroundedPlayback(cdp);
      return { p3, p4 };
    },
    { args: ['--mute-audio'] },
  );

  const { p3, p4 } = report;
  console.log(`  headless load reported document.hidden = ${p3.loadedHidden} (the design measured true; the probe forces it, and asserts below)`);
  for (const sample of [p3.foreground, p3.midway, p3.late, p3.returned]) {
    console.log(`  ${sample.what}: state ${sample.state}, position ${Math.round(sample.positionMs)} ms, word ${sample.word}/${sample.tone}, arming ${sample.arming}, bars ${sample.bars}`);
  }
  check(p3.foreground.hidden === false, 'the foreground sample really is foreground (document.hidden === false)');
  check(p3.midway.state === 'playing', 'the engine stayed playing four seconds into the gap', p3.midway.state);
  check(p3.late.state === 'playing', 'and eight seconds into it — no paused flash', p3.late.state);
  check(p3.returned.state === 'playing', 'and on the way back', p3.returned.state);
  check(p3.returned.positionMs > p3.foreground.positionMs + 7000, 'the position moved by the whole gap, not by its own extrapolation', `${Math.round(p3.foreground.positionMs)} → ${Math.round(p3.returned.positionMs)} ms`);
  check(p3.returned.bars !== null && p3.returned.bars > 0, 'the bars are being fed again on return', p3.returned.bars);
  check(p3.returned.arming === false && p3.returned.word === 'spectrum', 'and the chip is back on the live word', `${p3.returned.word}/${p3.returned.tone} arming=${p3.returned.arming}`);

  console.log('  P4 medians (ms from the tap to the element reporting sound):');
  for (const kind of ['cold', 'next', 'repeat']) {
    const shape = p4[kind];
    console.log(`    ${kind}: n=${shape.n} median=${shape.median} p90=${shape.p90} ms ${JSON.stringify(shape.ms)}`);
  }
  console.log(`  P4 the pool is empty on the web path at every tap: ${p4.warmedOnTheWeb}`);
  for (const tap of p4.taps) {
    console.log(`    tap ${tap.kind} row ${tap.row} "${tap.title}" ${tap.ms} ms (warmed before: ${JSON.stringify(tap.warmedBefore)})`);
  }
  const missed = p4.taps.filter((tap) => tap.ms < 0);
  check(p4.cold.n >= 3, 'three cold taps were timed', p4.cold.n);
  check(missed.length === 0, 'every tap reached first sound inside 15 s', missed.length);

  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ label, url, p3, p4 }, null, 2)}\n`);
  console.log(`\n${label}: ${failures.length === 0 ? 'P3 green' : `${failures.length} P3 failures`}`);
  if (failures.length) process.exit(1);
}

await main();
