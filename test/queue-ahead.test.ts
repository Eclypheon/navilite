/**
 * v1.9.0 — the tap, and the track after it.
 *
 * Three things are asserted here, and they are the three the owner's report is about:
 *
 *   1. **The tap paints before any network work.** `select()` is the synchronous half of a tap —
 *      the row highlight, the title, the artist, the artwork and the loading state — and it must
 *      reach the screen with the engine having been asked for *nothing*. The engine's `play` in
 *      this file does not resolve until the test lets it, so "before the request resolves" is not
 *      a race that happens to be won: it is the state of the world the assertions run in.
 *   2. **The next track's bytes are requested before the current one ends.** Nothing in this file
 *      ever ends a track; the prefetch has to have happened anyway, because on the link the owner
 *      has (a phone on mobile data, reaching the house through a relay) a track change that starts
 *      with a cold fetch is a track change that stalls.
 *   3. **A rapid change leaves exactly one fetch in flight, for the item he chose.** Two taps in
 *      quick succession must not leave the abandoned track's stream downloading in the background,
 *      must not re-order the queue, and must not change what is playing.
 *
 * No DOM, no network, no Chrome: the engine and the library are stubs of the surface the queue
 * actually touches, so this runs in milliseconds and cannot be flaky.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue } from '../src/state/queue.ts';
import type { AudioEngine, TrackRequest } from '../src/player/engine.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };
const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 2 });
const queueOf = (...ids: string[]) => ids.map((id) => ({ song: song(id), context: CONTEXT }));
const urlOf = (id: string): string => `http://127.0.0.1:4599/rest/stream?id=${id}`;

/**
 * The URL these tests expect: the same stream, asked for at the rate the app starts at.
 *
 * Since v1.9.0 *every* stream request carries a bitrate, and an unmeasured link starts modest
 * (`STARTING_KBPS`); a link the app has measured as fast drops the parameter and gets the original.
 * So the URL is part of the change under test, not noise in it.
 */
const cappedUrlOf = (id: string): string => `${urlOf(id)}&maxBitRate=128`;

interface Prefetch {
  url: string;
  signal: AbortSignal;
  /** Resolved by the test, so "in flight" is a state this file controls. */
  finish: (bytes?: number, ms?: number) => void;
}

/**
 * The engine, reduced to what the queue uses. `play` returns a promise the test holds, which is
 * how a slow link is represented without a network: nothing resolves until the test says so.
 */
function stubEngine(): {
  engine: AudioEngine;
  plays: TrackRequest[];
  /** Every URL the queue asked the engine to get ready while this one plays (v1.9.1). */
  prepares: TrackRequest[];
  /** How many times the queue threw the prepared track away. */
  discards: number;
  releasePlay: () => void;
} {
  const plays: TrackRequest[] = [];
  const prepares: TrackRequest[] = [];
  let discards = 0;
  let engineState: 'idle' | 'playing' = 'idle';
  let release: (() => void) | null = null;
  const engine = {
    onEnded: null as null | (() => void),
    onProgress: null as null | ((positionMs: number, durationMs: number) => void),
    onNextRequested: null as null | (() => void),
    onPreviousRequested: null as null | (() => void),
    status: () => ({
      state: engineState,
      backend: 'web',
      spectrum: false,
      modeReason: '',
      positionMs: 0,
      durationMs: 0,
      error: null,
      nativeAvailable: false,
    }),
    play: (track: TrackRequest) => {
      plays.push(track);
      return new Promise<void>((resolve) => {
        release = () => {
          engineState = 'playing';
          resolve();
        };
      });
    },
    prepareNext: async (track: TrackRequest) => {
      prepares.push(track);
    },
    discardPrepared: async () => {
      discards += 1;
    },
    pause: async () => {},
    seek: async () => {},
    resume: async () => {},
    stop: async () => {},
    toggle: async () => {},
  };
  return {
    engine: engine as unknown as AudioEngine,
    plays,
    prepares,
    get discards() {
      return discards;
    },
    releasePlay: () => release?.(),
  };
}

/** The library, reduced to what the queue uses — with a stub prefetch that the test can settle. */
function stubLibrary(): { library: Library; prefetches: Prefetch[] } {
  const prefetches: Prefetch[] = [];
  const library = {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (track: Song, maxBitRate?: number | null) =>
      maxBitRate == null ? urlOf(track.id) : `${urlOf(track.id)}&maxBitRate=${maxBitRate}`,
    prefetch: (url: string, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        prefetches.push({ url, signal, finish: () => resolve() });
      }),
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined },
  };
  return { library: library as unknown as Library, prefetches };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('a tap paints the selection and the loading state before anything is requested', async () => {
  const { engine, plays, releasePlay } = stubEngine();
  const { library, prefetches } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);
  let paints = 0;
  queue.onChanged = () => {
    paints += 1;
  };

  // The tap, and only the tap: `select` is the synchronous half.
  queue.select(queueOf('song-1', 'song-2'), 0, CONTEXT);

  assert.equal(queue.currentSong?.id, 'song-1', 'the row he touched is the song on screen');
  assert.equal(queue.isLoading, true, 'and it is drawn in its loading state');
  assert.ok(paints > 0, 'the screen was redrawn by the tap itself');
  assert.equal(plays.length, 0, 'and nothing had been asked of the engine yet — no fetch, no I/O');
  assert.equal(prefetches.length, 0, 'nothing is being pulled for a track that is not even playing');

  void queue.start();
  await tick();
  assert.equal(plays.length, 1, 'the request for the stream follows the paint, not the other way round');
  assert.equal(plays[0]!.url, cappedUrlOf('song-1'), 'and it is the stream of the track he tapped');
  assert.equal(queue.isLoading, true, 'still loading while the engine has not answered');

  releasePlay();
  await tick();
  await tick();
  assert.equal(queue.isLoading, false, 'the loading state comes off when the engine has the stream');
  assert.equal(queue.measuredKbps, null, 'nothing has been measured yet — the app does not invent a number');
});

