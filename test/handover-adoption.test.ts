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
import type { NativeBridge, NativeBridgeEvents, NativeHandover, NativeReturnReading, NativeReturnRecord, NativeTrackInfo } from '../src/player/native.ts';
import { PlaybackQueue } from '../src/state/queue.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, QueueItem, Song } from '../src/api/types.ts';

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };

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
  /**
   * **Every `return` record the web layer asked the phone to write (unreleased).** One per foreground
   * return, and the branch is the fact this file's log could not carry before: the decision is made
   * here and the file is written in Swift, so the fake bridge is the only place the ask can be seen.
   */
  returns: NativeReturnRecord[];
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
  returns: [],
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
      /* The ask the phone's log is written from (unreleased). Recorded, never invented: the branch
       * comes from the engine's own decision, so a return that took `adopt` cannot say `handover`. */
      async recordReturn(facts: NativeReturnRecord) {
        record.order.push(`return:${facts.path}`);
        record.returns.push(facts);
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
  engine.onAdvancedNatively = (songId: string, _index: number, positionMs?: number) => {
    /*
     * What `PlaybackQueue` does with a native advance: the track the player moved to IS the track the
     * app is on. Without this the engine has no way to be on the entry the queue reached. A
     * `positionMs` is only ever present when the native side is ANSWERING a refusal, and it is
     * rendered — `renderReading` is where the queue lands when the entry is already the visible one.
     */
    engine.adoptNativeAdvance(track(songId), positionMs);
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

/* ----------------------- a refusal that names the sound is an ANSWER (unreleased) */

test('an answer naming the entry and its position is RENDERED — nothing is started, and the row leaves loading', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('a'));
    await settle();
    const startsBefore = engine.status().returnPath.starts;
    record.plays = [];
    record.order = [];

    /*
     * The return's own start was issued and never committed, so the native side settled the offer as
     * `handover-refused` — and it answers with the entry the queue is sounding **and where it is now**
     * (`positionMs`, `reading: true`). That is the owner's four refusals, three seconds apart: the
     * row sat on `loading` over a song the queue was playing the whole time.
     */
    record.events?.onAdvanced?.('b', 1, 17_769);
    await settle();

    assert.deepEqual(record.plays, [], 'the answer starts nothing — the sound it names already exists');
    assert.equal(
      record.order.filter((step) => step.startsWith('play')).length,
      0,
      `no play reaches the player (${record.order.join(' → ')})`,
    );
    assert.equal(engine.status().state, 'playing', 'the row settles on the reading, not on loading');
    assert.ok(
      Math.abs(engine.status().positionMs - 17_769) < 2_000,
      `the position is the reading's, not zero (${engine.status().positionMs} ms)`,
    );
    assert.equal(
      engine.status().returnPath.starts,
      startsBefore,
      'and a reading is not a start — the counter a start moves is untouched',
    );
  } finally {
    await engine.stop();
    await settle();
  }
});

test('the same answer delivered twice issues no second request and no second start', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('b'));
    await settle();
    record.plays = [];
    record.order = [];

    record.events?.onAdvanced?.('b', 1, 17_769);
    record.events?.onAdvanced?.('b', 1, 17_769);
    await settle();

    assert.deepEqual(record.plays, [], 'one reading, one answer — neither delivery starts a player');
    assert.equal(
      record.order.filter((step) => step === 'handover').length,
      0,
      `and nothing asks the native side again (${record.order.join(' → ')})`,
    );
    assert.equal(engine.status().state, 'playing', 'the row stays on the decision it was given');
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ------------------------------------------- the return's own line (unreleased) --------------- */

/*
 * The two questions the phone's log could not answer, asserted where they can be asserted without a
 * phone: **which build wrote the file** (lexically, below — the limit is stated there) and **which
 * branch the return took**. The branch is decided in this layer and the file is written in Swift, so
 * the only observable here is the ask itself: one `recordReturn` per foreground return, carrying the
 * branch the engine actually chose.
 */

