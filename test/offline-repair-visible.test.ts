/**
 * v1.9.23 — **the repaired row reaches the screen, and the track he is playing with it.**
 *
 * The store's repair (v1.9.22, `OfflineStore.repairMetadata`) is not the whole fix, and v1.9.22
 * shipped as if it were: it filled the rows and nothing that draws from them, so the owner opened
 * **On this phone**, read his own screenshot back — a column of blank titles and `--:--` — and only
 * saw the names after leaving the screen and returning. Two objects can hold a blank copy of the
 * same song and this file is about both of them:
 *
 *   - the **row** a view drew, whose title/sub-line/time were written once, at build
 *     (`src/ui/app.ts`, `songRow`: `titleNode`/`subNode`/`timeNode` + `paintText`);
 *   - the **queue's** own copy, which is the object the view handed it at the tap and which the
 *     player bar prints — `currentSong` *is* that object (`src/state/queue.ts`), so a blank one is a
 *     blank title in the bar and the bar's total is
 *     `status.durationMs || (song.duration ?? 0) * 1000` = `0:00` (`src/ui/app.ts`,
 *     `updatePlayerBar`). That is the other half of his screenshot.
 *
 * What is provable here is the **mechanism**, on the real `OfflineStore` and the real
 * `PlaybackQueue`: a legacy store, the repair, the fill the UI drives, and the number the bar draws.
 * The screen half — the rows repainting in place, on the route he is looking at — is a browser
 * reading, and it is asserted in `test/offline-views.test.ts` against the harness's own report
 * (`tools/offline-check.mjs`, the "a row a 1.9.19 build wrote" block).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { MirrorStore } from '../src/storage/offline.ts';
import { OfflineStore } from '../src/state/offline.ts';
import { PlaybackQueue } from '../src/state/queue.ts';
import { fillSong } from '../src/state/song-metadata.ts';
import { formatDuration, formatTime } from '../src/ui/dom.ts';
import type { AudioEngine, PublishedTrack, TrackRequest } from '../src/player/engine.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

const CONTEXT: QueueContext = { kind: 'downloads', name: 'On this phone' };
const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 10 });

/** A `localStorage` stand-in, so the store reads and writes a mirror it can be inspected through. */
function memoryStore(): MirrorStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * The legacy store, exactly as `parseMirror` reads what a 1.9.19 build wrote: `path`, `bytes` and
 * `state` on every row, no metadata key anywhere. The manifest beside the rows is the download's own
 * record — the `Song`s the playlist was answered with — so this repair needs no connection at all.
 */
function legacyStore(rows: string[], manifestSongs: Song[] | null = null): OfflineStore {
  const mirror = memoryStore();
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: Object.fromEntries(rows.map((id) => [id, { path: `file:///${id}.mp3`, bytes: 1000, state: 'complete' }])),
      ...(manifestSongs === null
        ? {}
        : { playlists: { 'pl-1': { songs: manifestSongs, name: 'Driving', requestedAt: Date.now(), state: 'complete' } } }),
    }),
  );
  return new OfflineStore(null, { store: mirror });
}

interface Stub {
  engine: AudioEngine;
  played: string[];
}

function stubEngine(): Stub {
  const played: string[] = [];
  const engine = {
    onEnded: null as null | (() => void),
    onProgress: null as null | ((positionMs: number, durationMs: number) => void),
    onNextRequested: null as null | (() => void),
    onPreviousRequested: null as null | (() => void),
    onAdvancedNatively: null,
    status: () => ({ state: 'playing' as const, positionMs: 0, durationMs: 0 }),
    play: (track: TrackRequest) => {
      played.push(track.url);
      return Promise.resolve();
    },
    prepareNext: async () => true,
    warmedUrl: () => null,
    pruneWarmed: () => undefined,
    discardPrepared: async () => undefined,
    seek: async () => undefined,
    resume: async () => undefined,
    pause: async () => undefined,
    stop: async () => undefined,
    toggle: async () => undefined,
    setQueue: (statement: { list: readonly PublishedTrack[]; index: number }) => void statement,
  };
  return { engine: engine as unknown as AudioEngine, played };
}

