/**
 * `t_05775526` — **the row's transport belongs to the player that is making the sound.**
 *
 * The owner's report (build 86): coming back to the app while a track plays shows the right track and
 * the right second — and a play icon, a frozen seekbar and a dead spectrum. The reading was right and
 * the *transport* was wrong, because the row's playing state was read from the app's own player while
 * the away queue held the sound.
 *
 * Two outcomes are asserted here, and they are the two the card allows:
 *
 *   1. **The take works** — the app's own player starts the queue's entry at the queue's position and
 *      the queue is released only after that start commits. This is the return the owner remembers:
 *      no seam, spectrum alive.
 *   2. **The take is refused** — the queue is still the sound, so the queue owns the row: `playing`,
 *      the position ticking from the queue's reading, and pause/resume/seek routed to the queue's own
 *      player (`queueTransport`), never a write to the silent one. The paused settle at
 *      `engine.ts:2605` is the line this replaces.
 *
 * And the other direction: **the owner's own pause is never resumed over.** Nothing sounding on the
 * return is a `paused` row, one tap from playing, with no `play` written to get there.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import type { EngineOptions } from '../src/player/engine-contract.ts';
import type {
  NativeBridge,
  NativeBridgeEvents,
  NativeReturnRecord,
  NativeTrackInfo,
} from '../src/player/native.ts';
/*
 * **The bridge's own two parses, so a test can never invent a shape the phone cannot send
 * (unreleased, `t_e56c0413`).** `sounding` used to be fabricated as `path === 'queue'`, which meant
 * the paused-queue guard in the engine was tested with a `NativeReturnReading` the bridge could not
 * produce; and an answer to `handover()` without `taken: true` was read as an offer.
 */
import { handoverAnswerOf, returnReadingOf } from '../src/player/native.ts';

