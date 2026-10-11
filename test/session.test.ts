/**
 * The resume snapshot — the thing that makes a relaunch land on the same second of the same track.
 *
 * This is the v1.7 replacement for "restore from the server's `savePlayQueue`", and the two ways it
 * can go wrong are both silent, so they are pinned here: a snapshot that validates when it should
 * not (a corrupt or stale queue restored as if it were the last session) and one that fails to
 * round-trip (a play order or position lost between writing and reading).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_VERSION,
  clearSnapshot,
  loadSnapshot,
  parseSnapshot,
  saveSnapshot,
  type ResumeSnapshot,
  type SnapshotStore,
} from '../src/storage/session.ts';

const NOW = 1_800_000_000_000;

function memoryStore(seed: Record<string, string> = {}): SnapshotStore & { values: Record<string, string> } {
  const values = { ...seed };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
    removeItem: (key) => {
      delete values[key];
    },
  };
}

/** What `PlaybackQueue.resumeState()` produces for a three-track queue playing the third one. */
function snapshot(overrides: Partial<ResumeSnapshot> = {}): ResumeSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    savedAt: NOW,
    songId: 's3',
    positionMs: 41_500,
    playing: true,
    songs: [
      { id: 's1', title: 'one' },
      { id: 's2', title: 'two' },
      { id: 's3', title: 'three' },
    ] as ResumeSnapshot['songs'],
    order: [2, 0, 1],
    cursor: 0,
    shuffle: true,
    repeat: 'all',
    context: { kind: 'playlist', id: 'p1', name: 'Late night' },
    ...overrides,
  };
}

test('a snapshot round-trips: the queue, the play order, the cursor, the flags and the position', () => {
  const store = memoryStore();
  saveSnapshot(snapshot(), store);
  const restored = loadSnapshot(store, NOW);
  assert.ok(restored);
  assert.deepEqual(restored.songs.map((song) => song.id), ['s1', 's2', 's3']);
  assert.deepEqual(restored.order, [2, 0, 1], 'a shuffled queue must come back in the same order');
  assert.equal(restored.cursor, 0);
  assert.equal(restored.positionMs, 41_500);
  assert.equal(restored.playing, true);
  assert.equal(restored.shuffle, true);
  assert.equal(restored.repeat, 'all');
  assert.deepEqual(restored.context, { kind: 'playlist', id: 'p1', name: 'Late night' });
  assert.equal(restored.v, SNAPSHOT_VERSION);
});

test('a snapshot of a different shape is ignored, never half-read', () => {
  const store = memoryStore({ [SNAPSHOT_KEY]: JSON.stringify({ ...snapshot(), v: SNAPSHOT_VERSION - 1 }) });
  assert.equal(loadSnapshot(store, NOW), null);
});

test('a stale snapshot is not a session anyone expects to find playing', () => {
  const stale = snapshot({ savedAt: NOW - SNAPSHOT_MAX_AGE_MS - 1 });
  assert.equal(parseSnapshot(JSON.stringify(stale), NOW), null);
  // …and one written just inside the window is still resumed.
  assert.ok(parseSnapshot(JSON.stringify(snapshot({ savedAt: NOW - SNAPSHOT_MAX_AGE_MS + 1 })), NOW));
});

test('a corrupt queue is thrown away rather than resumed', () => {
  const cases: Array<[string, Partial<ResumeSnapshot>]> = [
    ['no songs', { songs: [] }],
    ['a song with no id', { songs: [{ title: 'x' }] as ResumeSnapshot['songs'] }],
    ['an order that is the wrong length', { order: [0, 1] }],
    ['an order with an index past the end', { order: [0, 1, 7] }],
    ['an order that repeats an index', { order: [0, 0, 1] }],
    ['a cursor past the end', { cursor: 3 }],
    ['a negative position', { positionMs: -1 }],
    ['no id for the current track', { songId: '' }],
  ];
  for (const [name, override] of cases) {
    assert.equal(parseSnapshot(JSON.stringify(snapshot(override)), NOW), null, name);
  }
  assert.equal(parseSnapshot('not json at all', NOW), null);
  assert.equal(parseSnapshot(null, NOW), null);
});

test('a repeat mode this build does not know falls back to off instead of poisoning the queue', () => {
  const restored = parseSnapshot(JSON.stringify(snapshot({ repeat: 'shuffle-forever' as ResumeSnapshot['repeat'] })), NOW);
  assert.equal(restored?.repeat, 'off');
});

test('clearing removes the snapshot, so a fresh launch does not resurrect a cleared queue', () => {
  const store = memoryStore();
  saveSnapshot(snapshot(), store);
  assert.ok(loadSnapshot(store, NOW));
  clearSnapshot(store);
  assert.equal(loadSnapshot(store, NOW), null);
  assert.equal(store.values[SNAPSHOT_KEY], undefined);
});

test('a store that throws is survivable: resume is off, playback is not', () => {
  const hostile: SnapshotStore = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  };
  assert.equal(loadSnapshot(hostile, NOW), null);
  assert.doesNotThrow(() => saveSnapshot(snapshot(), hostile));
  assert.doesNotThrow(() => clearSnapshot(hostile));
});
