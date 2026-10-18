/**
 * The download's honesty (owner, v2.0.0-beta.5), in his words:
 *
 *   "once the download of the playlist completes, the button text still changes to download covers
 *    which i then have to click on ... it instantly completes and i get a tick and filesize"
 *   "the retry should not appear if the download is still actively working"
 *   "show the exact filesize to one decimal point eg. 4.8 GB rather than an Up to 5 GB"
 *   "while the file is downloading can you add some kind of indicator ... perhaps a progress bar"
 *   "it should not retry completely from the beginning and redownload files that already have been
 *    successfully downloaded"
 *
 * Each test below is one of those sentences, read off the shipped code with a fake bridge — no
 * phone, no network, every transfer's completion emitted by hand.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OfflineStore,
  STALL_MS,
  formatSize,
  type DownloadEvent,
  type DownloadJob,
  type DownloadsBridge,
  type IndexRow,
} from '../src/state/offline.ts';
import { downloadControlLabel, downloadTapAction, offlineUrl, type DownloadControlFacts, type DownloadTapAction } from '../src/ui/app.ts';
import { loadMirror, type MirrorStore } from '../src/storage/offline.ts';
import type { Song } from '../src/api/types.ts';

const TRACKS = 40;
const PER_ALBUM = 10;
const SONG_BYTES = 5_000_000;

/** The owner's shape: 40 tracks, 10 to an album, so 4 covers. */
const songs: Song[] = Array.from({ length: TRACKS }, (_, index) => ({
  id: `s${index}`,
  title: `Track ${index}`,
  artist: 'Someone',
  album: `Album ${Math.floor(index / PER_ALBUM)}`,
  duration: 227,
  size: SONG_BYTES,
  suffix: 'opus',
  coverArt: `al${Math.floor(index / PER_ALBUM)}`,
}));
const COVERS = new Set(songs.map((song) => song.coverArt)).size;

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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const kindOf = (job: DownloadJob): 'audio' | 'lyrics' | 'art' =>
  job.suffix === 'lyrics' ? 'lyrics' : job.suffix === 'art' ? 'art' : 'audio';

interface FakeBridge extends DownloadsBridge {
  enqueued: DownloadJob[];
  attempts: Map<string, number>;
  emit(name: 'progress' | 'done' | 'failed', event: DownloadEvent): void;
}

function fakeBridge(): FakeBridge {
  const listeners = new Map<string, (event: DownloadEvent) => void>();
  const enqueued: DownloadJob[] = [];
  const attempts = new Map<string, number>();
  return {
    configure: async () => undefined,
    enqueue: async (job) => {
      const key = `${kindOf(job)}:${job.songId}`;
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      enqueued.push(job);
    },
    cancel: async () => undefined,
    remove: async () => undefined,
    list: async (): Promise<IndexRow[]> => [],
    freeBytes: async () => -1,
    readLyrics: async () => null,
    writeLyrics: async () => undefined,
    addListener: async (name, listener) => {
      listeners.set(name, listener);
      return () => undefined;
    },
    enqueued,
    attempts,
    emit(name, event) {
      listeners.get(name)?.(event);
    },
  };
}

const audioJobs = (bridge: FakeBridge): DownloadJob[] => bridge.enqueued.filter((job) => kindOf(job) === 'audio');
const artJobs = (bridge: FakeBridge): DownloadJob[] => bridge.enqueued.filter((job) => kindOf(job) === 'art');

function store(bridge: FakeBridge): OfflineStore {
  return new OfflineStore(bridge, { store: memoryStore(), artUrl: (cover) => `rest/getCoverArt?id=${cover}` });
}

/** The button's sentence, read from the store's own facts — the control's `label()` in one line. */
function labelOf(offline: OfflineStore, playlistId: string, songList: Song[] = songs, now = Date.now()): string {
  const record = offline.record(playlistId);
  const activity = offline.activityOf(playlistId);
  const stalled = offline.stallOf(playlistId, now).stalled;
  const facts: DownloadControlFacts = {
    state: record?.state ?? 'none',
    done: record?.done ?? 0,
    total: record?.total ?? 0,
    songs: songList,
    size: formatSize(activity.total > 0 ? activity.total : (record?.bytes ?? 0)),
    missing: offline.missingCount(playlistId, songList),
    missingCovers: offline.missingCovers(songList),
    activity,
    stalled,
  };
  return downloadControlLabel(facts);
}

/* ------------------------------------------------------------------ 1. the exact figure */

