/**
 * v1.9.18 — offline browsing: the playlists a connection is not needed for.
 *
 * The owner's report is that a playlist he had already downloaded could not be browsed with no
 * connection, and that the view answered with the transport's own message. The UI half of that is
 * driven in a real browser (`test/offline-views.test.ts`, over `tools/offline-check.mjs`); this
 * file is the half that has to be exact and cannot be flaky — what the store says it can show
 * offline, and what it remembers about a playlist it downloaded.
 *
 * Three claims:
 *
 *   1. `downloadedPlaylists()` is the offline browse list: the manifests that have something on
 *      disk, newest request first, with the name they were downloaded under;
 *   2. the name survives a relaunch (it is written into the mirror, which is the only thing the
 *      next session has before the native index answers);
 *   3. `rememberPlaylistName()` is what keeps older downloads named — a manifest written before
 *      names were recorded has none, and the server's own list is the source that fills it in.
 *
 * No phone, no network, no DOM: the bridge is a fake, so every value here is driven explicitly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OfflineStore } from '../src/state/offline.ts';
import type { DownloadEvent, DownloadJob, DownloadsBridge, IndexRow } from '../src/state/offline.ts';
import { loadMirror } from '../src/storage/offline.ts';
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
  emit(name: 'progress' | 'done' | 'failed', event: DownloadEvent): void;
}

function fakeBridge(rows: IndexRow[] = []): FakeBridge {
  const listeners = new Map<string, (event: DownloadEvent) => void>();
  return {
    configure: async () => undefined,
    enqueue: async (_job: DownloadJob) => undefined,
    cancel: async () => undefined,
    remove: async () => undefined,
    list: async () => rows,
    freeBytes: async () => -1,
    readLyrics: async () => null,
    writeLyrics: async () => undefined,
    addListener: async (name, listener) => {
      listeners.set(name, listener);
      return () => undefined;
    },
    emit(name, event) {
      listeners.get(name)?.(event);
    },
  };
}

/** Download a playlist in the store and land its file, so it reads `complete` with rows on disk. */
async function download(bridge: FakeBridge, store: OfflineStore, playlistId: string, name: string, songs: Song[]): Promise<void> {
  await store.download(playlistId, songs, { name });
  for (const entry of songs) bridge.emit('done', { songId: entry.id, path: `file:///${entry.id}.mp3`, bytes: 1000 });
}

test('the offline browse list is the manifests with something on disk, newest first, by name', async () => {
  const store = new OfflineStore(fakeBridge(), { store: memoryStore() });
  const bridge = fakeBridge();
  const store2 = new OfflineStore(bridge, { store: memoryStore() });

  await download(bridge, store2, 'pl-old', 'Driving', [song('a')]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await download(bridge, store2, 'pl-new', 'Late night', [song('b'), song('c')]);

  const listed = store2.downloadedPlaylists();
  assert.deepEqual(
    listed.map((entry) => [entry.id, entry.name, entry.record.done, entry.record.total]),
    [
      ['pl-new', 'Late night', 2, 2],
      ['pl-old', 'Driving', 1, 1],
    ],
    'newest request first, with the name it was downloaded under and the counts',
  );
  // The song list the playlist page draws from is the manifest's, offline, in order.
  assert.deepEqual(listed[0]?.record.songs.map((entry) => entry.id), ['b', 'c']);
  // An empty store is an empty list, not a crash: a phone with nothing downloaded.
  assert.deepEqual(store.downloadedPlaylists(), []);
});

test('a playlist whose files have not landed is not offered as browsable offline', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.download('pl-1', [song('a')], { name: 'Not yet' });
  assert.deepEqual(store.downloadedPlaylists(), [], 'nothing is on disk yet');
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.deepEqual(
    store.downloadedPlaylists().map((entry) => entry.name),
    ['Not yet'],
    'and it appears the moment a file is complete',
  );
});

test('the name a playlist was downloaded under survives a relaunch, from the mirror', async () => {
  const mirror = memoryStore();
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: mirror });
  await download(bridge, store, 'pl-1', 'Late night driving', [song('a'), song('b')]);

  // The relaunch: no bridge answer yet, nothing but the mirror — which is the state a cold start
  // is in before `list()` replies, and the one the offline page has to work from.
  const next = new OfflineStore(null, { store: mirror });
  assert.equal(loadMirror(mirror)?.playlists?.['pl-1']?.name, 'Late night driving', 'the mirror holds the name');
  await next.hydrate();
  assert.deepEqual(
    next.downloadedPlaylists().map((entry) => [entry.id, entry.name, entry.record.done, entry.record.total]),
    [['pl-1', 'Late night driving', 2, 2]],
    'the record is rebuilt from the manifest and the mirrored rows, so the playlist is listed with its name',
  );
});

test('a manifest written before names were recorded is named by the server’s own list, once', async () => {
  const mirror = memoryStore();
  // A legacy mirror: rows, a manifest, and no name anywhere.
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: { a: { path: 'file:///a.mp3', bytes: 1000, state: 'complete' } },
      playlists: { 'pl-1': { songs: [song('a')], requestedAt: Date.now(), state: 'complete' } },
    }),
  );
  const legacy = new OfflineStore(null, { store: mirror });
  await legacy.hydrate();
  assert.equal(legacy.downloadedPlaylists()[0]?.name, 'Downloaded playlist', 'no name is invented for it');

  legacy.rememberPlaylistName('pl-1', 'Driving');
  assert.equal(legacy.downloadedPlaylists()[0]?.name, 'Driving', 'the server’s name is adopted');
  assert.equal(loadMirror(mirror)?.playlists?.['pl-1']?.name, 'Driving', 'and it is durable');

  // Idempotent, and never a write for a playlist with no manifest to name.
  const writes: string[] = [];
  const counted = { getItem: () => null, setItem: () => void writes.push('write'), removeItem: () => undefined };
  const guarded = new OfflineStore(null, { store: counted });
  guarded.rememberPlaylistName('pl-none', 'Nothing downloaded here');
  assert.deepEqual(writes, [], 'a playlist with no download is not ours to name');
});