test('the next track is requested before the current one ends', async () => {
  const { engine, releasePlay, prepares } = stubEngine();
  const { library, prefetches } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await tick();
  releasePlay();
  await tick();
  await tick();

  // No track has ended, and the one after the current one is already being pulled.
  assert.equal(prefetches.length, 1, 'the track after the one playing was requested while it plays');
  assert.equal(prefetches[0]!.url, cappedUrlOf('song-2'), 'and it is the next track in this queue, not another');
  assert.equal(prefetches[0]!.signal.aborted, false, 'it is still in flight — the current track is still playing');
  assert.equal(queue.currentSong?.id, 'song-1', 'and none of this changed what is playing');
  /*
   * v1.9.1 — and the same track is prepared **on the player**, not only measured: the engine holds
   * the next track buffered and silent, which is what makes the track boundary instant. The bytes
   * v1.9.0 fetched in the WebView were never the player's, whatever the release said.
   */
  assert.equal(prepares.length, 1, 'the next track was handed to the engine to get ready');
  assert.equal(prepares[0]!.url, cappedUrlOf('song-2'), 'under the URL it will be played with, bound now');
  assert.equal(prepares[0]!.title, 'Track song-2', 'with the metadata the lock-screen card will need');
});

test('ten taps in a row each paint the row he touched, and the waiting state never clears itself', async () => {
  const { engine, releasePlay } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const items = queueOf(...ids);
  const painted: string[] = [];
  let paints = 0;
  queue.onChanged = () => {
    paints += 1;
  };

  for (let i = 0; i < ids.length; i += 1) {
    /*
     * The tap: `select` is synchronous and this read happens in the same turn — no await between
     * them, so what is read is what the screen was given.
     */
    queue.select(items, i, CONTEXT);
    painted.push(queue.currentSong?.id ?? 'nothing');
    assert.equal(queue.isLoading, true, `tap ${i + 1}: the row is drawn as waiting`);
    void queue.start();
    releasePlay();
    await tick();
    await tick();
    assert.equal(queue.isLoading, false, `tap ${i + 1}: and it settles when the engine answers`);
  }

  assert.deepEqual(painted, ids, `${ids.length} consecutive taps, ${painted.length} painted selections`);
  assert.ok(paints >= ids.length * 2, `every tap repainted the screen — ${paints} repaints for ${ids.length} taps`);
});

test('a second tap on the row whose load is still in flight is not a missed tap', async () => {
  const { engine, releasePlay, plays, prepares } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);
  const items = queueOf('song-1', 'song-2');

  queue.select(items, 0, CONTEXT);
  void queue.start();
  await tick();
  assert.equal(plays.length, 1, 'the first tap asked the engine for the stream');

  // …and he taps the same row again, while that load has not answered.
  queue.select(items, 0, CONTEXT);
  void queue.start();
  await tick();
  assert.equal(plays.length, 1, 'the second tap is the same request, not a second one');
  assert.equal(queue.isLoading, true, 'and the row stays drawn as waiting rather than settling on the instant');

  releasePlay();
  await tick();
  await tick();
  assert.equal(queue.isLoading, false, 'the state comes off when the load it was waiting for answers');
  assert.equal(queue.currentSong?.id, 'song-1', 'and what is playing is the row he touched');
  assert.equal(prepares.length, 1, 'the look-ahead ran once, for the track that follows it');
});

test('a rapid double tap leaves one fetch in flight, for the track after the one he chose', async () => {
  const { engine, releasePlay } = stubEngine();
  const { library, prefetches } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);

  // He taps track 1: its stream starts and track 2 begins buffering.
  queue.select(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  void queue.start();
  await tick();
  releasePlay();
  await tick();
  await tick();
  assert.equal(prefetches.length, 1);

  // …and immediately taps track 2, before anything resolved.
  queue.select(queueOf('song-1', 'song-2', 'song-3'), 1, CONTEXT);
  void queue.start();
  await tick();
  releasePlay();
  await tick();
  await tick();

  const active = prefetches.filter((call) => !call.signal.aborted);
  assert.equal(prefetches.length, 2, 'the second tap asked for something, and only one thing');
  assert.equal(prefetches[0]!.signal.aborted, true, 'the abandoned prefetch was cancelled');
  assert.equal(active.length, 1, 'exactly one fetch is in flight');
  assert.equal(active[0]!.url, cappedUrlOf('song-3'), 'and it is the track after the one he chose');
  assert.equal(queue.currentSong?.id, 'song-2', 'what is playing is what he chose — the prefetch moved nothing');
  assert.equal(queue.position, 1, 'and the queue is in the order he left it in');
});