test('the size is exact to one decimal, and no state ever says "up to"', () => {
  assert.equal(formatSize(Math.round(4.8 * 1024 ** 3)), '4.8 GB', 'the owner\'s example, to one decimal');
  assert.equal(formatSize(327_155_712), '312.0 MB', 'a mid-sized playlist, still one decimal');
  assert.equal(formatSize(4_812), '4.7 KB');
  assert.equal(formatSize(0), '0 B');
  const states = ['none', 'estimating', 'downloading', 'partial', 'complete', 'failed'] as const;
  for (const state of states) {
    const label = downloadControlLabel({
      state,
      done: 3,
      total: 10,
      songs,
      size: '4.8 GB',
      missing: 0,
      missingCovers: 0,
      activity: { bytes: 1_000_000, total: 5_152_000_000, at: Date.now(), pending: 2 },
      stalled: false,
    });
    assert.doesNotMatch(label, /up to/i, `${state} must never print "up to": ${label}`);
  }
});

/* ------------------------------------------------------------------ 2. one tap, covers included */

test('one tap fetches covers too, and the finish state is a tick and a size — no second step', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();

  assert.equal(audioJobs(bridge).length, TRACKS, 'every track queued by the one tap');
  assert.equal(new Set(artJobs(bridge).map((job) => job.songId)).size, COVERS, 'and every cover, in the same tap');

  for (const job of audioJobs(bridge)) {
    bridge.emit('done', { songId: job.songId, path: `file:///${job.songId}.opus`, bytes: SONG_BYTES });
  }
  await settle();

  // Audio is all here, the covers are still in flight: the job is NOT finished, and the button
  // must not offer a second one ("once the download completes the button text still changes to
  // download covers which i then have to click on").
  assert.equal(offline.record('pl-1')?.state, 'downloading', 'a pending cover keeps the one job open');
  assert.doesNotMatch(labelOf(offline, 'pl-1'), /cover/i, 'no covers step is offered while the job runs');

  let artDone = 0;
  for (const job of artJobs(bridge)) {
    bridge.emit('done', { songId: job.songId, kind: 'art', path: `file:///${job.songId}.art`, bytes: 200_000 });
    artDone += 1;
  }
  await settle();
  assert.equal(artDone, COVERS);

  const record = offline.record('pl-1');
  assert.equal(record?.state, 'complete', 'audio and covers both self-complete: no tap anywhere');
  assert.equal(record?.done, TRACKS);
  const label = labelOf(offline, 'pl-1');
  assert.match(label, /^✓ \d+\.\d (MB|GB)$/, `the finished control is a tick and a size: ${label}`);
  assert.doesNotMatch(label, /cover|retry/i);
  offline.dispose();
});

/* ------------------------------------------------------------------ 3. retry only when stalled */

test('retry is withheld while the job is moving, and offered once it has been silent for the window', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();

  // A transfer reporting bytes is the job saying it is alive.
  bridge.emit('progress', { songId: 's0', bytes: 2_500_000, total: SONG_BYTES });
  await settle();
  assert.ok((offline.activityOf('pl-1').bytes ?? 0) >= 2_500_000, 'the in-flight bytes are visible to the UI');
  assert.equal(offline.stallOf('pl-1').stalled, false, 'bytes just arrived');
  const stillWarm = offline.stallOf('pl-1', Date.now() + STALL_MS - 1_000);
  assert.equal(stillWarm.stalled, false, `inside the ${STALL_MS} ms window is not stalled either`);
  assert.doesNotMatch(labelOf(offline, 'pl-1'), /retry/i, 'the owner\'s sentence: no retry while it works');

  // …and silence past the window is what a retry is for.
  const cold = offline.stallOf('pl-1', Date.now() + STALL_MS + 1_000);
  assert.equal(cold.stalled, true, 'no bytes and no event for the window');
  assert.equal(cold.window, STALL_MS);
  const record = offline.record('pl-1');
  const stalledLabel = downloadControlLabel({
    state: record?.state ?? 'none',
    done: record?.done ?? 0,
    total: record?.total ?? 0,
    songs,
    size: '195.3 MB',
    missing: 0,
    missingCovers: 0,
    activity: offline.activityOf('pl-1'),
    stalled: true,
  });
  assert.match(stalledLabel, /retry/i, `a stalled job offers the tap: ${stalledLabel}`);
  offline.dispose();
});

