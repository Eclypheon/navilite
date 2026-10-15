/**
 * The on-device lyrics cache, from the owner's point of view.
 *
 * Navi writes sidecars while the library is being listened to, so a track can be opened *before*
 * its lyrics exist and gain them later. That is exactly the case the owner tripped over — "tracks
 * I opened before the corpus existed stayed blank" — and it is the behaviour these tests pin down:
 *
 *   - a visit that finds nothing is remembered **briefly**, so a library full of tracks without
 *     lyrics does not re-ask on every scroll past;
 *   - the miss expires in **minutes**, not in hours, so a sidecar that lands afterwards is picked
 *     up without the user clearing anything — including a miss that a *previous* build wrote
 *     with its six-hour window, which v1.3 must not inherit;
 *   - a hit lives longer than a miss but not forever: the route serves the file as it is now, so
 *     a `.txt` that is later upgraded to a timed `.lrc` has to be able to appear.
 *
 * Both halves are asserted, including the one that is easy to forget: inside the miss window the
 * app will still say "no lyrics" for a track that now has them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LyricsService } from '../src/lyrics/service.ts';
import { LyricsCache } from '../src/storage/lyrics.ts';
import { fromSidecar } from '../src/api/lyrics.ts';
import type { Song } from '../src/api/types.ts';

const song: Song = {
  id: 'album-1-1-track-3',
  title: 'Track 3',
  artist: 'Alien Lab',
  album: 'Alien Lab — Transmission',
  albumId: 'album-1-1',
  duration: 30,
  path: 'Alien Lab/Alien Lab — Transmission/03 - Track 3.wav',
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

test('a track opened before its lyrics existed shows them once the miss expires', async () => {
  let clock = Date.UTC(2026, 0, 1);
  const cache = new LyricsCache(fakeStorage(), () => clock);
  let sidecarExists = false;
  let fetches = 0;
  const service = new LyricsService(
    cache,
    () => ({
      getLyricsBySongId: async () => [],
      getLyrics: async () => null,
    }),
    () => ({
      lyricsFor: async () => {
        fetches += 1;
        return sidecarExists ? 'kimi no koe ga kikoeru\n' : null;
      },
    }),
  );

  assert.equal(await service.lyricsFor(song), null, 'no sidecar yet: the panel says so');
  assert.equal(fetches, 1);

  // The sidecar lands while the app is open. A second visit inside the miss window is still
  // served from the cache — worth knowing, and the reason the window is five minutes.
  sidecarExists = true;
  assert.equal(await service.lyricsFor(song), null, 'the miss is cached, so the next visit inside the window still says none');
  assert.equal(fetches, 1, 'and the library is not asked again');

  // Five minutes later the miss has expired: the same track is asked for again and the words
  // appear. Under v1.2's six-hour window the owner was still looking at a blank screen.
  clock += 5 * MINUTE_MS + 1;
  const doc = await service.lyricsFor(song);
  assert.equal(fetches, 2, 'the expired miss means one more question, not a permanent blank');
  assert.equal(doc?.lines[0].text, 'kimi no koe ga kikoeru');
  assert.equal(doc?.source, 'route');
});

test('a miss written by the previous build is not inherited', async () => {
  // v1.2 kept a miss for six hours. Upgrading has to re-ask rather than carry that blank
  // forward, which is the whole point of the owner's report.
  let clock = Date.UTC(2026, 0, 1);
  const cache = new LyricsCache(fakeStorage(), () => clock);
  cache.set(song.id, null); // what v1.2 wrote
  clock += HOUR_MS;
  assert.equal(cache.get(song.id), undefined, 'an hour-old miss is already expired in v1.3');

  const service = new LyricsService(
    cache,
    () => ({
      getLyricsBySongId: async () => [{ line: [{ value: 'the sidecar that arrived since' }] }],
      getLyrics: async () => null,
    }),
    () => null,
  );
  const doc = await service.lyricsFor(song);
  assert.equal(doc?.lines[0].text, 'the sidecar that arrived since');
});

test('a hit is kept far longer than a miss, but not forever', async () => {
  let clock = Date.UTC(2026, 0, 1);
  const cache = new LyricsCache(fakeStorage(), () => clock);
  let fetches = 0;
  const service = new LyricsService(cache, () => ({
    getLyricsBySongId: async () => {
      fetches += 1;
      return [{ line: [{ value: 'once' }] }];
    },
    getLyrics: async () => null,
  }));

  await service.lyricsFor(song);
  clock += DAY_MS;
  assert.equal((await service.lyricsFor(song))?.lines[0].text, 'once');
  assert.equal(fetches, 1, 'a day later the words are still served from the device');

  // A week on, the track is asked for again: a `.txt` sidecar that has since been upgraded to a
  // timed `.lrc` (or a better file in general) has to be able to replace what is on the device.
  clock += 7 * DAY_MS;
  await service.lyricsFor(song);
  assert.equal(fetches, 2, 'the hit expires after a week so an upgraded sidecar can land');
});

test('the cache survives a relaunch, and clear() empties it', async () => {
  const storage = fakeStorage();
  const first = new LyricsCache(storage, () => Date.UTC(2026, 0, 1));
  first.set(song.id, { source: 'route', synced: false, fullRomaji: true, lines: [{ timeMs: null, text: 'kept' }] });
  assert.equal(first.size, 1);

  // A fresh instance over the same storage is what a relaunch looks like.
  const second = new LyricsCache(storage, () => Date.UTC(2026, 0, 1));
  assert.equal(second.get(song.id)?.lines[0].text, 'kept');

  second.clear();
  assert.equal(second.get(song.id), undefined);
  assert.equal(new LyricsCache(storage, () => Date.UTC(2026, 0, 1)).size, 0);
});

/**
 * v1.9.15 — the cache boundary.
 *
 * v1.9.14 made the offline copy, the download lane and the native completion handler refuse the
 * lyrics route's 404 document, and the owner's pane still showed it: the view cache is read
 * **first** (`src/lyrics/service.ts`), and a ≤1.9.13 build had cached that document as a
 * week-long hit. The boundary is therefore closed in both directions here — the entry a
 * previous build left is not served, and the document cannot be written back in as a hit.
 */
test('the route’s 404 document is refused at the cache boundary, in both directions', () => {
  const routeError = '{"error": "no lyrics sidecar for this track", "path": "yorushika/eruma/13 - 海底、月明kari.opus", "tried": ["….lrc", "….txt"]}';
  const poisoned = fromSidecar(routeError);
  assert.ok(poisoned, 'the body parses — that is exactly why it has to be refused on content');

  // What a ≤1.9.13 build left behind: the parsed document, stored as a week-long hit under the
  // key this cache has always written.
  const storage = fakeStorage();
  storage.setItem('navilite.lyrics.v1', JSON.stringify([{ key: song.id, at: Date.UTC(2026, 0, 1), doc: poisoned }]));
  const cache = new LyricsCache(storage, () => Date.UTC(2026, 0, 2));
  assert.equal(cache.get(song.id), undefined, 'a poisoned entry is not an answer');
  assert.equal(cache.size, 0, 'and it is dropped, not left to be re-examined for a week');

  // …and it cannot come back in through the other door.
  cache.set(song.id, poisoned);
  assert.equal(cache.get(song.id), null, 'the error document is never held as a hit — the honest "nothing yet" is');

  // The words themselves pass through the boundary untouched, timings included.
  cache.set(song.id, fromSidecar('[00:01.00]A line\n[00:02.00]Another'));
  assert.equal(cache.get(song.id)?.lines[1]?.text, 'Another');
  assert.equal(cache.get(song.id)?.synced, true);
});
