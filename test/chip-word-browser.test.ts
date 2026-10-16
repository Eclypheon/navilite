/**
 * The chip's word, read off the screen at 393 x 852, over the mock library — **the surface the
 * owner photographed.**
 *
 * His report (v1.9.24, Telegram, with a screenshot of the playlist page for `Jap`, a track paused at
 * 1:28 / 4:55):
 *
 * > *"the spectrum always works but on the playlist pages, the bottom bar seems to keep flashing to
 * > native audio spectrum off even though the spectrum is working fine"*
 *
 * The screenshot's own decoding: the mini-player's chip read `NATIVE AUDIO` while the debug line
 * under it read `paused · native · spectrum off · player: paused · pause`. The spectrum was fine;
 * the *label* claimed a capability the app has not lost.
 *
 * This drives the real app in a real browser over a real library and reads the chip's own text at
 * each state the card names — playing, paused, a load, a track change, after navigating the app's
 * playlist screens, and on the now-playing screen — plus **every distinct word the chip wore during
 * the run**, with the millisecond it changed at. That last list is the flashing he describes and
 * the one thing a code reading cannot produce.
 *
 * What a browser cannot show, said here rather than implied: this build's backend is `web`, so the
 * capability word this path reaches is `theme` (no WebAssembly-free Web Audio, or a stream the
 * browser will not hand over) — **not** the `native audio` in his screenshot, which belongs to the
 * Capacitor shell's own engine. That word is reproduced on the fake-bridge harness
 * (`test/engine-native.test.ts`, the v1.9.26 case), where the native backend exists. The finding is
 * the same one on both paths: a stopped transport reaching the branch that is about capability.
 *
 * Needs Chrome and a built `dist/`, so it skips (with the reason printed) when either is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startMockLibrary } from './support/mock-fixture.ts';

/**
 * The browser plumbing, borrowed from the existing audit tool rather than re-written (the same
 * import `test/slow-link-browser.test.ts` uses): `tools/` is plain JavaScript with no type
 * declarations, so it is loaded through a variable specifier to keep `tsc --noEmit` honest.
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

const USER = 'navilite-chip';
const PASSWORD = 'mock';

/** One reading of the screen: what the chip says, and what the engine behind it says. */
interface Reading {
  ms: number;
  label: string;
  /** The chip node's whole text, cap suffix and all. */
  chip: string | null;
  /** The chip's word alone — the text the cap suffix is appended to (`… · 96 kbps`). */
  onScreen: string | null;
  state: string;
  backend: string;
  spectrum: boolean;
  arming: boolean;
  /** The engine's own field (`EngineStatus.visualiser`), null on a tree that predates it. */
  word: string | null;
  tone: string | null;
  reason: string;
}

interface Readings {
  tap: Reading;
  playing: Reading;
  playingOnPlaylistPage: Reading;
  paused: Reading;
  pausedListScreen: Reading;
  pausedAfterNavigating: Reading;
  resumed: Reading;
  midChange: Reading;
  afterChange: Reading;
  nowScreen: Reading & { chips: string[] };
}

/** What the page hands back: the readings at each state, and every distinct word it wore. */
interface Probed {
  out: Readings;
  /** Every distinct word the chip wore, in order, as it wore it. */
  words: { ms: number; label: string; chip: string | null; onScreen: string | null; state: string }[];
}

/**
 * The whole sequence in one page evaluation, on a playlist page because that is where the owner was.
 */