test('a job with its own retry pass scheduled is working, not stalled', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();
  // The native side gives up on one track: the pump is now scheduled for this playlist.
  bridge.emit('failed', { songId: 's7', status: 500, error: 'timed out' });
  await settle();
  // The track is `failed`, and the covers of the same job are still in flight — so the record is
  // open (not complete) and the job has a pass of its own scheduled: the tap must not be offered.
  assert.notEqual(offline.record('pl-1')?.state, 'complete', 'one failed track of forty is not a finish');
  assert.equal(
    offline.stallOf('pl-1', Date.now() + STALL_MS + 1_000).stalled,
    false,
    'the pump is the job still working — a retry label here would re-enqueue over it',
  );
  assert.doesNotMatch(labelOf(offline, 'pl-1'), /retry/i);
  offline.dispose();
});

/* ------------------------------------------------------------------ 4. a retry resumes */

test('a retry resumes: the files already here are not fetched again', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();
  assert.equal(audioJobs(bridge).length, TRACKS);

  // 25 of the 40 landed before the owner's connection went away.
  const landed = audioJobs(bridge).slice(0, 25);
  for (const job of landed) bridge.emit('done', { songId: job.songId, path: `file:///${job.songId}.opus`, bytes: SONG_BYTES });
  await settle();
  const before = offline.record('pl-1');
  assert.equal(before?.done, 25);
  const bytesBefore = offline.activityOf('pl-1').bytes;
  assert.equal(bytesBefore, 25 * SONG_BYTES, 'the bytes on the phone, counted');

  // The tap (retry) — the same download(), from the top of the list.
  const beforeJobs = audioJobs(bridge).length;
  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();
  const fetchedAgain = audioJobs(bridge).length - beforeJobs;

  assert.equal(fetchedAgain, TRACKS - 25, `only the 15 that are missing are fetched (got ${fetchedAgain})`);
  assert.equal(bridge.attempts.get('audio:s0'), 1, 'a complete track is never asked for twice');
  for (const job of landed) {
    assert.equal(bridge.attempts.get(`audio:${job.songId}`), 1, `${job.songId} was not re-fetched`);
  }
  assert.equal(offline.record('pl-1')?.done, 25, 'the resume starts from what is on the phone');
  assert.equal(offline.activityOf('pl-1').bytes, bytesBefore, 'and no byte was thrown away');
  offline.dispose();
});

/* ------------------------------------------------------------------ 5. the live indicator */