test('one `return` record per foreground return — one return writes one, two write exactly two', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('a'));
    await settle();
    assert.equal(record.returns.length, 0, 'a start is not a return, so nothing is written for it');

    await engine.handleVisibility(true);
    record.sounding = { songId: 'a', index: 0, positionMs: 40_000, path: 'plugin', sounding: true };
    await engine.handleVisibility(false);
    await settle();
    assert.equal(
      record.returns.length,
      1,
      `one return to the foreground is one record, not zero and not two (${record.returns.map((r) => r.path).join(', ')})`,
    );
    assert.equal(
      record.order.filter((step) => step.startsWith('return:')).length,
      1,
      `and it is asked for once on the way back (${record.order.join(' → ')})`,
    );

    await engine.handleVisibility(true);
    record.songNow = 'b';
    record.reading = { songId: 'b', index: 1, positionMs: 247_000 };
    record.sounding = null;
    await engine.handleVisibility(false);
    await settle();
    assert.equal(
      record.returns.length,
      2,
      `two returns are exactly two records (${record.returns.map((r) => r.path).join(', ')})`,
    );
  } finally {
    await engine.stop();
    await settle();
  }
});

test('the record’s `path` is the branch the return took — `adopt` on a sounding player, `handover` when it is not', async () => {
  const adopting = blank();
  const adoptEngine = engineFor(adopting);
  try {
    await adoptEngine.play(track('a'));
    await settle();
    await adoptEngine.handleVisibility(true);
    adopting.sounding = { songId: 'a', index: 0, positionMs: 51_000, path: 'plugin', sounding: true };
    await adoptEngine.handleVisibility(false);
    await settle();

    assert.equal(adopting.returns.length, 1, 'the adoption return wrote its line');
    const adopted = adopting.returns[0];
    assert.equal(adopted.path, 'adopt', 'the player was already sounding the visible entry, so this is the adoption branch');
    assert.equal(adopted.songId, 'a', 'and the reading’s entry is on the line');
    assert.equal(adopted.route, 'plugin', 'with the route that owned the sound');
    assert.equal(adopted.started, false, 'an adoption starts nothing — the fact the old log could not state');
    assert.equal(adopted.state, 'playing', 'and the machine settled on playing');
    assert.ok(adopted.positionMs >= 50_000, `the reading’s own position, not the app’s clock (${adopted.positionMs})`);
    assert.ok(adopted.durationMs > 0, `and the duration, so the line can say what "stuck" meant (${adopted.durationMs})`);
  } finally {
    await adoptEngine.stop();
    await settle();
  }

  const handing = blank();
  const handoverEngine = engineFor(handing);
  try {
    await handoverEngine.play(track('a'));
    await settle();
    await handoverEngine.handleVisibility(true);
    handing.songNow = 'b';
    handing.reading = { songId: 'b', index: 1, positionMs: 247_000 };
    handing.sounding = null;
    await handoverEngine.handleVisibility(false);
    await settle();

    assert.equal(handing.returns.length, 1, 'the handover return wrote one line');
    const handed = handing.returns[0];
    assert.equal(handed.path, 'handover', 'nothing was sounding the visible entry, so the sound was handed over');
    assert.equal(handed.songId, 'b', 'and the line names the entry the handover offered');
    assert.equal(handed.started, true, 'a handover issues the start — the two branches are one word apart in the file now');
  } finally {
    await handoverEngine.stop();
    await settle();
  }
});

/*
 * **Lexical, and the limit is the point.** `runtimeIdentity()` reads `Bundle.main.infoDictionary`, and
 * no test in this repository can render a `Bundle` — so this asserts the two keys are in the dictionary
 * the identity record is written from, not that a phone wrote them. Code-present is the proof level
 * until a capture contains an `identity` line carrying `version` and `build`.
 */
test('the identity line carries the build, and the unmapped record carries both sides of the comparison', () => {
  const identity = body('private func runtimeIdentity() -> [String: Any] {', 'private static func provisioningAppId');
  assert.match(
    identity,
    /"version":\s*bundle\.infoDictionary\?\["CFBundleShortVersionString"\]/,
    'the identity record names the version it is running as, so a pasted segment can be dated from itself',
  );
  assert.match(
    identity,
    /"build":\s*bundle\.infoDictionary\?\["CFBundleVersion"\]/,
    'and the build number, which is the one the release cards speak in',
  );

  const unmapped = body('if case .stop(let stopWhy) = decision {', 'stopAwayQueue(why: stopWhy)');
  assert.match(unmapped, /"itemUrl":\s*queueItemUrl \?\? "unavailable"/, 'the queue’s own current item url is on the record');
  assert.match(unmapped, /"attachedUrls":\s*attachedUrls/, 'and the urls this side attached, so the mismatch is visible');

  const bridge = body('@objc func recordReturn(_ call: CAPPluginCall) {', '/// The whole log, as lines');
  assert.match(
    bridge,
    /self\.record\("return", facts\)/,
    'the web layer asks for the line; `record(_:_:)` stays the only writer, so there is still one file and one shape',
  );
});

