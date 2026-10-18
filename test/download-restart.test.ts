/**
 * v2.0.0-beta.6 — **nothing can be downloaded** (owner, on the shipped beta.5):
 *
 *   "the download progress seems to keep reverting so it would climb for awhile and then drop back
 *    down as if something is forcing the files to be deleted. No songs can be downloaded at all."
 *
 * The measured shape: the phone opened every `download.view` and tore it down within 3–70 ms, so no
 * transfer ever reached its `Content-Length`, nothing was promoted, and each failure deleted the
 * staging bytes. Two mechanisms produced that, and the three tests below are each one of them, written
 * so that the **shipped** beta.5 tree fails them:
 *
 *   1. native `enqueue` cancelled the task it had just resumed — `cancelTask` decided its victim inside
 *      `session.getAllTasks`'s *asynchronous* completion, which ran after the replacement was already
 *      running (the Swift half is modelled here, because `node --test` cannot run Swift);
 *   2. `download()`, `resume()` and `pump()` walked the same playlist concurrently with no single-flight
 *      guard, so two passes cancelled each other's transfers;
 *   3. and the byte figure the owner watched was written straight from every `progress` event, so a
 *      second task's low count made it regress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OfflineStore, type DownloadEvent, type DownloadJob, type DownloadsBridge, type IndexRow } from '../src/state/offline.ts';
import type { Song } from '../src/api/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteDownloads.swift'), 'utf8');

/** The `enqueue` method's own body — sliced, so the ordering claims are about this method only. */
const enqueueBody = source.slice(source.indexOf('@objc func enqueue'), source.indexOf('@objc func cancel'));

/* --------------------------------------------------------------- 1. the native race */

test('enqueue never cancels the transfer it just resumed', () => {
  // The semantics are read out of the shipped source: on beta.5 `enumerating` was true and
  // `idempotent` was false, and the model below then reproduces the owner's abort.
  const semantics = {
    enumerating: /session\?\.getAllTasks/.test(source),
    idempotent: /live\.state == \.running \|\| live\.state == \.suspended/.test(enqueueBody),
  };

  const created: Array<{ key: string; cancelled: boolean }> = [];
  const live = new Map<string, { key: string; cancelled: boolean }>();
  const deferred: Array<() => void> = [];
  const enqueue = (key: string): void => {
    if (semantics.idempotent && live.has(key)) return; // a live transfer is a no-op
    if (semantics.enumerating) {
      // beta.5: the cancel is decided inside an async getAllTasks completion …
      deferred.push(() => {
        for (const task of created) if (task.key === key) task.cancelled = true;
      });
    } else {
      // …and beta.6 cancels by handle, synchronously, before the successor exists.
      const previous = live.get(key);
      if (previous) {
        live.delete(key);
        previous.cancelled = true;
      }
    }
    const task = { key, cancelled: false };
    created.push(task);
    live.set(key, task); // registered before `resume()`
  };

  enqueue('audio:s1'); // the owner's tap starts the transfer
  enqueue('audio:s1'); // a second pass — the boot resume or the pump walks the same playlist
  for (const completion of deferred) completion(); // …and the session enumeration finally lands

  assert.equal(semantics.enumerating, false, 'a cancel is never decided by an asynchronous enumeration');
  assert.equal(created.length, 1, 're-enqueueing a live transfer creates no second task');
  assert.equal(created[0]?.cancelled, false, 'and the transfer that is running is not cancelled by its own enqueue');
});

