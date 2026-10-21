/**
 * v1.9.9 — the published queue, the boundary the native side walks, and the two lanes.
 *
 * Four claims, and each one is a defect the owner could feel:
 *
 *   1. **The boundary is the whole queue, not the look-ahead.** v1.9.8 armed the native side with
 *      the two warm slots after the one playing — a chain built in JavaScript, never refilled while
 *      JavaScript was suspended, so a third track end with the app away had nothing to play and the
 *      music stopped. What is asserted here is that the statement carries **every entry of the
 *      resolved play order**, with a slot only for the entries the app genuinely holds warm and *no
 *      slot* for the rest (which the native side fetches itself): n entries, n boundaries. Asserted
 *      against the bridge, which is the thing that decides which slot an entry is played from.
 *   2. **An advance is adopted by index.** A play order is not a list of slot names, and with
 *      shuffle on the position in the order is the only thing that says which track is playing. The
 *      index the native side reports is honoured (and an index that names a *different* track is not
 *      adopted blindly — the id is the fallback).
 *   3. **A warm slot that holds no media is not warm.** The engine drops the claim, the entry is
 *      published **without a slot**, and nothing anywhere claims that boundary was going to be
 *      instant.
 *   4. **The audible lane is never behind warm work.** The two lanes and the yield are in
 *      `createAssetLanes`, and they are driven here directly: a start must not wait for a warm that
 *      is still fetching, and a warm that cannot yield must issue nothing at all.
 *
 * The real `AudioEngine` and the real `PlaybackQueue` are driven here, against a fake bridge and a
 * fake library: no DOM, no network, no phone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import type { EngineOptions } from '../src/player/engine-contract.ts';
import { createAssetLanes, identitySentence, toAbsoluteArtworkUrl, type NativeBridge, type NativeBridgeEvents, type NativeQueueStatement, type NativeTrackInfo } from '../src/player/native.ts';
import { PlaybackQueue } from '../src/state/queue.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://navilite.example' };

/*
 * The engine builds a media element in its constructor whichever platform it is on — in a wrapped
 * build it is never played, and it is the *only* browser thing any of the native paths touch. One
 * stub, so these tests run with no DOM at all.
 */
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

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };
const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 180 });
const queueOf = (...ids: string[]) => ids.map((id) => ({ song: song(id), context: CONTEXT }));
const urlOf = (id: string): string => `http://127.0.0.1:4599/rest/stream?id=${id}`;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/**
 * Long enough for the bridge's own round trips to land. The bridge calls are promises that take
 * time — the same 5 ms the fake bridge below waits before it reports a position — because a player
 * that answered a `play` with its own position *synchronously* would be answered before the engine
 * had a chance to wait for it, which is not what a device does.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
};

/** One statement of the queue as the bridge received it, in the terms the tests assert on. */
interface Stated {
  songs: string[];
  /** The slot each entry was played from, or null where the app holds nothing warm. */
  slots: Array<string | null>;
  index: number;
  repeat: string;
  awake: boolean;
}

interface Boundary {
  /** What the app has stated to the native side, latest last. */
  stated: Stated[];
  /** The track the native player moved to by itself, as the app was told. */
  advanced: string[];
  /** Slots the bridge asked the plugin to make warm, and what the plugin answered. */
  warmed: string[];
  /** Every `load` the bridge was asked for — a boundary must not produce one. */
  loads: string[];
  plays: string[];
  /** What the app asked the player to do when it retried a start that produced no sound. */
  retries: number;
  events: NativeBridgeEvents | null;
  /** False models a slot whose item exists and holds nothing (the defect this release fixes). */
  warmHoldsBytes: boolean;
}

/**
 * The bridge, reduced to what the engine and the queue touch — with the statement under test
 * (the published queue) recorded rather than simulated, and the warm proof answered from a flag.
 */
