/**
 * v1.9.8 — the boundary, the warm slot, and the start path.
 *
 * Three claims, each of which is the owner's complaint in his own words, and none of which can be
 * proved by reading a phone:
 *
 *   1. **A track that ends with the app away advances.** Off screen there is no web layer at all —
 *      the plugin's completion goes to a suspended view and `watchForPinnedEnd` is driven by a clock
 *      tick that has been stopped — so the native player is given the next slot and plays it itself
 *      (`armBoundary`, and the `advanced` event it answers with). Asserted here as: the boundary the
 *      app states names **exactly the warm tracks ahead of it, in the order they would be played**,
 *      it names them to the native side only while the app is away, and the track it moves to is
 *      **adopted** — nothing is loaded, nothing is played, and no track is skipped.
 *   2. **A warm next slot is real.** `prepare` resolves only after the slot has been asked for the
 *      media data required to start, and the bridge answers `false` — the engine drops its claim —
 *      when the slot holds nothing. So "warm" cannot be a claim about a player that was merely
 *      created.
 *   3. **The start path never asks for a transcode, and a failed start is retried in place.** The
 *      URL a play is given carries no `maxBitRate`, and the retry after a start that produced no
 *      sound asks the player that already holds the track rather than unloading it.
 *
 * The real `AudioEngine` and the real `PlaybackQueue` are driven here, against a fake bridge and a
 * fake library: no DOM, no network, no phone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine, type EngineOptions } from '../src/player/engine.ts';
import type { NativeBridge, NativeBridgeEvents, NativeTrackInfo } from '../src/player/native.ts';
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

interface Boundary {
  /** What the app has stated to the native side, latest first. */
  stated: Array<{ next: readonly string[]; previous: string | null; awake: boolean }>;
  /** The slots the bridge turned those tracks into — the chain the native side would play. */
  chain: string[];
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
 * The bridge, reduced to what the engine and the queue touch — with the two statements under test
 * (the boundary and the warm proof) recorded rather than simulated.
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
        record.plays.push(`play@0`);
        await wait();
        setTimeout(() => events.onPosition(0), 5);
        return true;
      },
      async discard() {
        slots.clear();
      },
      async armBoundary(boundary: { next: readonly string[]; previous: string | null; awake: boolean }) {
        record.stated.push({ next: [...boundary.next], previous: boundary.previous, awake: boundary.awake });
        record.chain = boundary.next.map((songId) => slots.get(songId) ?? `missing:${songId}`);
        return true;
      },
      async reconcile() {
        return { changed: false, songId: null };
      },
      nativeAdvance() {
        return { armed: record.chain.length, advances: record.advanced.length, failures: 0, ignored: 0, reason: 'test' };
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
  return { stated: [], chain: [], advanced: [], warmed: [], loads: [], plays: [], retries: 0, events: null, warmHoldsBytes: true };
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

/**
 * Every engine is stopped before its test ends: the clock ticker and the spectrum poll are
 * `setInterval`s, and a test process that holds one open never exits.
 */
async function stopAll(engines: AudioEngine[]): Promise<void> {
  for (const engine of engines) await engine.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const engine of engines) await engine.stop();
}

test('the boundary names the warm tracks ahead, in order, and only while the app is away', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  // Off screen — the state the native side is given the boundary in.
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();

  /*
   * The tracks ahead of the one playing are what a track that ends advances to, and the order is
   * the play order: song-2 is next, song-3 is the one after it. A boundary that named only one of
   * them, or named them the other way round, would play the wrong track — and a boundary that named
   * the *previous* track (which is also warm, and is warmed second) would play it twice.
   */
  const last = record.stated[record.stated.length - 1];
  assert.deepEqual(last?.next, ['song-2', 'song-3'], 'the native side is given the two tracks ahead of this one, in the order they would be played');
  assert.deepEqual(record.chain, ['navilite-slot-1', 'navilite-slot-2'], 'and each is a slot the app actually warmed, in that order');
  assert.equal(last?.awake, false, 'stated as "the app is away", which is the only state in which the native side may act');

  // Coming back in: the same picture, stated with the web layer awake, so the native side stands down.
  await engine.handleVisibility(false);
  const back = record.stated[record.stated.length - 1];
  assert.equal(back?.awake, true, 'with the app on screen the web layer takes the boundary back, and the native side is told so');
  assert.deepEqual(back?.next, ['song-2', 'song-3'], 'the chain itself is unchanged — only who acts on it');
  assert.equal(engine.status().nativeBoundary.advances, 0, 'and nothing has been advanced by it');
  await stopAll([engine]);
});

test('a track the native player started by itself is adopted — nothing is loaded, nothing is replayed', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();
  const loadsBefore = record.loads.length;
  const playsBefore = record.plays.length;

  /*
   * The native player took the boundary: it played the slot holding song-2 while the web view was
   * frozen, and this is the message the app receives when it wakes (or immediately, if it was still
   * alive to receive it).
   */
  record.events?.onAdvanced?.('song-2');
  await settle();

  assert.equal(queue.currentSong?.id, 'song-2', 'the queue moves onto the track that is sounding');
  assert.equal(queue.position, 1, 'and its cursor moves with it, in the order the listener left');
  assert.equal(record.loads.length, loadsBefore, 'nothing was loaded: the track is already on the player and already playing');
  assert.equal(record.plays.length, playsBefore, 'and nothing was played again — adopting a boundary is not starting a track');
  assert.equal(engine.status().state, 'playing', 'the machine agrees that sound exists');
  assert.equal(engine.currentTrack?.id, 'song-2', 'the engine is following the track that replaced the one it had');

  /*
   * And the same message arriving twice — which it does, because the app learns about an advance both
   * from the event and from asking the player on the way back — changes nothing but the look-ahead.
   */
  record.events?.onAdvanced?.('song-2');
  await settle();
  assert.equal(queue.currentSong?.id, 'song-2', 'a second report of the same advance is idempotent');
  assert.equal(record.loads.length, loadsBefore, 'and still loads nothing');
  assert.equal(queue.position, 1, 'the cursor does not run on');
  await stopAll([engine]);
});

test('a boundary the native side refuses comes back to the app, and the track still moves on', async () => {
  const record = blank();
  const { engine, queue } = pair(record);
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();
  assert.equal(record.stated[record.stated.length - 1]?.awake, false, 'the app is away and the native side holds the boundary');

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

test('a warm slot that holds no media is not warm, and the app is told so instead of pretending', async () => {
  const record = blank();
  record.warmHoldsBytes = false;
  const { engine, queue } = pair(record);
  await engine.handleVisibility(true);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await settle();

  assert.ok(record.warmed.length > 0, 'the app asked the player for the media a warm slot needs');
  assert.deepEqual(engine.status().warmedIds, [], 'a slot that answered "no media" is not claimed as warm by the engine');
  assert.deepEqual(record.stated[record.stated.length - 1]?.next, [], 'and the native boundary is not armed with a slot that cannot start');
  assert.equal(engine.status().nativeBoundary.armed, 0, 'so nothing is armed, and the app says so rather than promising an instant boundary');
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
    setNeighbours: () => undefined,
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