test('the cancel is by identity, and it happens before the successor is created', () => {
  assert.match(source, /private var liveTasks: \[String: URLSessionTask\] = \[:\]/, 'the plugin keeps its own task handles');
  assert.match(source, /private func stopTask\(key: String, deliberate: Bool\) -> Bool/, 'the one cancel helper');
  assert.match(source, /let task = liveTasks\.removeValue\(forKey: key\)/, 'a cancel names the task it created');
  assert.doesNotMatch(source, /session\?\.getAllTasks\s*\{/, 'the session-wide enumeration is gone entirely');

  // The idempotency guard sits before the cancel and before the staging delete: a second enqueue of a
  // live job may not restart the bytes that have already arrived.
  const guard = enqueueBody.indexOf('if let live = liveTask(job.taskKey)');
  const stop = enqueueBody.indexOf('stopTask(key: job.taskKey, deliberate: true)');
  const stagingDelete = enqueueBody.indexOf('removeItem(at: staging)');
  const register = enqueueBody.indexOf('register(task, key: job.taskKey)');
  const resume = enqueueBody.search(/task(?:\?)?\.resume\(\)/);
  assert.ok(guard >= 0, 'the idempotency guard exists');
  assert.ok(guard < stop, 'the guard returns before anything is cancelled');
  assert.ok(stop < stagingDelete, 'the superseded transfer is stopped before its staging bytes go');
  assert.ok(register >= 0 && register < resume, 'the new task is registered before it is resumed');

  // A replaced transfer's cancellation is not reported as a failure of the track.
  assert.match(source, /if takeReplacement\(task\) \{ return \}/, 'the replacement is not a failure event');
});

/* ------------------------------------------------------- 2. one walk per playlist */

const TRACKS = 4;
const SONG_BYTES = 5_000_000;

const songs: Song[] = Array.from({ length: TRACKS }, (_, index) => ({
  id: `s${index}`,
  title: `Track ${index}`,
  artist: 'Someone',
  album: 'Album',
  duration: 227,
  size: SONG_BYTES,
  suffix: 'opus',
  coverArt: 'al1',
}));

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
  enqueued: DownloadJob[];
  cancelled: string[];
  emit(name: 'progress' | 'done' | 'failed', event: DownloadEvent): void;
}

function fakeBridge(gate: Promise<void>): FakeBridge {
  const listeners = new Map<string, (event: DownloadEvent) => void>();
  const enqueued: DownloadJob[] = [];
  const cancelled: string[] = [];
  return {
    configure: async () => undefined,
    enqueue: async (job) => {
      enqueued.push(job);
      await gate; // a bridge call is a round trip: both passes are in it at the same time
    },
    cancel: async (songId) => void cancelled.push(songId),
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
    cancelled,
    emit(name, event) {
      listeners.get(name)?.(event);
    },
  };
}

const store = (bridge: FakeBridge): OfflineStore =>
  new OfflineStore(bridge, { store: memoryStore(), artUrl: (cover) => `rest/getCoverArt?id=${cover}` });

const audioJobs = (bridge: FakeBridge): DownloadJob[] =>
  bridge.enqueued.filter((job) => job.suffix !== 'lyrics' && job.suffix !== 'art');

test('two passes over the same playlist cannot walk it at the same time', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = fakeBridge(gate);
  const offline = store(bridge);

  // The owner's tap and the boot resume, overlapping: both enumerate the same playlist.
  const first = offline.download('pl1', songs, { name: 'Mix' });
  const second = offline.download('pl1', songs, { name: 'Mix' });
  release();
  await Promise.all([first, second]);

  const perKey = new Map<string, number>();
  for (const job of audioJobs(bridge)) perKey.set(job.songId, (perKey.get(job.songId) ?? 0) + 1);
  assert.equal(perKey.size, TRACKS, 'every track was asked for');
  for (const [songId, count] of perKey) assert.equal(count, 1, `${songId} was enqueued once, not once per pass`);
  assert.deepEqual(bridge.cancelled, [], 'and no pass cancelled a transfer the other one had started');
});

/* --------------------------------------- 4. a terminal state is forgotten by IDENTITY */

/**
 * The residual of the beta.6 fix (t_2e457501). A task that was **deliberately replaced** is
 * cancelled, so its `didFail`/`didFinishDownload` lands *after* its successor is already registered
 * under the same key. beta.6 forgot "whatever is under this key", so that late callback unregistered
 * the SUCCESSOR — the idempotency guard then saw nothing live, and the next enqueue started a second
 * transfer for the same bytes (duplicate traffic, and a duplicate's failure reported for a track
 * whose first transfer is still moving).
 *
 * Modelled from the shipped source, the way the tests above are, because `node --test` cannot run
 * Swift: the semantics are read out of `forgetTask`'s own body.
 */
