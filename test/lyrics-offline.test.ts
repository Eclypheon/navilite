/**
 * The offline-lyrics seam (§"Offline lyrics"): the durable copy sits between the view cache and the
 * network, so a downloaded playlist's lyrics render — and highlight — with no connection.
 *
 * No network, no DOM, no phone: the bridge is a fake and every source counts its calls, so the
 * central claims are executable:
 *
 *   - a `present` row → the doc, parsed at read time, with **zero** network calls;
 *   - a `none` row inside its freshness window → `null` with zero calls;
 *   - an older `none` → the route is re-asked and a newly written sidecar wins;
 *   - a track with no row asks today's three sources in order and gets an identical doc;
 *   - a `present` row whose file is gone returns to the network without throwing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LyricsService } from '../src/lyrics/service.ts';
import { OfflineStore, type DownloadEvent, type DownloadJob, type IndexRow } from '../src/state/offline.ts';
import { LyricsCache } from '../src/storage/lyrics.ts';
import { fromSidecar, type LyricsSource } from '../src/api/lyrics.ts';
import type { SidecarSource } from '../src/api/sidecar.ts';
import type { Song, StructuredLyrics } from '../src/api/types.ts';

const song = (id = 'a'): Song => ({ id, title: 'Track', artist: 'Someone', album: 'Something', duration: 180 });

/** The route's own answer for a track with no sidecar — verbatim from the owner's phone (§1). */
const ROUTE_ERROR = '{"error": "no lyrics sidecar for this track", "path": "yorushika/eruma/13 - 海底、月明kari.opus", "tried": ["yorushika/eruma/13 - 海底、月明kari.lrc", "yorushika/eruma/13 - 海底、月明kari.txt"]}';

/** Let the store's `void`-ed capture finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

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

function row(songId: string, lyrics: IndexRow['lyrics']): IndexRow {
  return { songId, path: 'file:///a.mp3', suffix: 'mp3', bytes: 1000, state: 'complete', refs: [], title: '', artist: '', album: '', durationSec: 180, lyrics };
}

/** A bridge whose `readLyrics` answers from a mutable body, and `list()` from the given rows. */
function bridge(rows: IndexRow[], readBody: (songId: string) => string | null) {
  return {
    configure: async () => undefined,
    enqueue: async () => undefined,
    cancel: async () => undefined,
    remove: async () => undefined,
    list: async () => rows,
    freeBytes: async () => -1,
    readLyrics: async (songId: string) => readBody(songId),
    writeLyrics: async () => undefined,
    addListener: async () => () => undefined,
  };
}

/** A library/sidecar pair that counts every call and can be pointed at fixed answers. */
function sources() {
  const calls: string[] = [];
  const library: LyricsSource & { getLyricsBySongId: (id: string) => Promise<StructuredLyrics[]> } = {
    getLyricsBySongId: async (id) => {
      calls.push(`getLyricsBySongId:${id}`);
      return [];
    },
    getLyrics: async () => {
      calls.push('getLyrics');
      return null;
    },
  };
  const sidecar: SidecarSource & { lyricsFor: (s: Song) => Promise<string | null> } = {
    lyricsFor: async (s) => {
      calls.push(`sidecar:${s.id}`);
      return null;
    },
  };
  return { calls, library, sidecar };
}

const LRC = '[00:01.00]First line\n[00:02.00]Second line';
const TXT = 'First line\nSecond line';

test('a present row serves the doc parsed at read time, with zero network calls', async () => {
  const { calls, library, sidecar } = sources();
  const store = new OfflineStore(bridge([row('a', { state: 'present', bytes: LRC.length })], () => LRC), { store: memoryStore() });
  await store.hydrate();
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  const doc = await service.lyricsFor(song());
  assert.ok(doc, 'the durable copy answered');
  assert.equal(doc.synced, true, 'the LRC timings survived the read');
  assert.equal(doc.lines[0]?.timeMs, 1000, 'the stored timeMs is the parsed LRC tag');
  assert.deepEqual(calls, [], 'no source was asked — the body came from disk');
});

