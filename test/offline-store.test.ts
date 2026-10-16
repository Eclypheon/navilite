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
import { ART_ASSUMED_BYTES, OfflineStore } from '../src/state/offline.ts';
import type { DownloadEvent, DownloadJob, DownloadsBridge, IndexRow } from '../src/state/offline.ts';
import { OFFLINE_MIRROR_KEY, loadMirror } from '../src/storage/offline.ts';
import type { Song } from '../src/api/types.ts';

const song = (id: string, size = 1000): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 10, size });

/** A completed row as `list()` reports one, which is also what the native index writes on completion. */
const indexRow = (id: string, refs: string[] = ['pl-1']): IndexRow => ({
  songId: id,
  path: `file:///${id}.mp3`,
  suffix: 'mp3',
  bytes: 1000,
  state: 'complete',
  refs,
  title: `Track ${id}`,
  artist: '',
  album: '',
  durationSec: 10,
});

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

/**
 * Let the store's fire-and-forget work finish: the Navidrome capture `onFailed` starts, and the
 * read-back after a lyric `done`, are both `void`-ed, and both resolve inside a microtask or two.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
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

/*
 * v1.9.17 — the file that is gone. The resolver cannot see a deleted file (it is synchronous and
 * never touches the filesystem), so the row is voided on the one signal the app gets: a start that
 * produced no sound for a track it asked for as a `file://` path (`state/queue.ts`). The void has to
 * reach the **native** index and not only this process, because `list()` reports `index.json`
 * without stat-ing the file, so a row dropped here alone would be back at the next boot reconcile.
 */
test('a complete row whose file has gone is voided from the index, the mirror and the native index', async () => {
  const bridge = fakeBridge([indexRow('a')]);
  const mirror = memoryStore();
  const store = new OfflineStore(bridge, { store: mirror });
  await store.hydrate();
  assert.equal(store.pathFor('a'), 'file:///a.mp3', 'the row answers with its file while the file is there');
  assert.equal(loadMirror(mirror)?.rows['a']?.state, 'complete', 'and the mirror carries it, so a relaunch resolves local');

  await store.voidMissingFile('a');
  assert.equal(store.pathFor('a'), null, 'the dead row no longer resolves — the next start is the stream');
  assert.deepEqual(bridge.removed, ['a'], 'and the native index is corrected, not just this process');
  assert.deepEqual(loadMirror(mirror)?.rows, {}, 'the mirror cannot resurrect it on the next launch either');
  assert.equal(store.totalTracks(), 0, 'it is no longer counted as a downloaded track');
});

test('voiding a missing file reconciles the playlist down, and only a complete row is voidable', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'complete', 'the playlist reads complete over a file that is on disk');

  // A song the index does not hold — never downloaded, or already voided — is not a row to void.
  await store.voidMissingFile('b');
  assert.deepEqual(bridge.removed, [], 'nothing was removed for a song with no row');

  await store.voidMissingFile('a');
  assert.equal(store.record('pl-1')?.done, 0, 'the playlist no longer counts the track as downloaded');
  assert.equal(store.record('pl-1')?.state, 'failed', 'so its control is the one that offers the download again');
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
  const asked: string[] = [];
  const store = new OfflineStore(bridge, {
    store: memoryStore(),
    lyricsUrl: () => 'https://music.example/lyrics?path=a',
    lyricsFallback: async (song) => {
      asked.push(song.id);
      return null; // Navidrome has nothing either: the track's words are nowhere.
    },
  });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  // The route answers 404 for a track whose folder holds no sidecar — the normal case.
  bridge.emit('failed', { songId: 'a', kind: 'lyrics', status: 404, error: 'not found' });
  await settle();
  assert.deepEqual(asked, ['a'], 'the 404 is not terminal: Navidrome is asked next (v1.9.14)');
  assert.equal(store.lyricsState('a')?.state, 'none', 'and every source empty is `none` — never `present`');
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

