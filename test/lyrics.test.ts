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
  fromSidecar,
  fromStructured,
  parseLrc,
  parsePlain,
  type LyricsSource,
} from '../src/api/lyrics.ts';
import { LyricsRoute, nativeSidecarFetch, type SidecarFetch, type SidecarSource } from '../src/api/sidecar.ts';
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

/** A track with the library path Navidrome reports, which is what the route is asked with. */
const songWithPath: Song = {
  ...song,
  path: 'ヨルシカ/エルマ/06 - 神様のダンス.opus',
};

function source(overrides: Partial<LyricsSource> = {}): LyricsSource {
  return {
    getLyricsBySongId: async () => [],
    getLyrics: async () => null,
    ...overrides,
  };
}

/** A stand-in for the library's own lyric route. */
function sidecar(body: string | null, onAsk?: (song: Song) => void): SidecarSource {
  return {
    lyricsFor: async (asked) => {
      onAsk?.(asked);
      return body;
    },
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

/* ------------------------------------------------------- our own lyric route */

test('the route answers the sidecar file itself, timed or not, and is a first-class source', () => {
  const plain = fromSidecar('one line\ntwo line\n');
  assert.equal(plain?.source, 'route');
  assert.equal(plain?.synced, false, 'no timings is the normal case, not a failure');
  assert.deepEqual(
    plain?.lines.map((line) => line.text),
    ['one line', 'two line'],
  );

  const timed = fromSidecar('[00:01.00]one\n[00:02.50]two\n');
  assert.equal(timed?.source, 'route');
  assert.equal(timed?.synced, true);
  assert.deepEqual(timed?.lines, [
    { timeMs: 1000, text: 'one' },
    { timeMs: 2500, text: 'two' },
  ]);

  assert.equal(fromSidecar(''), null);
  assert.equal(fromSidecar('\n  \n'), null);
});

test('the route URL carries the track path percent-encoded, exactly as the server expects', () => {
  // The shape Nova's service documents and the curl transcript shows: `?path=<relative path>`,
  // audio extension included. Spaces, `/`, `·` and Japanese are all escaped by the client.
  const route = new LyricsRoute('');
  assert.equal(
    route.urlFor(songWithPath),
    '/lyrics?path=%E3%83%A8%E3%83%AB%E3%82%B7%E3%82%AB%2F%E3%82%A8%E3%83%AB%E3%83%9E%2F06%20-%20%E7%A5%9E%E6%A7%98%E3%81%AE%E3%83%80%E3%83%B3%E3%82%B9.opus',
  );

  // A library on another origin (the native builds always are) is asked at that origin's door.
  const remote = new LyricsRoute('https://library.test:9443/');
  assert.match(remote.urlFor(songWithPath) ?? '', /^https:\/\/library\.test:9443\/lyrics\?path=/);

  // No path on the song: there is nothing to ask with, and the route is not asked at all.
  assert.equal(route.urlFor(song), null);
});

test('the route never throws: 404, a refusal, an abort and a dead route all mean "no lyrics"', async () => {
  const calls: string[] = [];
  const asking: SidecarFetch = async (url) => {
    calls.push(url);
    return { status: 200, body: 'kimi no koe\n' };
  };
  const route = new LyricsRoute('', { fetch: asking });
  assert.equal(await route.lyricsFor(songWithPath), 'kimi no koe\n');
  assert.equal(calls.length, 1);

  for (const answer of [
    { status: 404, body: '{"error":"no lyrics sidecar for this track"}' },
    { status: 400, body: '{"error":"rejected path"}' },
    { status: 503, body: '{"error":"music root is not a directory"}' },
    { status: 200, body: '   \n' },
  ]) {
    const stand = new LyricsRoute('', { fetch: async () => answer });
    assert.equal(await stand.lyricsFor(songWithPath), null, `${answer.status} means none`);
  }

  const offline = new LyricsRoute('', {
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(await offline.lyricsFor(songWithPath), null);

  const silent = new LyricsRoute('', { fetch: async () => null });
  assert.equal(await silent.lyricsFor(songWithPath), null);

  // A track with no library path is never asked for: no request, no answer.
  let asked = 0;
  const skipped = new LyricsRoute('', {
    fetch: async () => {
      asked += 1;
      return { status: 200, body: 'should not happen' };
    },
  });
  assert.equal(await skipped.lyricsFor(song), null);
  assert.equal(asked, 0);
});

test('inside the wrapped builds the route is fetched with the platform client, not the browser', async () => {
  // The route sends no Access-Control-Allow-Origin, and inside the APK/IPA the page's origin is
  // the webview's own, so a browser fetch there is refused before the text arrives. The native
  // builds therefore use the OS's HTTP client, whose request has no browser origin to check.
  const calls: Array<Record<string, unknown>> = [];
  const http = {
    request: async (options: Record<string, unknown>) => {
      calls.push(options);
      return { status: 200, data: '[00:01.00]kimi no koe\n[00:02.00]ga kikoeru\n' };
    },
  };
  const route = new LyricsRoute('https://library.test:9443', {
    fetch: nativeSidecarFetch(http as never),
    timeoutMs: 4000,
  });
  const body = await route.lyricsFor(songWithPath);
  assert.match(body ?? '', /kimi no koe/);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    'https://library.test:9443/lyrics?path=%E3%83%A8%E3%83%AB%E3%82%B7%E3%82%AB%2F%E3%82%A8%E3%83%AB%E3%83%9E%2F06%20-%20%E7%A5%9E%E6%A7%98%E3%81%AE%E3%83%80%E3%83%B3%E3%82%B9.opus',
  );
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[0]?.responseType, 'text');
  assert.equal(calls[0]?.connectTimeout, 4000);
  assert.equal(calls[0]?.readTimeout, 4000);

  // What the platform hands back for a 404: a JSON body, which is not a lyric.
  const missing = nativeSidecarFetch({
    request: async () => ({ status: 404, data: { error: 'no lyrics sidecar for this track' } }),
  } as never);
  assert.equal(await new LyricsRoute('', { fetch: missing }).lyricsFor(songWithPath), null);

  // And a client that fails outright (no route, no network) is still just "no lyrics".
  const dead = nativeSidecarFetch({
    request: async () => {
      throw new Error('the host is not reachable');
    },
  } as never);
  assert.equal(await new LyricsRoute('', { fetch: dead }).lyricsFor(songWithPath), null);
});

test('fetchLyrics asks our own route first and does not touch the Subsonic calls when it answers', async () => {
  const seen: string[] = [];
  const doc = await fetchLyrics(
    songWithPath,
    source({
      getLyricsBySongId: async (id) => {
        seen.push(`structured:${id}`);
        return [{ synced: true, line: [{ start: 0, value: 'navidrome answer' }] }];
      },
      getLyrics: async () => {
        seen.push('legacy');
        return { artist: 'Alien Lab', title: 'Track 3', value: 'legacy' };
      },
    }),
    sidecar('[00:01.00]route line one\n[00:02.00]route line two\n', (asked) => seen.push(`route:${asked.id}`)),
  );
  assert.equal(doc?.source, 'route');
  assert.deepEqual(seen, [`route:${songWithPath.id}`]);
  assert.deepEqual(doc?.lines, [
    { timeMs: 1000, text: 'route line one' },
    { timeMs: 2000, text: 'route line two' },
  ]);
});

test('an empty or broken route falls back to Navidrome, and a route-less setup still works', async () => {
  const nothing = await fetchLyrics(
    songWithPath,
    source({ getLyricsBySongId: async () => [{ line: [{ value: 'from navidrome' }] }] }),
    sidecar(null),
  );
  assert.equal(nothing?.source, 'sidecar');
  assert.equal(nothing?.lines[0].text, 'from navidrome');

  const broken = await fetchLyrics(
    songWithPath,
    source({ getLyricsBySongId: async () => [{ line: [{ value: 'from navidrome' }] }] }),
    {
      lyricsFor: async () => {
        throw new Error('the route exploded');
      },
    },
  );
  assert.equal(broken?.lines[0].text, 'from navidrome');

  // No route at all (the server has none): exactly the v1.2 behaviour.
  const without = await fetchLyrics(song, source({ getLyricsBySongId: async () => [{ line: [{ value: 'plain v1.2' }] }] }));
  assert.equal(without?.lines[0].text, 'plain v1.2');

  // Everything empty: still null, never a throw.
  assert.equal(await fetchLyrics(songWithPath, source(), sidecar(null)), null);
  assert.equal(await fetchLyrics(songWithPath, null, sidecar(null)), null);
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
  for (const file of ['../src/api/lyrics.ts', '../src/api/sidecar.ts']) {
    const module = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    const code = module.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/lrclib|https?:\/\//i.test(code), false, `${file} must not name an outside service`);
  }
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

test('the service hands the route through: a track the library route can answer never reaches the API', async () => {
  let structured = 0;
  const service = new LyricsService(
    fakeCache(),
    () =>
      source({
        getLyricsBySongId: async () => {
          structured += 1;
          return [{ line: [{ value: 'from navidrome' }] }];
        },
      }),
    () => sidecar('route line one\nroute line two\n'),
  );
  const doc = await service.lyricsFor(songWithPath);
  assert.equal(doc?.source, 'route');
  assert.deepEqual(
    doc?.lines.map((line) => line.text),
    ['route line one', 'route line two'],
  );
  assert.equal(structured, 0, 'the route answered, so Navidrome was never asked');
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
