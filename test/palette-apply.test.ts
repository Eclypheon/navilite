/**
 * The palette-apply regression test.
 *
 * The defect it covers is invisible to a DOM assertion and to the type checker: `boot()` passed
 * the function `applyPalette` where `restoreSession()` wanted an object with an `apply` method,
 * and a function *is* structurally one (that is `Function.prototype.apply`). So every cold start
 * — the stored-session path, i.e. every normal launch — called `applyPalette(undefined)` from
 * inside `syncPalette()`, `applyPaletteVars` threw on `palette.primary` in a floating promise, and
 * the album-art theme was never applied for the rest of the session. It shipped that way in v1.1
 * through v1.4 because nothing ever asked the app what colour it had ended up.
 *
 * This runs `tools/palette-check.mjs`, which drives the real app in real Chrome through the stored
 * session, taps a play button, and then asserts on the numbers it reported — not just its exit
 * code, so a driver that quietly stopped driving anything would fail here:
 *
 *   - the launch itself throws nothing;
 *   - with cover art reachable the palette comes back `fromArt: true`, *is* the artwork's colour
 *     and is not the default, and the document is carrying it;
 *   - with `getCoverArt` failing the app lands on the defaults, applies them and throws nothing;
 *   - the two track changes are different tracks, so neither check is vacuous;
 *   - and nothing was thrown anywhere in the session.
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

const DEFAULT_PRIMARY = '#7cd2ff';
const REPORT = join(tmpdir(), `navilite-palette-${process.pid}.json`);
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

interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  fromArt: boolean;
}

interface PaletteReading {
  palette: Palette;
  cssPrimary: string;
  playing: string | null;
  errors: string[];
}

interface PaletteReport {
  phases: {
    onBoot?: PaletteReading & { route: string };
    artReachable?: { before: PaletteReading; played: { rows: number; song: string | null }; artworkArrived: boolean; after: PaletteReading };
    artUnreachable?: { before: PaletteReading; played: { song: string | null }; after: PaletteReading };
    final?: PaletteReading;
  };
  checks: Record<string, { ok: boolean; detail?: string }>;
}

test('a track change re-themes the app: the album-art palette applies, and nothing is thrown', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium binary found — set CHROME_PATH to run the palette apply check');
    return;
  }
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    t.skip('dist/ is not built — run `npm run build` first');
    return;
  }

  // A port the OS picked, not 4615: this file and test/pager.test.ts both used to ask for that one,
  // and the loser's mock was answered by the winner's (see test/support/mock-fixture.ts).
  const mock = await startMockLibrary({ stress: true });
  try {
    const { code, output } = await run(
      process.execPath,
      ['tools/palette-check.mjs', '--url', mock.base, '--json', REPORT],
      180_000,
    );
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('FAIL') || line.trimStart().startsWith('- '))
      .join('\n');
    assert.equal(code, 0, `the palette apply check failed:\n${failed || output}`);
    assert.match(output, /RESULT: the theme follows the track, and nothing threw\./);

    const report = JSON.parse(readFileSync(REPORT, 'utf8')) as PaletteReport;
    for (const [label, check] of Object.entries(report.checks)) {
      assert.equal(check.ok, true, `${label}: ${check.detail ?? ''}`);
    }

    // Nothing was thrown during the stored-session launch, or anywhere after it.
    assert.deepEqual(report.phases.onBoot?.errors, [], 'the cold start threw');
    assert.deepEqual(report.phases.final?.errors, [], 'something threw during the session');

    // The artwork palette is the one the app held, and the one the document carried.
    const withArt = report.phases.artReachable;
    assert.equal(withArt?.artworkArrived, true, 'the artwork palette never arrived — the app stayed on the defaults');
    assert.equal(withArt?.after.palette?.fromArt, true, `palette after the track change: ${JSON.stringify(withArt?.after.palette)}`);
    assert.deepEqual(withArt?.after.errors, [], 'the track change with cover art threw');
    assert.notEqual(withArt?.after.palette?.primary, DEFAULT_PRIMARY, 'the artwork palette is the default palette');
    assert.equal(
      withArt?.after.cssPrimary,
      withArt?.after.palette?.primary,
      `the document is carrying “${withArt?.after.cssPrimary}” while the palette says “${withArt?.after.palette?.primary}”`,
    );

    // And with the cover art door shut, the fallback is applied rather than thrown.
    const noArt = report.phases.artUnreachable;
    assert.equal(noArt?.after.palette?.fromArt, false, 'a missing cover art did not fall back to the defaults');
    assert.equal(noArt?.after.palette?.primary, DEFAULT_PRIMARY);
    assert.equal(noArt?.after.cssPrimary, DEFAULT_PRIMARY, 'the defaults were not applied when no cover art was reachable');
    assert.deepEqual(noArt?.after.errors, [], 'the track change with no cover art threw');

    // Neither half of this is vacuous: two different tracks were actually played.
    assert.ok(withArt?.played.song, 'the first track change did not start a track');
    assert.ok(noArt?.played.song, 'the second track change did not start a track');
    assert.notEqual(noArt?.played.song, withArt?.played.song, 'both halves played the same track, so the second proved nothing');
  } finally {
    mock.stop();
  }
});
