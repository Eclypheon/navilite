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
 * One thing about the now-playing screen is measured rather than assumed, and it is why the
 * assertion there is worded as it is: that screen draws an opaque overlay over the bar, so the bar's
 * chip node is still in the DOM behind it and **nothing is visible to the owner there**. The probe
 * reads what is painted at the chip's own centre (`elementFromPoint`) beside the node count, so the
 * run says "one node, one field" — not "both surfaces show the word".
 *
 * What a browser cannot show, said here rather than implied: this build's backend is `web`, so the
 * capability word this path reaches is `theme` (no Web Audio at all, or a stream the browser will not
 * hand over) — **not** the `native audio` in his screenshot, which belongs to the Capacitor shell's
 * own engine. That word is reproduced on the fake-bridge harness
 * (`test/engine-native.test.ts`, the v1.9.26 case), where the native backend exists. The finding is
 * the same one on both paths: a stopped transport reaching the branch that is about capability.
 *
 * The file drives the probe **twice** (v1.9.27, card `t_71dc787e`), because the web path has two
 * halves of one rule and only the first of them can be produced by a same-origin mock:
 *
 *   1. the ordinary run — a library the app is same-origin with, so every stream is measurable. Its
 *      word list must show **no capability word while the item is playing**: the window in front of
 *      the analyser's first frame is `spectrum…`, not the amber `theme` it used to wear for ~128 ms
 *      at every track start;
 *   2. the second run — the app on `127.0.0.1`, the settings naming `localhost`, and
 *      `--no-cors-stream`: a cross-origin library that will not hand the stream over. There the
 *      capability word must still arrive, as **this item's own verdict**, after that window and with
 *      the reason naming the case.
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
  /** Only present when the run was asked to linger: the same item, watched on (v1.9.27). */
  lingered?: Reading;
  nowScreen: Reading & {
    chips: string[];
    /** The tag of whatever is painted at the bar's chip centre there — the overlay, measured. */
    chipTopElement: string | null;
    /** True when the chip itself is what is under the finger there. */
    chipIsTopElement: boolean;
  };
}

/** What the page hands back: the readings at each state, and every distinct word it wore. */
interface Probed {
  out: Readings;
  /** Every distinct word the chip wore, in order, as it wore it, with the reason at that moment. */
  words: { ms: number; label: string; chip: string | null; onScreen: string | null; state: string; reason: string }[];
}

/**
 * The whole sequence in one page evaluation, on a playlist page because that is where the owner was.
 *
 * `lingerMs` is how long the run keeps watching the chip **after the last step** — 0 for the ordinary
 * run, and a few seconds for the second one, whose subject is a stream the analyser never sees: the
 * verdict for a track is `ZERO_FRAMES_BEFORE_THEME` samples (1.8 s of playing) into *that track*, and
 * this probe's sequence pauses and changes tracks before that has elapsed. Watching on is the same
 * probe reading the same chip, not a second harness.
 */
const PROBE = (lingerMs: number): string => `(async () => {
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

  // 5. The now-playing screen, still paused: every chip node on it, what they read, and whether the
  //    bar's chip is actually what is painted at its own centre there (the now overlay covers the bar).
  location.hash = '#/now';
  await sleep(400);
  const paintedAtChipCentre = () => {
    const n = node();
    if (!n) return { top: null, isChip: false };
    const box = n.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const tag = top ? top.tagName + (top.className ? '.' + String(top.className).split(' ')[0] : '') : null;
    return { top: tag, isChip: top === n || (top !== null && n.contains(top)) };
  };
  const nowPainted = paintedAtChipCentre();
  out.nowScreen = {
    ...note('the now-playing screen'),
    chips: Array.from(document.querySelectorAll('.mode-chip')).map((n) => n.textContent),
    chipTopElement: nowPainted.top,
    chipIsTopElement: nowPainted.isChip,
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

  /*
   * And, when the caller asks for it, keep watching the same chip on the same item until its own
   * samples have answered (the second run's whole point: the verdict is per item and takes its own
   * time to be earned).
   */
  if (${lingerMs} > 0) {
    await sleep(${lingerMs});
    out.lingered = note('the same item, ${lingerMs} ms later');
  }

  return {
    out,
    words: seen.map((r) => ({ ms: r.ms, label: r.label, chip: r.chip, onScreen: r.onScreen, state: r.state, reason: r.reason })),
  };
})()`;

/**
 * One whole run of the probe over one mock library — the setup this file has always done, in one
 * place, so the second run below (a stream the browser genuinely cannot hand over) drives the *same*
 * probe against the same app rather than a second harness.
 *
 * `libraryHost` is the host the app's settings name, and it is the one knob that changes the run:
 *
 *   - left alone, the settings name the mock's own address and the page was fetched from it, so the
 *     library is **same-origin** — the app never sets `crossOrigin="anonymous"`, every stream is
 *     visible to the analyser, and this is the ordinary run;
 *   - `'localhost'`, while the page was fetched from `127.0.0.1`, makes `client.isCrossOrigin` true
 *     (`src/api/subsonic.ts` compares origins), which is the only way this app ever asks the browser
 *     for sample access — and with `--no-cors-stream` the mock sends no `Access-Control-Allow-Origin`
 *     on `/rest/stream`, which is the cross-origin stream the research and §4 of
 *     `docs/verification.md` call *"the one the library will not hand over"*.
 */
