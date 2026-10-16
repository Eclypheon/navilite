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
import { startMockLibrary } from './support/mock-fixture.ts';
import { formatTime } from '../src/ui/dom.ts';

/**
 * No port of this test's own any more: the fixture asks the OS (test/support/mock-fixture.ts). This
 * comment used to say a *number* was needed because `node --test` runs these files in parallel and a
 * mock is killed in the `finally` below — taking another test's library down with it "which is a flake,
 * not a finding". That reasoning was right and the fix was one test file deep: 4619 moved this file out
 * of the way, and 4615 stayed claimed by both test/pager.test.ts and test/palette-apply.test.ts, which
 * is exactly the flake it was written about. Now no file claims a number at all.
 */
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
  /** v1.9.20: the playlist rows with their mark, and the song rows with theirs. */
  playlistRows?: Array<{ title: string | null; sub: string | null; mark: string; label: string | null }>;
  /** v1.9.23: the song rows' own text — what the metadata repair has to reach. */
  songMarks?: Array<{ title: string | null; sub?: string | null; time?: string | null; mark: string; label: string | null }>;
  /** v1.9.23: the player bar — the title the queue's `Song` prints, and the total built from it. */
  bar?: { hidden: boolean; title: string | null; sub: string | null; position: string | null; total: string | null };
  artSrcs?: string[];
  /** The shell's `--accent-primary` on a reading (the `paletteOffline` state carries before/after). */
  primary?: string;
  before?: string;
  after?: string;
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

/**
 * The player bar's own text, as `tools/offline-check.mjs` reads it (v1.9.23). The bar is recorded on
 * its own rather than as part of a `Reading`, because the two readings that matter here are the bar
 * *at the tap* and the bar *once the store could name the track* — the same screen, two moments.
 */
