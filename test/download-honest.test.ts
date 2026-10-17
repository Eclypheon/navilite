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
import {
  OfflineStore,
  STALL_MS,
  formatSize,
  type DownloadEvent,
  type DownloadJob,
  type DownloadsBridge,
  type IndexRow,
} from '../src/state/offline.ts';
import { downloadControlLabel, type DownloadControlFacts } from '../src/ui/app.ts';
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
function labelOf(offline: OfflineStore, playlistId: string, songList: Song[] = songs): string {
  const record = offline.record(playlistId);
  const activity = offline.activityOf(playlistId);
  const stalled = offline.stallOf(playlistId).stalled;
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