function fakeBridge(record: Boundary): (os: string, events: NativeBridgeEvents) => Promise<NativeBridge> {
  return async (_os: string, events: NativeBridgeEvents) => {
    record.events = events;
    const wait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
    /** The slots the bridge believes hold warm tracks: `songId -> slot`. */
    const slots = new Map<string, string>();
    let nextSlot = 1;
    return {
      async load(info: NativeTrackInfo) {
        record.loads.push(info.url);
        await wait();
      },
      async play(seconds: number) {
        record.plays.push(`play@${Math.round(seconds)}`);
        await wait();
        /*
         * The player answers the call, and reports where it is a moment later — **after** the call
         * has been answered, which is what the engine's own start proof waits for. A report that
         * arrived inside the call would be a report nobody was waiting for.
         */
        setTimeout(() => events.onPosition(Math.max(0, seconds)), 5);
      },
      async prepare(info: NativeTrackInfo) {
        const slot = `navilite-slot-${nextSlot++}`;
        slots.set(info.id ?? info.url, slot);
        record.warmed.push(slot);
        await wait();
        // The plugin's own answer: whether the slot holds the media it was asked for.
        return record.warmHoldsBytes;
      },
      async adopt(songId?: string) {
        if (typeof songId !== 'string') return false;
        const slot = slots.get(songId);
        if (slot === undefined) return false;
        slots.delete(songId);
        record.plays.push('play@0');
        await wait();
        setTimeout(() => events.onPosition(0), 5);
        return true;
      },
      async discard() {
        slots.clear();
      },
      async setQueue(statement: NativeQueueStatement) {
        const songs = statement.list.map((entry) => entry.songId);
        const statedSlots = statement.list.map((entry) => {
          if (entry.warmUrl == null) return null;
          return slots.get(entry.songId) ?? `missing:${entry.songId}`;
        });
        record.stated.push({ songs, slots: statedSlots, index: statement.index, repeat: statement.repeat, awake: statement.awake });
        // The native side can walk this queue: it holds the order and the index, and it fetches
        // whatever it was given no slot for.
        return songs.length > 0 && statement.index >= 0;
      },
      async reconcile() {
        return { changed: false, songId: null, index: -1 };
      },
      nativeAdvance() {
        const last = record.stated[record.stated.length - 1];
        return { armed: last ? last.songs.length : 0, advances: record.advanced.length, failures: 0, ignored: 0, reason: 'test' };
      },
      async retryPlayInPlace() {
        record.retries += 1;
        return true;
      },
      pause: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      seek: async () => undefined,
      positionMs: () => 0,
      sync: async () => null,
      activateSession: async () => true,
      listenRemoteCommands: () => () => undefined,
      hasNativeSpectrum: false,
    } as unknown as NativeBridge;
  };
}

function stubLibrary(): Library {
  return {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (track: Song, maxBitRate?: number | null) =>
      maxBitRate == null ? urlOf(track.id) : `${urlOf(track.id)}&maxBitRate=${maxBitRate}`,
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined, streamUrl: (id: string) => urlOf(id) },
  } as unknown as Library;
}

function blank(): Boundary {
  return { stated: [], advanced: [], warmed: [], loads: [], plays: [], retries: 0, events: null, warmHoldsBytes: true };
}

/** The engine and the queue, wired to each other exactly as `src/ui/app.ts` wires them. */
function pair(record: Boundary): { engine: AudioEngine; queue: PlaybackQueue } {
  const engine = new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'],
  });
  const queue = new PlaybackQueue(engine, stubLibrary());
  return { engine, queue };
}

const lastStated = (record: Boundary): Stated => record.stated[record.stated.length - 1]!;

/**
 * Every engine is stopped before its test ends: the clock ticker and the spectrum poll are
 * `setInterval`s, and a test process that holds one open never exits.
 */
async function stopAll(engines: AudioEngine[]): Promise<void> {
  for (const engine of engines) await engine.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const engine of engines) await engine.stop();
}