/*
 * v1.9.14, defect 2: the download lane mirrors the online chain. A track whose words live **inside
 * the file itself** — an embedded tag Navidrome reads, with no `.lrc`/`.txt` beside the audio — has
 * no route URL and never 200s, so before this the lane recorded `none` and the owner saw lyrics
 * online and none offline.
 */
test('a lyric the route has no sidecar for is captured from Navidrome instead', async () => {
  const bridge = fakeBridge();
  const written: Array<{ songId: string; text: string }> = [];
  bridge.writeLyrics = async (songId, text) => void written.push({ songId, text });
  const asked: string[] = [];
  const store = new OfflineStore(bridge, {
    store: memoryStore(),
    lyricsUrl: () => 'https://music.example/lyrics?path=a',
    lyricsFallback: async (song) => {
      asked.push(song.id);
      return '[00:01.00]First line\n[00:02.00]Second line';
    },
  });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  bridge.emit('failed', { songId: 'a', kind: 'lyrics', status: 404, error: 'no sidecar' });
  await settle();
  assert.deepEqual(asked, ['a'], 'the fallback ran for the track the route 404s');
  assert.equal(written.length, 1, 'and its body became the stored lyric file');
  assert.match(written[0]?.text ?? '', /^\[00:01\.00\]First line/, 'stored raw: LRC stays LRC, timings and all');
  assert.equal(store.lyricsState('a')?.state, 'present', 'the row is present, not a miss');
  assert.equal(store.record('pl-1')?.state, 'complete', 'both axes resolved — the playlist is done, not `· retry`');
});

/*
 * v1.9.14, defect 3: the mirrors downloaded before the fix hold the route's **404 document** as
 * their lyric file and still read `present`. Nothing about that file changes by itself, so the
 * check lives where the body is read — `lyricsDoc`, the one door between the durable copy and the
 * view.
 */
test('a stored route-error body is refused, voided and re-fetched exactly once', async () => {
  const error = '{"error": "no lyrics sidecar for this track", "path": "x.opus", "tried": [".lrc"]}';
  const rows = [indexRow('a')];
  rows[0].lyrics = { state: 'present', file: 'a.lyrics', bytes: error.length, fetchedAt: Date.now() };
  const bridge = fakeBridge(rows);
  let body: string | null = error;
  bridge.readLyrics = async () => body;
  bridge.writeLyrics = async (_songId, text) => void (body = text);
  const asked: string[] = [];
  const store = new OfflineStore(bridge, {
    store: memoryStore(),
    lyricsFallback: async (song) => {
      asked.push(song.id);
      return '[00:03.00]Real words';
    },
  });
  await store.hydrate();
  assert.equal(store.lyricsState('a')?.state, 'present', 'the phone holds the row 1.9.13 wrote');
  assert.equal((await store.lyricsDoc('a')).kind, 'miss', 'the poisoned row is refused');
  assert.equal((await store.lyricsDoc('a')).kind, 'miss', 'a second read refuses it too');
  await settle();
  assert.deepEqual(asked, ['a'], 'one re-fetch, not one per read');
  assert.equal(store.lyricsState('a')?.state, 'present', 'the good body is now the row');
  const after = await store.lyricsDoc('a');
  assert.equal(after.kind, 'present', 'and it is served from the device again');
  assert.equal(after.kind === 'present' ? after.doc.lines[0]?.text : '', 'Real words');
});

