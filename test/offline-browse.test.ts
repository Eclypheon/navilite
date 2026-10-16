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
import { OfflineStore, SERVER_ASKS_PER_PASS } from '../src/state/offline.ts';
import type { DownloadEvent, DownloadJob, DownloadsBridge, IndexRow } from '../src/state/offline.ts';
import { loadMirror } from '../src/storage/offline.ts';
import type { Song } from '../src/api/types.ts';
/*
 * **The row's own sentences** (v1.9.21). The three formatters below are what the Playlists row and
 * the playlist page's own control print, imported from the UI rather than re-spelled here — a test
 * that restates a format string cannot catch the format string being wrong. `src/ui/app.ts` has no
 * module-scope DOM access (importing it boots nothing: `boot()` is what draws), so a node test can
 * read them the way the app does.
 */
import { downloadControlLabel, grownControlLabel, playlistRowLabel, playlistSubLine } from '../src/ui/app.ts';
/*
 * v1.9.22 — the row's `--:--`, from the function the row actually calls. A test that restated the
 * placeholder as a literal could pass while the view drew something else.
 */
import { formatDuration } from '../src/ui/dom.ts';

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

  /*
   * **The row's own arithmetic, for that playlist** (v1.9.21).
   *
   * `badge.total` is the *manifest's* length — what was asked for when it was downloaded — and the
   * row is drawn beside the playlist the server has just described, which here is one track longer.
   * The defect: the row printed the manifest's number as the denominator, so this playlist read
   * `3 tracks · 2 of 2 on this phone` under the hollow mark while its own page said `2 of 3 · retry`
   * (the owner's shape: `270 tracks · 269 of 269 on this phone`). One fact, two numbers.
   */
  const grown = [covered('a', 'cover-a'), covered('b', 'cover-a'), covered('c', 'cover-a')];
  const grownBadge = store.playlistBadge('pl-1', grown.length);
  assert.equal(grownBadge.done, 2, 'the numerator is still the files that are here');
  assert.equal(grownBadge.total, 2, 'and the badge still says what was asked for — the manifest’s length');

  const grownRow = { id: 'pl-1', name: 'Driving', songCount: grown.length };
  assert.equal(playlistSubLine(grownRow, grownBadge), '3 tracks · 2 of 3 on this phone', 'the row prints the playlist’s own length');
  assert.equal(playlistRowLabel(grownRow, grownBadge), 'Open Driving, 2 of 3 downloaded', 'and so does the name VoiceOver reads');

  /*
   * …and **the page's own control prints the same pair** for that playlist: `downloadControl`'s
   * grown label (`grownControlLabel`, called with the same store's own `missingCount`) is
   * `2 of 3 · retry`. The two screens are asserting one fact, so the numbers must be the numbers.
   */
  const control = grownControlLabel(grown, store.missingCount('pl-1', grown));
  assert.equal(control, '2 of 3 · retry', 'the playlist page’s own control');
  assert.equal(
    /^3 tracks · (\d+ of \d+) on this phone$/.exec(playlistSubLine(grownRow, grownBadge))?.[1],
    /^(\d+ of \d+) · retry$/.exec(control)?.[1],
    'the row and the page’s own control agree on the numbers',
  );

  // …and a track that never landed leaves the playlist partial, with the count of what did.
  await store.download('pl-2', [covered('c', 'cover-a'), covered('d', 'cover-a')], { name: 'Stopped' });
  bridge.emit('done', { songId: 'c', path: 'file:///c.mp3', bytes: 1000 });
  bridge.emit('failed', { songId: 'd', error: 'HTTP 500' });
  assert.equal(store.playlistBadge('pl-2').state, 'partial');
  assert.equal(store.playlistBadge('pl-2').done, 1);

  /*
   * **The same two screens, for a download that is not `complete`** (v1.9.21's leftover). pl-2 has
   * landed one of the two files it asked for, and its playlist has grown to three tracks since —
   * the state `7453ebd` never reached: the control's `partial` and `downloading` branches printed
   * `record.total`, the **manifest's** length, so this playlist's own page read `1 of 2 · retry`
   * under a row that read `3 tracks · 1 of 3 on this phone`. One fact, two numbers, in the very
   * state the pair was introduced to fix, which is why the agreement is asserted for it too.
   *
   * The `downloading` branch is the same one call and is asserted in the lyric-in-flight test below.
   */
  const partialBadge = store.playlistBadge('pl-2', 3);
  assert.equal(partialBadge.state, 'partial', 'one file landed of two asked for, and the playlist has grown');
  const grownSongs = [covered('c', 'cover-a'), covered('d', 'cover-a'), covered('e', 'cover-a')];
  const partialRow = { id: 'pl-2', name: 'Stopped', songCount: grownSongs.length };
  /*
   * The control's own sentence, from the facts `downloadControl` resolves for it: the record the
   * store holds (whose `total` is still the manifest's two) and the playlist in front of the owner.
   * The size is passed in already formatted, the way the adapter hands it over — `partial` prints no
   * size, so it is a literal here and cannot flatter the assertion.
   */
  const partialRecord = store.record('pl-2')!;
  const partialControl = downloadControlLabel({
    state: partialRecord.state,
    done: partialRecord.done,
    total: partialRecord.total,
    songs: grownSongs,
    size: 'up to 24 MB',
    missing: store.missingCount('pl-2', grownSongs),
    missingCovers: store.missingCovers(grownSongs),
  });
  assert.equal(partialControl, '1 of 3 · retry', 'the control reads the playlist’s own length, never the manifest’s');
  assert.equal(
    /· (\d+ of \d+) on this phone$/.exec(playlistSubLine(partialRow, partialBadge))?.[1],
    /^(\d+ of \d+) · retry$/.exec(partialControl)?.[1],
    'the row and the page’s own control agree for a partial download of a grown playlist too',
  );

  await store.remove('pl-1');
  assert.equal(store.playlistBadge('pl-1').state, 'none', 'and a removed download is not marked at all');
});

