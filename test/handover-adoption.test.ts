/**
 * v2.0-beta.18 — **the return handover is an ADOPTION, not a pause with a reading nobody takes.**
 *
 * The away queue keeps the sound going while the app is suspended, and the return used to be a
 * documented pause: `handOverAwayQueue` stopped the only player making sound and published the entry,
 * index and position it had reached (`awayResume`) — and nothing in the web layer ever read it. The app
 * then started the track from its own last clock reading, or (after an "adoption" of a track the
 * handover had just paused) started nothing at all.
 *
 * The claims asserted here:
 *
 *   1. **The app starts the adopted entry at the queue's position, not at zero.** The reading names a
 *      track and a position; the app's own player is started at exactly that position.
 *   2. **The queue is released only AFTER that start has committed.** The paused items are the only
 *      thing that still knows where the track was, so `releaseHandover` must be the last thing in the
 *      order — a release first is the defect this card exists to close.
 *   3. **A reading about an entry that is not being started is kept, not spent.** The next start of
 *      that entry begins at the reading's position.
 *   4. The three Swift-side readings: re-arming the queue drops the reading, a failed entry is not
 *      re-attached by the next top-up, and only the entry the queue is SOUNDING reaches the fetch path
 *      (with the queue paused first, so a second player cannot start on top of it).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import type { EngineOptions } from '../src/player/engine-contract.ts';
import type { NativeBridge, NativeBridgeEvents, NativeHandover, NativeReturnReading, NativeTrackInfo } from '../src/player/native.ts';

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
  /** Every start, in the order it was issued: `play <songId>@<seconds>`. */
  plays: string[];
  /** Everything that happened, so an ORDER can be asserted rather than two separate facts. */
  order: string[];
  /**
   * **Every statement of the queue, with the `awake` flag it carried.** `setQueue` is the boundary's
   * only writer — `awake: true` is the sole way the native side learns the app is on screen again —
   * so the statement itself has to be recordable, or a return that never re-states the queue reads as
   * a pass (which is exactly how the `awake: false` defect stayed green in this file).
   */
  statements: { index: number; awake: boolean }[];
  /** What the plugin answers `handover()` with — the queue's own reading. */
  reading: NativeHandover | null;
  /** What the plugin puts in `now().return` — the player's own reading of what is sounding. */
  sounding: NativeReturnReading | null;
  /** What the player answers `sync()` with. */
  playing: boolean;
  syncPositionMs: number;
  released: number;
  songNow: string;
  /** When set, `load` waits on it: a start that is genuinely still in flight. */
  loadGate: Promise<void> | null;
  /** When true the player accepts `play` and never reports a position — a start that makes no sound. */
  silent: boolean;
}

const blank = (): Record => ({
  events: null,
  plays: [],
  order: [],
  statements: [],
  reading: null,
  sounding: null,
  playing: true,
  syncPositionMs: 42_000,
  released: 0,
  songNow: '',
  loadGate: null,
  silent: false,
});

const track = (id: string) => ({
  id,
  url: `http://127.0.0.1:4599/rest/stream?id=${id}`,
  crossOrigin: false,
  title: `Track ${id}`,
  artist: 'Someone',
  album: 'Something',
  artworkUrl: null,
  durationMs: 180_000,
});

const ROUND_TRIP_MS = 5;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
};

