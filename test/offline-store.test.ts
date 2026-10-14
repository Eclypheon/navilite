/**
 * The OfflineStore's state machine (§5), the shared-track rule (§S9/S10) and the boot reconcile.
 *
 * No phone, no network, no DOM: the bridge is a fake, so every transition is driven explicitly and
 * read back from the store — nothing here can be flaky.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OfflineStore } from '../src/state/offline.ts';
import type { DownloadEvent, DownloadJob, DownloadsBridge, IndexRow } from '../src/state/offline.ts';
import type { Song } from '../src/api/types.ts';

const song = (id: string, size = 1000): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 10, size });

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

interface FakeBridge extends DownloadsBridge {
  removed: string[];
  enqueued: DownloadJob[];
  emit(name: 'progress' | 'done' | 'failed', event: DownloadEvent): void;
}

function fakeBridge(rows: IndexRow[] = []): FakeBridge {
  const listeners = new Map<string, (event: DownloadEvent) => void>();
  const removed: string[] = [];
  const enqueued: DownloadJob[] = [];
  return {
    configure: async () => undefined,
    enqueue: async (job) => void enqueued.push(job),
    cancel: async () => undefined,
    remove: async (songId) => void removed.push(songId),
    list: async () => rows,
    freeBytes: async () => -1,
    readLyrics: async () => null,
    writeLyrics: async () => undefined,
    addListener: async (name, listener) => {
      listeners.set(name, listener);
      return () => undefined;
    },
    removed,
    enqueued,
    emit(name, event) {
      listeners.get(name)?.(event);
    },
  };
}

test('a cancelled download keeps the completed tracks and reads partial', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.download('pl-1', [song('a'), song('b')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'downloading');
  await store.cancel('pl-1');
  assert.equal(store.record('pl-1')?.state, 'partial');
  assert.equal(store.record('pl-1')?.done, 1);
});

test('two playlists sharing a track keep it until the last ref goes (S10)', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(store.pathFor('a'), 'file:///a.mp3');
  // A second playlist that already has the track on disk adds a ref, and fetches nothing.
  await store.download('pl-2', [song('a')]);
  assert.equal(bridge.enqueued.filter((job) => job.songId === 'a').length, 1);
  await store.remove('pl-1');
  assert.ok(!bridge.removed.includes('a'), 'the shared track survives one playlist removal');
  assert.equal(store.pathFor('a'), 'file:///a.mp3');
  await store.remove('pl-2');
  assert.ok(bridge.removed.includes('a'), 'the file is dropped at zero refs');
  assert.equal(store.pathFor('a'), null);
});

test('a boot with a missing mirror rebuilds from list() and plays local on the first start', async () => {
  const rows: IndexRow[] = [
    { songId: 'a', path: 'file:///a.mp3', suffix: 'mp3', bytes: 1000, state: 'complete', refs: ['pl-1'], title: 'Track a', artist: '', album: '', durationSec: 10 },
  ];
  const bridge = fakeBridge(rows);
  // The mirror is missing entirely; the store must still resolve from list().
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.hydrate();
  assert.equal(store.pathFor('a'), 'file:///a.mp3');
  assert.equal(store.record('pl-1')?.state, 'complete');
});

test('invariant 7 is an executable claim: the store imports no queue, engine or native module', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'src', 'state', 'offline.ts'), 'utf8');
  const imports = source
    .split('\n')
    .filter((line) => /^\s*import\s/.test(line))
    .join('\n');
  assert.doesNotMatch(imports, /state\/queue|player\/engine|player\/native/);
});

/* ---------------------------------------------------- the offline-lyrics axis */

test('a lyric is enqueued in the audio lane with suffix "lyrics", never on the bridge lanes', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await store.download('pl-1', [song('a')]);
  const lyricsJobs = bridge.enqueued.filter((job) => job.suffix === 'lyrics');
  assert.equal(lyricsJobs.length, 1, 'one lyric transfer per track');
  assert.equal(lyricsJobs[0]?.url, 'https://music.example/lyrics?path=a');
  const audioJobs = bridge.enqueued.filter((job) => job.suffix !== 'lyrics');
  assert.equal(audioJobs.length, 1, 'audio is enqueued once, beside the lyric');
});

test('a failed lyric holds the playlist at partial while the audio row stays complete and playable (invariant 8)', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  bridge.emit('failed', { songId: 'a', kind: 'lyrics' });
  assert.equal(store.record('pl-1')?.state, 'partial', 'the failed lyric leaves the playlist at retry');
  assert.equal(store.record('pl-1')?.done, 1, 'the audio track is still counted complete');
  assert.equal(store.pathFor('a'), 'file:///a.mp3', 'and the lyric failure never gates the local file');
});

test('a playlist is complete only when every audio row is complete and every lyric is present or none', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'downloading', 'audio in, lyric still pending');
  bridge.emit('done', { songId: 'a', kind: 'lyrics', bytes: 4213 });
  assert.equal(store.record('pl-1')?.state, 'complete', 'both axes resolved');
});

test('removing the last ref drops the lyric row with the audio row', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  bridge.emit('done', { songId: 'a', kind: 'lyrics', bytes: 100 });
  assert.equal(store.lyricsState('a')?.state, 'present');
  await store.remove('pl-1');
  assert.ok(bridge.removed.includes('a'), 'the native remove is asked once (deleting both files)');
  assert.equal(store.lyricsState('a'), null, 'and the lyric row is gone with the audio row');
});