test('the body is parsed at read time, not at download time', async () => {
  let body = TXT;
  const store = new OfflineStore(bridge([row('a', { state: 'present', bytes: TXT.length })], () => body), { store: memoryStore() });
  await store.hydrate();
  const first = await store.lyricsDoc('a');
  assert.equal(first.kind, 'present');
  assert.equal(first.kind === 'present' ? first.doc.synced : true, false, 'a plain .txt read is untimed');
  body = LRC;
  const second = await store.lyricsDoc('a');
  assert.equal(second.kind, 'present');
  assert.equal(second.kind === 'present' ? second.doc.synced : false, true, 'the same row, re-read as .lrc, is now synced');
});

test('a none row inside its window returns null with zero calls', async () => {
  const { calls, library, sidecar } = sources();
  const store = new OfflineStore(bridge([row('a', { state: 'none', bytes: 0, fetchedAt: Date.now() })], () => null), { store: memoryStore() });
  await store.hydrate();
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  const doc = await service.lyricsFor(song());
  assert.equal(doc, null, 'a fresh miss is the empty state, immediately');
  assert.deepEqual(calls, [], 'and nothing is re-asked');
});

test('an older none is re-asked, and a newly written sidecar wins', async () => {
  const { calls, library, sidecar } = sources();
  sidecar.lyricsFor = async (s) => {
    calls.push(`sidecar:${s.id}`);
    return LRC;
  };
  const store = new OfflineStore(bridge([row('a', { state: 'none', bytes: 0, fetchedAt: Date.now() - 6 * 60 * 1000 })], () => null), { store: memoryStore() });
  await store.hydrate();
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  const doc = await service.lyricsFor(song());
  assert.ok(doc, 'the route answered with the new sidecar');
  assert.equal(doc.synced, true);
  assert.deepEqual(calls, ['sidecar:a'], 'the stale miss fell through to the route, which won');
});

test('a track with no row asks the three sources in today\'s order and returns an identical doc', async () => {
  const { calls, library, sidecar } = sources();
  sidecar.lyricsFor = async (s) => {
    calls.push(`sidecar:${s.id}`);
    return TXT;
  };
  const store = new OfflineStore(bridge([], () => null), { store: memoryStore() });
  await store.hydrate();
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  const doc = await service.lyricsFor(song('b'));
  assert.ok(doc);
  assert.equal(doc.synced, false, 'untimed text is the normal, untimed case');
  assert.deepEqual(calls, ['sidecar:b'], 'the route is asked first, and answered — the id-keyed and legacy calls never run');
});

test('a present row whose file is gone returns to the network without throwing', async () => {
  const { calls, library, sidecar } = sources();
  sidecar.lyricsFor = async (s) => {
    calls.push(`sidecar:${s.id}`);
    return TXT;
  };
  const store = new OfflineStore(bridge([row('a', { state: 'present', bytes: 10 })], () => null), { store: memoryStore() });
  await store.hydrate();
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  const doc = await service.lyricsFor(song());
  assert.ok(doc, 'the missing file fell through to the network, which answered');
  assert.deepEqual(calls, ['sidecar:a'], 'and no stale doc was served');
});

/* ------------------------------------------ §3: the poisoned rows a 1.9.13 build left behind */

/**
 * The download lane's bridge, modelled: `writeLyrics` is the durable copy `readLyrics` reads back,
 * and the two listeners the store subscribes to are kept, so a transfer can be driven here.
 */
function lane(rows: IndexRow[], files = new Map<string, string>()) {
  const listeners = new Map<string, (event: DownloadEvent) => void>();
  const jobs: DownloadJob[] = [];
  return {
    files,
    jobs,
    emit(name: 'done' | 'failed', event: DownloadEvent): void {
      listeners.get(name)?.(event);
    },
    configure: async () => undefined,
    enqueue: async (job: DownloadJob) => void jobs.push(job),
    cancel: async () => undefined,
    remove: async () => undefined,
    list: async () => rows,
    freeBytes: async () => -1,
    readLyrics: async (songId: string) => files.get(songId) ?? null,
    writeLyrics: async (songId: string, text: string) => void files.set(songId, text),
    addListener: async (name: string, listener: (event: DownloadEvent) => void) => {
      listeners.set(name, listener);
      return () => undefined;
    },
  };
}

