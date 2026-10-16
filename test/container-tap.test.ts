/**
 * The bottom container's two-tap rule, pinned in `npm test` (beta.3).
 *
 * The owner's report is about a *tap*, so no DOM assertion can express it: *"the list scrolls to it…
 * tap it again and you get the spectrum… it scrolls upwards a random chunk… i'm not able to tap
 * again when the song title is on the screen to go into spectrum view."* Two of his screens are in
 * that sentence and only one of them was ever checked: the tap rule (`v2.0-beta`'s item 4) was driven
 * by `tools/container-tap-check.mjs`, which **is not run by `npm test`** — and its fixture could not
 * produce the state his report is about, because it never gave the playlist page a local manifest to
 * paint from (`renderPlaylist` paints the phone's own list and then the server's answer, and only the
 * second paint's rows are on the screen; the first batch stayed in the registry the tap used to read,
 * at a `(0,0,0,0)` rect). So the defect shipped, was reported, and came back.
 *
 * This test runs that harness — the whole of it, the checks `v2.0-beta` already had plus the
 * downloaded-playlist fixture and the end-of-list cases — and then asserts the **numbers** it
 * reported, not just its exit code, so a harness that quietly stopped testing anything fails here:
 *
 *   - the middle of a long list: one move, the row centred, the second tap opens the spectrum;
 *   - the fixture that reproduces the report: the list painted **twice** (the harness's own probe,
 *     no app hook) and the same two taps still land, on the row the view *marks*;
 *   - the first row of the list, scrolled down: clamped at `scrollTop 0`, fully on screen, second
 *     tap opens;
 *   - the last row, list at the top: clamped at the list's own maximum, the row **above the player
 *     bar** at that limit — which is the assertion that decides whether the view's end padding is
 *     enough — and the second tap opens;
 *   - a view whose order is not the queue's (`#/downloads`, the store's own order, deliberately
 *     reversed by the fixture): the check first proves the playing song sits at a *different*
 *     position there, then that the tap resolves the row the view marks by id and centres it — an
 *     index-based target would answer with another row;
 *   - the pair's other half: the same downloaded playlist with the API at a dead port paints **once**
 *     and the same tap still centres and opens. Same list, same tap, opposite result on the shipped
 *     bytes — that is the reproduction;
 *   - and the motion accounting: one `scroll` event per centring tap, **zero** on the tap that opens
 *     (`docs/design-beta-3-scroll.md` §2).
 *
 * It needs Chrome and a built `dist/`, so it skips (with the reason printed) when either is missing,
 * exactly as the scroll-containment test does. The harness really plays audio, so it stays muted
 * (`--mute-audio`) and no iOS Simulator is booted: Chrome's input pipeline, 393 x 852.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startMockLibrary } from './support/mock-fixture.ts';

const REPORT = join(tmpdir(), `navilite-container-tap-${process.pid}.json`);
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
      reject(new Error(`timed out after ${timeoutMs} ms: ${command} ${args.join(' ')}\n${output}`));
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

interface Box {
  top: number;
  bottom: number;
  height: number;
}

interface Reading {
  route: string;
  barTitle: string | null;
  nowHidden: boolean;
  nowMode: string;
  scrollTop: number;
  scrollBox: Box;
  scrollMax: number;
  playingRowTitle: string | null;
  playingRow: Box | null;
  playingRowIndex: number;
  playingRowMarks: number;
  bar: Box | null;
  rowCount: number;
  queueContext: string | null;
  meta: { x: number; y: number };
}

interface Scene {
  before: Reading;
  after: Reading;
  opened: Reading;
}

interface TapReport {
  url: string;
  chrome: string;
  ms: number;
  stages: {
    centre?: { before: Reading; after: Reading };
    visibleOpensOnFirstTap?: { before: Reading; after: Reading };
    searchTwoSubmits?: Scene;
    ghostPaints?: { lists: number; rows: number; scrolls: number };
    ghostOnline?: Scene;
    ghostFirstRow?: Scene;
    ghostLastRow?: Scene;
    albumOrder?: { before: Reading; after: Reading };
    refusedPaints?: { lists: number; rows: number; scrolls: number };
    refusedServer?: Scene;
  };
  skips: Array<{ message: string; reason: string }>;
  failures: string[];
}

/** The row is inside the scroll box *and* clear of the player bar — the band the eye has. */
function above(reading: Reading): boolean {
  const row = reading.playingRow;
  if (row === null) return false;
  const band = reading.bar && reading.bar.height > 0 ? reading.bar.top : reading.scrollBox.bottom;
  return row.top >= reading.scrollBox.top && row.bottom <= reading.scrollBox.bottom && row.bottom <= band;
}