const PROBE = `(async () => {
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
  const node = () => document.querySelector('.mode-chip');
  const chipText = () => (node() ? node().textContent : null);
  const chipWord = () => (chipText() === null ? null : chipText().split(' \\u00b7 ')[0]);
  const status = () => {
    const s = window.__navilite.status();
    return {
      state: s.state,
      backend: s.backend,
      spectrum: s.spectrum,
      arming: s.spectrumArming,
      word: s.visualiser ? s.visualiser.word : null,
      tone: s.visualiser ? s.visualiser.tone : null,
      reason: String(s.modeReason || '').slice(0, 80),
    };
  };
  const seen = [];
  const note = (label) => {
    const reading = { ms: Math.round(performance.now()), label, chip: chipText(), onScreen: chipWord(), ...status() };
    seen.push(reading);
    return reading;
  };

  const songRows = () => Array.from(document.querySelectorAll('button.row.song'));
  const barPlay = () => document.querySelector('.playerbar button[aria-label="Play or pause"]');
  const barNext = () => document.querySelector('.playerbar button[aria-label="Next"]');
  /**
   * Settle the transport on 'paused' and **prove it is still there** a moment later.
   *
   * One thing here is not the app: the mock's own library and the app's restored play queue can
   * start a load inside the first second of a session, and a reading taken through that is a
   * reading of a moving train. So the state is waited for, held for 600 ms, re-read, and settled
   * again — and the probe reports what it settled on.
   */
  const settlePaused = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const waited = await waitFor(() => status().state === 'paused', 5000);
      if (!waited.value) break;
      await sleep(600);
      if (status().state === 'paused') return true;
    }
    if (status().state === 'playing') barPlay().click();
    await waitFor(() => status().state === 'paused', 5000);
    await sleep(600);
    return status().state === 'paused';
  };

  const seeded = await waitFor(() => songRows().length > 1, 10000);
  if (!seeded.value) throw new Error('the playlist never drew its song rows');
  /** The playlist page he was on: everything below is read on a screen of this kind. */
  const playlistRoute = location.hash;
  if (playlistRoute.indexOf('#/playlist/') !== 0) throw new Error('the rows are not on a playlist page: ' + playlistRoute);

  /*
   * Every word the chip wears, as it wears it. A poll would miss a word that lasted one status
   * event; the observer fires on the mutation itself, and only records a *change* of word.
   */
  let last = chipText();
  new MutationObserver(() => {
    const now = chipText();
    if (now === last) return;
    last = now;
    note('the chip changed');
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  const out = {};

  // 1. The tap. Read synchronously, before anything can have run: the app's own word for a tap
  //    whose stream is not here yet (v1.9.0), which no state of this card touches.
  songRows()[0].click();
  out.tap = note('a tap on a row of the playlist');

  const played = await waitFor(() => status().state === 'playing', 15000);
  if (!played.value) throw new Error('the track never started');
  await sleep(500);
  out.playing = note('playing');

  // 2. Back onto a playlist page, the way he gets there, with the track playing.
  location.hash = playlistRoute;
  await waitFor(() => songRows().length > 0, 8000);
  await sleep(400);
  out.playingOnPlaylistPage = note('playing, browsing the playlist page');

  // 3. HIS SCREENSHOT: a track loaded and paused, on a playlist page.
  barPlay().click();
  if (!(await settlePaused())) throw new Error('the transport would not stay paused');
  out.paused = note('paused, on the playlist page (his screenshot)');

  // 4. The same transport state after navigating the app's own screens — the report is about what
  //    the bar says while he is browsing, and this is that bar, still on the same one-chip node.
  location.hash = '#/playlists';
  await waitFor(() => location.hash.indexOf('#/playlists') === 0 && document.querySelectorAll('button.row').length > 0, 8000);
  await sleep(300);
  out.pausedListScreen = note('still paused, on the playlists screen');

  location.hash = playlistRoute;
  await waitFor(() => songRows().length > 0, 8000);
  await sleep(300);
  out.pausedAfterNavigating = note('still paused, back on a playlist page');

  // 5. The now-playing screen, still paused: every chip node on it, and what they read.
  location.hash = '#/now';
  await sleep(400);
  out.nowScreen = {
    ...note('the now-playing screen'),
    chips: Array.from(document.querySelectorAll('.mode-chip')).map((n) => n.textContent),
  };

  // 6. Back to the playlist page, resume, and read the whole of a track change.
  location.hash = playlistRoute;
  await waitFor(() => songRows().length > 0, 8000);
  if (status().state !== 'playing') barPlay().click();
  await waitFor(() => status().state === 'playing', 10000);
  await sleep(400);
  out.resumed = note('resumed, on the playlist page');

  barNext().click();
  await sleep(120);
  out.midChange = note('mid track change');
  await waitFor(() => status().state === 'playing', 15000);
  await sleep(700);
  out.afterChange = note('the new track playing');

  return {
    out,
    words: seen.map((r) => ({ ms: r.ms, label: r.label, chip: r.chip, onScreen: r.onScreen, state: r.state })),
  };
})()`;