/*
 * **The look-ahead's one-entry-behind boundary (unreleased).** The log's `ahead-issued` names the
 * entry that had just become current (20 ms after the boundary that made it so), then the genuine
 * next entry is `ahead-skipped`: the statement that armed it lagged the boundary by one entry, so
 * `index + 1` was the sound itself. The statement is now reconciled with the queue's own current
 * item before anything is fetched ahead.
 */
test('the look-ahead is issued from the entry the away queue is sounding, not from a lagging statement', () => {
  const arm = body('if !self.awake {', 'self.armAwayQueue(token: self.generation)');
  const reconciled = arm.indexOf('self.queueSoundingEntry()');
  const preload = arm.indexOf('self.preloadAhead(token: self.generation)');
  assert.ok(
    reconciled >= 0,
    'the statement is reconciled with the queue’s own current item before anything is warmed ahead',
  );
  assert.ok(
    preload > reconciled,
    'and the look-ahead is issued after it, so it targets index + 1 of the SOUND, not of a stale statement',
  );
});

/* ------------------------- the refusal answers with the PUBLISHED index (unreleased) -------- */

/*
 * The owner's log, one layer up from the rules: `handover-refused` carried `index:7` (entry 8 of 269)
 * and `handover-displayed` answered "index 0" — the position of the item inside AVPlayer's attached
 * window, not in the published order. `nameQueue`'s cursor is 0..2 by construction, so the answer has
 * to look the entry up in `queue`, exactly as the adopt and the offer paths already did.
 */
test('the refusal derives its index from the published order — the window cursor is only a fallback', () => {
  const keep = body('case .keepTheQueue(let why):', 'private func queuePositionMs');
  assert.match(
    keep,
    /NavilitePressRules\.publishedIndex\(/,
    'the answer looks the sounding entry up in the published order, as the adopt and offer paths do',
  );
  assert.doesNotMatch(
    keep,
    /queueSoundingEntry\(\)\?\.cursor \?\? reading\.index/,
    'the AVPlayer window cursor is no longer the index the refusal names',
  );
  assert.match(
    keep,
    /fallback: soundingEntry\?\.cursor \?\? reading\.index/,
    'the cursor survives only as the last-resort fallback, for an entry the order cannot name',
  );
  assert.equal(
    (swift.match(/NavilitePressRules\.publishedIndex\(/g) ?? []).length,
    3,
    'all three index derivations in the remote go through the one lookup, so a fourth cannot drift',
  );
});

/*
 * **The web layer’s own gate (unreleased).** Even with the native side answering in the published
 * order, a reading is not a boundary this player walked: the index it writes into `statement` is
 * looked up in the statement's own list, never copied from the event. An older native build that
 * still sends AVPlayer's window index (0..2) therefore cannot write 0 beside entry 8 of 269.
 */
test('a reading’s index is taken from the published list, not from the event’s number', () => {
  const nativeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'player', 'native.ts'),
    'utf8',
  );
  assert.match(
    nativeSource,
    /const reading = event\?\.reading === true \|\| answered !== undefined;/,
    'a reading is recognised at the listener, whether or not the native build stamps `reading`',
  );
  assert.match(
    nativeSource,
    /const at = songId \? statement\.list\.findIndex\(\(entry\) => entry\.songId === songId\) : -1;/,
    'and the statement index comes from the published list, so a window index can never enter it',
  );
  assert.match(
    nativeSource,
    /if \(at >= 0\) statement = \{ \.\.\.statement, index: at \};/,
    'a reading the list can name still moves the statement onto that entry',
  );
});

/* ------------------- the adoption the QUEUE takes, not a hand-written stand-in (unreleased) --- */

/*
 * **F5: the branch that produced the owner's spinner, driven through the real `PlaybackQueue`.**
 *
 * `handover-adoption.test.ts` used to stand in for the queue in `engine.onAdvancedNatively`, which
 * meant `queue.adoptNativeAdvance`'s already-visible branch (`src/state/queue.ts:964-980`) was never
 * executed by any test in the tree — the reading the app renders after a return was code-present
 * only. This drives the real queue, the real engine and the bridge event the native side sends, so
 * the row's entry, its position and the absence of `loading` are the queue's own outcome.
 *
 * **F2 is the same path one field earlier:** the native side's adoption now sends `positionMs` and
 * `reading: true`. Without the position the queue takes the boundary branch, `engine.ts` sets the
 * position to 0 and calls the return a boundary the native player took while the app was away — the
 * row read 0:00 on a track 45 s in. The second half of this test is that negative: the same event
 * with no position is the old behaviour, and it reads 0.
 */