test('the native side is given the whole queue — every entry, in the order it will be played', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  // Off screen — the state the native side is given the boundary in.
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();

  /*
   * **All three entries, not the two after the one playing.** This is the invariant that makes a
   * boundary uncrossable: the order is the app's, the native side holds the whole of it, and it can
   * fetch any entry it has no slot for. v1.9.8 stated a two-slot chain here and ran out after two
   * track ends with the app away.
   */
  const stated = lastStated(record);
  assert.deepEqual(stated.songs, ['song-1', 'song-2', 'song-3'], 'the whole resolved play order is published, in the order it will be played');
  assert.equal(stated.index, 0, 'with the entry that is playing named as an index');
  assert.equal(stated.repeat, 'off', 'and the repeat mode, so the end of the list can be taken the way the app would');
  assert.equal(stated.awake, false, 'stated as "the app is away", which is the only state in which the native side may act');
  assert.deepEqual(
    stated.slots,
    [null, 'navilite-slot-1', 'navilite-slot-2'],
    'the entries the app holds warm carry their slot; everything else is published without one, which is the instruction to fetch it',
  );
  assert.equal(engine.status().nativeBoundary.armed, 3, 'the native side says it is holding all three entries');

  // Coming back in: the same queue, stated with the web layer awake, so the native side stands down.
  await engine.handleVisibility(false);
  const back = lastStated(record);
  assert.equal(back.awake, true, 'with the app on screen the web layer takes the boundary back, and the native side is told so');
  assert.deepEqual(back.songs, ['song-1', 'song-2', 'song-3'], 'the queue itself is unchanged — only who acts on it');
  assert.equal(engine.status().nativeBoundary.advances, 0, 'and nothing has been advanced by it');
  await stopAll([engine]);
});

test('a track the native player started by itself is adopted by index — nothing is loaded, nothing is replayed', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();
  const loadsBefore = record.loads.length;
  const playsBefore = record.plays.length;

  /*
   * The native player took the boundary: it played the entry holding song-3 while the web view was
   * frozen, and this is the message the app receives when it wakes — with the index it moved to.
   */
  record.events?.onAdvanced?.('song-3', 2);
  await settle();

  assert.equal(queue.currentSong?.id, 'song-3', 'the queue moves onto the track that is sounding');
  assert.equal(queue.position, 2, 'and its cursor moves to the index the native side reported');
  assert.equal(record.loads.length, loadsBefore, 'nothing was loaded: the track is already on the player and already playing');
  assert.equal(record.plays.length, playsBefore, 'and nothing was played again — adopting a boundary is not starting a track');
  assert.equal(engine.status().state, 'playing', 'the machine agrees that sound exists');
  assert.equal(engine.currentTrack?.id, 'song-3', 'the engine is following the track that replaced the one it had');

  /*
   * And the same message arriving twice — which it does, because the app learns about an advance both
   * from the event and from asking the player on the way back — changes nothing but the look-ahead.
   */
  record.events?.onAdvanced?.('song-3', 2);
  await settle();
  assert.equal(queue.currentSong?.id, 'song-3', 'a second report of the same advance is idempotent');
  assert.equal(record.loads.length, loadsBefore, 'and still loads nothing');
  assert.equal(queue.position, 2, 'the cursor does not run on');
  await stopAll([engine]);
});

