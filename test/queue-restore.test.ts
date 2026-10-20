/**
 * v1.9.19 — the launch restore only adopts onto a launch the owner has not touched.
 *
 * Since v1.9.18 the server's saved queue (`getPlayQueue`) is fetched *after* the first paint, so on a
 * slow server it can land up to the request timeout (20 s) into a session that is already in use.
 * `restore()` overwrote items, order, cursor, context and `pendingStartMs` and republished all of it
 * with no check at all, so the owner could tap a downloaded track — which needs no server, which is
 * the whole point of the offline work — and watch the player bar, the now-playing screen and the row
 * highlight jump to another track while the audio kept playing his choice, with the native side
 * handed the stale queue.
 *
 * The rule is now the queue's own: a launch convenience is adopted only when nothing has been chosen
 * (`currentSong === null`). Both directions are asserted here, because the failure mode of the guard
 * is a restore that never happens at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackQueue } from '../src/state/queue.ts';
import type { AudioEngine } from '../src/player/engine.ts';
import type { PublishedTrack, TrackRequest } from '../src/player/engine-contract.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };
const LAST_SESSION: QueueContext = { kind: 'song', name: 'your last session' };
const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 180 });
const itemsOf = (...ids: string[]) => ids.map((id) => ({ song: song(id), context: CONTEXT }));

interface Stub {
  engine: AudioEngine;
  /** Every queue the engine was told about, latest last. */
  published: Array<{ songs: string[]; index: number }>;
}

function stubEngine(): Stub {
  const published: Array<{ songs: string[]; index: number }> = [];
  const engine = {
    onEnded: null,
    onProgress: null,
    onNextRequested: null,
    onPreviousRequested: null,
    onAdvancedNatively: null,
    status: () => ({ state: 'playing' as const, positionMs: 0 }),
    play: (_track: TrackRequest) => Promise.resolve(),
    seek: async () => undefined,
    resume: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    toggle: async () => undefined,
    setQueue: (statement: { list: readonly PublishedTrack[]; index: number }) => {
      published.push({ songs: statement.list.map((entry) => entry.songId), index: statement.index });
    },
  };
  return { engine: engine as unknown as AudioEngine, published };
}

function stubLibrary(): Library {
  return {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (track: Song) => `http://127.0.0.1:4599/rest/stream?id=${track.id}`,
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined },
  } as unknown as Library;
}

test('a launch nobody has touched adopts the server’s saved queue', () => {
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());

  const adopted = queue.restore(itemsOf('past-1', 'past-2', 'past-3'), 1, 30_000, LAST_SESSION);

  assert.equal(adopted, true, 'an untouched launch takes the queue the server saved');
  assert.equal(queue.currentSong?.id, 'past-2', 'at the track the server said was current');
  assert.equal(queue.position, 1, 'and the cursor with it');
  assert.equal(queue.queueContext?.name, 'your last session', 'in the context the restore came with');
  assert.deepEqual(stub.published[stub.published.length - 1], { songs: ['past-1', 'past-2', 'past-3'], index: 1 });
});

test('a queue the owner has started is never replaced by the server’s', async () => {
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());
  // The owner taps a downloaded track in the launch window — no server involved, so it plays.
  await queue.play(itemsOf('local-1', 'local-2'), 0, CONTEXT);
  const publishedBefore = stub.published.length;

  const adopted = queue.restore(itemsOf('past-1', 'past-2', 'past-3'), 1, 30_000, LAST_SESSION);

  assert.equal(adopted, false, 'the restore declines rather than adopting');
  assert.equal(queue.currentSong?.id, 'local-1', 'the track that is playing is still the one he chose');
  assert.deepEqual(
    queue.resumeState().songs.map((entry) => entry.id),
    ['local-1', 'local-2'],
    'his queue is intact — not the server’s three songs',
  );
  assert.equal(queue.queueContext?.name, 'a playlist', 'and so is the context the now screen shows');
  assert.equal(stub.published.length, publishedBefore, 'and the native side was not republished a stale queue');
});

test('the guard is the current entry, not playback — a second restore is refused either way', () => {
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());
  // A queue put back and never started (the snapshot path). Nothing is playing, but the queue is in
  // use, so a later restore does not get to replace it: the guard is `currentSong !== null`, which is
  // "an entry has been chosen" rather than "audio is running". Nothing at launch issues two restores
  // — the deferred server fetch is only taken when there was no snapshot to restore from — so this is
  // the boundary stated rather than a path the app walks.
  queue.restore(itemsOf('snapshot-1'), 0, 0, LAST_SESSION);

  assert.equal(queue.restore(itemsOf('past-1', 'past-2'), 1, 0, LAST_SESSION), false, 'the second adopt is refused');
  assert.equal(queue.currentSong?.id, 'snapshot-1', 'and the queue that was there is untouched');

  // From empty — the fresh-install launch this exists for — it is allowed.
  const fresh = new PlaybackQueue(stubEngine().engine, stubLibrary());
  assert.equal(fresh.restore(itemsOf('past-1'), 0, 0, LAST_SESSION), true, 'an empty queue adopts');
  assert.equal(fresh.currentSong?.id, 'past-1');
});
