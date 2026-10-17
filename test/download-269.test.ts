/**
 * The 269-track playlist (owner, v2.0.0-beta.4): "the download for the jap track list always stops
 * at 254 tracks then i have to click retry for it to finish downloading the rest. and for both
 * playlists, after they finished downloading it seems i need another tap to download the covers."
 *
 * The job's song list is handed to the bridge one transfer at a time, `await`ed. Nothing bounds that
 * call, and nothing catches it: a bridge call that rejects (or that simply never settles) ends the
 * enumeration where it stood, so the tracks past it are never queued, their lyrics are never queued,
 * and — the second half of the report — the covers of the albums past that point are never asked for
 * at all. A retry then works because the tracks that did land are `complete` and cost no bridge call,
 * which is exactly the owner's "click retry and it finishes".
 *
 * `Jap` is 269 tracks. 254 of them got queued before the enumeration died, so the last album's cover
 * (`al22`) was never enqueued — the untapped cover the owner saw.
 *
 * No phone, no network: the bridge is a fake, and every transfer's completion is emitted by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OfflineStore } from '../src/state/offline.ts';
import type { DownloadEvent, DownloadJob, DownloadsBridge, IndexRow } from '../src/state/offline.ts';
import type { Song } from '../src/api/types.ts';

const TRACKS = 269;
const PER_ALBUM = 12;

/** The owner's playlist, in shape: 269 tracks, 12 to an album, so 23 covers. */
const songs: Song[] = Array.from({ length: TRACKS }, (_, index) => ({
  id: `s${index}`,
  title: `Track ${index}`,
  artist: 'Someone',
  album: `Album ${Math.floor(index / PER_ALBUM)}`,
  duration: 227,
  size: 5_000_000,
  suffix: 'opus',
  coverArt: `al${Math.floor(index / PER_ALBUM)}`,
}));
const COVERS = new Set(songs.map((song) => song.coverArt)).size;

interface MemoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStore(): MemoryStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const kindOf = (job: DownloadJob): 'audio' | 'lyrics' | 'art' =>
  job.suffix === 'lyrics' ? 'lyrics' : job.suffix === 'art' ? 'art' : 'audio';

interface FakeBridge extends DownloadsBridge {
  enqueued: DownloadJob[];
  attempts: Map<string, number>;
  emit(name: 'progress' | 'done' | 'failed', event: DownloadEvent): void;
}

/**
 * `fail`: a key whose transfer the bridge refuses, `times` times (then accepts) — the native call
 * rejecting. `stall`: a key whose call never answers, `times` times — the Capacitor handler that
 * drops the message. Both are one line in the native plugin away from the real thing.
 */