test('an index that names a different track is not adopted blindly — the track id still decides', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  /*
   * A queue whose play order is **not** its list order: `order` is [2, 0, 1], so position 0 is
   * song-3, position 1 is song-1, position 2 is song-2. This is the shape shuffle produces, and it
   * is what the by-id adoption could not describe: the native side's index and the track's place in
   * the list are two different numbers.
   */
  queue.restoreExact(
    { songs: [song('song-1'), song('song-2'), song('song-3')], order: [2, 0, 1], cursor: 0, shuffle: true, repeat: 'off', context: CONTEXT },
    0,
  );
  void queue.start();
  await settle();

  // The native side says it is on song-1 at index 2 — where its list holds song-2. A wrong index is
  // not a track: the id is what decides, and the cursor lands where song-1 really is.
  record.events?.onAdvanced?.('song-1', 2);
  await settle();
  assert.equal(queue.currentSong?.id, 'song-1', 'the track the native side named is the one adopted');
  assert.equal(queue.position, 1, 'and its position in the published order, not the index it came with');
  assert.equal(queue.songPosition, 0, 'which is the first entry of the list — the order is not the list');

  // The honest index, from the same list: adopted as given.
  record.events?.onAdvanced?.('song-2', 2);
  await settle();
  assert.equal(queue.currentSong?.id, 'song-2', 'a correct index is adopted as it is');
  assert.equal(queue.position, 2, 'at the position it names in the published order');
  await stopAll([engine]);
});

test('a boundary the native side refuses comes back to the app, and the track still moves on', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();
  assert.equal(lastStated(record).awake, false, 'the app is away and the native side holds the boundary');

  /*
   * Its own completion is not the app's to act on while it is away: the native player is the only
   * thing that can hear the end there, and acting on this one as well is how a track gets skipped.
   */
  record.events?.onComplete?.();
  await settle();
  assert.equal(queue.currentSong?.id, 'song-1', 'a completion that arrived while the native side held the boundary does not move the queue');

  /*
   * And the door it may not close: when the native side says it could not take the boundary, the end
   * of that track is the app's again — which is what keeps a refused boundary from becoming a track
   * that never moves on.
   */
  record.events?.onBoundaryRefused?.();
  await settle();
  assert.equal(queue.currentSong?.id, 'song-2', 'a boundary the native player refused still advances the track');
  assert.equal(engine.status().state, 'playing', 'and the next track is playing');
  await stopAll([engine]);
});

test('a warm slot that holds no media is not warm, and the entry is published without a slot', async () => {
  const record = blank();
  record.warmHoldsBytes = false;
  const { engine, queue } = pair(record);
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();

  assert.ok(record.warmed.length > 0, 'the app asked the player for the media a warm slot needs');
  assert.deepEqual(engine.status().warmedIds, [], 'a slot that answered "no media" is not claimed as warm by the engine');
  assert.deepEqual(
    lastStated(record).slots,
    [null, null, null],
    'so no entry is published with a slot — the native side fetches each one itself rather than being handed an asset that cannot start',
  );
  assert.equal(engine.status().nativeBoundary.armed, 3, 'and the queue is still the boundary: totality is the list, not the warmth');
  await stopAll([engine]);
});

test('a retry in place asks the player that already holds the track, and never loads it again', async () => {
  const record = blank();
  const engine = new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'],
  });
  await engine.handleVisibility(true);

  const request = {
    id: 'song-1',
    url: urlOf('song-1'),
    crossOrigin: false,
    title: 'Track song-1',
    artist: 'Someone',
    album: 'Something',
    artworkUrl: null,
    durationMs: 180_000,
  };
  await engine.play(request, 0);
  await settle();
  const loadsAfterTheFirstStart = record.loads.length;
  const playsAfterTheFirstStart = record.plays.length;

  const heard = await engine.retryPlayInPlace(0);
  await settle();

  assert.equal(heard, true, 'the retry answers whether the player actually produced sound');
  assert.equal(record.loads.length, loadsAfterTheFirstStart, 'the track is not fetched a second time — the item is already on the player');
  assert.equal(record.plays.length, playsAfterTheFirstStart + 1, 'the same item is simply asked to play once more, and nothing is unloaded to do it');
  assert.equal(engine.status().state, 'playing', 'and the track is playing as far as the app is concerned');
  await stopAll([engine]);
});

