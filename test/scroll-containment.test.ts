/**
 * The v1.4 scroll-containment regression test.
 *
 * The owner's report is about movement, so a DOM assertion cannot express it: *"if i'm in my
 * playlist then i go to my spectrum view, when i scroll, it seems to scroll the playlist behind
 * it"* and *"i should not be able to scroll the top bar of the main app such that it takes up more
 * space"*. Both were true of a document that was itself the scroll context, so both are checked by
 * driving the real app in a real browser at 393 x 852 (the iPhone 15 Pro's own numbers), firing
 * real touch and wheel scroll gestures through the input pipeline, and reading positions around
 * them.
 *
 * It runs `tools/scroll-check.mjs`, which owns the gestures, and then asserts the numbers it
 * reported — not just its exit code — so a harness that quietly stopped testing anything would
 * fail here:
 *
 *   - the list is scrolled by a real gesture at all (otherwise "nothing moved" is vacuous);
 *   - the top bar's `getBoundingClientRect()` is identical before and after every gesture;
 *   - the document never scrolls, and has nothing to scroll;
 *   - a gesture over the spectrum leaves the list's `scrollTop` untouched, in both modes;
 *   - closing the spectrum puts the list back at exactly the offset it was left at;
 *   - a deliberately 600 px-wide element is still reported by the 393 px layout audit, i.e. moving
 *     the scroll context off the document did not disarm the owner's own overflow regression.
 *
 * It needs Chrome and a built `dist/`, so it skips (with the reason printed) when either is
 * missing rather than passing on nothing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startMockLibrary } from './support/mock-fixture.ts';

const REPORT = join(tmpdir(), `navilite-scroll-containment-${process.pid}.json`);
const CHROME_CANDIDATES: string[] = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome(): string | null {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs} ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

interface ScrollState {
  route: string;
  header: { top: number; height: number; bottom: number };
  documentScrollTop: number;
  windowScrollY: number;
  documentScrollable: number;
  scrollSurface: string;
  scrollTop: number;
  scrollable: number;
  overflowY: string;
  overscrollY: string;
  nowOpen: boolean;
  lyricsScrollTop: number | null;
}

interface ScrollReport {
  states: Record<string, ScrollState> & {
    layoutGuard?: { injected: { overflow: number; surface: string; named: string[] }; clean: { overflow: number } };
    hitTest?: { points: Array<{ insideNow: boolean }>; allInsideNow: boolean };
  };
  gestures: Array<{
    at: string;
    surface: string;
    before: number;
    after: number;
    documentBefore: number;
    documentAfter: number;
    headerBefore: ScrollState['header'];
    headerAfter: ScrollState['header'];
  }>;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

test('nothing moves when you scroll: not the list behind the spectrum, not the top bar', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium binary found — set CHROME_PATH to run the scroll-containment check');
    return;
  }
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    t.skip('dist/ is not built — run `npm run build` first');
    return;
  }

  const mock = await startMockLibrary({ stress: true });
  try {
    const { code, output } = await run(
      process.execPath,
      ['tools/scroll-check.mjs', '--url', mock.base, '--json', REPORT],
      300_000,
    );
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('FAIL') || line.trimStart().startsWith('- '))
      .join('\n');
    assert.equal(code, 0, `the scroll-containment check failed:\n${failed || output}`);
    assert.match(output, /RESULT: nothing moved that should not have\./);

    const report = JSON.parse(readFileSync(REPORT, 'utf8')) as ScrollReport;

    for (const [label, check] of Object.entries(report.checks)) {
      assert.equal(check.ok, true, `${label}: ${check.detail ?? ''}`);
    }

    // The gesture mechanism is real: the list moved when it was supposed to.
    const browsed = report.gestures.find((gesture) => gesture.at === 'the playlist, browsing');
    assert.ok(browsed, 'the browsing gesture was not recorded');
    assert.ok(
      browsed.after > browsed.before,
      `the list did not move under a real gesture (scrollTop ${browsed.before} -> ${browsed.after}) — the check would be vacuous`,
    );

    // The document is not a scroll context any more, and has nothing to scroll.
    assert.equal(report.states.opened?.documentScrollable, 0, 'the document still has scrollable content');
    assert.equal(report.states.opened?.documentScrollTop, 0);
    assert.equal(report.states.opened?.windowScrollY, 0);
    assert.notEqual(report.states.opened?.scrollSurface, 'html', 'the document is still the scroll surface');

    // The top bar is identical before and after every single gesture.
    for (const gesture of report.gestures) {
      assert.deepEqual(
        gesture.headerAfter,
        gesture.headerBefore,
        `the top bar moved during “${gesture.at}”: ${JSON.stringify(gesture.headerBefore)} -> ${JSON.stringify(gesture.headerAfter)}`,
      );
    }

    // The offset the list was left at is the offset it comes back to, to the pixel.
    const leftAt = report.states.spectrumOpen?.scrollTop;
    assert.ok(typeof leftAt === 'number' && leftAt > 0, 'the list was not scrolled before the spectrum opened');
    assert.equal(report.states.afterSpectrumGesture?.scrollTop, leftAt, 'scrolling the spectrum moved the list behind it');
    assert.equal(report.states.lyricsGestured?.scrollTop, leftAt, 'scrolling the lyrics view moved the list behind it');
    assert.equal(report.states.restored?.scrollTop, leftAt, 'closing the spectrum did not restore the list offset');
    assert.equal(report.states.restored?.route, '#/playlist/pl-stress-long');

    // The lyrics panel is a real scroller under the same gesture — so the check above means
    // "it did not chain", not "there was nothing to scroll".
    assert.ok(
      Number(report.states.lyricsGestured?.lyricsScrollTop) > 0,
      'the lyrics panel never took the gesture, so the chaining check proved nothing',
    );

    // The 393 px layout guard still bites after the shell stopped being the scroller.
    assert.ok(Number(report.states.layoutGuard?.injected?.overflow) > 0, 'the layout audit missed an injected 600 px element');
  } finally {
    mock.stop();
  }
});