test('a lyric transfer that lands as the route-error body is not left reading present', async () => {
  const error = '{"error": "no lyrics sidecar for this track", "path": "x.opus", "tried": [".lrc"]}';
  const bridge = fakeBridge();
  let body: string | null = error;
  bridge.readLyrics = async () => body;
  bridge.writeLyrics = async (_songId, text) => void (body = text);
  const store = new OfflineStore(bridge, {
    store: memoryStore(),
    lyricsUrl: () => 'https://music.example/lyrics?path=a',
    lyricsFallback: async () => null,
  });
  await store.download('pl-1', [song('a')]);
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  bridge.emit('done', { songId: 'a', kind: 'lyrics', bytes: error.length });
  await settle();
  assert.equal(store.lyricsState('a')?.state, 'none', 'the read-back refused it — the row is a miss, not `present`');
  assert.equal(await store.lyricsDoc('a').then((r) => r.kind === 'present'), false, 'and nothing serves the JSON');
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

  // The on-foreground reconcile runs again on every visibility change: it must not restart the
  // transfers that are already running.
  second.enqueued.length = 0;
  await two.hydrate();
  assert.equal(second.enqueued.length, 0, 'a later reconcile does not re-enqueue a live download');
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

/* ------------------------------- the on-foreground reconcile (review round 1) */

test('a foreground reconcile keeps the rows of the transfers still running, so their done event lands', async () => {
  const rows: IndexRow[] = [];
  const bridge = fakeBridge(rows);
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.hydrate(); // boot
  await store.download('pl-1', [song('a'), song('b')]);
  rows.push(indexRow('a')); // the audio that landed wrote its index row; b is still transferring
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'downloading');

  // Back into the foreground: `list()` answers with the one finished file and nothing about b.
  await store.hydrate();
  // A live download is not offered as `retry`: a tap on that label re-enqueues, and the native
  // enqueue cancels the task it replaces — restarting a transfer that was nearly done.
  assert.equal(store.record('pl-1')?.state, 'downloading', 'the still-transferring track is not a retry');

  rows.push(indexRow('b'));
  bridge.emit('done', { songId: 'b', path: 'file:///b.mp3', bytes: 1000 });
  assert.equal(store.pathFor('b'), 'file:///b.mp3', 'the track that landed while the app was out is resolvable');
  assert.equal(store.record('pl-1')?.state, 'complete');
  assert.equal(store.record('pl-1')?.done, 2);
});

test('a cancelled download keeps no row alive across a reconcile', async () => {
  const rows: IndexRow[] = [];
  const bridge = fakeBridge(rows);
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.hydrate();
  await store.download('pl-1', [song('a'), song('b')]);
  await store.cancel('pl-1');
  await store.hydrate();
  assert.equal(store.record('pl-1')?.state, 'partial', 'a cancelled download is retry, never a running one');

  bridge.emit('done', { songId: 'b', path: 'file:///b.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'partial', 'and a late event does not claim it completed');
});

test('the manifest is durable before the first enqueue, so a kill inside the loop still resumes (E2)', async () => {
  const store = memoryStore();
  const bridge = fakeBridge();
  const enqueue = bridge.enqueue.bind(bridge);
  bridge.enqueue = async (job) => {
    await enqueue(job);
    // The app is killed while this enqueue is in flight: the loop never reaches the next track.
    if (job.songId === 'b') await new Promise<never>(() => undefined);
  };
  const one = new OfflineStore(bridge, { store });
  void one.download('pl-1', [song('a'), song('b')]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    loadMirror(store)?.playlists?.['pl-1']?.state,
    'downloading',
    'both transfers are enqueued and the manifest is already persisted',
  );
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });

  // A force-quit here, then the next boot, which lists the one file that landed.
  const second = fakeBridge([indexRow('a')]);
  const two = new OfflineStore(second, { store });
  await two.hydrate();
  const record = two.record('pl-1');
  assert.ok(record, 'the manifest rebuilt the record without a completed file for both tracks');
  assert.equal(record.total, 2, 'the manifest is the total, not the files that happened to land');
  assert.notEqual(record.state, 'complete', 'a kill inside the enqueue loop never reconciles as complete');
  assert.deepEqual(
    second.enqueued.filter((job) => job.suffix !== 'lyrics').map((job) => job.songId),
    ['b'],
    'and only the missing track is re-enqueued',
  );
  one.dispose();
});

test('a no-space abort takes its own manifest back out of the mirror', async () => {
  const store = memoryStore();
  const bridge = fakeBridge();
  let atSpaceCheck: string | null = null;
  bridge.freeBytes = async () => {
    atSpaceCheck = store.getItem(OFFLINE_MIRROR_KEY);
    return 0;
  };
  const one = new OfflineStore(bridge, { store });
  const result = await one.download('pl-1', [song('a')]);
  assert.equal(result.kind, 'no-space');
  assert.match(atSpaceCheck ?? '', /"downloading"/, 'the manifest was persisted before the space check');

  assert.equal(loadMirror(store)?.playlists, undefined, 'the abort removed it again');
  const second = fakeBridge();
  const two = new OfflineStore(second, { store });
  await two.hydrate();
  assert.equal(two.record('pl-1'), null, 'so the next boot has no download to resume');
  assert.equal(second.enqueued.length, 0, 'and nothing is fetched behind the owner back');
});

/* --------------------------------------------------------- the album-art axis (v1.9.20) */

/** A track that names its cover, the way a `Song` from the server does. */
const covered = (id: string, coverArt: string): Song => ({ ...song(id), coverArt, albumId: `${coverArt}-album` });

/** Land the audio **and** the lyric of every song, so an assertion is about the art axis alone. */
function landAudioAndLyrics(bridge: FakeBridge, songs: Song[]): void {
  for (const entry of songs) {
    bridge.emit('done', { songId: entry.id, path: `file:///${entry.id}.mp3`, bytes: 1000 });
    bridge.emit('done', { songId: entry.id, kind: 'lyrics', bytes: 100 });
  }
}

test('a download enqueues one cover transfer per distinct cover id, keyed by the cover', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), artUrl: (coverArtId) => `getCoverArt?id=${coverArtId}&size=512` });
  const songs = [covered('a', 'cover-1'), covered('b', 'cover-1'), covered('c', 'cover-2')];
  await store.download('pl-1', songs, { name: 'Driving' });

  const art = bridge.enqueued.filter((job) => job.suffix === 'art');
  assert.deepEqual(
    art.map((job) => [job.songId, job.suffix, job.coverArt]),
    [
      ['cover-1', 'art', 'cover-1'],
      ['cover-2', 'art', 'cover-2'],
    ],
    'one transfer per cover — a 12-track album is one file, not twelve — and the key is the cover id',
  );
  assert.equal(art[0].url, 'getCoverArt?id=cover-1&size=512', 'asked at the size the spectrum page draws');
  assert.deepEqual(art[0].coverOf, ['a', 'b'], 'carrying the songs that share it, so a 1.9.19 row can learn its cover');
  assert.deepEqual(
    bridge.enqueued.filter((job) => job.suffix !== 'art').map((job) => job.coverArt),
    ['cover-1', 'cover-1', 'cover-2'],
    'and the audio jobs carry it too: a row knows its cover from birth',
  );
});