(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://navilite.example' };

/* The engine builds a media element whichever platform it is on; in a wrapped build it is never played. */
(globalThis as unknown as { Audio: unknown }).Audio = class {
  preload = '';
  crossOrigin: string | null = null;
  src: string | null = null;
  currentTime = 0;
  duration = Number.NaN;
  error: { message: string; code: number } | null = null;
  addEventListener(): void {}
  removeAttribute(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
};

interface Record {
  events: NativeBridgeEvents | null;
  /** Everything that reached a player or the boundary, in order. */
  order: string[];
  /** Every start the app's own player was asked for, in seconds. */
  plays: string[];
  /** Every command the away queue's own player was given. */
  queueOps: string[];
  /** What `handover()` answers — the raw wire, parsed by the bridge’s own `handoverAnswerOf`. */
  reading: { [key: string]: unknown } | null;
  /** What `now().return` answers — the raw wire, parsed by the bridge’s own `returnReadingOf`. */
  sounding: { [key: string]: unknown } | null;
  /** What `sync()` answers about the app's own player. */
  playing: boolean;
  syncPositionMs: number;
  released: number;
  /** When true the app's own start never makes a sound (the refused take). */
  silent: boolean;
  returns: NativeReturnRecord[];
  loadGate: Promise<void> | null;
}

const blank = (): Record => ({
  events: null,
  order: [],
  plays: [],
  queueOps: [],
  reading: null,
  sounding: null,
  playing: true,
  syncPositionMs: 0,
  released: 0,
  silent: false,
  returns: [],
  loadGate: null,
});

const track = (id: string) => ({
  id,
  url: `http://127.0.0.1:4599/rest/stream?id=${id}`,
  crossOrigin: false,
  title: `Track ${id}`,
  artist: 'Someone',
  album: 'Something',
  artworkUrl: null,
  durationMs: 300_000,
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

function fakeBridge(record: Record): (os: string, events: NativeBridgeEvents) => Promise<NativeBridge> {
  return async (_os: string, events: NativeBridgeEvents) => {
    record.events = events;
    return {
      async load(info: NativeTrackInfo) {
        if (record.loadGate) await record.loadGate;
        await wait(2);
        return { assetId: `slot-${info.id ?? 'x'}`, cached: false };
      },
      async prepare(info: NativeTrackInfo) {
        await wait(2);
        return { assetId: `slot-${info.id ?? 'x'}`, holdsBytes: true };
      },
      async play(seconds: number) {
        record.order.push(`play:${seconds}`);
        record.plays.push(seconds.toFixed(0));
        await wait(2);
        /* A start the player refuses makes no sound at all — the refused take. */
        if (record.silent) throw new Error('the player refused the start');
        // The app's own player's answer that sound exists.
        setTimeout(() => events.onPosition(Math.max(0, seconds)), 3);
      },
      async adopt() {
        return false;
      },
      async discard() {},
      async setQueue(options?: { index?: number; awake?: boolean }) {
        record.order.push(`setQueue:awake=${options?.awake === true}`);
        return true;
      },
      async handover() {
        record.order.push('handover');
        /*
         * The bridge's own parse (unreleased): an answer without `taken: true` is no reading, so the
         * engine cannot be handed a position the phone did not hand the sound over at.
         */
        return handoverAnswerOf(record.reading) ?? { songId: '', index: -1, positionMs: 0 };
      },
      async releaseHandover() {
        record.order.push('release');
        record.released += 1;
        return true;
      },
      /* The away queue's own transport — the call a press must reach while the queue is the sound. */
      async queueTransport(op: string, positionMs?: number) {
        record.queueOps.push(positionMs === undefined ? op : `${op}:${positionMs}`);
        return true;
      },
      async recordReturn(facts: NativeReturnRecord) {
        record.returns.push(facts);
        return true;
      },
      async reconcile() {
        record.order.push('reconcile');
        /* The bridge's own parse of `now().return` — including the phone's own `sounding`. */
        return { changed: false, songId: null, index: 0, resume: null, reading: returnReadingOf(record.sounding) };
      },
      async retryPlayInPlace() {
        return true;
      },
      pause: async () => {
        record.order.push('pause');
      },
      resume: async () => {
        record.order.push('resume');
      },
      stop: async () => {
        record.order.push('stop');
      },
      seek: async (seconds: number) => {
        record.order.push(`seek:${seconds}`);
      },
      positionMs: () => 0,
      sync: async () => ({ playing: record.playing, positionMs: record.syncPositionMs, durationMs: 300_000 }),
      activateSession: async () => true,
      listenRemoteCommands: () => () => undefined,
      hasNativeSpectrum: false,
    } as unknown as NativeBridge;
  };
}

function engineFor(record: Record): AudioEngine {
  return new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'],
  });
}

/** Put the session on one playing track, with the app's own player sounding it. */
async function playing(engine: AudioEngine, record: Record, positionMs: number): Promise<void> {
  await engine.play(track('a'));
  await settle();
  record.syncPositionMs = positionMs;
  record.order = [];
  record.plays = [];
}

/* ------------------------------------------------------------------ 1. the take takes */

test('a return takes the sound back: the app’s own player sounds the queue’s entry at the queue’s position, and the queue is released after that start commits', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await playing(engine, record, 240_000);
    await engine.handleVisibility(true);

    /*
     * The queue played on while the app was away and holds the sound at 4:03 (`path: 'queue'`), and
     * the app's own start of the same entry at that position does reach the speakers.
     */
    const at = 243_000;
    record.sounding = { songId: 'a', index: 0, positionMs: at, path: 'queue', sounding: true };
    /* The phone's answer to `handover()`: `taken: true` is the offer, and only then is it a reading. */
    record.reading = { songId: 'a', index: 0, positionMs: at, path: 'plugin', sounding: false, taken: true };
    record.playing = true;
    // The app's own player is the sound now, so it reports where it really is.
    record.syncPositionMs = at + 400;

    await engine.handleVisibility(false);
    await settle();

    assert.equal(engine.status().state, 'playing', 'the row is playing');
    assert.deepEqual(record.plays, [(at / 1000).toFixed(0)], 'the app starts the queue’s entry at the queue’s own position');
    assert.equal(record.released, 1, 'and the queue is released exactly once, after that start');
    assert.ok(
      record.order.indexOf('release') > record.order.indexOf(`play:${at / 1000}`),
      `the release is the last thing in the order (${record.order.join(' → ')})`,
    );
    const shown = engine.status().positionMs;
    assert.ok(
      Math.abs(shown - at) <= NaviliteDriftMs,
      `the bar is on the queue’s position, not on 0 (${shown} vs ${at})`,
    );
    assert.ok(!record.order.some((entry) => entry.startsWith('pause') || entry.startsWith('seek')), 'nothing was paused or seeked');
    const request = record.returns.at(-1);
    assert.equal(request?.path, 'handover', 'the return names its branch');
    assert.equal(request?.started, true, 'and it says a start was issued');
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ------------------------------------------------- 2. the take is refused: the queue owns the row */

test('a return whose take is refused leaves the queue owning the row: playing, ticking from the queue’s reading, with pause/resume/seek routed to the queue — never paused over audible music', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await playing(engine, record, 240_000);
    await engine.handleVisibility(true);

    const at = 243_000;
    record.sounding = { songId: 'a', index: 0, positionMs: at, path: 'queue', sounding: true };
    record.reading = { songId: 'a', index: 0, positionMs: at, path: 'plugin', sounding: false, taken: true };
    /* The take is refused: the app's own player holds the entry at that position and makes no sound. */
    record.silent = true;
    record.playing = false;
    record.syncPositionMs = at;

    await engine.handleVisibility(false);
    await settle();

    /*
     * THE DEFECT: today this row is `paused` (or `interrupted`) over a track that is audibly playing —
     * `readReturn`'s `sync()` on the silent app player, and the settle at `engine.ts:2605`.
     */
    assert.equal(
      engine.status().state,
      'playing',
      `the queue is the sound, so the row is playing (observed ${engine.status().state}: ${engine.status().modeReason})`,
    );

    const before = engine.status().positionMs;
    assert.ok(Math.abs(before - at) <= 2_000, `the bar is on the queue’s reading (${before} vs ${at})`);
    await wait(150);
    assert.ok(engine.status().positionMs > before, 'and the position ticks from that reading');

    /*
     * The app's own player's report — the steady-state writer in the owner's build: it says `paused`
     * at 0:00 because it is not the sound. The row and the bar must not move.
     */
    record.events?.onState('paused', false, { currentTime: 0 } as never);
    assert.equal(engine.status().state, 'playing', 'a report from a player that is not the sound cannot pause the row');
    assert.ok(engine.status().positionMs >= before, 'nor snap the bar back to 0:00');

    /* A press reaches the sound: pause stops the queue, not the silent player. */
    await engine.pause();
    assert.deepEqual(record.queueOps, ['pause'], 'the pause went to the away queue');
    assert.ok(!record.order.includes('pause'), 'and never to the app’s own player');
    assert.equal(engine.status().state, 'paused', 'the row is paused because the owner paused it');

    /* And the same press again restarts exactly that queue. */
    await engine.toggle();
    assert.deepEqual(record.queueOps, ['pause', 'resume'], 'the resume went to the away queue as well');
    assert.ok(!record.order.includes('resume'), 'and not to the app’s own player');
    assert.equal(engine.status().state, 'playing', 'the row is playing again');

    /* The bar as well: a drag moves the queue, not a player nobody can hear. */
    await engine.seek(90_000);
    assert.equal(record.queueOps.at(-1), 'seek:90000', 'the seek went to the away queue');
    assert.ok(!record.order.some((entry) => entry.startsWith('seek')), 'and not to the app’s own player');
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ----------------------------------------------------------- 3. the owner's own pause stands */

test('a return with nothing sounding after the owner’s own pause is paused — one tap from playing, and no resume written', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await playing(engine, record, 61_000);
    await engine.pause();
    assert.equal(engine.status().state, 'paused', 'the owner stopped it');
    record.order = [];
    record.plays = [];

    await engine.handleVisibility(true);
    /*
     * Nothing is sounding: the app's own player still holds the entry (so the return is an adoption)
     * and is paused where he left it. That is the case a `paused` row is for.
     */
    record.sounding = { songId: 'a', index: 0, positionMs: 61_000, path: 'plugin', sounding: false };
    record.playing = false;
    record.syncPositionMs = 61_000;

    await engine.handleVisibility(false);
    await settle();

    assert.equal(engine.status().state, 'paused', 'the row is paused');
    assert.deepEqual(record.plays, [], 'no start was issued to get there');
    assert.ok(!record.order.includes('resume'), 'and nothing was resumed over his decision');
    assert.deepEqual(record.queueOps, [], 'the queue was not asked to play either');

    /* One tap: the same player starts again, from where he stopped it. */
    await engine.toggle();
    await settle();
    assert.equal(engine.status().state, 'playing', 'one tap from paused');
    assert.ok(record.order.includes('resume'), `the resumed player was asked (${record.order.join(' → ')})`);
  } finally {
    await engine.stop();
    await settle();
  }
});

/**
 * The drift the take is proved on, as the Swift side states it (`NavilitePressRules.maxDriftMs`): a
 * start that lands within this of the queue's position is the same sound, not a restart.
 */
const NaviliteDriftMs = 250;

/* ------------------------------------------------------------------------------------------------
 * `t_e56c0413` — the two wire facts the adopt exit was missing.
 *
 * Both tests below feed the engine the **raw answers the phone sends**, through the bridge's own
 * parsers (`handoverAnswerOf`, `returnReadingOf`), because the previous shape was one the bridge
 * could not produce: `sounding` was fabricated as `path === 'queue'`, and an answer with
 * `taken: false` was read as an offer.
 * ---------------------------------------------------------------------------------------------- */

test('an adopt-route handover (taken: false) answers no reading: the row keeps the position F2 rendered, never enters loading, and issues no play', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await playing(engine, record, 240_000);
    await engine.handleVisibility(true);

    /*
     * The phone's own adopt branch has already notified `advanced` with the queue's live position, and
     * the row renders it (`engine.renderReading`) — this is the position the fix must keep.
     */
    const at = 243_000;
    engine.renderReading(at);
    assert.equal(engine.status().state, 'playing', 'the row is playing on the adoption’s reading');

    const states: string[] = [];
    engine.subscribe((status) => states.push(status.state));

    /* The queue holds the sound; the app's own player is loaded, silent, at 0:00. */
    record.sounding = { songId: 'a', index: 0, positionMs: at, path: 'queue', sounding: true };
    /*
     * THE ANSWER THAT BROKE IT: the adopt branch returns `taken: false`, and `returnReading()` still
     * names this side's own entry — `path: 'plugin'`, at `0`. Read as an offer, `adoptHandover` started
     * the visible track there, forced, which reloaded it and overwrote the position above.
     */
    record.reading = { songId: 'a', index: 0, positionMs: 0, path: 'plugin', sounding: false, taken: false };
    record.playing = false;
    record.syncPositionMs = 0;

    await engine.handleVisibility(false);
    await settle();

    assert.deepEqual(record.plays, [], 'no start was issued: the phone did not hand the sound over');
    assert.ok(!record.order.some((entry) => entry.startsWith('play:')), `nothing reached the player (${record.order.join(' → ')})`);
    assert.equal(record.released, 0, 'and nothing was released — there was nothing to take');
    assert.ok(!states.includes('loading'), `the row never went back to loading (${states.join(' → ')})`);
    assert.equal(engine.status().state, 'playing', 'the queue still owns the row');
    const shown = engine.status().positionMs;
    assert.ok(
      Math.abs(shown - at) <= 2_000,
      `the position F2 rendered survives the return (${shown} vs ${at}) — 0:00 here is the restart`,
    );
    assert.equal(record.returns.at(-1)?.path, 'handover', 'the return names the branch it took');
    assert.equal(record.returns.at(-1)?.started, false, 'and says it issued no start');
  } finally {
    await engine.stop();
    await settle();
  }
});