test('the chip’s word on the screen he photographed: a paused track on a playlist page is not a capability claim', async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  if (!existsSync('dist/index.html')) {
    t.skip('no built dist/ — run `npm run build` first');
    return;
  }
  const mock = await startMockLibrary({ stress: true, dist: 'dist', extra: ['--user', USER, '--password', PASSWORD] });
  try {
    const probed = (await withChromePage(async ({ cdp }) => {
      await navigate(cdp, mock.base);
      await evaluate(
        cdp,
        `(() => {
          localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(mock.base)}, username: ${JSON.stringify(USER)} }));
          localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(PASSWORD)});
          return true;
        })()`,
      );
      await navigate(cdp, mock.base);
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
      // The owner's screen: a playlist with tracks in it, which is where the rows are tappable.
      await evaluate(cdp, `(async () => { location.hash = '#/playlists'; return true; })()`);
      await evaluate(
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
      return await evaluate(cdp, PROBE);
    })) as unknown as Probed;

    const r = probed.out;
    const say = (label: string, reading: Reading): void => {
      console.log(
        `      ${label}: chip "${reading.onScreen}" (whole text "${reading.chip}") · state ${reading.state} · spectrum ${reading.spectrum} · arming ${reading.arming} · engine word "${reading.word}" · tone "${reading.tone}"`,
      );
    };
    console.log('  the chip on the screen, in Chrome at 393x852 over the mock library:');
    say('1. the tap', r.tap);
    say('2. playing', r.playing);
    say('3. playing, browsing the playlist page', r.playingOnPlaylistPage);
    say('4. PAUSED (his screenshot)', r.paused);
    say('5. still paused, on the playlists screen', r.pausedListScreen);
    say('6. still paused, back on a playlist page', r.pausedAfterNavigating);
    say('7. the now-playing screen', r.nowScreen);
    say('8. resumed', r.resumed);
    say('9. mid track change', r.midChange);
    say('10. the new track playing', r.afterChange);
    console.log(`      every distinct word the chip wore (${probed.words.length}):`);
    for (const w of probed.words) console.log(`        ${String(w.ms).padStart(6)} ms  "${w.onScreen}"   (${w.label}, state ${w.state})`);
    console.log(`      chip nodes on the now-playing screen: ${r.nowScreen.chips.length} ${JSON.stringify(r.nowScreen.chips)}`);

    // The load: the app's own word, unchanged by this card.
    assert.equal(r.tap.onScreen, 'loading…', 'a tap whose stream is not here yet says so, in the same paint');
    assert.equal(r.playing.onScreen, 'spectrum', 'a playing track is fed by its own item');
    assert.equal(r.playingOnPlaylistPage.onScreen, 'spectrum', 'and it stays that way while he browses the playlist page');

    /*
     * THE READING THIS CARD IS ABOUT. A track loaded and paused on a playlist page: nothing is being
     * measured, which is true, and the only reason is that nothing is playing. On the installed
     * build this node read the capability word (his `NATIVE AUDIO`); this path's equivalent is
     * `theme` — the same branch of the same expression.
     */
    assert.equal(r.paused.onScreen, 'paused', `paused on a playlist page reads the transport's own word, not a capability (was "${r.paused.onScreen}")`);
    assert.notEqual(r.paused.word, 'native audio', 'and the engine’s own word for it is not the native one either');

    // Navigating the app's own screens does not move it: the state is the same state.
    assert.equal(r.pausedListScreen.onScreen, 'paused', 'on the playlists screen too, the word is the transport’s');
    assert.equal(r.pausedAfterNavigating.onScreen, 'paused', 'a playlist page away, it still is');
    assert.equal(r.pausedAfterNavigating.state, 'paused', 'and the machine is still paused');

    // Every chip node on the now-playing screen agrees with the bar — they read one field.
    assert.ok(r.nowScreen.chips.length > 0, 'the now-playing screen has the chip on it');
    assert.deepEqual(
      [...new Set(r.nowScreen.chips.map((text: string) => text.split(' · ')[0]))],
      ['paused'],
      'and every one of them reads the same word, from the same field',
    );

    // And it is the engine's own word the chip prints — one source, not a second expression.
    for (const [label, reading] of Object.entries({ playing: r.playing, paused: r.paused, resumed: r.resumed })) {
      assert.equal(reading.onScreen, reading.word, `the ${label} chip prints EngineStatus.visualiser.word`);
    }

    assert.equal(r.resumed.onScreen, 'spectrum', 'the bars come back with the transport');
    /*
     * Mid change. What the word is at that instant is the app's business (a load, an arming window,
     * or the new item's first frames — all three are legitimate), and what it may never be is a
     * capability claim about a transport that is not playing. The reading is printed either way.
     */
    assert.ok(
      r.midChange.onScreen !== 'native audio' && !(r.midChange.onScreen === 'theme' && r.midChange.state !== 'playing'),
      `a change is never a capability word out of a stopped transport (read "${r.midChange.onScreen}" in ${r.midChange.state})`,
    );
    assert.equal(r.afterChange.onScreen, 'spectrum', 'and the track it lands on is fed by its own item');

    /*
     * The flashing, as a list: every distinct word this bar wore across a play, a pause, two screens
     * and a track change — with the transport state it wore it in. The invariant is a statement
     * about the sequence, not about one state: **while the transport is not playing, the chip may
     * not wear a capability word.** (What this probe does not claim: on the web path a *playing*
     * item whose analyser has not yet produced its first frame wears `theme` for ~90 ms — the
     * pre-existing verdict window, unchanged by this card, and the reason the filter below is on the
     * transport state rather than on the whole run.)
     */
    const words = [...new Set(probed.words.map((w) => w.onScreen))];
    const notPlaying = probed.words.filter((w) => w.state !== 'playing');
    console.log(`      distinct words across the run: ${JSON.stringify(words)}`);
    console.log(
      `      of those, worn while the transport was not playing: ${JSON.stringify([...new Set(notPlaying.map((w) => w.onScreen))])} (${notPlaying.length} changes)`,
    );
    assert.ok(
      notPlaying.every((w) => w.onScreen !== 'theme' && w.onScreen !== 'native audio'),
      `no state of a stopped transport is a capability claim (${JSON.stringify(notPlaying.map((w) => `${w.onScreen}@${w.state}`))})`,
    );
  } finally {
    mock.stop();
  }
});