test('a cover whose event is keyed by the cover id reaches every row that carries it', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), artUrl: (coverArtId) => `getCoverArt?id=${coverArtId}` });
  const songs = [covered('a', 'cover-1'), covered('b', 'cover-1')];
  await store.download('pl-1', songs, { name: 'Driving' });
  landAudioAndLyrics(bridge, songs);
  const before = store.estimate(songs);
  assert.equal(before.exact, false, 'the cover is not here yet, so the figure is still a ceiling');

  /*
   * The event's key is a **cover id**, so `this.rows.get(event.songId)` misses by construction and
   * the event is dropped on the floor unless the handler fans out. That is what this asserts.
   */
  bridge.emit('done', { songId: 'cover-1', kind: 'art', bytes: 41_230 });
  assert.equal(store.artPathFor('cover-1'), 'file:///cover-1.art', 'the file is named after the cover, beside the audio');
  const after = store.estimate(songs);
  assert.equal(after.total, before.total - ART_ASSUMED_BYTES + 41_230, 'the assumption is replaced by the measured file');
  assert.equal(after.exact, true, 'and the figure is exact again');
  assert.equal(store.playlistBadge('pl-1').coverArt, 'cover-1', 'the row the UI draws can name the cover');
});

test('a cover fails without gating anything, and a 404 is a recorded fact', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), artUrl: (coverArtId) => `getCoverArt?id=${coverArtId}` });
  const songs = [covered('a', 'cover-1')];
  await store.download('pl-1', songs, { name: 'Driving' });
  landAudioAndLyrics(bridge, songs);
  assert.equal(store.record('pl-1')?.state, 'complete');

  bridge.emit('failed', { songId: 'cover-1', kind: 'art', status: 500, error: 'HTTP 500' });
  assert.equal(store.record('pl-1')?.state, 'complete', 'a missing picture never puts a playlist on `· retry`');
  assert.equal(store.missingCovers(songs), 1, 'and the control can still offer it');

  bridge.emit('failed', { songId: 'cover-1', kind: 'art', status: 404 });
  assert.equal(store.missingCovers(songs), 0, 'the library has no cover for this album: a fact, not a retry for ever');
  assert.equal(store.record('pl-1')?.state, 'complete', 'and it is still not the playlist’s business');
});

