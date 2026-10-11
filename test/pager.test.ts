/**
 * The v1.5 swipe-pager regression test.
 *
 * The owner asked for the now-playing screen's three views to be *swiped* — *"swiping left or right
 * should transition the screens smoothly and appear like it is pulling in the screen from the side
 * rather than a sudden change"* — with the order **playlist | spectrum | lyrics**, and for a vertical
 * scroll to keep scrolling instead of turning a page. Both claims are about what happens *during* a
 * gesture, so a DOM assertion cannot express either: this drives the real app in a real browser at
 * 393 x 852, with real fingers through the input pipeline (`Input.dispatchTouchEvent`), and reads the
 * panes' geometry between moves, with the finger still down.
 *
 * It runs `tools/pager-check.mjs` and then asserts the numbers it reported — not just its exit code,
 * so a harness that quietly stopped measuring would fail here:
 *
 *   - the panes moved exactly as far as the finger did, and the strip is transformed by that travel;
 *   - the playlist and the now screen tile edge to edge while they trade places, so nothing is ever
 *     exposed between them;
 *   - a mostly-vertical diagonal gesture (200 px across — more than half a pane) scrolls the list and
 *     turns no page at all, and the pager writes no transform for it;
 *   - the same shallow 0.2-pane distance snaps back when released slowly and turns the page when
 *     flicked — the velocity projection, proven by the difference and by the release the report
 *     carries (the gap the pager's own clock saw, and the panes it projects);
 *   - the ring walks 1 → 2 → 0 and back;
 *   - the (x/y) line and the transport are still hit-testable with the finger down;
 *   - the highlight follows a 36-line sidecar to the line, never scrolls the panel past its own end,
 *     and leaves a hand scroll alone until the grace period is over.
 *
 * It needs Chrome and a built `dist/`, so it skips (with the reason printed) when either is missing
 * rather than passing on nothing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const PORT = 4615;
const REPORT = join(tmpdir(), `navilite-pager-${process.pid}.json`);
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

interface PagerState {
  position: number;
  offset: number;
  dragging: boolean;
  settled: boolean;
}

interface GestureRelease {
  gapMs: number;
  pxPerMs: number;
  projectedPanes: number;
}

interface PagerReport {
  checks: Record<string, { ok: boolean; detail?: string }>;
  stages: {
    diagonalOnList: { scrollTop: number; after: PagerState; list: { translate: string } };
    opened: { route: string; pager: PagerState };
    follow: { samples: Array<{ x: number; offset: number; expected: number; strip: number }>; offsetErrorPx: number; stripErrorPx: number };
    flick: {
      ms: number;
      offsets: number[];
      rest: number;
      route: string;
      /** The cadence the check asked for, and whether the release move was dispatched in one task. */
      askedGapMs: number;
      sameTaskRelease: boolean;
      /** Whether the release the check actually got is a fast one — i.e. whether the verdict is about the pager. */
      releaseIsFast: boolean;
      release: GestureRelease;
    };
    snapBack: { offsets: number[]; rest: number; settled: boolean; settledAfterMs: number; release: GestureRelease };
    slowRelease: { offsets: number[]; rest: number; settled: boolean; settledAfterMs: number; release: GestureRelease };
    ring: { first: { pane: number; route: string }; second: { pane: number; route: string } };
    pill: { strip: number[]; pills: Array<string | null> };
    controlsMidDrag: { offset: number; controls: Array<{ selector: string; insideControl: boolean }> };
    history: { onLyrics: { pane: number }; back: { pane: number; route: string }; forward: { pane: number; route: string } };
    lyricsDensity: { lines: number; visibleLines: number; firstLineInFade: boolean; firstLineFullyInside: boolean };
    lyricsSong: { lines: number; duration: number };
    lyricsWalk: Array<{ index: number; activeIndex: number; scrollTop: number; maxScroll: number; atEnd: boolean }>;
    grace: { handMoved: number; afterHand: number; duringGrace: number };
  };
}