function fakeBridge(record: Record): (os: string, events: NativeBridgeEvents) => Promise<NativeBridge> {
  return async (_os: string, events: NativeBridgeEvents) => {
    record.events = events;
    return {
      async load(info: NativeTrackInfo) {
        if (record.loadGate) await record.loadGate;
        await wait(ROUND_TRIP_MS);
        return { assetId: `slot-${info.id ?? 'x'}`, cached: false };
      },
      async prepare(info: NativeTrackInfo) {
        await wait(ROUND_TRIP_MS);
        return { assetId: `slot-${info.id ?? 'x'}`, holdsBytes: true };
      },
      async play(seconds: number) {
        record.order.push(`play:${seconds}`);
        record.plays.push(seconds.toFixed(0));
        await wait(ROUND_TRIP_MS);
        // The player's own answer that sound exists, a moment after the call — after the engine's wait.
        // A `silent` player takes the call and never answers: a start that produced no sound.
        if (!record.silent) setTimeout(() => events.onPosition(Math.max(0, seconds)), 5);
      },
      async adopt() {
        record.order.push('adopt');
        await wait(ROUND_TRIP_MS);
        return false;
      },
      async discard() {},
      async setQueue(options?: { index?: number; awake?: boolean }) {
        /*
         * The statement, with the flag it carried. `awake` is the whole subject of the boundary
         * finding: this call is the only writer of the native side's `awake`, so the fake has to
         * carry it or the suite cannot see a return that never re-states the queue.
         */
        const awake = options?.awake === true;
        record.order.push(`setQueue:awake=${awake}`);
        record.statements.push({ index: options?.index ?? -1, awake });
        await wait(ROUND_TRIP_MS);
        return true;
      },
      async handover() {
        record.order.push('handover');
        await wait(ROUND_TRIP_MS);
        return record.reading ?? { songId: '', index: -1, positionMs: 0 };
      },
      async releaseHandover() {
        record.order.push('release');
        record.released += 1;
        await wait(ROUND_TRIP_MS);
        return true;
      },
      async reconcile() {
        record.order.push('reconcile');
        const reading = record.sounding;
        return record.songNow
          ? { changed: true, songId: record.songNow, index: 1, resume: null, reading }
          : { changed: false, songId: null, index: 0, resume: null, reading };
      },
      nativeAdvance() {
        return { armed: 1, advances: 0, failures: 0, ignored: 0, reason: 'test', timeline: '', identity: '', startedAt: 0, foregroundTimeline: '', foregroundStartedAt: 0 } as unknown as ReturnType<NonNullable<NativeBridge['nativeAdvance']>>;
      },
      async retryPlayInPlace() {
        return true;
      },
      pause: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      seek: async () => undefined,
      positionMs: () => 0,
      sync: async () => ({ playing: record.playing, positionMs: record.syncPositionMs, durationMs: 180_000 }),
      activateSession: async () => true,
      listenRemoteCommands: () => () => undefined,
      hasNativeSpectrum: false,
    } as unknown as NativeBridge;
  };
}

function engineFor(record: Record): AudioEngine {
  const engine = new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'],
  });
  /*
   * What `PlaybackQueue` does with the native advance: the track the player moved to IS the track the
   * app is on. Without this the engine has no way to be on the entry the queue reached, which is the
   * state the return path is about.
   */
  engine.onAdvancedNatively = (songId: string) => {
    engine.adoptNativeAdvance(track(songId));
  };
  return engine;
}

test('the return adopts the entry the queue reached, at the queue’s own position, then releases it', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('a'));
    await engine.handleVisibility(true);

    /*
     * The queue played on while the app was away: it is on entry b, four minutes in, and it paused
     * itself there to hand the sound back (`handOverAwayQueue`).
     */
    record.songNow = 'b';
    record.reading = { songId: 'b', index: 1, positionMs: 247_000 };
    record.plays = [];
    record.order = [];
    await engine.handleVisibility(false);
    await settle();

    assert.deepEqual(record.plays, ['247'], 'the app starts entry b at the position the QUEUE reached, not at zero');
    assert.ok(
      record.order.indexOf('handover') < record.order.indexOf('play:247'),
      `the queue is asked to hand over BEFORE the app starts that entry (${record.order.join(' → ')})`,
    );
    const playAt = record.order.indexOf('play:247');
    const releaseAt = record.order.indexOf('release');
    assert.ok(playAt >= 0, `the start was issued (${record.order.join(' → ')})`);
    assert.ok(releaseAt > playAt, `the queue is released AFTER that start commits (${record.order.join(' → ')})`);
    assert.equal(record.released, 1, 'and it is released exactly once');
  } finally {
    await engine.stop();
    await settle();
  }
});

test('a reading about an entry nobody is starting is kept, and spent by the next start of it', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('a'));
    await engine.handleVisibility(true);
    // The queue reached c and handed the sound back, but the app's own player is still on a: nothing
    // is started for a track the app was never asked to play.
    record.reading = { songId: 'c', index: 2, positionMs: 61_000 };
    record.plays = [];
    record.order = [];
    await engine.handleVisibility(false);
    await settle();

    assert.deepEqual(record.plays, [], 'no entry is started for a reading the app has no track for');
    assert.equal(record.released, 0, 'and the reading is not spent either');

    // The owner taps that entry: it begins where the queue was, and only then is the queue released.
    record.order = [];
    await engine.play(track('c'));
    await settle();
    assert.deepEqual(record.plays, ['61'], 'the start of that entry uses the reading as its position');
    const playAt = record.order.indexOf('play:61');
    const releaseAt = record.order.indexOf('release');
    assert.ok(releaseAt > playAt, `released after the commit (${record.order.join(' → ')})`);
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ------------------------------ the return as an ADOPTION (unreleased) */