async function probeTheChip(options: { libraryHost?: string; lingerMs?: number } = {}): Promise<Probed> {
  const flags = ['--user', USER, '--password', PASSWORD];
  if (options.libraryHost) flags.push('--no-cors-stream');
  const mock = await startMockLibrary({ stress: true, dist: 'dist', extra: flags });
  const library = options.libraryHost ? mock.base.replace('127.0.0.1', options.libraryHost) : mock.base;
  try {
    return (await withChromePage(async ({ cdp }) => {
      await navigate(cdp, mock.base);
      await evaluate(
        cdp,
        `(() => {
          localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(library)}, username: ${JSON.stringify(USER)} }));
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
      return await evaluate(cdp, PROBE(options.lingerMs ?? 0));
    })) as unknown as Probed;
  } finally {
    mock.stop();
  }
}

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
  {
    const probed = await probeTheChip();

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
    console.log(
      `      on the now-playing screen the chip's own centre is painted by: ${r.nowScreen.chipTopElement} — the chip itself: ${r.nowScreen.chipIsTopElement}`,
    );

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

    /*
     * The now-playing screen — said as what this probe can read, not as "both surfaces show the word".
     * The now overlay is opaque and paints over the bar, so the DOM finds one chip node there that the
     * owner cannot see: `chips.length === 1` is a fact about the DOM, and the coverage below is measured
     * rather than assumed. What is asserted is the invariant that survives it — one node, one field,
     * therefore nothing can disagree — plus the measurement itself.
     */
    assert.equal(r.nowScreen.chips.length, 1, 'the now-playing screen carries the bar’s one chip node in the DOM');
    assert.deepEqual(
      [...new Set(r.nowScreen.chips.map((text: string) => text.split(' · ')[0]))],
      ['paused'],
      'and that one node reads the word the same field gives the bar',
    );
    assert.equal(
      r.nowScreen.chipIsTopElement,
      false,
      `the bar’s chip is not what is painted on the now-playing screen — the overlay covers it (top element at the chip’s centre: ${r.nowScreen.chipTopElement})`,
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
     * and a track change — with the transport state it wore it in. Two invariants, and both are
     * statements about the sequence rather than about one state:
     *
     *   - while the transport is not playing, the chip may not wear a capability word;
     *   - **and while it IS playing it may not wear one either** (t_71dc787e) — the reading this
     *     probe was extended for. `theme` while playing used to be reached for ~128 ms at every
     *     track start (`384 ms "theme"` → `512 ms "spectrum"`, measured at `d769fd4`), not because
     *     this browser could not measure the item — the graph was built and the bars came in a moment
     *     later — but because the licence the chip's word reached the capability through was *"the
     *     transport is playing and the bars are not being fed"*, and the analyser's own first-frame
     *     window is inside that. The word for that window is §515.4's `spectrum…`: **no frame for
     *     this item yet** is not **frames for this item that are not real**. The item's own verdict
     *     (silence for `ZERO_FRAMES_BEFORE_THEME`, or one frozen frame over and over) is the only
     *     thing that may spend `theme`, and the second run in this file — a library whose stream the
     *     browser will not hand over — is where that half is read off a screen, not argued from code.
     */
    const words = [...new Set(probed.words.map((w) => w.onScreen))];
    const notPlaying = probed.words.filter((w) => w.state !== 'playing');
    const playingCapability = probed.words.filter(
      (w) => w.state === 'playing' && (w.onScreen === 'theme' || w.onScreen === 'native audio'),
    );
    console.log(`      distinct words across the run: ${JSON.stringify(words)}`);
    console.log(
      `      of those, worn while the transport was not playing: ${JSON.stringify([...new Set(notPlaying.map((w) => w.onScreen))])} (${notPlaying.length} changes)`,
    );
    console.log(
      `      and worn while it WAS playing: ${JSON.stringify([...new Set(probed.words.filter((w) => w.state === 'playing').map((w) => w.onScreen))])}`,
    );
    assert.ok(
      notPlaying.every((w) => w.onScreen !== 'theme' && w.onScreen !== 'native audio'),
      `no state of a stopped transport is a capability claim (${JSON.stringify(notPlaying.map((w) => `${w.onScreen}@${w.state}`))})`,
    );
    assert.deepEqual(
      playingCapability.map((w) => `${w.onScreen}@${w.ms}ms`),
      [],
      'and no capability word is worn while the item playing can be measured — the window in front of the item’s first frame is the spectrum’s own word',
    );
  }
});

/**
 * **The other half of the same rule, on the surface that can produce it: a stream the browser
 * genuinely will not hand over** (card `t_71dc787e`). The run above is a library the app is
 * same-origin with, so its streams are always measurable and `theme` is never licensed there; this
 * run serves the app from `127.0.0.1` and names `localhost` in the settings, which is what makes
 * `client.isCrossOrigin` true, the element ask for `crossOrigin="anonymous"`, and
 * `--no-cors-stream`'s missing `Access-Control-Allow-Origin` bite (§4 of `docs/verification.md`,
 * measured by hand on 2026-10-11; this is the same case on a harness).
 *
 * What the word list must show, in order, while the transport is playing:
 *
 *   1. `spectrum…` — the analyser is attached, the item is playing, and its samples have not answered
 *      yet. Before the fix this was `theme`, amber, from the first paint — the capability claim the
 *      card is about, on a stream that *does* turn out to be unmeasurable, which is exactly why the
 *      fix may not be a blanket replacement;
 *   2. `theme` — the item's own verdict, after `ZERO_FRAMES_BEFORE_THEME` analyser frames of silence,
 *      with the reason line naming the case. That is the statement the word is licensed for, and it
 *      must survive: the app has not lost this capability, this item's samples are not real.
 */
test('on a stream the browser will not hand over, the chip still reaches the capability word and names the verdict (t_71dc787e)', async (t) => {
  const chrome = findChrome();
  if (!chrome) {
    t.skip('no Chrome/Chromium binary found');
    return;
  }
  if (!existsSync('dist/index.html')) {
    t.skip('no built dist/ — run `npm run build` first');
    return;
  }
  const probed = await probeTheChip({ libraryHost: 'localhost', lingerMs: 3000 });
  const r = probed.out;

  console.log('  the same probe, over a library the app is cross-origin with and whose stream sends no ACAO:');
  for (const w of probed.words) {
    console.log(`        ${String(w.ms).padStart(6)} ms  "${w.onScreen}"   (${w.label}, state ${w.state}) — ${w.reason}`);
  }

  const playing = probed.words.filter((w) => w.state === 'playing');
  const firstComing = playing.findIndex((w) => w.onScreen === 'spectrum…');
  const firstVerdict = playing.findIndex((w) => w.onScreen === 'theme');
  console.log(
    `      while playing: ${JSON.stringify(playing.map((w) => w.onScreen))} — first "spectrum…" at ${firstComing === -1 ? 'never' : `${playing[firstComing].ms} ms`}, first "theme" at ${firstVerdict === -1 ? 'never' : `${playing[firstVerdict].ms} ms`}`,
  );
  console.log(
    `      and the item watched on (${r.lingered ? `${r.lingered.ms} ms` : 'no lingered reading'}): chip "${r.lingered?.onScreen}" · spectrum ${r.lingered?.spectrum} · arming ${r.lingered?.arming} — ${r.lingered?.reason}`,
  );

  /*
   * 1. The window: on this run the stream *is* unmeasurable, and the app still does not say so before
   *    it has asked. The word while the item plays and the analyser has answered nothing is the
   *    spectrum's own — this is the half the fix is about, and on this run it is what the amber word
   *    used to be worn over.
   */
  assert.ok(
    firstComing !== -1,
    'the item is playing, its analyser is attached and its samples have not answered: the spectrum is coming',
  );

  /*
   * 2. The verdict, earned by this item's own samples and read on the surface: 18 analyser frames of
   *    silence, the reason naming the case. This is the statement `theme` is licensed for, and the
   *    reason the fix could not be a blanket replacement of the word.
   */
  assert.ok(r.lingered, 'the run watched the same item on, as it was asked to');
  assert.equal(
    r.lingered.onScreen,
    'theme',
    'the browser will not hand this stream over, and the chip names it — the only thing the word may mean',
  );
  assert.equal(r.lingered.state, 'playing', 'while the item is playing, on its own samples’ verdict');
  assert.match(
    String(r.lingered.reason),
    /silence|samples|tainted|cross-origin|Access-Control/i,
    'and the sentence behind it names the case, rather than a browser that cannot do this at all',
  );

  /*
   * 3. And the order is the point: the capability word is the *verdict*, reached after the window —
   *    never instead of it. Before the fix this run wore `theme` from the first paint (373 ms) and
   *    nothing else, which is a correct conclusion reached without asking the item.
   */
  assert.ok(firstVerdict !== -1, 'the capability word is still reachable on this path');
  assert.ok(
    firstVerdict > firstComing,
    'the capability word is the item’s verdict, reached after the window — never instead of it',
  );

  // And a stopped transport is still the transport's own word, on this run too.
  assert.ok(
    r.paused.onScreen === 'paused',
    `and no state of a stopped transport is a capability claim (read "${r.paused.onScreen}")`,
  );
});