function fakeBridge(options: { fail?: string; failTimes?: number; stall?: string; stallTimes?: number } = {}): FakeBridge {
  const listeners = new Map<string, (event: DownloadEvent) => void>();
  const enqueued: DownloadJob[] = [];
  const attempts = new Map<string, number>();
  let failed = 0;
  let stalled = 0;
  return {
    configure: async () => undefined,
    enqueue: async (job) => {
      const kind = kindOf(job);
      const key = `${kind}:${job.songId}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if (key === options.fail && failed < (options.failTimes ?? Number.POSITIVE_INFINITY)) {
        failed += 1;
        throw new Error(`native refused ${key}`);
      }
      if (key === options.stall && stalled < (options.stallTimes ?? Number.POSITIVE_INFINITY)) {
        stalled += 1;
        await new Promise<never>(() => undefined); // never settles, like a dropped bridge message
      }
      enqueued.push(job);
    },
    cancel: async () => undefined,
    remove: async () => undefined,
    list: async (): Promise<IndexRow[]> => [],
    freeBytes: async () => -1,
    readLyrics: async () => null,
    writeLyrics: async () => undefined,
    addListener: async (name, listener) => {
      listeners.set(name, listener);
      return () => undefined;
    },
    enqueued,
    attempts,
    emit(name, event) {
      listeners.get(name)?.(event);
    },
  };
}

const audioJobs = (bridge: FakeBridge): DownloadJob[] => bridge.enqueued.filter((job) => kindOf(job) === 'audio');
const artJobs = (bridge: FakeBridge): DownloadJob[] => bridge.enqueued.filter((job) => kindOf(job) === 'art');

function store(bridge: FakeBridge, enqueueTimeoutMs?: number): OfflineStore {
  return new OfflineStore(bridge, {
    store: memoryStore(),
    artUrl: (cover) => `rest/getCoverArt?id=${cover}`,
    enqueueTimeoutMs,
  });
}

test('the shipped bug cannot come back: the bridge is reached through one bounded call, never a bare await', () => {
  /*
   * The cold reading, kept as a source rule because the defect's evidence is arithmetic, not a
   * branch: with one bare `await this.bridge.enqueue(...)` per track, a fake bridge that refuses
   * track 255's call left `enqueued` at exactly **254** audio jobs, 22 of the 23 covers, and the
   * record on `downloading` — the owner's "stops at 254, then retry finishes it". Every transfer now
   * goes through `safeEnqueue`, which is bounded, retried, and cannot throw out of the loop.
   */
  const source = readFileSync(new URL('../src/state/offline.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /await this\.bridge\.enqueue\(/, 'a bare awaited enqueue is the bug');
  assert.match(source, /private async safeEnqueue\(job: DownloadJob, giveUp: \(\) => void\)/, 'the one door is bounded');
  assert.match(source, /await withTimeout\(this\.bridge\.enqueue\(job\), this\.enqueueTimeoutMs\)/, 'and the wait is bounded');
  const calls = source.split('await this.safeEnqueue(').length - 1;
  assert.equal(calls, 3, 'audio, lyrics and art all go through it');
});

test('one tap queues all 269 tracks and all 23 covers, and the refused call is retried in place', async () => {
  const bridge = fakeBridge({ fail: 'audio:s254', failTimes: 1 });
  const offline = store(bridge);
  await offline.download('pl-1', songs);
  await settle();

  assert.equal(audioJobs(bridge).length, TRACKS, 'every track is queued');
  assert.equal(new Set(artJobs(bridge).map((job) => job.songId)).size, COVERS, 'every cover is queued by the same tap');
  assert.equal(bridge.attempts.get('audio:s254'), 2, 'the refused transfer was asked again, not abandoned');

  // Native completes every audio transfer — no retry tap anywhere.
  for (const job of audioJobs(bridge)) {
    bridge.emit('done', { songId: job.songId, path: `file:///${job.songId}.opus`, bytes: 5_000_000 });
  }
  await settle();
  assert.equal(offline.record('pl-1')?.state, 'complete', 'the job finishes on its own');
  assert.equal(offline.record('pl-1')?.done, TRACKS);
  offline.dispose();
});

test('a bridge call that never answers cannot hang the list either', async () => {
  // The dropped Capacitor message: the promise simply never settles.
  const bridge = fakeBridge({ stall: 'audio:s100', stallTimes: 1 });
  const offline = store(bridge, 20);
  await offline.download('pl-1', songs);
  await settle();

  assert.equal(audioJobs(bridge).length, TRACKS, 'the list ran to the end past the stalled track');
  assert.equal(new Set(artJobs(bridge).map((job) => job.songId)).size, COVERS);
  assert.equal(bridge.attempts.get('audio:s100'), 2, 'and the stalled track was asked again after the timeout');
  offline.dispose();
});

test('a transfer the native side reports failed comes back by itself, with a backoff', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-1', songs);
  await settle();
  const before = audioJobs(bridge).length;
  assert.equal(before, TRACKS);

  // A flaky transfer: the native side gives up on track 7 and reports it.
  bridge.emit('failed', { songId: 's7', status: 500, error: 'timed out' });
  await settle();
  assert.equal(audioJobs(bridge).length, TRACKS);

  // The pump's first backoff round is 1.5 s: no tap, no human.
  await new Promise((resolve) => setTimeout(resolve, 1800));
  await settle();
  assert.equal(audioJobs(bridge).filter((job) => job.songId === 's7').length, 2, 'track 7 was re-queued by itself');
  offline.dispose();
});