interface BarReading {
  hidden: boolean;
  title: string | null;
  sub: string | null;
  position: string | null;
  total: string | null;
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
  const mock = await startMockLibrary({ stress: true });
  try {
    const { code, output } = await run(
      process.execPath,
      [
        'tools/offline-check.mjs',
        '--app',
        mock.base,
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

    /*
     * ---------------------------------------------------------------------------------------
     * v1.9.20 — the downloaded-content acceptance, asserted on the numbers the harness reported
     * rather than on its exit code (the pattern this file already uses for 1.9.18's claims).
     * ---------------------------------------------------------------------------------------
     */

    // **Item 1, with the server answering.** One row per playlist: the store used to paint its
    // own row beside the server's, which is the duplicated playlist the owner photographed. The row
    // the server draws for the playlist that is *also* on this phone must carry the mark.
    const onlinePlaylists = report.states.playlistsOnline;
    const onlineTitles = (onlinePlaylists?.playlistRows ?? []).map((row) => row.title);
    assert.ok(onlineTitles.length > 2, 'the online playlists screen drew no rows');
    assert.equal(
      new Set(onlineTitles).size,
      onlineTitles.length,
      `a playlist name was painted twice with the server up: ${JSON.stringify(onlineTitles)}`,
    );
    const markedOnline = (onlinePlaylists?.playlistRows ?? []).filter((row) => row.mark !== 'none');
    assert.equal(markedOnline.length, 1, `expected exactly one marked playlist row, got ${JSON.stringify(markedOnline)}`);
    assert.equal(markedOnline[0]?.mark, 'complete', 'the downloaded playlist did not read as downloaded');
    assert.match(String(markedOnline[0]?.sub), /on this phone/, 'and its row does not say the music is here');

    // **Item 1, with the server refused** — and item 2's honesty rule: the playlist the store holds
    // only part of must not read as complete.
    const offlinePlaylists = report.states.playlistsOffline;
    const offlineTitles = (offlinePlaylists?.playlistRows ?? []).map((row) => row.title);
    assert.equal(offlineTitles.length, 2, `the offline playlists screen drew ${JSON.stringify(offlineTitles)}`);
    assert.equal(new Set(offlineTitles).size, 2, 'a playlist name was painted twice with the server refused');
    const complete = offlinePlaylists?.playlistRows?.find((row) => row.mark === 'complete');
    const partial = offlinePlaylists?.playlistRows?.find((row) => row.mark === 'partial');
    assert.ok(complete, 'the fully downloaded playlist is not marked complete offline');
    assert.ok(partial, 'the partially downloaded playlist is not marked partial offline');
    assert.match(String(partial?.sub), /1 of 3 on this phone/, 'the partial row does not say how much is here');
    // The cover on those rows is the copy beside the audio, not a URL on the API: the API is refused,
    // so a network URL here would be a broken image and an unthemed spectrogram.
    assert.ok((offlinePlaylists?.artSrcs ?? []).length > 0, 'the offline playlists rows drew no cover at all');
    for (const src of offlinePlaylists?.artSrcs ?? []) {
      assert.match(String(src), /\/offline-art\//, `a cover was drawn from somewhere other than the device copy: ${src}`);
    }

    // **Item 2, per track** — every downloaded song row carries its mark with no connection.
    const offlinePage = report.states.playlistOffline;
    assert.equal(offlinePage?.songMarks?.length, 3, 'the offline playlist page did not draw three song rows');
    for (const row of offlinePage?.songMarks ?? []) {
      assert.equal(row.mark, 'complete', `${row.title} is on this phone and is not marked`);
      assert.match(String(row.label), /downloaded$/, 'and its accessible name does not say so');
    }

    // **Item 3** — "On this phone" is a view over the store, drawn with no round trip.
    const downloads = report.states.downloadsOffline;
    assert.equal(downloads?.title, 'On this phone', 'the downloaded-songs view is not titled for where the music lives');
    assert.deepEqual(
      [...(downloads?.rows ?? [])].sort(),
      ['Only this one is here', '夜に駆ける', 'A very long unbroken track title for the 393 px audit', '海底、月明かり'].sort(),
      'the downloaded-songs view did not list the tracks on the phone',
    );
    assert.deepEqual(downloads?.playlistRows ?? [], [], 'it drew a playlist-shaped row: that is the entity the owner reported');
    const hungDownloads = report.states.downloadsWithPendingRequest;
    assert.ok(
      Number(hungDownloads?.ms) < 3000,
      `the downloaded-songs view waited ${hungDownloads?.ms} ms for a server that never answered`,
    );

    // **v1.9.21 — the Library keeps its own door to the downloaded music with no connection.** The
    // offline page replaced the whole view and took the entry row with it, so while offline the only
    // way into `#/downloads` was Settings. Asserted as the readings: the row is on that page, it is
    // in the same list as the downloaded playlists, and tapping it opens the view.
    const libraryOffline = report.states.libraryOffline;
    assert.ok(
      (libraryOffline?.downloadedRows ?? []).includes('On this phone'),
      `the Library’s entry row is not on the offline page: ${JSON.stringify(libraryOffline?.downloadedRows)}`,
    );
    const entryRow = report.states.libraryEntryRowOffline as unknown as
      | { sub: string | null; label: string | null; listRows: Array<string | null> }
      | undefined;
    assert.match(String(entryRow?.sub), /^\d+ tracks? · /, 'the entry row does not say how much is on the phone');
    assert.equal(entryRow?.label, 'Open On this phone', 'the entry row’s accessible name is not the view it opens');
    assert.ok(
      (entryRow?.listRows ?? []).includes('Late night driving'),
      `the entry row is in a list of its own rather than the downloads list: ${JSON.stringify(entryRow?.listRows)}`,
    );
    const tappedThrough = report.states.libraryEntryRowTap;
    assert.equal(tappedThrough?.route, '#/downloads', 'the entry row did not open the downloaded music');
    assert.equal(tappedThrough?.title, 'On this phone', 'the view the entry row opened is not the downloaded music');
    assert.deepEqual(
      [...(tappedThrough?.rows ?? [])].sort(),
      ['Only this one is here', '夜に駆ける', 'A very long unbroken track title for the 393 px audit', '海底、月明かり'].sort(),
      'the entry row opened a view without the tracks on the phone',
    );

    // **Item 4** — the cover on disk drove the palette. `DEFAULT_PALETTE.primary` is what the shell
    // wears when no art was read at all, so anything else is the proof that the local cover was
    // fetched and sampled rather than silently fallen back from.
    const palette = report.states.paletteOffline;
    assert.equal(palette?.before, '#7cd2ff', 'the shell was not wearing the default palette before the tap');
    assert.notEqual(palette?.after, '#7cd2ff', 'the palette stayed on the default: the cover on disk was not read');
    assert.ok(String(palette?.after).length > 0, 'no palette was written at all');

    /*
     * ---------------------------------------------------------------------------------------
     * v1.9.23 — the repair reaching **the screen and the queue**, asserted on the readings the
     * harness reported rather than on its exit code (the pattern every block above uses).
     * ---------------------------------------------------------------------------------------
     */

    // **The screen he photographed.** A store a 1.9.19 build wrote — every row named by the
    // download's own record on the phone and none of them carrying it — read on `#/downloads`, once
    // as the route drew and once when the store had spoken, with no navigation between the two.
    const legacyAsDrawn = report.states.downloadsLegacyAsDrawn;
    const legacyRepaired = report.states.downloadsLegacyRepaired;
    assert.equal(legacyAsDrawn?.route, '#/downloads', 'the first reading of the legacy rows was taken off the route');
    assert.equal(legacyRepaired?.route, '#/downloads', 'the reading that names the rows was taken somewhere else');
    const legacyRows = legacyRepaired?.songMarks ?? [];
    const legacyNamed = legacyRows.filter((row) => (row.title ?? '') !== '');
    const legacyUnnamed = legacyRows.filter((row) => (row.title ?? '') === '');
    assert.deepEqual(
      legacyNamed.map((row) => row.title).sort(),
      ['A very long unbroken track title for the 393 px audit', '夜に駆ける', '海底、月明かり'].sort(),
      'the rows the repair named are not the ones the download’s own record names',
    );
    for (const row of legacyNamed) {
      assert.equal(row.time, '3:34', `${row.title} is named but its length is not the record’s own (214 s)`);
      assert.match(String(row.sub), /ヨルシカ/, `${row.title} has no artist on its sub-line`);
    }
    // …and the row nobody can name keeps drawing what it drew: not its id, not a length.
    assert.equal(
      legacyUnnamed.length,
      1,
      `expected the one row no record names, read ${JSON.stringify(legacyRows.map((row) => [row.title, row.time]))}`,
    );
    assert.equal(legacyUnnamed[0]?.time, '--:--', 'an unnamed row drew a length nobody had told the app');
    assert.doesNotMatch(String(legacyUnnamed[0]?.label), /orphan/, 'an unnamed row drew its song id as the row’s name');

    // **And the bar.** The row was blank when he tapped it and the list was gone before the server
    // could name it, so the only thing that can name the bar is the queue's own copy being filled.
    const expected = report.states.barCaseSong as unknown as { id: string; title: string; duration: number } | undefined;
    const barAsTapped = report.states.barAsTapped as unknown as BarReading | undefined;
    const barWhenNamed = report.states.barWhenNamed as unknown as BarReading | undefined;
    assert.ok(expected?.title, 'the harness never recorded the track the library named for the bar reading');
    assert.equal(barAsTapped?.title, '', 'the bar was not blank when the tap landed on the unnamed row');
    assert.equal(barAsTapped?.total, '0:00', 'the bar did not draw 0:00 for a track with no stored length');
    assert.equal(barWhenNamed?.title, expected?.title, 'the bar’s title is not the library’s own name for the track');
    assert.equal(barWhenNamed?.total, formatTime(expected?.duration ?? 0), 'the bar’s total is not the track’s real length');

    /*
     * ---------------------------------------------------------------------------------------
     * v1.9.23's follow-up — the row's **accessible name**, read beside the text it carries.
     *
     * The name is the only thing a screen reader hears about a row, and it is built out of the
     * row's title — which, for a row only the *server* can name, is filled by the same store pass
     * that writes the name. So a name painted before that pass left the row announced as
     * `Play , downloaded` with its title legibly on the screen beside it, for as long as he stayed
     * on the screen. Asserted as one reading of the route: the **rendered text** and the
     * **aria-label** of the same row, taken on `#/downloads` with no navigation between them —
     * blank as the route drew, named once the store had spoken.
     * ---------------------------------------------------------------------------------------
     */
    const namedAsDrawn = report.states.downloadsServerNamedAsDrawn?.songMarks?.[0];
    const namedRow = report.states.downloadsServerNamed?.songMarks?.[0];
    assert.equal(
      report.states.downloadsServerNamed?.route,
      '#/downloads',
      'the accessible-name reading was taken off the route, so it is not the reading the card asked for',
    );
    assert.equal(
      namedAsDrawn?.title,
      '',
      `the row was not blank when the route drew it, so this reading is not the repair naming it: ${JSON.stringify(namedAsDrawn)}`,
    );
    assert.equal(namedRow?.title, expected?.title, 'the row the server named does not read as the library’s own title');
    assert.equal(
      namedRow?.label,
      `Play ${expected?.title}, downloaded`,
      'the row’s accessible name is not the title it shows beside the mark: a screen reader hears this row and nothing else',
    );
  } finally {
    mock.stop();
  }
});