/**
 * The same line's transient cousin (v1.9.21): a playlist whose audio has all landed while one
 * **lyric** is still in flight. Nothing is missing to download, the record is not `complete`, and
 * the row reads `n of m on this phone` beside the hollow mark rather than the measured size — so it
 * is the second shape that flows through the denominator, and it must be the playlist's length here
 * too, not the manifest's.
 */
test('a grown playlist with a lyric still in flight prints the playlist’s own length as well', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore(), lyricsUrl: () => 'https://music.example/lyrics?path=a' });
  await store.download('pl-1', [covered('a', 'cover-a'), covered('b', 'cover-a')], { name: 'Driving' });
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  bridge.emit('done', { songId: 'b', path: 'file:///b.mp3', bytes: 1000 });
  assert.equal(store.record('pl-1')?.state, 'downloading', 'audio in, a lyric still pending');

  // The server reports four tracks: two were downloaded, two were added afterwards.
  const badge = store.playlistBadge('pl-1', 4);
  assert.equal(badge.state, 'partial', 'the row carries the hollow mark, not a size');
  assert.equal(badge.done, badge.total, 'with every file that was asked for on the phone');
  assert.equal(
    playlistSubLine({ id: 'pl-1', name: 'Driving', songCount: 4 }, badge),
    '4 tracks · 2 of 4 on this phone',
    'the denominator is the playlist in front of the owner, not the manifest',
  );

  /*
   * …and the page's own control, whose `downloading` branch is the other half of the same pair,
   * reads the same numbers — `2 of 4`: the record it draws from is the one the store holds, whose
   * `total` is still the manifest's two, and the length it prints comes from the playlist in front
   * of the owner, exactly as the row's does (v1.9.21's leftover). This is the branch the defect was
   * not filed against and the one a lyric still in flight lands in.
   */
  const grownSongs = [covered('a', 'cover-a'), covered('b', 'cover-a'), covered('c', 'cover-a'), covered('d', 'cover-a')];
  const grownRecord = store.record('pl-1')!;
  const control = downloadControlLabel({
    state: grownRecord.state,
    done: grownRecord.done,
    total: grownRecord.total,
    songs: grownSongs,
    size: 'up to 24 MB',
    missing: store.missingCount('pl-1', grownSongs),
    missingCovers: store.missingCovers(grownSongs),
  });
  assert.equal(control, '2 of 4 · up to 24 MB', 'the playlist page’s own control, while a lyric is still in flight');
  assert.equal(
    /· (\d+ of \d+) on this phone$/.exec(playlistSubLine({ id: 'pl-1', name: 'Driving', songCount: 4 }, badge))?.[1],
    /^(\d+ of \d+) · up to 24 MB$/.exec(control)?.[1],
    'the row and the page’s own control agree while a lyric is still in flight, too',
  );
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

/* ------------------------------------------------- the rows that carry no metadata (v1.9.22) */