test('PROBE A — the owner pauses the away queue from the island while the app is away: the row ends paused at his position, the clock is not running, and neither player is written to', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await playing(engine, record, 240_000);
    /*
     * Return #1: the take is refused, so the queue is the sound and owns the row (the branch above).
     * That is the state the owner is in when he presses pause: from here the press reaches the queue.
     */
    await engine.handleVisibility(true);
    const at = 243_000;
    record.sounding = { songId: 'a', index: 0, positionMs: at, path: 'queue', sounding: true };
    record.reading = { songId: 'a', index: 0, positionMs: at, path: 'plugin', sounding: false, taken: true };
    record.silent = true;
    record.playing = false;
    record.syncPositionMs = at;
    await engine.handleVisibility(false);
    await settle();
    assert.equal(engine.status().state, 'playing', 'the queue owns the row after the refused take');

    /*
     * **THE PROBE (`t_234b1ab8`).** He leaves again and pauses from the island / the lock screen. That
     * press never reaches this side: no `engine.pause()`, no dispatch — the machine is still `playing`,
     * exactly as it is on his phone, and the only fact about the pause is the phone's own `sounding`
     * on the way back. The tree's previous version of this test called `engine.pause()` first, which
     * left the machine already `paused` and made the whole case invisible.
     */
    await engine.handleVisibility(true);
    record.silent = false;
    record.queueOps = [];
    record.order = [];
    record.plays = [];
    assert.equal(engine.status().state, 'playing', 'nothing here has been told he paused');

    const pausedAt = 244_000;
    record.sounding = { songId: 'a', index: 0, positionMs: pausedAt, path: 'queue', sounding: false };
    /* And the offer it used to build: `taken: false` with a reading of this side's own entry at 0:00. */
    record.reading = { songId: 'a', index: 0, positionMs: 0, path: 'plugin', sounding: false, taken: false };
    record.playing = false;
    record.syncPositionMs = 0;

    await engine.handleVisibility(false);
    await settle();

    assert.equal(
      engine.status().state,
      'paused',
      `the row is paused over the queue he paused (${engine.status().state}: ${engine.status().modeReason})`,
    );
    assert.deepEqual(record.plays, [], 'nothing was started — his decision stands');
    assert.deepEqual(record.queueOps, [], 'the queue was not resumed behind his back');
    assert.ok(!record.order.includes('resume'), `and no player was resumed either (${record.order.join(' → ')})`);
    assert.ok(!record.order.some((entry) => entry.startsWith('pause')), 'and no player was asked to pause either — it was already paused');
    const shown = engine.status().positionMs;
    assert.ok(
      Math.abs(shown - pausedAt) <= 2_000,
      `the row is on his position in the queue, not on the silent player's 0:00 (${shown} vs ${pausedAt})`,
    );
    /* The clock: the row is a decision, so nothing advances between two readings of it. */
    await wait(150);
    assert.equal(engine.status().positionMs, shown, 'the clock is not running over a queue he paused');
    assert.equal(record.returns.at(-1)?.started, false, 'the return issued no start');

    /* One tap: the queue he paused starts again from where he left it — one player, his entry. */
    await engine.toggle();
    await settle();
    assert.equal(engine.status().state, 'playing', 'one tap from paused');
    assert.deepEqual(record.queueOps, ['resume'], 'and the tap reached the player that really holds the entry');
    assert.ok(!record.order.includes('resume'), `nothing was written to the silent app player (${record.order.join(' → ')})`);
  } finally {
    await engine.stop();
    await settle();
  }
});

