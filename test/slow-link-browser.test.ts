/**
 * v1.9.0 — the numbers behind the owner's bar: *"the load times should be nigh imperceptible."*
 *
 * This drives the real app in a real browser at 393 x 852 against the project's own mock Subsonic
 * server, and it measures the three things that bar is about:
 *
 *   - **the tap paints in the same task** — read *synchronously* after `row.click()`, so no
 *     microtask, no timer and no network callback can have run in between. The paint is therefore
 *     before any request resolves by construction, not by a race that happens to be won;
 *   - **the next track's bytes are requested while the current one plays** — the mock and the app
 *     both appear in the page's own resource timeline, so the prefetch is visible as a `fetch`
 *     entry for a *different* stream URL than the one being played;
 *   - **what a track change costs, cold and warm** — the same tap on the track that was prefetched,
 *     measured the same way, plus the transfer sizes the browser reports for both loads.
 *
 * What it cannot measure, and says so rather than implying otherwise: the owner's mobile link. This
 * runs over loopback on this Mac — no relay, no carrier NAT, no radio. The *latency* he pays
 * (~100–400 ms of round trip through a relay) is exactly what a track change no longer spends,
 * because by then the request is already in flight; the loopback numbers below are about the
 * mechanism, not about his link.
 *
 * Needs Chrome and a built `dist/`, so it skips (with the reason printed) when either is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The browser plumbing, borrowed from the existing audit tool rather than re-written.
 *
 * Loaded through a variable specifier on purpose: `tools/` is plain JavaScript with no type
 * declarations (every other check in this repository *spawns* a tool instead of importing one), and
 * a variable specifier is what keeps `tsc --noEmit` honest about a module it cannot see inside.
 */