/**
 * The owner, on the installed build: *"the library was populated by a bunch of nameless songs with
 * no durations... when I click in, they are playable and even have album art and lyrics. I went to
 * the individual playlists and neither had blank songs."*
 *
 * 497 tracks, ten rows of blanks with `--:--` where the duration goes, and every file fine. The
 * rows were written by a build before v1.9.20 carried a copy of the song's title/artist/album/
 * coverArt/duration (`src/storage/offline.ts:24-38`), and `downloadedSongs()` maps a row straight
 * to a `Song` — so the view printed what the row had, which was nothing, and nothing ever went back
 * for it. The playlist pages looked right because they ask the server, and the track played fine
 * because the file is on disk (art and lyrics resolve from the file and the server lazily).
 *
 * This is that state, made runnable: a legacy mirror (no `title` on any row) whose download's own
 * record *does* name every song. The repair has to make the rows name them — from the phone, with
 * no connection — and `--:--` has to become the real duration.
 */
test('a row a 1.9.19 build wrote is repaired from the download’s own record, with no connection', async () => {
  const mirror = memoryStore();
  // The legacy mirror, exactly as `parseMirror` reads it: rows with `path`, `bytes` and `state`, and
  // no metadata key anywhere. The manifest beside them is the download's own record, which is where
  // the `Song`s the playlist was answered with live.
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: {
        a: { path: 'file:///a.mp3', bytes: 1000, state: 'complete' },
        b: { path: 'file:///b.mp3', bytes: 2000, state: 'complete' },
      },
      playlists: {
        'pl-1': { songs: [song('a'), song('b')], name: 'Driving', requestedAt: Date.now(), state: 'complete' },
      },
    }),
  );
  // No bridge and no server: this is the airplane-mode half, and it is the half that must work.
  const store = new OfflineStore(null, { store: mirror });

  const before = store.downloadedSongs();
  assert.deepEqual(
    before.map((entry) => [entry.id, entry.title, entry.duration]),
    [
      ['a', '', undefined],
      ['b', '', undefined],
    ],
    'the rows the owner saw: no titles, no durations — and `formatDuration` draws that as `--:--`',
  );
  assert.equal(formatDuration(before[0]?.duration), '--:--', 'which is the placeholder on his screenshot');

  const fixed = await store.repairMetadata();
  assert.equal(fixed, 2, 'both rows are filled in');
  assert.deepEqual(
    store.downloadedSongs().map((entry) => [entry.id, entry.title, entry.artist, entry.duration]),
    [
      ['a', 'Track a', 'Someone', 10],
      ['b', 'Track b', 'Someone', 10],
    ],
    'with real titles, artists and durations — never the song id, never a placeholder',
  );
  assert.equal(formatDuration(store.downloadedSongs()[0]?.duration), '0:10', 'and the row times the track');

  /*
   * …and it is **durable**: the repair writes the rows back to the mirror, so the next launch (and
   * the next foreground reconcile, whose `list()` answer has none either) still has them.
   */
  assert.equal(loadMirror(mirror)?.rows['a']?.title, 'Track a', 'the mirror now carries the title');
  assert.equal(loadMirror(mirror)?.rows['a']?.durationSec, 10, 'and the duration');

  const relaunch = new OfflineStore(null, { store: mirror });
  assert.deepEqual(
    relaunch.downloadedSongs().map((entry) => entry.title),
    ['Track a', 'Track b'],
    'so a cold start draws the titles with nothing asked of anyone',
  );

  // Idempotent: a second pass has nothing to fill and writes nothing new.
  assert.equal(await store.repairMetadata(), 0, 'a repair with nothing left to repair is a no-op');
});

/**
 * The other half of the same requirement: **a fresh download shows its metadata immediately**, so
 * the repair cannot be the only thing that ever names a row. The enqueue carries the `Song` fields
 * (v1.9.20) and the row is written with them, so this list is never blank on the way in.
 */
test('a fresh download shows its metadata immediately, with no repair and no round trip', async () => {
  const bridge = fakeBridge();
  const store = new OfflineStore(bridge, { store: memoryStore() });
  await store.download('pl-1', [covered('a', 'cover-a', 4096)], { name: 'Driving' });
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 4096 });

  const rows = store.downloadedSongs();
  assert.deepEqual(
    rows.map((entry) => [entry.id, entry.title, entry.artist, entry.album, entry.duration, entry.coverArt, entry.size]),
    [['a', 'Track a', 'Someone', 'Something', 10, 'cover-a', 4096]],
    'title, artist, album, duration and the cover id are on the row the moment the file lands',
  );
  // Nothing was asked of the server, and the repair has nothing to do: this is the path the fix must
  // not have made the only one that works.
  let asked = 0;
  const counting = new OfflineStore(bridge, { store: memoryStore(), songLookup: async () => (asked += 1, song('a')) });
  await counting.download('pl-1', [song('a')], { name: 'Driving' });
  bridge.emit('done', { songId: 'a', path: 'file:///a.mp3', bytes: 1000 });
  assert.equal(await counting.repairMetadata(), 0, 'a complete row is not a repair job');
  assert.equal(asked, 0, 'and the server is not asked about a row that already has its metadata');
});

