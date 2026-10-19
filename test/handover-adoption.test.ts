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
import type { NativeBridge, NativeBridgeEvents, NativeHandover, NativeTrackInfo } from '../src/player/native.ts';

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
  /** What the plugin answers `handover()` with — the queue's own reading. */
  reading: NativeHandover | null;
  released: number;
  songNow: string;
}

const blank = (): Record => ({ events: null, plays: [], order: [], reading: null, released: 0, songNow: '' });

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
        setTimeout(() => events.onPosition(Math.max(0, seconds)), 5);
      },
      async adopt() {
        record.order.push('adopt');
        await wait(ROUND_TRIP_MS);
        return false;
      },
      async discard() {},
      async setQueue() {
        record.order.push('setQueue');
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
        return record.songNow
          ? { changed: true, songId: record.songNow, index: 1, resume: null }
          : { changed: false, songId: null, index: 0, resume: null };
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
      sync: async () => ({ playing: true, positionMs: 42_000, durationMs: 180_000 }),
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

test('only the entry the queue is SOUNDING reaches the fetch path, and the queue is paused first', () => {
  const fail = body('private func awayItemDidFail', 'private func itemDidEnd');
  assert.match(fail, /let sounding = awayOwnsAudible \? at == awayCursor : at == 0/, 'the entry after the sounding one is not audible');
  const paused = fail.indexOf('awayQueue?.pause()');
  const fetched = fail.indexOf('take(entry: target');
  assert.ok(paused >= 0, 'the queue is paused on the way into the fetch path');
  assert.ok(fetched > paused, 'and it is paused BEFORE the second player is started');
});