test('the control repaints while bytes move, and its figure only ever grows', async () => {
  const bridge = fakeBridge();
  let paints = 0;
  const offline = new OfflineStore(bridge, {
    store: memoryStore(),
    artUrl: (cover) => `rest/getCoverArt?id=${cover}`,
  });
  offline.onChange(() => {
    paints += 1;
  });
  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();
  const start = paints;

  for (let step = 1; step <= 4; step += 1) {
    bridge.emit('progress', { songId: 's0', bytes: step * 1_000_000, total: SONG_BYTES });
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(offline.activityOf('pl-1').bytes >= 4_000_000, 'the newest byte count is the one on screen');
  assert.ok(paints > start, 'the control was repainted by the progress events, not only by a transfer finishing');
  offline.dispose();
});

/* ------------------------------------------------------------------ 6. the tap seam */

/**
 * **The tap, read exactly as `downloadControl`'s click handler reads it** — the same
 * `DownloadControlFacts` the sentence is printed from, through `downloadTapAction`. Sage's
 * send-back was that the sentence and the tap were two different questions; this is the one place
 * both are answered, so a test can drive ready → working → stalled and see the action in each.
 *
 * `now` is threaded through so the stall window can be crossed without waiting the real 20 s: the
 * window is the shipped constant, only the clock is the test's.
 */
function tapOf(offline: OfflineStore, playlistId: string, now = Date.now(), songList: Song[] = songs): DownloadTapAction {
  const record = offline.record(playlistId);
  const activity = offline.activityOf(playlistId);
  return downloadTapAction({
    state: record?.state ?? 'none',
    done: record?.done ?? 0,
    total: record?.total ?? 0,
    songs: songList,
    size: formatSize(activity.total > 0 ? activity.total : (record?.bytes ?? 0)),
    missing: offline.missingCount(playlistId, songList),
    missingCovers: offline.missingCovers(songList),
    activity,
    stalled: offline.stallOf(playlistId, now).stalled,
  });
}

test('the tap follows the sentence: ready → working → stalled, and a stalled tap resumes — never cancels', async () => {
  const bridge = fakeBridge();
  const memory = memoryStore();
  const offline = new OfflineStore(bridge, { store: memory, artUrl: (cover) => `rest/getCoverArt?id=${cover}` });

  // READY — nothing was ever asked of this playlist: the tap starts the job.
  assert.equal(tapOf(offline, 'pl-1'), 'download', 'ready: the tap downloads');
  assert.match(labelOf(offline, 'pl-1'), /^↓ /, 'ready: and the sentence offers a download');

  await offline.download('pl-1', songs, { name: 'Jap' });
  await settle();

  // WORKING — bytes are arriving: the sentence must not say retry, and the tap is still cancel.
  bridge.emit('progress', { songId: 's0', bytes: 1_000_000, total: SONG_BYTES });
  await settle();
  assert.equal(tapOf(offline, 'pl-1'), 'cancel', 'working: the tap cancels');
  assert.doesNotMatch(labelOf(offline, 'pl-1'), /retry/i, 'working: no retry while it moves');

  // 25 of the 40 land, then the connection goes quiet and never says anything again.
  for (const job of audioJobs(bridge).slice(0, 25)) {
    bridge.emit('done', { songId: job.songId, path: `file:///${job.songId}.opus`, bytes: SONG_BYTES });
  }
  await settle();

  // STALLED — past the window the sentence offers the tap… and the tap must ASK AGAIN.
  const cold = Date.now() + STALL_MS + 1_000;
  assert.equal(offline.stallOf('pl-1', cold).stalled, true, 'silent past the window');
  assert.match(labelOf(offline, 'pl-1', songs, cold), /retry/i, 'stalled: the control says retry');
  assert.equal(
    tapOf(offline, 'pl-1', cold),
    'download',
    'stalled: the tap resumes — this is the defect: it said retry and called cancel()',
  );

  // …and the resume keeps everything that already landed, byte for byte.
  const audioBefore = audioJobs(bridge).length;
  const bytesBefore = offline.activityOf('pl-1').bytes;
  await offline.download('pl-1', songs, { name: 'Jap' }); // what the tap does on 'download'
  await settle();
  assert.equal(audioJobs(bridge).length - audioBefore, TRACKS - 25, 'only the 15 missing tracks are asked for');
  for (let index = 0; index < 25; index += 1) {
    assert.equal(bridge.attempts.get(`audio:s${index}`), 1, `s${index} was already here and was not fetched twice`);
  }
  assert.equal(offline.activityOf('pl-1').bytes, bytesBefore, 'no byte thrown away by the resume');

  // …and the manifest is left `downloading`, which is the only state the next boot resumes. A
  // cancel here would have written `partial` (offline.ts `cancel`) and taken the job out of it.
  const mirror = loadMirror(memory as MirrorStore);
  assert.equal(
    mirror?.playlists?.['pl-1']?.state,
    'downloading',
    'the resumed job stays resumable in the mirror',
  );
  offline.dispose();
});

test('a finished download taps to a removal, a grown one to a resume, and an empty playlist to nothing', () => {
  const facts = (state: DownloadControlFacts['state'], extra: Partial<DownloadControlFacts> = {}): DownloadControlFacts => ({
    state,
    done: 0,
    total: 0,
    songs,
    size: '1.0 MB',
    missing: 0,
    missingCovers: 0,
    activity: { bytes: 0, total: 0, at: 0, pending: 0 },
    stalled: false,
    ...extra,
  });
  assert.equal(downloadTapAction(facts('none')), 'download', 'a playlist with no record downloads');
  assert.equal(downloadTapAction(facts('idle')), 'download');
  assert.equal(downloadTapAction(facts('failed')), 'download');
  assert.equal(downloadTapAction(facts('partial')), 'download');
  assert.equal(downloadTapAction(facts('complete')), 'remove', 'nothing left to fetch: the tap removes');
  assert.equal(downloadTapAction(facts('complete', { missing: 2 })), 'download', 'a grown playlist resumes');
  assert.equal(downloadTapAction(facts('complete', { missingCovers: 1 })), 'download', 'a missing cover resumes');
  assert.equal(downloadTapAction(facts('downloading', { stalled: true })), 'download', 'stalled is never a cancel');
  assert.equal(downloadTapAction(facts('estimating', { stalled: true })), 'download', 'nor is a stalled estimate');
  assert.equal(downloadTapAction(facts('complete', { songs: [] })), 'none', 'nothing to download, nothing to do');
  assert.equal(downloadTapAction(facts('none', { songs: [] })), 'none');
});

/* ------------------------------------------ 5. "500 MB downloaded, still 0 of 233" (beta.6) */

/**
 * The owner, on the shipped beta.6: *"even after 500 MB has been downloaded, it still shows 0 of 233
 * songs"*. The bytes arrived and nothing completed, and the control said nothing about why. Three
 * readings below: the 206 door, the reason line, and the figure that counted settled transfers.
 */

const swiftSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App', 'App', 'NaviliteDownloads.swift'), 'utf8');

test('a 206 completion is promoted, and its expected length is the Content-Range total', () => {
  // Read out of the shipped source: this door sits behind Caddy, which passes Range through, so a
  // resumed transfer answers 206 with perfectly good bytes.
  assert.match(swiftSource, /guard status == 200 \|\| status == 206 else/, 'a range response is not a failure');
  assert.match(swiftSource, /Content-Range/, 'a 206 is asked for its whole-file total');
  const completion = swiftSource.slice(swiftSource.indexOf('let expected = responseExpected'));
  assert.doesNotMatch(
    completion.slice(0, 400),
    /job\?\.expectedBytes/,
    'the JS job\'s byte guess is no longer the fallback: an unknown length is unverifiable, not a mismatch',
  );

  /** The completion path's own verdict, as the shipped code states it. */
  const promotes = (status: number, total: number, actual: number): boolean => {
    if (status !== 200 && status !== 206) return false;
    return total <= 0 || actual === total;
  };
  assert.equal(promotes(206, 27_972_305, 27_972_305), true, 'a finished resumed transfer promotes');
  assert.equal(promotes(206, 27_972_305, 1_024), false, 'a range body alone is never promoted as the file');
  assert.equal(promotes(200, 0, 5_000_000), true, 'an unknown length is unverifiable — the file\'s own bytes stand');
});

test('a failed transfer states its reason on the control, and a finished job takes it away', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-9', songs, { name: 'Jap' });
  await settle();

  const job = audioJobs(bridge)[0]!;
  bridge.emit('failed', { songId: job.songId, kind: 'audio', status: 206, error: 'HTTP 206' });
  await settle();

  const failure = offline.failureOf('pl-9');
  assert.equal(failure?.status, 206, 'the status the native side measured is kept');
  assert.equal(failure?.error, 'HTTP 206');

  const label = downloadControlLabel({
    state: 'downloading',
    done: 0,
    total: TRACKS,
    songs,
    size: '1.0 GB',
    missing: 0,
    missingCovers: 0,
    activity: offline.activityOf('pl-9'),
    stalled: false,
    failure,
  });
  assert.match(label, /· failed: HTTP 206/, `the control must say why, not only that nothing completed: ${label}`);

  await offline.cancel('pl-9');
  assert.equal(offline.failureOf('pl-9'), null, 'a cancelled job is not explaining a failure any more');
});

