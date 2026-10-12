/**
 * v1.9.9 — what the previous button means, at last in code.
 *
 * The rule has been written in a comment next to this method since v1.1, and the code never did it:
 * `if (position > 3000) { await seek(0); if (position <= 3000) return; }` — the second test sits
 * inside a branch the first test has already answered, so it is dead, and pressing previous after
 * three seconds **seeked to zero and then played the previous track anyway**. "Restart this one"
 * never happened on this button (that is finding 5 of the 1.9.9 design note).
 *
 * Three cases, all of them asserted here through the real `PlaybackQueue` and a stub engine:
 *   - more than three seconds in → restart this one, go nowhere else;
 *   - within the first three seconds → the previous entry, at 0:00;
 *   - at the first entry of the queue → restart it (no wrap).
 *
 * And the boundary is told where the listener is after every move: the queue the native side walks
 * has an index in it, and a step back that does not move that index is a boundary that would play
 * the wrong track.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackQueue } from '../src/state/queue.ts';
import type { AudioEngine, PublishedTrack, TrackRequest } from '../src/player/engine.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };
const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 180 });
const queueOf = (...ids: string[]) => ids.map((id) => ({ song: song(id), context: CONTEXT }));
const urlOf = (id: string): string => `http://127.0.0.1:4599/rest/stream?id=${id}`;

interface Stub {
  engine: AudioEngine;
  /** The URL of every track the queue asked the engine to start, in order. */
  plays: string[];
  /** Every seek the queue asked for, in ms. */
  seeks: number[];
  /** Every queue the engine was told about, latest last. */
  published: Array<{ songs: string[]; index: number }>;
  /** Where the player says it is, in ms — the fact the whole rule turns on. */
  setPosition(ms: number): void;
}

function stubEngine(): Stub {
  const plays: string[] = [];
  const seeks: number[] = [];
  const published: Array<{ songs: string[]; index: number }> = [];
  let positionMs = 0;
  const engine = {
    onEnded: null as null | (() => void),
    onProgress: null as null | ((positionMs: number, durationMs: number) => void),
    onNextRequested: null as null | (() => void),
    onPreviousRequested: null as null | (() => void),
    onAdvancedNatively: null,
    status: () => ({ state: 'playing' as const, positionMs }),
    play: (track: TrackRequest) => {
      plays.push(track.url);
      return Promise.resolve();
    },
    prepareNext: async () => true,
    warmedUrl: () => null,
    pruneWarmed: () => undefined,
    discardPrepared: async () => undefined,
    seek: async (ms: number) => {
      seeks.push(ms);
    },
    resume: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    toggle: async () => undefined,
    setQueue: (statement: { list: readonly PublishedTrack[]; index: number }) => {
      published.push({ songs: statement.list.map((entry) => entry.songId), index: statement.index });
    },
  };
  return {
    engine: engine as unknown as AudioEngine,
    plays,
    seeks,
    published,
    setPosition: (ms: number) => {
      positionMs = ms;
    },
  };
}

function stubLibrary(): Library {
  return {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (track: Song) => urlOf(track.id),
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined },
  } as unknown as Library;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('past three seconds, previous restarts this track and goes nowhere else', async () => {
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());
  await queue.play(queueOf('song-1', 'song-2', 'song-3'), 1, CONTEXT);
  const started = stub.plays.length;
  stub.setPosition(5000);

  await queue.previous();

  assert.deepEqual(stub.seeks, [0], 'the track was seeked back to its own beginning');
  assert.equal(queue.currentSong?.id, 'song-2', 'and it is still the track that is playing — v1.9.8 played the previous one anyway');
  assert.equal(queue.position, 1, 'the queue did not move');
  assert.equal(stub.plays.length, started, 'and nothing was started: a restart is a seek, not a new track');
  assert.equal(stub.published[stub.published.length - 1]?.index, 1, 'the boundary is told the same index it already had');
});

test('within the first three seconds, previous is the previous entry — at 0:00', async () => {
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());
  await queue.play(queueOf('song-1', 'song-2', 'song-3'), 1, CONTEXT);
  const started = stub.plays.length;
  stub.setPosition(1200);

  await queue.previous();
  await tick();

  assert.deepEqual(stub.seeks, [], 'nothing was seeked: this is a track change');
  assert.equal(queue.currentSong?.id, 'song-1', 'the track before the one playing is the one playing');
  assert.equal(queue.position, 0, 'and the cursor moved with it');
  assert.equal(stub.plays.length, started + 1, 'the previous track was started');
  assert.deepEqual(stub.plays[stub.plays.length - 1], urlOf('song-1'), 'as the original file — a start never asks for a transcode');
  assert.equal(stub.published[stub.published.length - 1]?.index, 0, 'and the boundary is told where the listener now is');
});

test('at the first entry of the queue, previous restarts it rather than wrapping', async () => {
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());
  await queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  const started = stub.plays.length;
  stub.setPosition(1000);

  await queue.previous();

  assert.deepEqual(stub.seeks, [0], 'the first track was restarted');
  assert.equal(queue.currentSong?.id, 'song-1', 'and the queue did not wrap round to the last track');
  assert.equal(queue.position, 0, 'the cursor is where it was');
  assert.equal(stub.plays.length, started, 'nothing was started');
});
