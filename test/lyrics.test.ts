/**
 * Lyrics: one source (the owner's library), three shapes of answer, and the honesty rules.
 *
 * The tests here are the contract the UI relies on:
 *   - a `.lrc` sidecar → timed lines the highlight can follow;
 *   - a `.txt` sidecar → untimed lines, which is the *normal* case and must never look broken;
 *   - nothing for the track → `null`, never an error and never invented text;
 *   - the app asks its own server and nobody else.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchLyrics,
  fromBlob,
  fromStructured,
  parseLrc,
  parsePlain,
  type LyricsSource,
} from '../src/api/lyrics.ts';
import type { Song } from '../src/api/types.ts';
import { LyricsService } from '../src/lyrics/service.ts';
import type { LyricsStore } from '../src/storage/lyrics.ts';

const song: Song = {
  id: 'album-1-1-track-3',
  title: 'Track 3',
  artist: 'Alien Lab',
  album: 'Alien Lab — Transmission',
  albumId: 'album-1-1',
  duration: 30,
};

function source(overrides: Partial<LyricsSource> = {}): LyricsSource {
  return {
    getLyricsBySongId: async () => [],
    getLyrics: async () => null,
    ...overrides,
  };
}

/* --------------------------------------------------------------- parsing */

test('parseLrc reads timings, and a line without one stays untimed', () => {
  const lines = parseLrc(['[00:12.50]first', 'untimed middle', '[01:05]last', '', '   '].join('\n'));
  assert.deepEqual(lines, [
    { timeMs: 12500, text: 'first' },
    { timeMs: null, text: 'untimed middle' },
    { timeMs: 65000, text: 'last' },
  ]);
});

test('parseLrc drops LRC metadata instead of showing it as a lyric', () => {
  const lines = parseLrc(['[ar:Someone]', '[ti:A song]', '[offset:+250]', '[00:01.00]only this'].join('\n'));
  assert.deepEqual(lines, [{ timeMs: 1000, text: 'only this' }]);
});

test('parsePlain keeps every non-empty line and times none of them', () => {
  const lines = parsePlain('one\ntwo\n\n   \nthree  \n');
  assert.deepEqual(lines, [
    { timeMs: null, text: 'one' },
    { timeMs: null, text: 'two' },
    { timeMs: null, text: 'three' },
  ]);
});

/* ------------------------------------------------- structured (Navidrome) */

test('fromStructured prefers the entry that carries timings', () => {
  const doc = fromStructured([
    { lang: 'jpn', synced: false, line: [{ value: 'plain sidecar' }] },
    { lang: 'jpn', synced: true, line: [{ start: 0, value: 'timed sidecar' }, { start: 5000, value: 'second' }] },
  ]);
  assert.ok(doc);
  assert.equal(doc.source, 'sidecar');
  assert.equal(doc.synced, true);
  assert.deepEqual(doc.lines, [
    { timeMs: 0, text: 'timed sidecar' },
    { timeMs: 5000, text: 'second' },
  ]);
});

test('fromStructured accepts an untimed sidecar as a first-class answer', () => {
  const doc = fromStructured([{ synced: false, line: [{ value: 'romaji line one' }, { value: 'romaji line two' }] }]);
  assert.ok(doc);
  assert.equal(doc.synced, false);
  assert.deepEqual(
    doc.lines.map((line) => line.text),
    ['romaji line one', 'romaji line two'],
  );
});

test('fromStructured applies the file offset to every line', () => {
  const doc = fromStructured([{ offset: 500, line: [{ start: 1000, value: 'shifted' }] }]);
  assert.deepEqual(doc?.lines, [{ timeMs: 1500, text: 'shifted' }]);
});

test('fromStructured ignores empty text and reports nothing for empty lyrics', () => {
  assert.equal(fromStructured([]), null);
  assert.equal(fromStructured([{ line: [{ start: 0, value: '' }] }]), null);
  assert.equal(fromStructured([{ line: [] }]), null);
});

/* ------------------------------------------------------ legacy plain blob */

test('fromBlob parses an LRC file served as a plain blob', () => {
  const doc = fromBlob('[00:01.00]one\n[00:02.00]two\n');
  assert.equal(doc?.source, 'blob');
  assert.equal(doc?.synced, true);
  assert.deepEqual(doc?.lines, [
    { timeMs: 1000, text: 'one' },
    { timeMs: 2000, text: 'two' },
  ]);
});

test('fromBlob treats an untimed blob as untimed lyrics, not as an error', () => {
  const doc = fromBlob('just words\nand more words\n');
  assert.equal(doc?.synced, false);
  assert.equal(doc?.lines.length, 2);
  assert.equal(fromBlob(''), null);
  assert.equal(fromBlob('\n\n'), null);
});

/* ------------------------------------------------------------ romanisation */

test('kana is romanised and kanji is reported rather than guessed', () => {
  const kanji = fromStructured([{ line: [{ value: '夜のなかを あるいていく' }] }]);
  assert.equal(kanji?.fullRomaji, false, 'the kanji char is still there, so it is not full romaji');
  assert.match(kanji?.lines[0].text ?? '', /^夜/);

  const kanaOnly = fromStructured([{ line: [{ value: 'きみのこえが きこえる' }] }]);
  assert.equal(kanaOnly?.fullRomaji, true);
  assert.equal(kanaOnly?.lines[0].text, 'kiminokoega kikoeru');

  const romajiSidecar = fromStructured([{ line: [{ value: 'kimi no koe ga kikoeru' }] }]);
  assert.equal(romajiSidecar?.fullRomaji, true);
  assert.equal(romajiSidecar?.lines[0].text, 'kimi no koe ga kikoeru', 'already-romaji text passes through');
});

