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
import { OfflineStore, type IndexRow } from '../src/state/offline.ts';
import { LyricsCache } from '../src/storage/lyrics.ts';
import type { LyricsSource } from '../src/api/lyrics.ts';
import type { SidecarSource } from '../src/api/sidecar.ts';
import type { Song, StructuredLyrics } from '../src/api/types.ts';

const song = (id = 'a'): Song => ({ id, title: 'Track', artist: 'Someone', album: 'Something', duration: 180 });

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
