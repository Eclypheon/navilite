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

test('a lyric the route says does not exist is a stored fact, not a playlist stuck on retry', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  // The route answers 404 for a track whose folder holds no sidecar — the normal case.
  bridge.emit('failed', { songId: 'a', kind: 'lyrics', status: 404, error: 'not found' });
  assert.equal(store.lyricsState('a')?.state, 'none', 'the miss is recorded, not a failure');
  assert.equal(store.record('pl-1')?.state, 'complete', 'and the playlist is not held on retry for it');

  // A transfer that really failed is still a failure, and still leaves the playlist on retry.
  const other = fakeBridge();
  const second = new OfflineStore(other, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await second.download('pl-1', [song('a')]);
  other.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  other.emit('failed', { songId: 'a', kind: 'lyrics', status: 500, error: 'boom' });
  assert.equal(second.lyricsState('a')?.state, 'failed', 'a 500 is not a miss');
  assert.equal(second.record('pl-1')?.state, 'partial', 'and it asks for one small retry');
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

/* ------------------------------------------- the durable manifest (kill / extended playlist) */

test('a download killed mid-flight reconciles as partial and resumes only the missing tracks (E2)', async () => {
  const store = memoryStore();
  const first = fakeBridge();
  const one = new OfflineStore(first, { store });
  await one.download('pl-1', [song('a'), song('b')]);
  first.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(one.record('pl-1')?.state, 'downloading');

  // The app is force-quit here. The next boot lists the one file that landed.
  const rows: IndexRow[] = [
    { songId: 'a', path: 'file:///a.mp3', suffix: 'mp3', bytes: 1000, state: 'complete', refs: ['pl-1'], title: 'Track a', artist: '', album: '', durationSec: 10 },
  ];
  const second = fakeBridge(rows);
  const two = new OfflineStore(second, { store });
  await two.hydrate();
  const record = two.record('pl-1');
  assert.ok(record, 'the manifest rebuilt the record without a completed file to derive it from');
  assert.notEqual(record.state, 'complete', 'a killed download never reconciles as complete');
  assert.equal(record.done, 1);
  assert.equal(record.total, 2, 'the manifest is the total, not the rows that happened to land');
  assert.deepEqual(
    second.enqueued.filter((job) => job.suffix !== 'lyrics').map((job) => job.songId),
    ['b'],
    'and only the missing track is re-enqueued',
  );
});

test('a cancelled download is not resumed on the next boot — only the owner asks again', async () => {
  const store = memoryStore();
  const first = fakeBridge();
  const one = new OfflineStore(first, { store });
  await one.download('pl-1', [song('a'), song('b')]);
  await one.cancel('pl-1');

  const second = fakeBridge();
  const two = new OfflineStore(second, { store });
  await two.hydrate();
  assert.equal(two.record('pl-1')?.state, 'partial');
  assert.equal(second.enqueued.length, 0, 'boot did not re-enqueue a download the owner cancelled');
});

test('a playlist a track was added to after the download is no longer complete', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.download('pl-1', [song('a'), song('b')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  bridge.emit('done', { songId: 'b', path: 'file:///b.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'complete');
  assert.equal(store.missingCount('pl-1', [song('a'), song('b')]), 0, 'nothing missing from the download');
  assert.equal(store.missingCount('pl-1', [song('a'), song('b'), song('c')]), 1, 'the track added later is the count');
});

test('the mirror carries the lyrics fetchedAt, so a "no lyrics" row is not re-asked next session', async () => {
  const store = memoryStore();
  const bridge = fakeBridge();
  const first = new OfflineStore(bridge, { store });
  await first.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  const before = first.lyricsState('a');
  assert.equal(before?.state, 'none', 'the fallback recorded "asked, nothing there"');

  const two = new OfflineStore(fakeBridge(), { store });
  const after = two.lyricsState('a');
  assert.equal(after?.state, 'none', 'the seeded row still knows there are no lyrics');
  assert.equal(after?.fetchedAt, before?.fetchedAt, 'and it kept the timestamp the freshness window reads');
});

test('onChange is a list: both subscribers are told, and an unsubscribed one goes quiet', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  const calls: string[] = [];
  const stopA = store.onChange(() => void calls.push('a'));
  const stopB = store.onChange(() => void calls.push('b'));
  await store.download('pl-1', [song('a')]);
  assert.ok(calls.includes('a') && calls.includes('b'), 'both subscribers heard the change');

  stopA();
  calls.length = 0;
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.deepEqual(calls, ['b'], 'the unsubscribed subscriber is silent');

  stopB();
  calls.length = 0;
  bridge.emit('failed', { songId: 'a' });
  assert.deepEqual(calls, [], 'and the store keeps nothing when both are gone');
});