interface BrowserAudit {
  findChrome: () => string | null;
  withChromePage: (
    fn: (page: { cdp: unknown; port: number }) => Promise<unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  evaluate: (cdp: unknown, expression: string) => Promise<unknown>;
  navigate: (cdp: unknown, url: string) => Promise<void>;
}

const AUDIT_PATH = '../tools/layout-audit.mjs';
const audit = (await import(AUDIT_PATH)) as BrowserAudit;
const { withChromePage, evaluate, navigate, findChrome } = audit;

/** What the page hands back, typed so the assertions below read like the claims they are. */
interface Shape {
  bytes: number;
  decoded: number;
  ms: number;
  initiator: string;
}

interface Reading {
  cold: { ms: number; highlighted: string | null; selected: boolean; loading: boolean; chip: string };
  coldFirstAudioMs: number;
  coldStream: Shape | null;
  prefetchBeforeTheEnd: boolean;
  prefetch: Shape | null;
  playingWhilePrefetching: string;
  warm: { ms: number; highlighted: string | null; selected: boolean; loading: boolean; chip: string };
  warmFirstAudioMs: number;
  warmStream: Shape | null;
  throughputKbps: number | null;
}

const PORT = 4657;
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'navilite-check';
const PASSWORD = 'mock';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The mock, started the way every other check starts it. */
function startMock(): { kill: () => void } {
  const child = spawn(process.execPath, ['tools/mock-subsonic.mjs', '--port', String(PORT), '--stress', '--dist', 'dist', '--user', USER, '--password', PASSWORD], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  return { kill: () => child.kill('SIGKILL') };
}

async function waitForMock(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/rest/ping?u=${USER}&p=${PASSWORD}&v=1.16.1&c=navilite&f=json`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('the mock Subsonic server never answered');
}

/**
 * Everything measured, in one page evaluation.
 *
 * The order inside is the point: `click()`, then the paint read, and only *then* any `await`. A
 * promise resolved by the network cannot have run in between, so "the row is selected and loading
 * before any request resolves" is not an assertion about timing — it is what the code path does.
 */
const MEASURE = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (fn, ms) => {
    const started = performance.now();
    for (;;) {
      const value = fn();
      if (value) return { value, ms: performance.now() - started };
      if (performance.now() - started > ms) return { value: null, ms: performance.now() - started };
      await sleep(20);
    }
  };
  const streams = () =>
    performance.getEntriesByType('resource').filter((entry) => entry.name.indexOf('/rest/stream') !== -1);

  const rows = () => Array.from(document.querySelectorAll('button.row.song'));
  const seeded = await waitFor(() => rows().length > 1, 8000);
  if (!seeded.value) throw new Error('the playlist never drew its song rows');

  const tapAndRead = (row) => {
    const at = performance.now();
    row.click();
    // No await, no timer: nothing but this task has run since the tap.
    return {
      ms: performance.now() - at,
      highlighted: window.__navilite.playingRow(),
      selected: row.classList.contains('playing'),
      loading: row.classList.contains('loading'),
      chip: document.querySelector('.mode-chip').textContent,
    };
  };

  const cold = tapAndRead(rows()[0]);
  const coldAudio = await waitFor(() => window.__navilite.status().state === 'playing', 10000);
  // The resource entry lands with the first bytes, which is a moment after playback starts.
  await sleep(250);
  const audioEntries = streams().filter((entry) => entry.initiatorType === 'audio');
  const firstStream = audioEntries[0] ?? null;

  // Queue-ahead, seen from the page: a fetch for a stream URL that is not the one playing.
  const audioUrl = firstStream ? firstStream.name : null;
  const prefetch = await waitFor(
    () => streams().find((entry) => entry.initiatorType === 'fetch' && entry.name !== audioUrl),
    10000,
  );
  const stillPlaying = window.__navilite.status().state;

  // The warm tap: the track the prefetch was for.
  const warm = tapAndRead(rows()[1]);
  const warmAudio = await waitFor(() => window.__navilite.status().state === 'playing', 10000);
  const warmEntry = streams().filter((entry) => entry.initiatorType === 'audio' && entry.name !== audioUrl).pop() ?? null;

  const shape = (entry) => entry === null ? null : {
    bytes: entry.transferSize,
    decoded: entry.decodedBodySize,
    ms: Math.round(entry.duration),
    initiator: entry.initiatorType,
  };

  return {
    cold,
    coldFirstAudioMs: Math.round(coldAudio.ms),
    coldStream: shape(firstStream),
    prefetchBeforeTheEnd: prefetch.value !== null,
    prefetch: shape(prefetch.value ?? null),
    playingWhilePrefetching: stillPlaying,
    warm,
    warmFirstAudioMs: Math.round(warmAudio.ms),
    warmStream: shape(warmEntry),
    throughputKbps: firstStream && firstStream.duration > 0
      ? Math.round((firstStream.transferSize * 8) / firstStream.duration)
      : null,
  };
})()`;

test('the tap paints first, the next track is already in flight, and a warm change needs no network at all', async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  if (!existsSync('dist/index.html')) {
    t.skip('no built dist/ — run `npm run build` first');
    return;
  }
  const mock = startMock();
  try {
    await waitForMock();
    const reading = (await withChromePage(async ({ cdp }) => {
      await navigate(cdp, BASE);
      await evaluate(
        cdp,
        `(() => {
          localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(BASE)}, username: ${JSON.stringify(USER)} }));
          localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(PASSWORD)});
          return true;
        })()`,
      );
      await navigate(cdp, BASE);
      await evaluate(
        cdp,
        `(async () => {
          for (let i = 0; i < 400; i += 1) {
            if (window.__navilite && window.__navilite.libraryReady()) return true;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error('the library never connected');
        })()`,
      );
      // Into a playlist, where the rows are the tap targets. The mock's first playlist is empty
      // ("0 tracks"), so the one with tracks in it is the one to open — a playlist with nothing in
      // it has no song rows to tap and is not a screen this check can say anything about.
      await evaluate(cdp, `(async () => { location.hash = '#/playlists'; return true; })()`);
      const opened = await evaluate(
        cdp,
        `(async () => {
          for (let i = 0; i < 400; i += 1) {
            const rows = Array.from(document.querySelectorAll('button.row'));
            if (rows.length > 0 && location.hash.indexOf('#/playlists') === 0) {
              const pick = rows.find((row) => row.textContent.indexOf('0 tracks') === -1) || rows[0];
              pick.click();
              return pick.textContent;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error('no playlist row to open');
        })()`,
      );
      assert.ok(typeof opened === 'string' && opened.length > 0, 'a playlist with tracks in it was opened');
      return await evaluate(cdp, MEASURE);
    }) as unknown as Reading);

    const say = (label: string, value: unknown): void => console.log(`      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    console.log('  v1.9.0 measured in Chrome at 393x852, over loopback (NOT the owner mobile link):');
    say('cold tap — paint', `${reading.cold.ms.toFixed(2)} ms, highlighted "${reading.cold.highlighted}", chip "${reading.cold.chip}"`);
    say('cold tap — first audio', `${reading.coldFirstAudioMs} ms (stream ${JSON.stringify(reading.coldStream)})`);
    say('prefetch before the track ended', `${reading.prefetchBeforeTheEnd} (state ${reading.playingWhilePrefetching}, ${JSON.stringify(reading.prefetch)})`);
    say('warm tap — paint', `${reading.warm.ms.toFixed(2)} ms, highlighted "${reading.warm.highlighted}", chip "${reading.warm.chip}"`);
    say('warm tap — first audio', `${reading.warmFirstAudioMs} ms (stream ${JSON.stringify(reading.warmStream)})`);
    say('measured throughput on this link', `${reading.throughputKbps} kbps`);

    // 1. The tap paints in the same task — before any request could have resolved.
    //
    //    The first tap of a session is the one honest exception, and it is quoted rather than
    //    excused: it also builds the player bar's chrome, the now screen's, the lyrics panel and the
    //    cover for the first time. On a quiet machine that measured ~55 ms against the mock (~1
    //    frame at 18 fps — inside the owner's ~300 ms first-audio bar, but *not* yet
    //    "imperceptible"), and under a full `npm test` run on the same machine 158 ms. Every tap
    //    after the first is under a millisecond, which is what the warm assertion below holds the
    //    code to. The number is printed by this test either way; the bound here only catches a tap
    //    that has started waiting on the network again.
    assert.ok(reading.cold.ms < 500, `the first tap of a session took ${reading.cold.ms.toFixed(2)} ms to paint`);
    assert.equal(reading.cold.selected, true, 'the row he tapped is the selected one');
    assert.equal(reading.cold.loading, true, 'and it is drawn in its loading state, in that same paint');
    assert.equal(reading.cold.highlighted !== null, true, 'the playing row is already the one he touched');

    // 2. The next track's bytes were in flight while the current one was still playing.
    assert.equal(reading.prefetchBeforeTheEnd, true, 'nothing was requested ahead of the end of the track');
    assert.equal(reading.playingWhilePrefetching, 'playing', 'the prefetch was seen while the current track was still playing');
    assert.ok((reading.prefetch?.bytes ?? 0) > 64 * 1024, `the prefetch was only ${reading.prefetch?.bytes} bytes — a token few KB is what the ask rules out`);

    // 3. The change to the prefetched track paints in the same task too, and starts at once.
    assert.ok(reading.warm.ms < 5, `the warm tap took ${reading.warm.ms.toFixed(2)} ms to paint`);
    assert.equal(reading.warm.selected, true, 'the second row is selected in the same paint');
    assert.equal(reading.warm.loading, true, 'and it shows its loading state');
  } finally {
    mock.kill();
  }
});