test('the two-tap rule: the row the view marks, one move, clamped at the ends, and the second tap opens', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium binary found — set CHROME_PATH to run the container-tap check');
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
      ['tools/container-tap-check.mjs', '--url', mock.base, '--json', REPORT],
      900_000,
    );
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('FAIL') || line.trimStart().startsWith('- '))
      .join('\n');
    assert.equal(code, 0, `the container-tap check failed:\n${failed || output}`);
    assert.match(output, /RESULT: the bottom container behaves/);

    const report = JSON.parse(readFileSync(REPORT, 'utf8')) as TapReport;
    const stages = report.stages;

    // 1. The middle of a long list, as `v2.0-beta` already had it: one move, centred, and the tap
    //    that opens moves nothing (the accounting §2 gives for rows 1, 3 and 6).
    const centre = stages.centre;
    assert.ok(centre, 'the centring stage was not recorded');
    const centreRow = centre.after.playingRow;
    const centreBox = centre.after.scrollBox;
    assert.ok(centreRow && centre.after.scrollTop !== centre.before.scrollTop, 'the first tap did not move the list');
    assert.ok(
      Math.abs(centreRow.top + centreRow.height / 2 - (centreBox.top + centreBox.bottom) / 2) <= 6,
      `the row was not centred: ${JSON.stringify(centreRow)} against ${JSON.stringify(centreBox)}`,
    );

    // 2. The fixture that reproduces the report: a playlist this phone has downloaded, with the
    //    server answering, so `renderPlaylist` painted its list twice (the harness's own probe) — and
    //    the two taps still land on the row the view *marks*.
    assert.equal(stages.ghostPaints?.lists, 2, `the downloaded playlist did not paint twice: ${JSON.stringify(stages.ghostPaints)}`);
    const ghost = stages.ghostOnline;
    assert.ok(ghost, 'the downloaded-playlist stage was not recorded');
    assert.equal(ghost.before.playingRowMarks, 1, 'the downloaded playlist did not mark exactly one row as playing');
    const ghostRow = ghost.after.playingRow;
    const ghostBox = ghost.after.scrollBox;
    assert.ok(
      ghostRow && Math.abs(ghostRow.top + ghostRow.height / 2 - (ghostBox.top + ghostBox.bottom) / 2) <= 6,
      `the downloaded playlist's row was not centred: ${JSON.stringify(ghostRow)} against ${JSON.stringify(ghostBox)}`,
    );
    assert.ok(above(ghost.after), 'the centred row was not fully on screen above the bar');
    assert.equal(ghost.opened.route, '#/now', 'the second tap did not open the now screen');
    assert.equal(ghost.opened.nowMode, 'spectrum', 'the second tap did not open it on the spectrum pane');

    // 3. The first row of the list, with the list scrolled down: clamped at the list's own top.
    const first = stages.ghostFirstRow;
    assert.ok(first, 'the first-row stage was not recorded');
    assert.equal(first.after.scrollTop, 0, `the first row was not clamped at scrollTop 0: ${first.after.scrollTop}`);
    assert.ok(above(first.after), 'the first row was not fully on screen above the bar');
    assert.equal(first.opened.route, '#/now', 'the second tap did not open the now screen on the first row');

    // 4. The last row, with the list at the top: clamped at the list's own maximum, and clear of the
    //    bar there — which is the assertion that decides whether the view's end padding is enough.
    const last = stages.ghostLastRow;
    assert.ok(last, 'the last-row stage was not recorded');
    assert.ok(last.after.scrollMax > 0, 'the list could not scroll, so the last-row case proved nothing');
    assert.equal(last.after.scrollTop, last.after.scrollMax, `the last row was not clamped at the list's maximum: ${last.after.scrollTop}`);
    assert.ok(above(last.after), `the last row was not clear of the player bar at the list's limit: ${JSON.stringify(last.after.playingRow)} bar ${JSON.stringify(last.after.bar)}`);
    assert.equal(last.opened.route, '#/now', 'the second tap did not open the now screen on the last row');

    // 5. A view whose order is not the queue's: the check proves the two positions differ, so the
    //    target cannot be an index, and the row this view marks is the one the tap opened on.
    assert.equal(report.skips.length, 0, `a precondition was skipped, so a case proved nothing: ${JSON.stringify(report.skips)}`);
    const album = stages.albumOrder;
    assert.ok(album, 'the album-page stage was not recorded');
    const queueAt = /\((\d+)\/(\d+)\)/.exec(album.before.queueContext ?? '');
    assert.ok(queueAt, `the now-playing line carries no queue position: ${album.before.queueContext}`);
    assert.ok(album.before.playingRowIndex >= 0, 'the album page carried no row for the playing song');
    assert.notEqual(
      album.before.playingRowIndex + 1,
      Number(queueAt[1]),
      'the album page happened to hold the playing song at its queue position, so this case proved nothing',
    );
    assert.equal(album.before.playingRowMarks, 1, 'the album page did not mark exactly one row as playing');
    assert.equal(album.before.playingRowTitle, album.before.barTitle, 'the marked row was not the track the bar shows');
    assert.equal(album.after.route, '#/now', 'one tap on a view whose order is not the queue’s did not open the now screen');
    assert.equal(album.after.nowMode, 'spectrum', 'and did not open it on the spectrum pane');

    // 6. The pair's other half: the same list with the API refused paints once, and the same tap
    //    still centres and opens.
    assert.equal(stages.refusedPaints?.lists, 1, `the refused half painted its list ${stages.refusedPaints?.lists} times, not once`);
    const refused = stages.refusedServer;
    assert.ok(refused, 'the refused-server stage was not recorded');
    assert.ok(above(refused.after), 'the same tap did not bring the row on screen with no server');
    assert.equal(refused.opened.route, '#/now', 'the second tap did not open the now screen with no server');

    // 7. Search after two submits: the second result set replaced the first, and the tap still finds
    //    the row the view marks.
    const search = stages.searchTwoSubmits;
    assert.ok(search, 'the two-submit search stage was not recorded');
    assert.equal(search.opened.route, '#/now', 'the second tap did not open the now screen on the search screen');
    assert.equal(search.opened.nowMode, 'spectrum', 'the second tap did not open it on the spectrum pane');
  } finally {
    mock.stop();
  }
});