/**
 * What the repair asks the server, and what it does when nobody can answer.
 *
 * The residue case is real — a row from a build whose playlist record is gone, in airplane mode —
 * and the honest answer is that it stays as it is. What this test pins is that it is asked **once**
 * per session (not once per draw of the view), and that a row which cannot be named changes nothing
 * else: the count and the bytes are still the files that are here, and the sort is still the
 * library's own, blanks landing where an empty title sorts.
 */
test('a row nobody can name is asked for once, and leaves the count, the bytes and the sort alone', async () => {
  const mirror = memoryStore();
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: {
        a: { path: 'file:///a.mp3', bytes: 1000, state: 'complete' },
        b: { path: 'file:///b.mp3', bytes: 2000, state: 'complete' },
      },
    }),
  );
  const asked: string[] = [];
  const store = new OfflineStore(null, {
    store: mirror,
    // The server knows one of them and has never heard of the other.
    songLookup: async (songId) => {
      asked.push(songId);
      return songId === 'a' ? { ...song('a'), title: 'Named by the server', duration: 42 } : null;
    },
  });

  assert.equal(await store.repairMetadata(), 1, 'the server named one of the two');
  assert.deepEqual(asked, ['a', 'b'], 'and both were asked, once each, in row order');
  const rows = store.downloadedSongs();
  const named = rows.find((entry) => entry.id === 'a');
  const unnamed = rows.find((entry) => entry.id === 'b');
  assert.deepEqual([named?.title, named?.duration], ['Named by the server', 42], 'the answered row is repaired');
  assert.deepEqual([unnamed?.title, unnamed?.duration], ['', undefined], 'the other one keeps what it had — nothing is invented for it');
  assert.equal(formatDuration(unnamed?.duration), '--:--', 'so it still draws the placeholder rather than a wrong number');

  // The count and the bytes are the files that are here, named or not.
  assert.equal(store.totalBytes(), 3000, 'the header’s size is the complete rows’ bytes');
  assert.equal(rows.length, 2, 'and the header’s count is the rows');

  // …and a second pass in the same session does not ask again.
  assert.equal(await store.repairMetadata(), 0, 'nothing more to fill');
  assert.deepEqual(asked, ['a', 'b'], 'and nobody is asked twice for the same row in one session');
});

/**
 * The two failure paths, which are not the same fact and must not be treated as one (v1.9.23).
 *
 * v1.9.22 marked the id as asked **before** the await, so the comment beside it ("the next pass … has
 * another go") was false in-session: a lookup that failed for want of a connection was retried on the
 * next *launch* at best, and the owner's first pass after the upgrade is exactly the pass that can
 * fail. A lookup that *failed* is now forgotten again and asked on the next pass; a `null` answer —
 * the server has told us it does not know this id — is not, because that answer will not change and a
 * retry would be a round trip per pass for it.
 */
test('a lookup that failed is asked again on the next pass, and one the server does not know is not', async () => {
  const mirror = memoryStore();
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: {
        a: { path: 'file:///a.mp3', bytes: 1000, state: 'complete' },
        b: { path: 'file:///b.mp3', bytes: 2000, state: 'complete' },
        c: { path: 'file:///c.mp3', bytes: 3000, state: 'complete' },
      },
    }),
  );
  const asked: string[] = [];
  let offline = true;
  const store = new OfflineStore(null, {
    store: mirror,
    songLookup: async (songId) => {
      asked.push(songId);
      // The connection is down for the first row of the pass, and `c` is not in the library at all.
      if (offline) {
        offline = false;
        throw new Error('could not reach the library');
      }
      return songId === 'c' ? null : { ...song(songId), title: `Named ${songId}` };
    },
  });

  assert.equal(await store.repairMetadata(), 1, 'the one row the server could answer is named');
  assert.deepEqual(asked, ['a', 'b', 'c'], 'all three were tried, in row order');
  assert.equal(
    store.downloadedSongs().find((entry) => entry.id === 'a')?.title,
    '',
    'the row the failure landed on keeps what it had — nothing is invented for it',
  );

  // The next pass: `a` is asked again (it failed), `c` is not (the server said it does not know it).
  assert.equal(await store.repairMetadata(), 1, 'and the row that failed is repaired by the next pass');
  assert.deepEqual(asked, ['a', 'b', 'c', 'a'], 'so the failure is retried in this session, and the `null` is not');
  assert.equal(store.downloadedSongs().find((entry) => entry.id === 'a')?.title, 'Named a', 'the row that failed is named now');
  assert.equal(await store.repairMetadata(), 0, 'and then there is nothing left to ask');
  assert.deepEqual(asked, ['a', 'b', 'c', 'a'], 'nobody is asked a third time');
});