test('a player already sounding the visible entry is READ on every return — never started, never loading', async () => {
  const record = blank();
  const engine = engineFor(record);
  const states: string[] = [];
  const unsubscribe = engine.subscribe((status) => states.push(status.state));
  try {
    await engine.play(track('a'));
    await settle();
    const startsAfterTheOnePlay = engine.status().returnPath.starts;
    assert.equal(startsAfterTheOnePlay, 1, 'the session has issued exactly one start so far');

    /*
     * The owner goes out and comes back three times with nothing else happening — his own words: "to
     * and fro should not affect the music". The player reports itself sounding the entry the queue is
     * on (`path: 'plugin'` is the plugin's own player, which is what an ordinary background/foreground
     * leaves sounding), at a position that keeps advancing because the sound never stopped.
     */
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await engine.handleVisibility(true);
      record.plays = [];
      record.order = [];
      record.statements = [];
      states.length = 0;
      record.syncPositionMs = 42_000 + cycle * 5_000;
      record.sounding = { songId: 'a', index: 0, positionMs: record.syncPositionMs, path: 'plugin', sounding: true };
      /*
       * And the queue's own offer names the same entry at the same position — which is what the plugin
       * really answers: `handover()` resolves `returnReading()`, so a phone whose own player is sounding
       * the track offers *that* track back. This is the reading the old return took and then
       * `play(track, position, force: true)`-ed, restarting the song the listener was hearing.
       */
      record.reading = { songId: 'a', index: 0, positionMs: record.syncPositionMs };

      await engine.handleVisibility(false);
      await settle();

      const status = engine.status();
      assert.deepEqual(record.plays, [], `cycle ${cycle}: the return starts nothing`);
      assert.ok(!record.order.includes('handover'), `cycle ${cycle}: the queue is never asked to hand over (${record.order.join(' → ')})`);
      assert.ok(!record.order.includes('release'), `cycle ${cycle}: and nothing is released`);
      assert.ok(!states.includes('loading'), `cycle ${cycle}: the return never draws loading (${states.join(' → ')})`);
      /*
       * **The boundary is re-stated, and it says the app is here.** This is the finding this
       * assertion exists for: the adoption returned before `syncQueue()`, so `awake` stayed `false` on
       * the native side while the app was on screen — two owners at the next track end (Swift's
       * `itemDidEnd` and the foreground web layer) and the card watchdog running over a screen it does
       * not own. The last statement after each return must therefore carry `awake: true`, and it must
       * be a statement of *this* queue.
       */
      const statement = record.statements[record.statements.length - 1];
      assert.ok(statement, `cycle ${cycle}: the queue is stated to the native boundary on the way back (${record.order.join(' → ')})`);
      assert.equal(statement.awake, true, `cycle ${cycle}: and the statement says the app is on screen (\`awake: true\`, got ${JSON.stringify(statement)})`);
      assert.ok(
        record.order.lastIndexOf('setQueue:awake=true') > record.order.indexOf('reconcile'),
        `cycle ${cycle}: it is made on the way back, after the player was read (${record.order.join(' → ')})`,
      );
      assert.equal(status.returnPath.path, 'adopt', `cycle ${cycle}: the return took the adoption branch`);
      assert.equal(status.state, 'playing', `cycle ${cycle}: the music is still playing`);
      assert.ok(
        Math.abs(status.positionMs - record.syncPositionMs) < 1_500,
        `cycle ${cycle}: the position is adopted from the player (${status.positionMs} vs ${record.syncPositionMs})`,
      );
    }

    const final = engine.status();
    assert.equal(final.returnPath.adoptions, 3, 'three returns, three adoptions');
    assert.equal(final.returnPath.starts, startsAfterTheOnePlay, 'and the whole session still has exactly ONE start');
  } finally {
    unsubscribe();
    await engine.stop();
    await settle();
  }
});

test('a player that is not on the visible entry still reaches the handover, and still ends in a decision', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('a'));
    await settle();
    await engine.handleVisibility(true);

    /*
     * The app's own player is sounding another entry ('b'), and the queue handed the visible one back
     * at 30 s. The reading is not the visible entry, so this return is NOT an adoption: it hands the
     * sound back and starts what it was given — the half of the return the adoption must not swallow.
     */
    record.sounding = { songId: 'b', index: 1, positionMs: 61_000, path: 'plugin', sounding: true };
    record.reading = { songId: 'a', index: 0, positionMs: 30_000 };
    record.plays = [];
    record.order = [];
    await engine.handleVisibility(false);
    await settle();

    assert.equal(engine.status().returnPath.path, 'handover', 'the other half is still the handover');
    assert.deepEqual(record.plays, ['30'], 'the queue’s reading is started at the queue’s own position');
    assert.ok(
      record.order.indexOf('handover') < record.order.indexOf('play:30'),
      `the queue is asked before the start (${record.order.join(' → ')})`,
    );
    assert.ok(
      record.order.indexOf('release') > record.order.indexOf('play:30'),
      `and released only after it commits (${record.order.join(' → ')})`,
    );
    assert.equal(record.released, 1, 'released exactly once');
    assert.equal(engine.status().state, 'playing', 'and the return ends in a decision, never in a stuck phase');
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ------------------------- the return always ends in a decision (unreleased) */