function stubLibrary(): Library {
  return {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (track: Song) => `http://127.0.0.1:4599/rest/stream?id=${track.id}`,
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined },
  } as unknown as Library;
}

/**
 * The bar's own total, stated the way `updatePlayerBar` states it
 * (`formatTime((status.durationMs || (song.duration ?? 0) * 1000) / 1000)`), with the engine's status
 * duration at 0 — which is what it reports for a track whose request carried no duration, the case
 * this chain is about. The rendered number is asserted in the browser reading
 * (`tools/offline-check.mjs`); what is asserted here is the arithmetic that number is made of.
 */
function barTotal(song: Song | null, statusDurationMs = 0): string {
  return formatTime((statusDurationMs || (song?.duration ?? 0) * 1000) / 1000);
}

/**
 * The defect, as the two things he can see — and then the fix, on the same objects.
 *
 * The row's own numbers come first (`--:--`, a blank title: the first test of
 * `test/offline-browse.test.ts`'s legacy case asserts them on the store, and this one asserts what
 * the *queue* holds after the tap), then the repair, then the fill the UI drives. The bar is not
 * simulated: the assertion is the bar's own expression, with `status.durationMs` 0.
 */
test('the queue’s own copy of a song is filled by the repair, so the bar’s name and total are the repaired ones', async () => {
  const store = legacyStore(['a', 'b'], [song('a'), song('b')]);
  const stub = stubEngine();
  const queue = new PlaybackQueue(stub.engine, stubLibrary());
  let redraws = 0;
  queue.onChanged = () => {
    redraws += 1;
  };

  // The view's first paint: the rows, and the queue's copy of *the same objects* (which is what
  // `renderDownloads` does — `items` is built from `downloadedSongs()`'s entries).
  const items = store.downloadedSongs().map((entry) => ({ song: entry, context: CONTEXT }));
  queue.select(items, 0, CONTEXT);
  const played = queue.currentSong;
  assert.equal(played, items[0]?.song, 'the queue plays the very object the row was drawn from');
  assert.equal(played?.title, '', 'the tap lands on a song with no title — his screenshot’s row');
  assert.equal(formatDuration(played?.duration), '--:--', 'and no length: the row prints `--:--`');
  assert.equal(barTotal(played), '0:00', 'and the bar’s total is 0:00 beside it');

  // The repair fills the store's rows…
  assert.equal(await store.repairMetadata(), 2, 'the download’s own record names both rows');
  assert.equal(store.downloadedSongs()[0]?.title, 'Track a', 'the store now knows the name');
  assert.equal(
    queue.currentSong?.title,
    '',
    '…and the queue still holds the blank copy: v1.9.22 shipped exactly this, which is why the screen did not change',
  );

  // …and the fill the UI drives (the store’s own notify) reaches the queue’s copy.
  const filled = queue.applyMetadata((songId) => store.songFor(songId));
  assert.equal(filled, 2, 'both entries in the queue are filled from the store’s answer');
  assert.equal(queue.currentSong?.title, 'Track a', 'the title reaches the queue');
  assert.equal(queue.currentSong?.artist, 'Someone', 'the sub-line’s artist with it');
  assert.equal(queue.currentSong?.duration, 10, 'and the length the bar’s total is built from');
  assert.equal(barTotal(queue.currentSong), '0:10', 'so the bar draws 0:10, not 0:00');
  assert.equal(queue.currentSong?.id, 'a', 'and the id is untouched: nothing was replaced, only filled');
  assert.ok(redraws >= 2, `the bar is redrawn by the fill itself (${redraws} onChanged calls), not left to the next status event`);

  // Idempotent: a second pass has nothing to fill, so it does not redraw.
  const before = redraws;
  assert.equal(queue.applyMetadata((songId) => store.songFor(songId)), 0, 'nothing left to fill');
  assert.equal(redraws, before, 'and nothing to repaint');
});

/**
 * The honesty rule, on the queue's half of it: **only what is missing is filled.**
 *
 * A song the library answered with is complete, so the phone's copy of that id must never overwrite
 * it — and a track nobody can name yet keeps the blank it already draws rather than gaining its own
 * id in the title slot or a zero in the duration field, which would read as data.
 */
