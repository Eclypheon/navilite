/**
 * v1.9.18 — the offline playlist page, driven in a real browser.
 *
 * The owner's report is a phone with no tailnet showing him
 * `could not reach https://alienlab.tailbed832.ts.net:9443 (TypeError: Load failed). Over Tailscale,
 * check the tailnet is up and the proxy is serving this path.` where his downloaded playlist's songs
 * should have been. No test can put his phone in airplane mode, so this drives the closest thing
 * that is honest about the same failure: the built app at 393 x 852 in real Chrome, with a real
 * `fetch` that really cannot reach the API — first a port nothing is listening on, then a port that
 * accepts the connection and never answers.
 *
 * It runs `tools/offline-check.mjs` and then asserts the numbers it reported — not just its exit
 * code — so a harness that quietly stopped measuring would fail here:
 *
 *   - the song list on the offline playlist page **is** the local manifest's, in order, by title;
 *   - the header names the playlist the store holds, and carries the offline badge;
 *   - the transport's own text ("could not reach", "Load failed", "Over Tailscale") appears nowhere
 *     in the document, on any of those screens, and no error box stands in for a view;
 *   - the songs are on screen in tens of milliseconds **while the request is still in flight**, which
 *     is the claim "the view does not wait for a round trip" stated as a number (the app's own
 *     request timeout is 20 s, so a view that waited would show nothing for 20 s);
 *   - the control: with the mirror gone the same route draws no songs — so the rows above came from
 *     the store and not from something cached;
 *   - and with the server *up*, the same route still draws the server's list, unbadged.
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

/**
 * A port of this test's own: `node --test` runs these files in parallel, and a mock is killed in the
 * `finally` below — on a shared port that would take the other test's library down with it, which is
 * a flake, not a finding. (4611/4613/4615/4657 are the other Chrome fixtures.)
 */
const PORT = 4619;
const REPORT = join(tmpdir(), `navilite-offline-check-${process.pid}.json`);
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

interface Reading {
  route: string;
  title: string | null;
  subtitle: string | null;
  rows: string[];
  downloadedRows: string[];
  pill: { visible: boolean; text: string } | null;
  emptyBox: string | null;
  leaked: string[];
  overflow: number;
  ms?: number;
}

interface OfflineReport {
  checks: Record<string, { ok: boolean; detail?: string }>;
  states: Record<string, Reading>;
}

test('a downloaded playlist is browsable with no connection, and no view prints a URL at him', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium binary found — set CHROME_PATH to run the offline check');
    return;
  }
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    t.skip('dist/ is not built — run `npm run build` first');
    return;
  }

  // The mock serves the built app *and* a real Subsonic API on one origin, which is what makes the
  // online control below possible: the same route, twice — once with the API reachable, once not.
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
      [
        'tools/offline-check.mjs',
        '--app',
        `http://127.0.0.1:${PORT}`,
        '--online-playlist',
        'pl-stress-long',
        '--json',
        REPORT,
      ],
      300_000,
    );
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('FAIL') || line.trimStart().startsWith('- '))
      .join('\n');
    assert.equal(code, 0, `the offline check failed:\n${failed || output}`);
    assert.match(output, /RESULT: a downloaded playlist is browsable with no connection/);

    const report = JSON.parse(readFileSync(REPORT, 'utf8')) as OfflineReport;
    for (const [label, check] of Object.entries(report.checks)) {
      assert.equal(check.ok, true, `${label}: ${check.detail ?? ''}`);
    }

    // The offline page is the *local* list: the manifest's own tracks, in its own order. If this
    // were the server's answer the titles would be the mock's fixture, not the mirror's.
    const offline = report.states.playlistOffline;
    assert.deepEqual(
      offline?.rows,
      ['海底、月明かり', '夜に駆ける', 'A very long unbroken track title for the 393 px audit'],
      'the offline playlist page did not draw the local manifest',
    );
    assert.equal(offline?.title, 'Late night driving', 'the header is not the name the store holds');
    assert.equal(offline?.emptyBox, null, 'an error box was drawn as the view');
    assert.deepEqual(offline?.leaked, [], 'the transport’s own text reached the screen');
    assert.equal(offline?.pill?.visible, true, 'nothing on the screen says the app is offline');
    assert.equal(offline?.overflow, 0, 'the offline page overflows the 393 px viewport');

    // Not vacuous: with the API gone the same route has nothing to draw — so the rows above came
    // from the store, and the harness is measuring the page rather than a cached document.
    assert.deepEqual(report.states.playlistWithoutMirror?.rows, [], 'the control drew songs with no mirror to draw them from');
    assert.equal(report.states.playlistWithoutMirror?.pill?.visible, true, 'the control did not reach the offline state');

    // And the claim that matters most, as a number: with a request still in flight (the app waits
    // 20 s for an answer) the songs were on screen well inside a second.
    const pending = report.states.playlistWithPendingRequest;
    assert.deepEqual(pending?.rows, offline?.rows, 'the songs were not on screen while the request hung');
    assert.ok(
      Number(pending?.ms) < 3000,
      `the view waited ${pending?.ms} ms for a server that never answered — the songs are drawn from the store, so it owes the round trip nothing`,
    );

    // With the server up, the same route is the server's: this is the regression guard for the
    // local-first order, and the mock's own 35-track playlist with the long Japanese name proves the
    // header came from the API and not from the mirror.
    const online = report.states.playlistOnline;
    assert.ok(Number(online?.rows.length) > 1, 'the online route did not draw the server’s list');
    assert.equal(online?.pill?.visible, false, 'the online route was badged as offline');
    assert.match(String(online?.title), /夜のドライブ/, 'the online header is not the server’s playlist name');

    // Every screen the harness visited, not just the playlist: the report is the assertion.
    for (const [name, state] of Object.entries(report.states)) {
      assert.deepEqual(state.leaked ?? [], [], `${name} printed the transport’s own text`);
    }
  } finally {
    mock.kill('SIGKILL');
  }
});