test('a return that reaches the handover with nothing sounding settles to a decision, never to loading', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    /*
     * The owner starts a track and leaves the screen while the load is still in flight. The machine is
     * at `loading`, and nothing will move it: the player never reports sound (the web view is
     * suspended, which is exactly the window the owner describes as "stuck in a loading phase").
     */
    let release!: () => void;
    record.loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    record.silent = true;
    const starting = engine.play(track('a'));
    await wait(10);
    await engine.handleVisibility(true);
    record.loadGate = null;
    release();
    await starting;
    await settle();
    assert.equal(engine.status().state, 'loading', 'the start never produced sound, so the row is still waiting');

    /*
     * The return finds nothing this side can name: no player reading, and the queue offers no entry
     * either. Nothing is started — and the row must still reach a decision rather than stay in the
     * phase it was left in.
     */
    record.plays = [];
    record.order = [];
    record.statements = [];
    record.sounding = null;
    record.reading = { songId: '', index: -1, positionMs: 0 };
    record.playing = false;
    await engine.handleVisibility(false);
    await settle();

    const status = engine.status();
    assert.equal(status.returnPath.path, 'handover', 'nothing was sounding this side, so this is the handover branch');
    assert.deepEqual(record.plays, [], 'and no entry is started for a reading that names none');
    assert.notEqual(status.state, 'loading', 'the row reaches a decision instead of sitting in loading over a silent track');
    assert.equal(status.state, 'paused', 'the decision is paused — one tap from playing');
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ------------------------------------ the Swift side: three readings, each a named defect */

const swift = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App', 'App', 'NaviliteRemote.swift'),
  'utf8',
);

function body(start: string, end: string): string {
  const at = swift.indexOf(start);
  assert.ok(at >= 0, `the file still contains ${start}`);
  const until = swift.indexOf(end, at);
  assert.ok(until > at, `${start} still has its end marker ${end}`);
  return swift.slice(at, until);
}

test('re-arming the queue drops the handover reading it described the items of', () => {
  const arm = body('private func armAwayQueue(token: Int)', 'private func topUpAwayQueue');
  const clear = arm.indexOf('awayResume = nil');
  const drop = arm.indexOf('queuePlayer.removeAllItems()');
  assert.ok(clear >= 0, 'the re-arm clears `awayResume`');
  assert.ok(drop > clear, 'and it happens as the items it described are removed, not after');
});

test('an entry that failed to play is not attached again by the next top-up', () => {
  const topUp = body('private func topUpAwayQueue(token: Int)', 'private func awayStart(');
  assert.match(
    topUp,
    /for entry in awayPlan\(\) where !attached\.contains\(entry\.songId\) && !awayFailed\.contains\(entry\.songId\)/,
    'the top-up skips every entry that already failed, so a 404 is not removed and re-created per statement',
  );
  assert.match(topUp, /queue-topup-skip/, 'and the skip is on the phone’s log rather than silent');
});

test('the plugin/fetch reading names the player’s own item, not the app’s statement of the slot', () => {
  const reading = body('private func returnReading()', '@objc func handover(');
  assert.match(
    reading,
    /let item = found\.player\.currentItem/,
    'the slot’s own item is required before an entry is named — a player that holds nothing has nothing sounding',
  );
  assert.match(
    reading,
    /queue\.first\(where: \{ \$0\.url == itemUrl \}\)/,
    'and the entry is named by the url the item was built from (identity, then the url — the queue branch’s bar)',
  );
  assert.match(
    reading,
    /Self\.isSounding\(found\.player\)/,
    'the app’s own statement of the slot is kept only while the player is actually making sound',
  );
  assert.doesNotMatch(
    reading,
    /songId = audible\.songId/,
    'no branch answers the app’s statement of the slot as if it were the player’s item',
  );
  assert.match(
    reading,
    /audible\?\.assetId == Self\.awaySlotName \? \(audible\?\.songId \?\? ""\) : ""/,
    'the only name kept with no player of ours is the away slot’s, which the queue reads above',
  );
});

test('only the entry the queue is SOUNDING reaches the fetch path, and the queue is paused first', () => {
  const fail = body('private func awayItemDidFail', 'private func itemDidEnd');
  assert.match(fail, /let sounding = awayOwnsAudible \? at == awayCursor : at == 0/, 'the entry after the sounding one is not audible');
  const paused = fail.indexOf('awayQueue?.pause()');
  const fetched = fail.indexOf('take(entry: target');
  assert.ok(paused >= 0, 'the queue is paused on the way into the fetch path');
  assert.ok(fetched > paused, 'and it is paused BEFORE the second player is started');
});
