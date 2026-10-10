/**
 * The on-device lyrics cache, from the owner's point of view.
 *
 * Navi writes sidecars while the library is being listened to, so a track can be opened *before*
 * its lyrics exist and gain them later. That is exactly the case the owner tripped over, and it
 * is the behaviour these tests pin down:
 *
 *   - a visit that finds nothing is remembered briefly, so a library full of tracks without
 *     lyrics does not re-ask on every scroll past;
 *   - the miss expires in hours, not in days, so a sidecar that lands afterwards is picked up
 *     without the user clearing anything.
 *
 * Both halves are asserted, including the one that is easy to forget: inside the miss window the
 * app will still say "no lyrics" for a track that now has them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LyricsService } from '../src/lyrics/service.ts';
import { LyricsCache } from '../src/storage/lyrics.ts';
import type { Song } from '../src/api/types.ts';

const song: Song = {
  id: 'album-1-1-track-3',
  title: 'Track 3',
  artist: 'Alien Lab',
  album: 'Alien Lab — Transmission',
  albumId: 'album-1-1',
  duration: 30,
};

const HOUR_MS = 60 * 60 * 1000;

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
  const service = new LyricsService(cache, () => ({
    getLyricsBySongId: async () => {
      fetches += 1;
      return sidecarExists ? [{ line: [{ value: 'kimi no koe ga kikoeru' }] }] : [];
    },
    getLyrics: async () => null,
  }));

  assert.equal(await service.lyricsFor(song), null, 'no sidecar yet: the panel says so');
  assert.equal(fetches, 1);

  // The sidecar lands while the app is open. A second visit inside the miss window is still
  // served from the cache — worth knowing, and the reason the window is short.
  sidecarExists = true;
  assert.equal(await service.lyricsFor(song), null, 'the miss is cached, so the next visit inside the window still says none');
  assert.equal(fetches, 1, 'and the library is not asked again');

  // Hours later the miss has expired: the same track is asked for again and the words appear.
  clock += 6 * HOUR_MS + 1;
  const doc = await service.lyricsFor(song);
  assert.equal(fetches, 2, 'the expired miss means one more question, not a permanent blank');
  assert.equal(doc?.lines[0].text, 'kimi no koe ga kikoeru');
});

test('a hit is kept far longer than a miss', async () => {
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
  clock += 24 * HOUR_MS;
  assert.equal((await service.lyricsFor(song))?.lines[0].text, 'once');
  assert.equal(fetches, 1, 'a day later the words are still served from the device');
});

test('the cache survives a relaunch, and clear() empties it', async () => {
  const storage = fakeStorage();
  const first = new LyricsCache(storage, () => Date.UTC(2026, 0, 1));
  first.set(song.id, { source: 'sidecar', synced: false, fullRomaji: true, lines: [{ timeMs: null, text: 'kept' }] });
  assert.equal(first.size, 1);

  // A fresh instance over the same storage is what a relaunch looks like.
  const second = new LyricsCache(storage, () => Date.UTC(2026, 0, 1));
  assert.equal(second.get(song.id)?.lines[0].text, 'kept');

  second.clear();
  assert.equal(second.get(song.id), undefined);
  assert.equal(new LyricsCache(storage, () => Date.UTC(2026, 0, 1)).size, 0);
});