test('a start that failed is retried in place by the queue — no second cold load of the same track', async () => {
  /*
   * The queue's half of the same rule, with the engine stubbed: what is asserted is what the queue
   * *does* about a start that produced no sound — one retry through `retryPlayInPlace`, and no
   * second `play` with a new URL (which is what a cold reload of a track that may already be
   * sounding would look like).
   */
  const plays: string[] = [];
  const retries: string[] = [];
  let released: (() => void) | null = null;
  const engine = {
    onEnded: null,
    onProgress: null,
    onNextRequested: null,
    onPreviousRequested: null,
    onAdvancedNatively: null,
    play: (track: { url: string }) => {
      plays.push(track.url);
      return new Promise<void>((resolve) => {
        released = resolve;
      });
    },
    startDidFail: () => true,
    lastStartOutcome: () => 'timeout' as const,
    retryPlayInPlace: async () => {
      retries.push('retry');
      return true;
    },
    warmedUrl: () => null,
    pruneWarmed: () => undefined,
    prepareNext: async () => true,
    setQueue: () => undefined,
    discardPrepared: async () => undefined,
    adoptNativeAdvance: () => undefined,
    status: () => ({ state: 'idle' as const, positionMs: 0 }),
    seek: async () => undefined,
    resume: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    toggle: async () => undefined,
  };
  const queue = new PlaybackQueue(engine as never, stubLibrary());

  const started = queue.play(queueOf('song-1', 'song-2'), 0, CONTEXT);
  await tick();
  // The engine's `play` is held open by this test: TS loses the assignment inside the callback, so
  // the call is made through the declared type.
  (released as unknown as (() => void) | null)?.();
  await started;

  assert.deepEqual(plays, [urlOf('song-1')], 'the track was asked for once, as the original file, and never reloaded at another URL');
  assert.deepEqual(retries, ['retry'], 'and the failure was answered by asking the player that holds it, once');
  assert.equal(queue.didNotStart, false, 'a retry that produced sound is not a failure on screen');
});

/* ------------------------------------------------------------------ the two lanes (v1.9.9) */

test('a start does not wait for a warm job, however long that warm job takes', async () => {
  /*
   * The owner's mandatory rule: *"the audible path never shares a lane with warm work — a tap must
   * not wait on a background preroll or a warm write, ever."* v1.9.8 put both on one lane, and a
   * warm is network-bound (`prepare` waits for real bytes), so a tap could sit behind a whole fetch.
   *
   * Here the warm job is a 400 ms fetch and the start is a 20 ms job issued *while it is running*:
   * the start finishes first, by a wide margin.
   */
  const lanes = createAssetLanes(5);
  const order: string[] = [];
  const warm = lanes.warm(async () => {
    order.push('warm-started');
    await new Promise((resolve) => setTimeout(resolve, 400));
    order.push('warm-finished');
  });
  await tick();
  const startedAt = Date.now();
  await lanes.audible(async () => {
    order.push('start-began');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('start-finished');
  });
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(order, ['warm-started', 'start-began', 'start-finished'], 'the start ran while the warm was still fetching, not after it');
  assert.ok(elapsed < 200, `the start did not wait for the warm job (it took ${elapsed} ms of a 400 ms warm)`);
  await warm;
});

test('warm work yields while a start is in flight, and issues nothing when it cannot', async () => {
  /*
   * The two lanes are separate, but the bytes share one pipe: a fetch that runs while the listener
   * waits for the first seconds of a track he tapped is competing with the stream he is waiting for.
   * So a warm job asks first, and gives up (rather than running late) if the lane never goes quiet.
   */
  const lanes = createAssetLanes(5);
  let audibleDone = false;
  const start = lanes.audible(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    audibleDone = true;
  });
  await tick();
  assert.equal(lanes.busy, true, 'a start in flight is a lane that is busy');

  // A short yield budget: the start is still in flight, so the warm is told to issue nothing.
  const polite = await lanes.warm(() => lanes.yieldToAudible(30));
  assert.equal(polite, false, 'a warm that cannot get clear of the audible lane issues nothing at all');

  await start;
  assert.equal(audibleDone, true, 'and the start was never held up by it');
  assert.equal(lanes.busy, false, 'once the start is over the lane is quiet again');
  assert.equal(await lanes.warm(() => lanes.yieldToAudible(30)), true, 'so the next warm job is free to run');
});