test('the swipe pager pulls its panes, and never takes a scroll', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium binary found — set CHROME_PATH to run the pager check');
    return;
  }
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    t.skip('dist/ is not built — run `npm run build` first');
    return;
  }

  const mock = spawn(process.execPath, ['tools/mock-subsonic.mjs', '--port', String(PORT), '--stress'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/rest/ping.view?u=navidrome&p=navidrome&v=1.16.1&c=Navilite&f=json`);
        if (response.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('the mock library never came up');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const { code, output } = await run(
      process.execPath,
      ['tools/pager-check.mjs', '--url', `http://127.0.0.1:${PORT}`, '--json', REPORT],
      420_000,
    );
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('FAIL') || line.trimStart().startsWith('- '))
      .join('\n');
    assert.equal(code, 0, `the pager check failed:\n${failed || output}`);
    assert.match(output, /RESULT: the pager pulls its panes, and nothing else moved\./);

    const report = JSON.parse(readFileSync(REPORT, 'utf8')) as PagerReport;
    for (const [label, check] of Object.entries(report.checks)) {
      assert.equal(check.ok, true, `${label}: ${check.detail ?? ''}`);
    }

    // It never took a scroll: a diagonal that carried more than half a pane's width across.
    assert.equal(report.stages.diagonalOnList.after.position, 0, 'the pager moved on a mostly-vertical drag');
    assert.equal(report.stages.diagonalOnList.after.offset, 0);
    assert.equal(
      report.stages.diagonalOnList.list.translate === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(report.stages.diagonalOnList.list.translate),
      true,
      `the pager wrote a transform onto the list: ${report.stages.diagonalOnList.list.translate}`,
    );

    // It *does* pull: the offset tracks the finger, and so does the strip.
    assert.ok(report.stages.follow.samples.length >= 4, 'the drag was not sampled while the finger was down');
    assert.ok(
      report.stages.follow.offsetErrorPx < 2,
      `the pane lagged the finger by ${report.stages.follow.offsetErrorPx} px`,
    );
    assert.ok(report.stages.follow.stripErrorPx < 2, `the strip was off by ${report.stages.follow.stripErrorPx} px`);
    for (let index = 1; index < report.stages.follow.samples.length; index += 1) {
      assert.ok(
        report.stages.follow.samples[index].offset > report.stages.follow.samples[index - 1].offset,
        'the offset did not advance with the finger, move by move',
      );
    }

    // Velocity: the same shallow distance, two different releases.
    assert.ok(
      Math.max(...report.stages.flick.offsets) < 2.32,
      `the flick travelled ${Math.max(...report.stages.flick.offsets)} panes — it must stay short of the commit point`,
    );
    assert.equal(report.stages.flick.rest, 0, 'the flick did not turn the page');
    /*
     * And the velocities are the harness's own, not whatever the driver happened to cost.
     *
     * The pager reads its release velocity from the `performance.now()` gap between its own last two
     * touchmoves, so a gesture driven through the input pipeline is clocked by the round trip — which
     * is how this pair of checks used to flake (t_067de214): the same `stepDelayMs: 6` CDP drag handed
     * the pager 212–330 ms gaps on a busy box and under 80 ms on a quiet one, straddling the ~78 ms
     * that decides a 0.2-pane drag. The gestures are now driven inside the page at a cadence the check
     * sets, and the report carries the gaps the pager's own clock saw: assert them, so a harness that
     * quietly stopped controlling (or reporting) the cadence fails here rather than passing on 0.32.
     */
    assert.ok(
      report.stages.slowRelease.release.gapMs >= 100,
      `the "slow" release was driven at ${report.stages.slowRelease.release.gapMs} ms between moves — not slow enough to mean anything`,
    );
    assert.equal(report.stages.slowRelease.settled, true, 'the slow release’s rest pose was read before the pager had stopped');
    // The short drag is the same claim at a shorter distance. Its commit threshold is 42 ms (0.12 panes
    // over two steps), so the ask is the floor that has to stay above it — a timer can only be late.
    assert.ok(
      report.stages.snapBack.release.gapMs >= 100,
      `the short drag was driven at ${report.stages.snapBack.release.gapMs} ms between moves — that is not clear of the 42 ms that would commit it`,
    );
    assert.equal(report.stages.snapBack.settled, true, 'the short drag’s rest pose was read before the pager had stopped');
    assert.ok(
      0.2 + report.stages.slowRelease.release.projectedPanes < 0.32,
      `the slow release projected to ${(0.2 + report.stages.slowRelease.release.projectedPanes).toFixed(3)} panes, past the commit point`,
    );
    assert.equal(report.stages.slowRelease.rest, 2, 'the slow release did not snap back');
    assert.ok(
      0.12 + report.stages.snapBack.release.projectedPanes < 0.32,
      `the short drag projected to ${(0.12 + report.stages.snapBack.release.projectedPanes).toFixed(3)} panes, past the commit point`,
    );
    assert.ok(
      report.stages.flick.release.projectedPanes >= 0.12,
      `the flick projected to only ${report.stages.flick.release.projectedPanes} panes — its commit was not the velocity projection`,
    );
    /*
     * And the flick's release is the harness's own *by construction*, not by a timer being punctual.
     * A timer can only be late: asked for 8 ms the pager's clock has seen 9–47 ms, and the commit needs
     * a gap under ~78 ms, so a punctual-timer flick goes red on a correct app. The release move is
     * dispatched in the same task as the one before it, so the gap is the synchronous work between two
     * dispatches — assert that, so a revision that quietly went back to a timer fails here instead of
     * on the app's account.
     */
    assert.equal(report.stages.flick.sameTaskRelease, true, 'the flick’s release move was not dispatched in the same task as the one before it');
    assert.ok(
      report.stages.flick.release.gapMs < 5,
      `the flick’s release gap was ${report.stages.flick.release.gapMs} ms — the release move was clocked by a timer, not by the check`,
    );
    assert.equal(report.stages.flick.releaseIsFast, true, 'the flick’s release was not fast enough to commit on velocity, so its verdict is not about the pager');
    assert.equal(report.stages.flick.askedGapMs, 8, 'the flick no longer asks for the cadence it reports');

    // The ring, and the pill sliding through the same pager.
    assert.equal(report.stages.ring.first.pane, 2, 'left from the spectrum is not the lyrics');
    assert.equal(report.stages.ring.first.route, '#/now/lyrics');
    assert.equal(report.stages.ring.second.pane, 0, 'left from the lyrics is not the playlist');
    const midFlight = report.stages.pill.strip.filter((value) => value < -2 && value > -391);
    assert.ok(midFlight.length > 0, 'the pill switched panes without the strip ever being between them');

    // The controls live outside the strip, so a finger on the pane cannot cover them.
    for (const control of report.stages.controlsMidDrag.controls) {
      assert.equal(control.insideControl, true, `${control.selector} was not reachable mid-drag`);
    }

    // Back and forward walk the panes.
    assert.equal(report.stages.history.onLyrics.pane, 2);
    assert.notEqual(report.stages.history.back.pane, 2, 'history.back() did not leave the lyrics pane');
    assert.equal(report.stages.history.forward.pane, 2, 'history.forward() did not return to the lyrics');

    // The lyrics: a sidecar longer than the panel, followed to the line.
    assert.ok(
      report.stages.lyricsSong.lines >= 30,
      `the sidecar has only ${report.stages.lyricsSong.lines} lines — the follow's scrolling is not exercised`,
    );
    assert.ok(report.stages.lyricsDensity.firstLineFullyInside, 'the first lyric line is not drawn whole');
    assert.equal(report.stages.lyricsDensity.firstLineInFade, false, 'the first lyric line sits in the panel’s faded band');
    const wrongLine = report.stages.lyricsWalk.filter((step) => step.activeIndex !== step.index);
    assert.equal(wrongLine.length, 0, `${wrongLine.length} positions lit a line that was not theirs`);
    const overshot = report.stages.lyricsWalk.filter((step) => step.scrollTop > step.maxScroll + 0.5);
    assert.equal(overshot.length, 0, `the follow scrolled past the end of the panel ${overshot.length} times`);

    // The grace period: a hand scroll is his.
    assert.ok(
      Math.abs(report.stages.grace.handMoved) > 20,
      'the hand scroll moved the panel nowhere, so the grace check proved nothing',
    );
    assert.ok(
      Math.abs(report.stages.grace.duringGrace - report.stages.grace.afterHand) <= 6,
      `the follow moved the panel ${report.stages.grace.duringGrace - report.stages.grace.afterHand} px while he was reading`,
    );
  } finally {
    mock.kill('SIGKILL');
  }
});