/** The library, reduced to what a `PlaybackQueue` touches. */
function stubLibrary(): Library {
  return {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (song: Song) => `http://127.0.0.1:4599/rest/stream?id=${song.id}`,
    prefetch: () => Promise.resolve(),
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined },
  } as unknown as Library;
}

const queueOf = (...ids: string[]): QueueItem[] =>
  /* `duration` is the track's own length in seconds and becomes `durationMs` — 300 s, so a
   * four-minute reading is inside it and the clock cannot clamp the assertion. */
  ids.map((id) => ({ song: { id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 300 }, context: CONTEXT }));

test('a native adoption that carries its position renders it — the row is that entry at that position, never loading', async () => {
  const record = blank();
  const engine = engineFor(record);
  /* Built AFTER the engine, because the queue claims `onAdvancedNatively` in its constructor —
   * that wiring is the thing under test, not a stand-in for it. */
  const queue = new PlaybackQueue(engine, stubLibrary());
  try {
    await queue.play(queueOf('a', 'b'), 1, CONTEXT);
    await settle();
    assert.equal(queue.currentSong?.id, 'b', 'the row is entry b before the adoption');
    assert.equal(queue.isLoading, false, 'and it is not waiting on a start');
    const starts = record.plays.length;
    assert.ok(
      engine.status().positionMs < 1_000,
      `the row is where the return's own start left it — 0:00, the state the owner saw (${engine.status().positionMs})`,
    );

    /*
     * **The old dict first, and it is the F2 symptom.** No `positionMs` is what the native side used
     * to send on `.adopt`: the queue's already-visible branch had no reading to render, so the row
     * stayed on the 0:00 the failed start left and the record called the return a boundary.
     */
    record.events?.onAdvanced?.('b', 1);
    await settle();
    assert.ok(
      engine.status().positionMs < 1_000,
      `without \`positionMs\` nothing is rendered and the row stays at 0:00 (${engine.status().positionMs})`,
    );

    // And now exactly the dict `NaviliteRemote.handOverAwayQueue` sends on `.adopt`: the entry, its
    // index, and the position the app's own player is already sounding.
    record.events?.onAdvanced?.('b', 1, 244_000);
    await settle();

    assert.equal(queue.currentSong?.id, 'b', 'the adoption leaves the row on the entry the event named');
    assert.equal(queue.isLoading, false, 'the row is not drawn as waiting — that spinner is the defect');
    /* The reading is rendered and its clock runs from it, so the row is `adoptedMs` plus the
     * fraction of a second since — anywhere near 0:00 is the defect this asserts against. */
    const rendered = engine.status().positionMs;
    assert.ok(
      Math.abs(rendered - 244_000) < 1_000,
      `and it renders the position the native side held, not 0:00 (${rendered} vs 244000)`,
    );
    assert.equal(record.plays.length, starts, 'the adoption starts nothing: it is a read plus a statement');
  } finally {
    await engine.stop();
    await settle();
  }
});

test('a return whose player gave no reading writes `-1`, never a number and a 0 (F4)', async () => {
  const record = blank();
  const engine = engineFor(record);
  try {
    await engine.play(track('a'));
    await settle();
    await engine.handleVisibility(true);
    /* Nothing of the app's is sounding and the queue names nothing: `reconcile` answers no reading,
     * so the record has no position to report. The interface documents `-1` for exactly this. */
    record.sounding = null;
    record.reading = { songId: '', index: -1, positionMs: 0 };
    await engine.handleVisibility(false);
    await settle();

    assert.equal(record.returns.length, 1, 'the return still wrote its one line');
    const line = record.returns[0];
    assert.equal(line.positionMs, -1, `no reading is written as -1, the file's own word (${line.positionMs})`);
    assert.equal(line.route, 'none', 'and the route is `none`, so nothing names a sound');
    assert.notEqual(line.durationMs, 0, `unknown duration is -1, never 0 (${line.durationMs})`);
  } finally {
    await engine.stop();
    await settle();
  }
});