/* --------------------------------------------------------------- fetching */

test('fetchLyrics asks the library first and uses the timed answer', async () => {
  const seen: string[] = [];
  const doc = await fetchLyrics(
    song,
    source({
      getLyricsBySongId: async (id) => {
        seen.push(`structured:${id}`);
        return [{ synced: true, line: [{ start: 0, value: 'kimi no koe' }] }];
      },
      getLyrics: async () => {
        seen.push('legacy');
        return { artist: 'Alien Lab', title: 'Track 3', value: 'should not be needed' };
      },
    }),
  );
  assert.equal(doc?.synced, true);
  assert.deepEqual(seen, [`structured:${song.id}`]);
});

test('fetchLyrics falls back to the old call when the server does not implement the new one', async () => {
  const doc = await fetchLyrics(
    song,
    source({
      getLyricsBySongId: async () => {
        throw new Error('not implemented');
      },
      getLyrics: async () => ({ artist: 'Alien Lab', title: 'Track 3', value: 'legacy line one\nlegacy line two' }),
    }),
  );
  assert.equal(doc?.source, 'blob');
  assert.deepEqual(
    doc?.lines.map((line) => line.text),
    ['legacy line one', 'legacy line two'],
  );
});

test('a blob for a different song is discarded, not shown', async () => {
  // The old call matches on artist and title, so a compilation or a live cut can come back
  // instead of the track that is playing. Another song's words are worse than nothing.
  const wrongTitle = await fetchLyrics(
    song,
    source({
      getLyricsBySongId: async () => [],
      getLyrics: async () => ({ artist: 'Alien Lab', title: 'Track 3 (live)', value: 'not this song' }),
    }),
  );
  assert.equal(wrongTitle, null);

  const wrongArtist = await fetchLyrics(
    song,
    source({
      getLyricsBySongId: async () => [],
      getLyrics: async () => ({ artist: 'Boot Sector', title: 'Track 3', value: 'not this artist' }),
    }),
  );
  assert.equal(wrongArtist, null);

  // Case and spacing are not a mismatch, and a server that reports no match metadata at all
  // is trusted — there is nothing to check it against.
  const forgiving = await fetchLyrics(
    song,
    source({
      getLyricsBySongId: async () => [],
      getLyrics: async () => ({ artist: ' alien lab ', title: 'track 3', value: 'ok' }),
    }),
  );
  assert.equal(forgiving?.lines[0].text, 'ok');

  const anonymous = await fetchLyrics(
    song,
    source({
      getLyricsBySongId: async () => [],
      getLyrics: async () => ({ value: 'ok' }),
    }),
  );
  assert.equal(anonymous?.lines[0].text, 'ok');
});

test('fetchLyrics answers null when the library has nothing, and never throws', async () => {
  assert.equal(await fetchLyrics(song, source()), null);
  assert.equal(await fetchLyrics(song, null), null);
  assert.equal(
    await fetchLyrics(
      song,
      source({
        getLyricsBySongId: async () => {
          throw new Error('offline');
        },
        getLyrics: async () => {
          throw new Error('offline');
        },
      }),
    ),
    null,
  );
});

test('lyrics are only ever fetched from the library — no third party in the source', () => {
  const module = readFileSync(fileURLToPath(new URL('../src/api/lyrics.ts', import.meta.url)), 'utf8');
  const code = module.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/lrclib|https?:\/\//i.test(code), false, 'the lyrics client must not name an outside service');
});

/* ---------------------------------------------------------------- service */

function fakeCache(): LyricsStore & { writes: string[] } {
  const map = new Map<string, ReturnType<LyricsStore['get']>>();
  return {
    writes: [],
    get: (key: string) => map.get(key),
    set(key: string, doc) {
      this.writes.push(key);
      map.set(key, doc);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

test('the service caches per track, including "this one has no lyrics"', async () => {
  const cache = fakeCache();
  let calls = 0;
  const service = new LyricsService(cache, () =>
    source({
      getLyricsBySongId: async () => {
        calls += 1;
        return [{ line: [{ value: 'kimi no koe' }] }];
      },
    }),
  );
  assert.equal((await service.lyricsFor(song))?.lines[0].text, 'kimi no koe');
  assert.equal((await service.lyricsFor(song))?.lines[0].text, 'kimi no koe');
  assert.equal(calls, 1, 'a second visit is served from the cache');
  assert.equal(cache.size, 1);

  const empty = new LyricsService(fakeCache(), () => source());
  assert.equal(await empty.lyricsFor({ ...song, id: 'other' }), null);
  assert.equal(empty.cachedTracks, 1, 'the miss is remembered, so it is not re-asked on every visit');
});

test('the service asks once for a track even when two panels open at once', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = new LyricsService(fakeCache(), () =>
    source({
      getLyricsBySongId: async () => {
        calls += 1;
        await gate;
        return [{ line: [{ value: 'once' }] }];
      },
    }),
  );
  const first = service.lyricsFor(song);
  const second = service.lyricsFor(song);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a?.lines[0].text, 'once');
  assert.equal(b?.lines[0].text, 'once');
});

test('forget empties the cache', async () => {
  const cache = fakeCache();
  const service = new LyricsService(cache, () => source());
  await service.lyricsFor(song);
  assert.equal(service.cachedTracks, 1);
  service.forget();
  assert.equal(service.cachedTracks, 0);
});