test('a song the library answered with is never overwritten, and one nobody can name keeps its blank', async () => {
  const store = legacyStore(['a', 'b'], [song('a')]);
  assert.equal(await store.repairMetadata(), 1, 'only `a` is named by the record');

  // Everything the library answered with, and nothing the phone's row for `a` has to say about it.
  const fromServer: Song = {
    id: 'a',
    title: 'Named by the server already',
    artist: 'The library',
    album: 'From the library',
    duration: 200,
    coverArt: 'cover-server',
  };
  const nameless: Song = { id: 'b', title: '', suffix: 'mp3' };
  const queue = new PlaybackQueue(stubEngine().engine, stubLibrary());
  queue.select(
    [
      { song: fromServer, context: CONTEXT },
      { song: nameless, context: CONTEXT },
    ],
    0,
    CONTEXT,
  );

  assert.equal(
    queue.applyMetadata((songId) => store.songFor(songId)),
    0,
    'the complete song is left exactly as it is, and the nameless row stays nameless',
  );
  assert.deepEqual(
    [fromServer.title, fromServer.artist, fromServer.album, fromServer.duration, fromServer.coverArt],
    ['Named by the server already', 'The library', 'From the library', 200, 'cover-server'],
    'nothing the library said was replaced by the phone’s copy of the same id',
  );
  assert.deepEqual(
    [nameless.title, nameless.duration, nameless.artist],
    ['', undefined, undefined],
    'and the row nobody can name draws what it drew: no id, no `0` standing in for a length',
  );
  assert.equal(formatDuration(nameless.duration), '--:--', 'which is the placeholder, not a fake time');
});

/**
 * The store's answer for **one** id, which both callers read from: it has to be the same row the list
 * draws, or the row and the bar could disagree about one track.
 */
test('the store answers for one song id with the same row the list draws, and nothing for what it does not hold', async () => {
  const mirror = memoryStore();
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: {
        a: { path: 'file:///a.mp3', bytes: 1000, state: 'complete' },
        // In flight, and named: not a file this phone can play yet.
        b: { path: 'file:///b.mp3', bytes: 2000, state: 'staging', title: 'Track b', durationSec: 20 },
      },
      playlists: { 'pl-1': { songs: [song('a')], name: 'Driving', requestedAt: Date.now(), state: 'complete' } },
    }),
  );
  const store = new OfflineStore(null, { store: mirror });
  assert.equal(await store.repairMetadata(), 1);

  const listed = store.downloadedSongs();
  assert.equal(listed.length, 1, 'only the complete row is in the list');
  assert.deepEqual(store.songFor('a'), listed[0], 'and the per-id answer is that very row');
  assert.equal(formatDuration(store.songFor('a')?.duration), '0:10', 'with its duration');
  assert.equal(store.songFor('b'), null, 'a file that has not landed is not a song to draw');
  assert.equal(store.songFor('nobody'), null, 'and neither is an id this phone does not hold');
});

/** The rule itself, where it is stated once (`src/state/song-metadata.ts`). */
test('the fill rule writes empty fields only, and returns how many it wrote', () => {
  const target: Song = { id: 'a', title: '', suffix: 'mp3' };
  const from: Song = { id: 'a', title: 'Track a', artist: 'Someone', album: 'Something', duration: 10, coverArt: 'cover-1' };

  assert.equal(fillSong(target, from), 5, 'title, artist, album, duration and the cover id');
  assert.deepEqual(
    [target.title, target.artist, target.album, target.duration, target.coverArt, target.suffix],
    ['Track a', 'Someone', 'Something', 10, 'cover-1', 'mp3'],
    'and the row keeps everything it already had',
  );
  assert.equal(fillSong(target, from), 0, 'a filled song has nothing left to fill');

  // A partial copy: one field, and never the id in the title slot.
  const partial: Song = { id: 'b', title: '', duration: 12 };
  assert.equal(fillSong(partial, { id: 'b', title: '', artist: '', duration: 0 }), 0, 'an empty source fills nothing');
  assert.deepEqual([partial.title, partial.duration], ['', 12], 'a nameless row stays nameless, a length is never zeroed');
});