/* ---------------- the re-ask guard is keyed on the ENTRY, not the entry and an index ---------- */

/*
 * The owner's log is still four refusals of one entry three seconds apart, with
 * `queue-handover-answered` nowhere in it. Two reasons, both in the guard:
 *
 *  - the identity was `(songId, index)`, and the index is re-derived over `queue` — which the
 *    statement being handled has already replaced with the web layer's own published list
 *    (`self.queue = entries…`, at the top of the statement, before the guard is reached). The app's
 *    order is not index-compatible with this side's (`queue-handover-jump` in the same log: 0jGX at
 *    5 where the queue has 0DHk at 7), so requiring the pair to be equal was never an invariant;
 *  - the standing-offer test came first and names the same entry, so the statement that follows a
 *    refusal returned in silence and the one line a working guard produces was unreachable.
 */
test('the re-ask guard is keyed on the entry, and the answer is asked about first', () => {
  const guard = body('if !fresh {', 'awayResume = (songId: songId');
  assert.ok(
    guard.indexOf('queue-handover-answered') >= 0 &&
      guard.indexOf('queue-handover-answered') < guard.indexOf('let standing = awayResume'),
    'the answer is recognised before the standing-offer test, which would otherwise swallow the statement in silence',
  );
  assert.match(
    guard,
    /if let standing = awayResume, standing\.songId == songId \{/,
    'a standing offer is the same entry — the index is not part of that identity either',
  );
  assert.doesNotMatch(
    swift,
    /standing\.index == soundingIndex/,
    'no identity is made out of an index the statement re-bases',
  );
  assert.doesNotMatch(
    swift,
    /answeredIndex == offeredIndex/,
    'and the rule does not require the two indices to agree: the entry is the request',
  );
  assert.match(
    swift,
    /"soundingIndex": soundingIndex/,
    'the refusal writes the index it answers with under a key `record` does not overwrite',
  );
  assert.match(
    swift,
    /"offerIndex": soundingIndex/,
    'and so does the offer, so the next log can show the two numbers the guard compared',
  );
});

/*
 * **The two hops no test can build, asserted where they are written (unreleased, F2).**
 *
 * The chain F2 is about is four layers: the Swift adoption's `advanced` dict → `native.ts`'s listener
 * → the engine → `queue.adoptNativeAdvance`. The two lower layers are driven for real above. The two
 * upper ones cannot be: `createNativeBridge` imports the Capacitor plugin by name, and `NaviliteRemote`
 * needs Xcode and AVFoundation. So they are asserted as the source that carries the field, which is
 * the proof level this repository already uses for the Swift side (`the identity line carries the
 * build`) — code-present, until a device capture shows the row's position.
 */
test('the adoption’s dict carries its position, and the listener forwards it (lexical, code-present)', () => {
  const adopt = body('if case .adopt(let adoptedSongId, let adoptedIndex, let adoptedMs) = decision {',
    'if case .stop(let stopWhy) = decision {');
  assert.match(adopt, /"positionMs":\s*adoptedMs/, 'the adoption sends the position it holds, not just the entry');
  assert.match(adopt, /"reading":\s*true/, 'and says it IS a reading — that is what `renderReading` is reached by');
  /*
   * **One return, one branch word (unreleased, `t_e56c0413` F4; `t_234b1ab8`).** The web layer's
   * `return` line for this same return says `path:"adopt"`, `route:"plugin"` (asserted behaviourally
   * above, in `the record's `path` is the branch the return took`). This record said `path:"plugin"` —
   * the route — so a capture answered "which branch?" two different ways, one line after the other. The
   * two lines must name the same branch, under the same key — and the route comes from the player
   * holding the entry (`appRoute`), not from a hardcoded `"plugin"` over a fetch slot.
   */
  assert.match(
    adopt,
    /"path":\s*"adopt"/,
    'the adoption record names the branch (`adopt`), as the engine’s own `return` line does',
  );
  assert.match(
    adopt,
    /"route":\s*self\.appRoute\(adoptedSongId\)/,
    'and carries where the sound was, under `route` — the key the `return` line uses, answered by the route that holds it',
  );
  assert.ok(
    !/"route":\s*"plugin"/.test(adopt),
    'and no longer hardcodes `plugin`, which was `fetch` whenever the app’s own player was the fetch slot',
  );
  assert.ok(
    !/"path":\s*"plugin"/.test(adopt),
    'and no longer answers `path:"plugin"`, which named the route under the branch’s key',
  );
  assert.ok(
    !/\.(play|pause|seek)\(/.test(adopt),
    'and it still issues no play, pause or seek: the adopt route is a read plus a statement',
  );
  assert.match(
    adopt,
    /notifyListeners\("advanced", data: \[[\s\S]*?\]\)/,
    'the answer is the `advanced` notification the web layer already handles',
  );

  const nativeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'player', 'native.ts'),
    'utf8',
  );
  const listenAt = nativeSource.indexOf("remote.addListener('advanced', (event) => {");
  assert.ok(listenAt >= 0, 'native.ts still listens for `advanced`');
  const listenEnd = nativeSource.indexOf("remote.addListener('advanceFailed'", listenAt);
  const listener = nativeSource.slice(listenAt, listenEnd > listenAt ? listenEnd : listenAt + 8_000);
  assert.match(
    listener,
    /const answered = Number\.isFinite\(event\?\.positionMs\) \? Number\(event\?\.positionMs\) : undefined;/,
    'the listener reads `positionMs` off the event — without this the position never leaves the phone',
  );
  assert.match(
    listener,
    /events\.onAdvanced\?\.\(songId, moved, answered\);/,
    'and hands it to the queue as the reading (third argument), which is what `adoptNativeAdvance` renders',
  );
});