/*
 * v1.9.18 — the *first* boundary after the app goes away, and who arms it.
 *
 * The owner's report, in his words: *"with the app backgrounded there is a slight delay before
 * auto-advance fires"*. The boundary itself is not in question — the native side owns it and takes
 * it off `AVPlayerItemDidPlayToEndTime` since v1.9.9. What was missing is the **arming**: this side
 * fetched the track *after* the one playing only from `commit()`, i.e. after a boundary it had
 * already taken, so the first track end after the handover had nothing loaded unless the app's own
 * warm pool still happened to hold it — and the app is suspended by then, so its pool is frozen
 * where it was. A boundary with no slot is a fetch, and a fetch is the pause he hears.
 *
 * The statement that says `awake: false` is the moment this side learns it will own that boundary,
 * so that is the moment it arms it. Asserted against the native source, because that is the only
 * place this behaviour lives and there is no device in the suite: the JS side cannot see it, and a
 * green JS test would say nothing about it.
 */
test('a handover arms the first boundary: the native side preloads ahead when it is given the queue', () => {
  const native = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App', 'App', 'NaviliteRemote.swift'), 'utf8');
  /* The whole method, to the next one — a fixed 6000-character window stopped reaching
   * `preloadAhead` once setQueue grew (beta.25). */
  const setQueueStart = native.indexOf('@objc func setQueue(');
  const setQueueEnd = native.indexOf('@objc func now(', setQueueStart);
  const setQueue = native.slice(setQueueStart, setQueueEnd === -1 ? setQueueStart + 9000 : setQueueEnd);
  assert.ok(setQueue.includes('self.installEndObserver()'), 'the handover no longer installs the end observer');
  assert.match(
    setQueue,
    /if !self\.awake \{[\s\S]*?self\.preloadAhead\(token: self\.generation\)/,
    'the handover does not arm the next entry — the first boundary after the app goes away would be a fetch again',
  );
  assert.ok(
    setQueue.indexOf('preloadAhead') > setQueue.indexOf('self.installEndObserver()'),
    'the arming happens before the observer is installed, so it may run against a queue this side has not adopted',
  );

  /*
   * And a slot name is not a warm slot (v2.0-beta.16). The old arming returned the moment *anything*
   * held the entry, so an entry whose prime never pulled a buffer was left in place while the card
   * counted the seam as warm — the ten seconds the owner hears. The arming now re-loads that entry,
   * but only under three conditions, and each is asserted here: it is a slot of this side's own (not
   * one the app handed over), the look-ahead's own record says the prime failed or stopped short of
   * `primeBuffer`, and the audible track has more than 20 s left so the reload cannot be heard.
   */
  const preloadAhead = native.slice(native.indexOf('private func preloadAhead('), native.indexOf('private func primeAhead('));
  assert.match(preloadAhead, /guard !awake, index >= 0, index < queue\.count else \{ return \}/, 'preloadAhead no longer checks that it is the off-screen owner');
  assert.ok(!/if holding\(entry\.songId\) != nil \{ return \}/.test(preloadAhead), 'preloadAhead returned on a slot name alone again — a slot with no audio would pass as warm');
  assert.match(preloadAhead, /guard Self\.windowSlots\.contains\(holding\) else \{ return \}/, 'the reload may take over a slot that is not this side\'s own window');
  assert.match(
    preloadAhead,
    /guard let state = ahead, state\.songId == entry\.songId,\s*\n\s*state\.gaveUp != nil \|\| state\.buffered < Self\.primeBuffer else \{ return \}/,
    'the reload is not conditional on the look-ahead\'s own record saying the prime failed or stopped short of a startable buffer',
  );
  assert.match(
    preloadAhead,
    /guard Self\.remainingSeconds\(from: audible\?\.assetId, bridge: bridge\) > 20 else \{ return \}/,
    'the reload is not guarded by time left on the audible track — it could be heard',
  );
  // Into the same slot, and primed again: a reload that allocated a second slot would leave two
  // connections open on the same entry and the audible stream sharing the pipe with both.
  assert.match(
    preloadAhead,
    /guard preloadSlot\(plugin: plugin, slot: holding, entry: entry, preroll: true\) else \{ return \}\s*\n\s*fetchWindow = \(holding, entry\.songId\)/,
    'the reload does not go back into the slot that already held the entry',
  );
  assert.match(preloadAhead, /primeAhead\(slot: holding, songId: entry\.songId, token: token\)/, 'the reloaded slot is never primed, so it would sit at `.readyToPlay` with no audio again');
});

/**
 * v2.0-beta.16 — the one sentence the card-tap investigation is read from.
 *
 * A tap on the Now Playing card is routed to the bundle id the media remote holds, so the row has to
 * carry that id, the signed id the install actually has (a rewritten one shows up here and nowhere
 * else), and the scene callbacks that say whether the system ever asked the app to come to the
 * front. All three are asserted as text, because the row is the only surface the owner can read.
 */
test('identitySentence names the bundle id, the signature and the scene counts (v2.0-beta.16)', () => {
  assert.equal(
    identitySentence(null, null),
    'identity: this build reports none',
    'a plugin that reports neither leaves the row saying so rather than inventing a reading',
  );
  const row = identitySentence(
    {
      bundleId: 'app.navilite',
      appId: 'K3STERTEAM.app.navilite',
      teamId: 'K3STERTEAM',
      appGroups: 'none',
      container: 'installed package',
      signatureMatchesBundleId: true,
    },
    { connects: 1, opens: 1, activations: 2, resignations: 0, last: 'openurl', lastUrl: 'navilite://now' },
  );
  assert.match(row, /^id app\.navilite \(team K3STERTEAM, installed package, signed id matches\)/);
  assert.match(row, /scene 1 connect \/ 1 open-url \/ 2 active, last openurl navilite:\/\/now$/);

  // The signature is what a sideloader that rewrote the id changes: reported as a difference, not
  // smoothed over, because an id that does not resolve to an installed app is the failure no
  // setting in this plugin can reach.
  assert.match(
    identitySentence({ bundleId: 'app.navilite', appId: 'ABCDE12345.com.altstore.app.navilite', signatureMatchesBundleId: false }, null),
    /signed id DIFFERS/,
  );
  // Nothing arrived: distinct from "arrived and did nothing", which is the whole point of the row.
  assert.match(
    identitySentence({ bundleId: 'app.navilite' }, { connects: 1, opens: 0, activations: 1, last: 'none' }),
    /1 connect \/ 0 open-url \/ 1 active, never asked/,
  );
});

test('toAbsoluteArtworkUrl converts relative cover art URLs to absolute URLs', () => {
  assert.equal(toAbsoluteArtworkUrl(null), undefined);
  assert.equal(toAbsoluteArtworkUrl(undefined), undefined);
  assert.equal(toAbsoluteArtworkUrl('https://example.com/cover.jpg'), 'https://example.com/cover.jpg');
  assert.equal(toAbsoluteArtworkUrl('file:///var/mobile/art.jpg'), 'file:///var/mobile/art.jpg');
  assert.equal(
    toAbsoluteArtworkUrl('/rest/getCoverArt.view?id=123', 'http://127.0.0.1:4599/rest/stream?id=123'),
    'http://127.0.0.1:4599/rest/getCoverArt.view?id=123',
  );
});