test('a failed transfer stops counting in the byte figure', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-f', songs, { name: 'Jap' });
  await settle();

  const job = audioJobs(bridge)[0]!;
  bridge.emit('progress', { songId: job.songId, kind: 'audio', bytes: 4_000_000, total: SONG_BYTES });
  assert.equal(offline.activityOf('pl-f').bytes, 4_000_000, 'a live transfer\'s count is what the figure adds');

  /*
   * The owner's figure: one failed transfer per track, none of them complete, and their last counts
   * kept in the sum — 233 tracks × ~2 MB ≈ the 500 MB he watched climb under `0 of 233`. A transfer
   * that has ended is not live, so its count goes with it.
   */
  bridge.emit('failed', { songId: job.songId, kind: 'audio', status: 206, error: 'HTTP 206' });
  await settle();
  assert.equal(
    offline.activityOf('pl-f').bytes,
    0,
    'a failed transfer\'s last count must not keep climbing in the figure',
  );

  bridge.emit('done', { songId: songs[1]!.id, kind: 'audio', path: 'file:///s1.opus', bytes: SONG_BYTES });
  await settle();
  assert.equal(offline.activityOf('pl-f').bytes, SONG_BYTES, 'a complete row carries those bytes instead');
});

/* ---------------------------------- 6. "failed: unsupported URL" (owner, beta.7 on his phone) */