/**
 * …and the sweep is **bounded** (v1.9.23). One visit to **On this phone** with the manifests gone was
 * one `getSong` per still-blank row — 497 of them on this phone, sequentially, off a screen the owner
 * is only looking at. The cap is per pass, the order is the rows', and the work still finishes: each
 * pass asks the first rows it has not asked yet, so the pass after this one names the next batch.
 */
test('the server sweep is capped, and the rows past the cap are named by the next pass', async () => {
  const ids = Array.from({ length: SERVER_ASKS_PER_PASS + 3 }, (_unused, index) => `s${String(index).padStart(2, '0')}`);
  const mirror = memoryStore();
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: Object.fromEntries(ids.map((id) => [id, { path: `file:///${id}.mp3`, bytes: 1000, state: 'complete' }])),
    }),
  );
  const asked: string[] = [];
  const store = new OfflineStore(null, {
    store: mirror,
    songLookup: async (songId) => {
      asked.push(songId);
      return { ...song(songId), title: `Named ${songId}` };
    },
  });

  assert.equal(await store.repairMetadata(), SERVER_ASKS_PER_PASS, 'one pass names at most the cap');
  assert.deepEqual(
    asked,
    ids.slice(0, SERVER_ASKS_PER_PASS),
    `${ids.length} blank rows off one screen is ${SERVER_ASKS_PER_PASS} round trips, not ${ids.length}`,
  );
  assert.equal(await store.repairMetadata(), 3, 'the next pass finishes the list');
  assert.deepEqual(asked.slice(SERVER_ASKS_PER_PASS), ids.slice(SERVER_ASKS_PER_PASS), 'the rows past the cap, in order');
  assert.equal(await store.repairMetadata(), 0, 'and then there is nothing left to ask');
  assert.equal(asked.length, ids.length, 'so every row was asked exactly once, in the end');
  assert.equal(
    store.downloadedSongs().filter((entry) => entry.title !== '').length,
    ids.length,
    'and every row is named — a cap that lost rows would be a worse defect than the burst',
  );
});

/**
 * **The reconcile must not throw the metadata away** — which is what it used to do, and what would
 * have made the repair a chore repeated on every foreground: `hydrate()` replaces the row map with
 * `list()`'s answer, and an index written before v1.9.20 answers with rows that have none.
 */
test('a reconcile with an older index keeps the metadata the mirror has', async () => {
  const mirror = memoryStore();
  mirror.setItem(
    'navilite.offline',
    JSON.stringify({
      v: 1,
      hydratedAt: Date.now(),
      rows: {
        a: { path: 'file:///a.mp3', bytes: 1000, state: 'complete', title: 'Track a', artist: 'Someone', album: 'Something', durationSec: 10 },
      },
    }),
  );
  // The native index is the truth about the *files* and has none of the metadata — the shape a
  // 1.9.19 index has. The bytes it reports are its own, and must be what the row ends up with.
  const bridge = fakeBridge([
    { songId: 'a', path: 'file:///a.mp3', suffix: 'mp3', bytes: 1234, state: 'complete', refs: [], title: '', artist: '', album: '', durationSec: 0 },
  ]);
  const store = new OfflineStore(bridge, { store: mirror });
  await store.hydrate();

  const row = store.downloadedSongs()[0];
  assert.deepEqual([row?.id, row?.size], ['a', 1234], 'the file, its bytes and its state come from the index');
  assert.deepEqual([row?.title, row?.duration], ['Track a', 10], 'the names come from what the store already knew');
  assert.equal(loadMirror(mirror)?.rows['a']?.title, 'Track a', 'and the reconcile wrote them back, so they stay known');
});
