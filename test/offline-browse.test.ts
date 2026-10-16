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

/** A track that names its cover, the way a `Song` from the server does. */
const covered = (id: string, coverArt: string, size = 1000): Song => ({ ...song(id, size), coverArt, albumId: `${coverArt}-album` });

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
  // **Before** any hydrate, too (v1.9.19): the page is painted in this tick.
  assert.deepEqual(
    next.downloadedPlaylists().map((entry) => entry.id),
    ['pl-1'],
    'the browse list answers from the mirror before anything is reconciled',
  );
  await next.hydrate();
  assert.deepEqual(
    next.downloadedPlaylists().map((entry) => [entry.id, entry.name, entry.record.done, entry.record.total]),
    [['pl-1', 'Late night driving', 2, 2]],
    'the record is rebuilt from the manifest and the mirrored rows, so the playlist is listed with its name',
  );
});

/**
 * The defect the browser harness structurally cannot see (v1.9.19).
 *
 * On the web `createDownloadsBridge()` is null, which makes `hydrate()` fully synchronous, so the
 * store there is always warm by the time anything reads it. On the phone a bridge exists, and
 * `hydrate()` reaches `rebuildPlaylists` only after `await bridge.list()` — a native round trip that
 * takes up to `BRIDGE_TIMEOUT_MS`. Boot does not await it (`void offline.hydrate()`), and the first
 * route is painted anyway, so for the whole of that window the playlist records have to answer from
 * the mirror or a cold launch in airplane mode says "nothing is downloaded on this phone yet" over a
 * phone full of downloads.
 *
 * This is the assertion the harness cannot make: a bridge is present, `list()` answers on a timer,
 * and nothing is awaited.
 */
test('with a bridge present the playlist records answer in the same tick the store is constructed', async () => {
  const mirror = memoryStore();
  const warm = fakeBridge();
  const store = new OfflineStore(warm, { store: mirror });
  await download(warm, store, 'pl-1', 'Late night driving', [song('a'), song('b')]);

  let answered = false;
  const slow: FakeBridge = {
    ...fakeBridge(),
    list: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          answered = true;
          resolve([]);
        }, 50);
      }),
  };
  const cold = new OfflineStore(slow, { store: mirror });
  // No `await`, no `hydrate()`: this is the tick `renderRoute` paints the first screen in.
  assert.equal(answered, false, 'the native index has not answered yet — the window this test is about');
  assert.deepEqual(
    cold.downloadedPlaylists().map((entry) => [entry.id, entry.name, entry.record.done, entry.record.total]),
    [['pl-1', 'Late night driving', 2, 2]],
    'the offline browse list comes from the mirror, not from the round trip',
  );
  assert.equal(cold.record('pl-1')?.state, 'complete', 'and so does the record the download control draws from');
  assert.equal(cold.pathFor('a'), 'file:///a.mp3', 'the resolver was already warm');

  await cold.hydrate();
  assert.equal(answered, true, 'and the reconcile still runs, replacing the mirror’s picture with list()’s');
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

/* ------------------------------------------- the badge and the downloaded-songs view (v1.9.20) */

/**
 * §3.1's table, in order, on one store: the mark is `record()` plus the one question the record
 * cannot answer on its own — *is the playlist in front of me still the one that was downloaded?*
 */
test('the badge is read from complete files, and a grown playlist is never called complete', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  assert.equal(store.playlistBadge('pl-none').state, 'none', 'a playlist nothing was asked of');

  await store.download('pl-1', [covered('a', 'cover-a'), covered('b', 'cover-a')], { name: 'Driving' });
  assert.equal(store.playlistBadge('pl-1').state, 'downloading', 'asked for, nothing landed yet');
  assert.equal(store.playlistBadge('pl-1').bytes, 0, 'and it promises no bytes that are not here');

  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(store.playlistBadge('pl-1').state, 'downloading', 'one of two is in flight, not complete');
  assert.equal(store.playlistBadge('pl-1').done, 1);
  assert.equal(store.playlistBadge('pl-1').bytes, 1000, 'measured from the rows that are here');

  bridge.emit('done', { songId: 'b', path: 'file:///b.mp3', bytes: 1000 });
  assert.equal(store.playlistBadge('pl-1').state, 'complete');
  assert.equal(store.playlistBadge('pl-1').bytes, 2000, 'the measured rows, never the estimate');
  assert.equal(store.playlistBadge('pl-1', 2).state, 'complete', 'the length it was downloaded at');

  // The server now says three tracks: the row must stop claiming to hold everything.
  assert.equal(store.playlistBadge('pl-1', 3).state, 'partial', 'a playlist that grew is not entirely downloaded');

  // …and a track that never landed leaves the playlist partial, with the count of what did.
  await store.download('pl-2', [covered('c', 'cover-a'), covered('d', 'cover-a')], { name: 'Stopped' });
  bridge.emit('done', { songId: 'c', path: 'file:///c.mp3', bytes: 1000 });
  bridge.emit('failed', { songId: 'd', error: 'HTTP 500' });
  assert.equal(store.playlistBadge('pl-2').state, 'partial');
  assert.equal(store.playlistBadge('pl-2').done, 1);

  await store.remove('pl-1');
  assert.equal(store.playlistBadge('pl-1').state, 'none', 'and a removed download is not marked at all');
});

test('the downloaded-songs view is one row per complete file, in library order, and answers cold', async () => {
  const mirror = memoryStore();
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: mirror });
  await store.download('pl-1', [song('a'), song('b')], { name: 'Driving' });
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 111 });
  assert.deepEqual(store.downloadedSongs().map((entry) => entry.id), ['a'], 'a staging row is not on the phone yet');

  bridge.emit('done', { songId: 'b', path: 'file:///b.mp3', bytes: 222 });
  assert.deepEqual(
    store.downloadedSongs().map((entry) => [entry.id, entry.title, entry.size]),
    [
      ['a', 'Track a', 111],
      ['b', 'Track b', 222],
    ],
    'one entry per song, with the metadata the rows carry',
  );

  /*
   * The cold start this view has to survive (the 1.9.19 defect, in a new place): a bridge whose
   * `list()` answers on a timer, nothing awaited, so every title on screen comes from the mirror.
   */
  let answered = false;
  const slow: FakeBridge = {
    ...fakeBridge(),
    list: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          answered = true;
          resolve([]);
        }, 50);
      }),
  };
  const cold = new OfflineStore(slow, { store: mirror });
  assert.equal(answered, false, 'the native index has not answered yet');
  assert.deepEqual(
    cold.downloadedSongs().map((entry) => entry.title),
    ['Track a', 'Track b'],
    'the titles come from the mirror, not from a round trip',
  );
});