/*
 * **Finding 2 of `t_234b1ab8` — `path` means the branch in every `return-adopted` writer, and the route
 * has its own key.**
 *
 * The log has two lines about one return: this file's Swift `record` (which writes `return-adopted` on
 * each of the four ways the sound is taken back) and the web layer's `return` line, written by
 * `engine.ts`'s `recordReturn` with `path` = the branch and `route` = `held.path`. Three of the four
 * phone-side writers used to put the *route* under `path` (`"queue"`, `"plugin"`, `"queue"`), so on a
 * queue-take return the phone said `path:"queue"` while the web said `path:"handover", route:"queue"`.
 *
 * No harness drives Swift→bridge, so this is asserted where it is written: **code-present**, on both
 * sides, for the two exits the card names — a queue-take return and an adopt return.
 */
test('every `return-adopted` writer names the branch under `path` and the route under `route` — on both sides of the log (lexical, code-present)', () => {
  const blocks = swift
    .split('record("return-adopted", [')
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('])')));
  assert.equal(blocks.length, 4, 'the record is written in exactly four places');
  for (const block of blocks) {
    const branch = /"path":\s*"([^"]+)"/.exec(block)?.[1];
    assert.ok(
      branch === 'adopt' || branch === 'handover',
      `every block names a branch under \`path\` — found ${String(branch)} in ${block.slice(0, 120)}`,
    );
    assert.match(block, /"route":/, 'and states the route under its own key');
    assert.ok(
      !/"path":\s*"(queue|plugin|fetch)"/.test(block),
      'no block answers a route under `path` any more',
    );
  }

  /* The adopt return: branch `adopt`, route from the player holding the entry. */
  assert.match(blocks[0], /"path":\s*"adopt"/);
  assert.match(blocks[0], /"route":\s*self\.appRoute\(adoptedSongId\)/);

  /* The queue-take return: `handover` — the sound came back through the app's own start — route `queue`. */
  assert.match(blocks[1], /"path":\s*"handover"/, 'the take in `spendHandover` is a handover');
  assert.match(blocks[1], /"route":\s*"queue"/, 'and names the queue as the route it came from');
  assert.match(blocks[2], /"route":\s*self\.appRoute\(reading\.songId\)/, 'a release the app already owned names the app’s route');
  assert.match(blocks[3], /"path":\s*"handover"/, 'the proved take in `finishRelease` is a handover');
  assert.match(blocks[3], /"route":\s*"queue"/);

  /* And the web's own line means the same two things: `path` is the branch argument, `route` the reading's. */
  const engineSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'player', 'engine.ts'),
    'utf8',
  );
  const recordReturn = engineSource.slice(engineSource.indexOf('private async recordReturn('));
  assert.match(
    recordReturn.slice(0, 1_600),
    /path: 'adopt' \| 'handover',/,
    'the web line’s `path` is the branch the return took',
  );
  assert.match(
    recordReturn.slice(0, 1_600),
    /route: held\?\.path \?\? 'none',/,
    'and its `route` is the route the reading named — the same key the phone now writes',
  );
});