test('PROBE B — the app’s own player was the sound and he pauses it while away: the row ends paused, not interrupted', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    /*
     * The app's own player is the sound (`path: 'plugin'`, and the queue is not sounding), and the
     * app goes away with the row on `playing`.
     */
    await playing(engine, record, 240_000);
    record.sounding = { songId: 'a', index: 0, positionMs: 240_000, path: 'plugin', sounding: false };
    await engine.handleVisibility(true);
    assert.equal(engine.status().state, 'playing', 'the row was playing when the screen went away');

    /* He pauses from the lock screen: the player holds the entry at 241 s and makes no sound. */
    const pausedAt = 241_000;
    record.sounding = { songId: 'a', index: 0, positionMs: pausedAt, path: 'plugin', sounding: false };
    record.playing = false;
    record.syncPositionMs = pausedAt;
    record.plays = [];
    record.order = [];
    record.queueOps = [];

    await engine.handleVisibility(false);
    await settle();

    assert.equal(
      engine.status().state,
      'paused',
      `his own pause is adopted as paused, not reported as an interruption he never made (${engine.status().state}: ${engine.status().modeReason})`,
    );
    assert.deepEqual(record.plays, [], 'nothing was started to get there');
    assert.ok(!record.order.includes('resume'), `and nothing was resumed over it (${record.order.join(' → ')})`);
    assert.deepEqual(record.queueOps, [], 'the queue was not asked anything either');
    const shown = engine.status().positionMs;
    assert.ok(Math.abs(shown - pausedAt) <= 2_000, `the row is on his position (${shown} vs ${pausedAt})`);
    assert.equal(record.returns.at(-1)?.path, 'adopt', 'the player was on the visible entry, so the return was a read');
    assert.equal(record.returns.at(-1)?.started, false, 'and it issued no start');

    /* One tap: the app's own player, which still holds the entry, starts again from there. */
    await engine.toggle();
    await settle();
    assert.equal(engine.status().state, 'playing', 'one tap from paused');
    assert.ok(record.order.includes('resume'), `and the tap went to the app's own player (${record.order.join(' → ')})`);
  } finally {
    await engine.stop();
    await settle();
  }
});

test('the two wire parses say exactly what the fix relies on', () => {
  /* An answer that did not perform the transfer is no reading, whatever it carries. */
  assert.equal(
    handoverAnswerOf({ songId: 'a', index: 0, positionMs: 0, path: 'plugin', sounding: false, taken: false }),
    null,
    'taken: false — the adopt exit — is not an offer',
  );
  assert.deepEqual(
    handoverAnswerOf({ songId: 'a', index: 0, positionMs: 243_000, taken: true }),
    { songId: 'a', index: 0, positionMs: 243_000 },
    'taken: true is the offer, and its position survives the parse',
  );
  /* A queue the owner paused is the same route and the same entry, and it is silent. */
  assert.equal(returnReadingOf({ songId: 'a', path: 'queue', positionMs: 61_000, sounding: false })?.sounding, false);
  assert.equal(returnReadingOf({ songId: 'a', path: 'queue', positionMs: 61_000, sounding: true })?.sounding, true);
  assert.equal(
    returnReadingOf({ songId: 'a', path: 'queue', positionMs: 61_000 })?.sounding,
    false,
    'a build that does not send the key has not said it is sounding, so it does not own the row',
  );
});