/**
 * The owner's reading on the shipped beta.7: `failed: unsupported url` and `failed: http 200`, while
 * the byte figure kept climbing. Two separate defects: a URL that reaches a native download task
 * **relative** can never be fetched (a browser resolves it; `URLSession` has no page), and the note
 * preferred the status over the words, so a transport failure after a `200` printed `HTTP 200`.
 */

test('a relative URL is made absolute before it can reach the native downloader', () => {
  const ctx = { library: { client: { baseUrl: 'https://lib.example:9443' } } };
  assert.equal(
    offlineUrl(ctx, '/lyrics?path=a%2Fb.opus'),
    'https://lib.example:9443/lyrics?path=a%2Fb.opus',
    'the sidecar route is same-origin relative: the library base is what it is relative TO',
  );
  assert.equal(offlineUrl(ctx, 'rest/download.view?id=x'), 'https://lib.example:9443/rest/download.view?id=x');
  assert.equal(offlineUrl(ctx, 'https://other.example/rest/x?id=1'), 'https://other.example/rest/x?id=1', 'absolute URLs are left alone');
  assert.equal(
    offlineUrl({ library: null }, '/lyrics?path=x'),
    'https://alienlab.tailbed832.ts.net:9443/lyrics?path=x',
    'before connect (the boot resume) the canonical origin is the base — never the webview origin',
  );
  assert.equal(offlineUrl(ctx, null), null, 'nothing to fetch is null, not a broken URL');
  assert.match(
    swiftSource,
    /guard let scheme = target\.scheme[\s\S]{0,120}scheme == "http" \|\| scheme == "https"/,
    'and the native door refuses a non-absolute URL instead of enqueuing one that can only fail',
  );
});

test('the failure note prints the reason, and the status only when the status IS the reason', () => {
  const facts = (failure: DownloadControlFacts['failure']): string =>
    downloadControlLabel({
      state: 'downloading',
      done: 0,
      total: TRACKS,
      songs,
      size: '1.0 GB',
      missing: 0,
      missingCovers: 0,
      activity: { bytes: 1_000, total: 5_152_000_000, at: Date.now(), pending: 2 },
      stalled: false,
      failure,
    });

  const transport = facts({ status: 200, error: 'The network connection was lost', songId: 's0', at: Date.now() });
  assert.match(transport, /network connection was lost/, `the words are the cause: ${transport}`);
  assert.doesNotMatch(transport, /HTTP 200/, 'a 2xx with an error is not an HTTP failure');

  const refused = facts({ status: 404, error: 'no lyrics sidecar for this track', songId: 's0', at: Date.now() });
  assert.match(refused, /no lyrics sidecar for this track \(HTTP 404\)/, `a refused status is a cause: ${refused}`);

  const unsupported = facts({ error: 'unsupported URL', songId: 's0', at: Date.now() });
  assert.match(unsupported, /unsupported URL/, 'and a status-less error prints exactly what it says');
});

test('a finished job takes the failure note away with the last transfer that caused it', async () => {
  const bridge = fakeBridge();
  const offline = store(bridge);
  await offline.download('pl-g', songs, { name: 'Jap' });
  await settle();

  bridge.emit('failed', { songId: songs[0]!.id, kind: 'audio', status: 500, error: 'timed out' });
  await settle();
  assert.match(
    downloadControlLabel({
      state: offline.record('pl-g')?.state ?? 'none',
      done: offline.record('pl-g')?.done ?? 0,
      total: offline.record('pl-g')?.total ?? 0,
      songs,
      size: '1.0 GB',
      missing: 0,
      missingCovers: 0,
      activity: offline.activityOf('pl-g'),
      stalled: false,
      failure: offline.failureOf('pl-g'),
    }),
    /· failed/,
    'the note is up while the job is unfinished',
  );

  // Everything lands, covers included: the job is complete, and it has nothing left to explain.
  for (const job of audioJobs(bridge)) {
    bridge.emit('done', { songId: job.songId, kind: 'audio', path: `file:///${job.songId}.opus`, bytes: SONG_BYTES });
  }
  for (const job of artJobs(bridge)) {
    bridge.emit('done', { songId: job.songId, kind: 'art', path: `file:///${job.songId}.art`, bytes: 200_000 });
  }
  await settle();

  assert.equal(offline.record('pl-g')?.state, 'complete', 'the job finished');
  assert.equal(offline.failureOf('pl-g'), null, 'a completed download is not explaining a failure any more');
  assert.doesNotMatch(labelOf(offline, 'pl-g'), /failed/, 'the finished control is a tick and a size');
  offline.dispose();
});