test('a stored route-error body is never served: the view goes to the sources instead', async () => {
  const { calls, library, sidecar } = sources();
  sidecar.lyricsFor = async (s) => {
    calls.push(`sidecar:${s.id}`);
    return TXT;
  };
  const files = new Map([[ 'a', ROUTE_ERROR ]]);
  const store = new OfflineStore(lane([row('a', { state: 'present', bytes: ROUTE_ERROR.length })], files), {
    store: memoryStore(),
    lyricsFallback: async () => null,
  });
  await store.hydrate();
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  const doc = await service.lyricsFor(song());
  assert.ok(doc, 'the words come from the route, not from the stored JSON');
  assert.equal(doc.lines[0]?.text, 'First line', 'and they are the lyric, not the error document');
  assert.deepEqual(calls, ['sidecar:a'], 'exactly as if no copy existed');
  assert.equal(store.lyricsState('a')?.state, 'none', 'the bad row is voided, never left reading `present`');
  await settle();
});

test('a 404 on the route makes the lane store Navidrome’s body, and it renders offline', async () => {
  const { calls, library, sidecar } = sources();
  const files = new Map<string, string>();
  const bridge = lane([], files);
  const store = new OfflineStore(bridge, {
    store: memoryStore(),
    lyricsUrl: () => 'https://music.example/lyrics?path=a',
    lyricsFallback: async (s) => {
      calls.push(`navidrome:${s.id}`);
      return LRC;
    },
  });
  await store.download('pl-1', [song()]);
  assert.equal(bridge.jobs.filter((job) => job.suffix === 'lyrics').length, 1, 'the lyric goes down the transfer lane first');
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  // The route has no sidecar for this track; Navidrome does (an embedded tag).
  bridge.emit('failed', { songId: 'a', kind: 'lyrics', status: 404, error: 'no sidecar' });
  await settle();
  assert.deepEqual(calls, ['navidrome:a'], 'the 404 fell through to Navidrome, not to `none`');
  assert.equal(files.get('a'), LRC, 'the body is the stored lyric file, LRC and all');
  assert.equal(store.record('pl-1')?.state, 'complete', 'and the playlist is not left on `· retry`');

  // …and with the connection gone, the pane reads it from the device.
  const service = new LyricsService(new LyricsCache(null), () => library, () => sidecar, () => store);
  calls.length = 0;
  const doc = await service.lyricsFor(song());
  assert.ok(doc, 'the captured lyric renders with no source at all');
  assert.equal(doc.synced, true, 'with its timings: the highlight survives the round trip');
  assert.equal(doc.lines[0]?.timeMs, 1000);
  assert.deepEqual(calls, [], 'zero network calls');
});

test('a poisoned view cache is refused too: the pane still reaches the words', async () => {
  /*
   * v1.9.15 — the layer the 1.9.14 fix did not reach. The view cache is read **before** the
   * offline copy, and a ≤1.9.13 build had cached the 404 document as a week-long hit, so the
   * owner's pane printed the server's JSON for tracks the guards below it had already cleaned
   * up. Both poisoned layers are present here, exactly as they are on his phone.
   */
  const { calls, library, sidecar } = sources();
  sidecar.lyricsFor = async (s) => {
    calls.push(`sidecar:${s.id}`);
    return TXT;
  };
  const cacheStore = memoryStore();
  cacheStore.setItem('navilite.lyrics.v1', JSON.stringify([{ key: 'a', at: Date.now(), doc: fromSidecar(ROUTE_ERROR) }]));
  const cache = new LyricsCache(cacheStore);
  const files = new Map([['a', ROUTE_ERROR]]);
  const store = new OfflineStore(lane([row('a', { state: 'present', bytes: ROUTE_ERROR.length })], files), {
    store: memoryStore(),
    lyricsFallback: async () => null,
  });
  await store.hydrate();
  const service = new LyricsService(cache, () => library, () => sidecar, () => store);

  const doc = await service.lyricsFor(song());
  await settle();
  assert.ok(doc, 'the pane has words to show');
  assert.equal(doc.lines[0]?.text, 'First line', 'the lyric, not the route’s error document');
  assert.deepEqual(calls, ['sidecar:a'], 'the poisoned cache answered for nobody');
  assert.equal(cache.get('a')?.lines[0]?.text, 'First line', 'and the cache now holds the words');
  assert.equal(store.lyricsState('a')?.state, 'none', 'the poisoned row was voided, as at 1.9.14');
});