test('the cover of a shared album goes only when the last row that names it goes', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), artUrl: (coverArtId) => `getCoverArt?id=${coverArtId}` });
  const songs = [covered('a', 'cover-1')];
  await store.download('pl-1', songs, { name: 'One' });
  landAudioAndLyrics(bridge, songs);
  bridge.emit('done', { songId: 'cover-1', kind: 'art', bytes: 41_230 });
  await store.download('pl-2', songs, { name: 'Two' });

  await store.remove('pl-1');
  assert.equal(store.pathFor('a'), 'file:///a.mp3', 'the track survives one playlist’s removal (S9/S10)');
  assert.deepEqual(bridge.removed, [], 'and nothing is deleted while another playlist still holds it');
  assert.equal(store.artPathFor('cover-1'), 'file:///cover-1.art', 'so the cover still resolves');

  await store.remove('pl-2');
  assert.deepEqual(bridge.removed, ['a'], 'the last ref went: the song is removed from the device');
  assert.equal(store.artPathFor('cover-1'), null, 'and nothing names its cover any more');
  /*
   * The file itself is the native side's to delete — `<coverId>.art` is not `<songId>.<suffix>` for
   * any row, which is why `remove`'s shared-file scan and the boot sweep's `named` set are asserted
   * as source claims in `test/download-lane.test.ts`.
   */
});

test('a download from 1.9.19 — audio and lyrics, no cover — is offered as a covers-only fetch', async () => {
  // Rows exactly as `list()` reports them for a download an older build wrote: no cover id, no art.
  const bridge = fakeBridge([indexRow('a')]);
  const store = new OfflineStore(bridge, { store: memoryStore(), artUrl: (coverArtId) => `getCoverArt?id=${coverArtId}` });
  await store.hydrate();
  const songs = [covered('a', 'cover-1')];
  assert.equal(store.record('pl-1')?.state, 'complete', 'the audio is all there, so it reads complete');
  assert.equal(store.missingCovers(songs), 1, 'the cover is not, and that is what the `↓ covers` label is for');

  await store.download('pl-1', songs, { name: 'Driving' });
  const art = bridge.enqueued.filter((job) => job.suffix === 'art');
  assert.deepEqual(art.map((job) => [job.songId, job.coverOf]), [['cover-1', ['a']]], 'the tap fetches the cover, naming the row it belongs to');
  assert.equal(bridge.enqueued.filter((job) => job.suffix !== 'art').length, 0, 'and not one audio byte is re-fetched');
});