const forgetBody = (() => {
  const start = source.indexOf('fileprivate func forgetTask');
  assert.ok(start >= 0, 'the plugin still has one place where a transfer stops being live');
  const next = source.indexOf('fileprivate func', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
})();

interface Transfer {
  key: string;
  state: 'running' | 'suspended' | 'completed';
  cancelled: boolean;
}

/**
 * One deliberate replacement, then the superseded transfer's late terminal callback. Returns what
 * the plugin believes is live afterwards, and every transfer it created for the key.
 */
function replacementRace(byIdentity: boolean, late: 'fail' | 'finish'): { live: Transfer | undefined; created: Transfer[]; already: number } {
  const tasks = new Map<string, Transfer>();
  const replaced = new Set<Transfer>();
  const created: Transfer[] = [];
  let already = 0;
  const KEY = 'audio:s1';

  // `forgetTask(_:)`: by identity, or — the beta.6 shape — whatever is registered under the key.
  const forget = (task: Transfer): void => {
    if (byIdentity) {
      if (tasks.get(task.key) === task) tasks.delete(task.key);
    } else {
      tasks.delete(task.key);
    }
  };
  // `stopTask(key:deliberate:)`: names the task it created, marks it a replacement, cancels it.
  const stop = (key: string): void => {
    const task = tasks.get(key);
    if (!task) return;
    tasks.delete(key);
    replaced.add(task);
    task.cancelled = true;
  };
  // `enqueue`, reduced to the two facts this defect turns on: the guard, and the replacement.
  const enqueue = (key: string): void => {
    const live = tasks.get(key);
    if (live && (live.state === 'running' || live.state === 'suspended')) {
      already += 1;
      return;
    }
    stop(key);
    const task: Transfer = { key, state: 'running', cancelled: false };
    created.push(task);
    tasks.set(key, task); // registered before it is resumed
  };

  enqueue(KEY); // the owner's tap: transfer A
  const first = created[0]!;
  first.state = 'completed'; // A's transfer has ended; its delegate callback is still to come
  enqueue(KEY); // a re-walk replaces it (A is not running) — transfer B, resumed
  if (late === 'fail') {
    forget(first); // didFail: forget by identity, then `takeReplacement` swallows the event
    assert.equal(replaced.has(first), true, 'the superseded transfer was a replacement, so no failure is reported');
  } else {
    forget(first); // didFinishDownload: the same identity rule, on the success path
  }
  enqueue(KEY); // …and now a later enqueue for the same key must still be a no-op
  return { live: tasks.get(KEY), created, already };
}

test('a superseded transfer’s late failure leaves its successor live', () => {
  // The semantics are read out of `forgetTask`'s own body: identity, or the beta.6 key sweep.
  const byIdentity =
    /forgetTask\(_ task: URLSessionTask\)/.test(forgetBody) && /liveTasks\[key\] === task/.test(forgetBody);

  for (const late of ['fail', 'finish'] as const) {
    const race = replacementRace(byIdentity, late);
    assert.equal(race.created.length, 2, `${late}: exactly two transfers for the key — the replacement, no duplicate`);
    assert.equal(race.live, race.created[1], `${late}: the successor is still the live transfer`);
    assert.equal(race.live?.cancelled, false, `${late}: and it was not cancelled by its predecessor’s report`);
    assert.equal(race.already, 1, `${late}: the later enqueue answered "already" instead of starting a second transfer`);
  }

  assert.ok(byIdentity, 'a terminal state forgets the task that ended, not the key it shares');
  assert.doesNotMatch(source, /forgetTask\(taskKey\)/, 'no terminal path forgets by key');
});

/* --------------------------------------------------------- 3. the figure never regresses */

test('the byte figure never goes down while the track is moving', async () => {
  const bridge = fakeBridge(Promise.resolve());
  const offline = store(bridge);
  await offline.download('pl1', songs, { name: 'Mix' });

  const figures: number[] = [];
  for (const bytes of [1_000_000, 3_000_000, 2_000_000, 4_000_000]) {
    // A second task for the same track used to report its own, lower count — the owner's "increment
    // then suddenly regress". One transfer per key means the only smaller reading is a stale one.
    bridge.emit('progress', { songId: 's0', bytes, total: SONG_BYTES });
    figures.push(offline.activityOf('pl1').bytes);
  }
  for (let i = 1; i < figures.length; i += 1) {
    assert.ok(
      figures[i]! >= figures[i - 1]!,
      `the figure regressed at step ${i}: ${figures[i - 1]} → ${figures[i]}`,
    );
  }
  assert.equal(figures.at(-1), 4_000_000, 'and it still follows the transfer’s own byte count');
});
