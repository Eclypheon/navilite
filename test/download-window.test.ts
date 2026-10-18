/**
 * v2.0.0-beta.10 — **`failed: cannot create file` (-3000) on a fresh container.**
 *
 * The owner reinstalled (empty container, plenty of free space) and the beta.8/9 build still reported
 * `NSURLErrorCannotCreateFile` — URLSession failing on its **own temp file**, before a byte was
 * written and before a request reached the server. The install-over/orphan theory died with that
 * install. What was left: `enqueue` created and resumed a `URLSessionDownloadTask` for **every** job
 * it was handed, and `httpMaximumConnectionsPerHost` caps *connections*, not tasks or the temp files
 * they each need. A 233-track playlist asks for 233 audio + ~233 lyrics + ~40 covers at once — several
 * hundred simultaneous tasks — which is the shape that makes `nsurlsessiond` fail to create files.
 * It also matches the build he remembers as working, which downloaded "song by song".
 *
 * `node --test` cannot run Swift, so the plugin's behaviour is **modelled from the shipped source**,
 * the way `test/download-restart.test.ts` does it: the semantics below are read out of the plugin's
 * own methods, and the model then reproduces the owner's burst. Against the beta.9 tree each test
 * fails (nothing bounds the live set); against this one they pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteDownloads.swift'), 'utf8');

/** A method's own body, sliced so a claim is about that method only. */
function body(signature: string, endSignature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `the plugin still has ${signature}`);
  const end = source.indexOf(endSignature, start + signature.length);
  return source.slice(start, end === -1 ? undefined : end);
}

const enqueueBody = body('@objc func enqueue', '@objc func cancel');
const forgetBody = body('fileprivate func forgetTask', '\n    /**');
const cancelBody = body('private func cancelTask(kind: String, songId: String)', '\n    /**');
const configureBody = body('@objc func configure', '@objc func enqueue');
const reconcileBody = body('private func reconcile()', '\n}');
const pruneBody = body('private func pruneOrphanTasks', '\n    /**');
const adoptBody = body('private func adopt(', '\n    /// This task');
const startNextBody = body('private func startNextPending', '\n    /**');
const didFailBody = body('fileprivate func didFail', 'fileprivate func didProgress');

/** Every fact the model below is entitled to, read out of the shipped plugin. */
const sem = {
  /** The window's width, from the constant `enqueue` and `register` both consult. */
  maxLive: Number(/private static let defaultMaxLive = (\d+)/.exec(source)?.[1] ?? NaN),
  /** The waiting half of the window: a FIFO of keys that were persisted but not started. */
  pendingKeys: /private var pendingKeys: \[String\] = \[\]/.test(source),
  /** The cap is enforced where the task is registered, not only where the slot is counted. */
  gatedInRegister: /guard liveTasks\.count < maxLive else \{ return false \}/.test(source),
  /** A job with no slot is answered as *waiting*, never as a failure. */
  waitingAnswer: /call\.resolve\(\["queued": true, "waiting": true\]\)/.test(enqueueBody),
  /** A settle starts the next waiting key. */
  pumpsOnForget: /pumpPending\(\)/.test(forgetBody),
  /** A cancel drops the key, so a waiting track is never started later. */
  dropsOnCancel: /dropPending\(key\)/.test(cancelBody),
  /** `configure({maxConcurrent})` sets the window too, so the two sides agree. */
  configuresWindow: /maxLive = max/.test(configureBody),
  /** The boot sweep adopts the session's surviving tasks, so they count toward the window. */
  adoptsAtBoot: /self\.adopt\(task, key: key\)/.test(body('private func pruneOrphanTasks', '\n    /**')),
  /** …but never more than the window holds: a relaunch may not come up wider than a launch. */
  adoptsWithinWindow: /liveTasks\.count < maxLive/.test(adoptBody),
  /** …and only a task that will still call back (a terminal one would hold a slot all launch). */
  adoptsOnlyLive: /task\.state == \.running/.test(adoptBody),
  /** …and only a key nothing already tracks: `getAllTasks` is async, so `enqueue` can win it. */
  adoptsOnlyUntracked: /liveTasks\[key\] == nil/.test(adoptBody),
  /** A task the sweep will not adopt is cancelled, so it cannot run outside `liveTasks`. */
  cancelsUnadopted:
    /self\.adopt\(task, key: key\) \{ continue \}/.test(pruneBody) &&
    /self\.markSilent\(task\)\s*\n\s*task\.cancel\(\)/.test(pruneBody),
  /** The loser of the `hasSlot`/`register` race is marked silent *before* it is cancelled. */
  marksLoserSilent: (() => {
    const registerAt = enqueueBody.indexOf('register(task, key: job.taskKey)');
    const markAt = enqueueBody.indexOf('markSilent(task)', registerAt);
    const cancelAt = enqueueBody.indexOf('task.cancel()', registerAt);
    return registerAt >= 0 && markAt >= 0 && cancelAt >= 0 && markAt < cancelAt;
  })(),
  /** `didFail` says nothing — and removes nothing — for a key that has no job. */
  failsOnlyWithJob: (() => {
    const guardAt = didFailBody.indexOf('guard let job = readJobs()[taskKey] else');
    const removeAt = didFailBody.indexOf('removeJob(kind: kind, songId: songId)');
    return guardAt >= 0 && removeAt >= 0 && guardAt < removeAt;
  })(),
  /** A waiting key with no job is spoken for, not quietly shifted off the queue. */
  speaksForJobless: /reportUnstartable\(key\)/.test(startNextBody),
};

interface Response {
  queued?: boolean;
  already?: boolean;
  waiting?: boolean;
}

/**
 * `NaviliteDownloads` reduced to the facts the owner's defect turns on: what gets a task, what waits,
 * and what starts when a transfer ends. `pendingKeys` false reproduces the beta.9 shape — every job
 * starts immediately — which is what each behavioural test asserts against.
 */
class Window {
  /** Keys with a persisted job (native `persist`/`removeJob`). */
  readonly jobs = new Set<string>();
  live = new Set<string>();
  pending: string[] = [];
  started: string[] = [];
  peak = 0;
  readonly failures: string[] = [];

  /**
   * `shade` overrides one fact from the shipped source, so a test can run the model against the
   * *reviewed* shape and show which assertion the defect would have failed.
   */
  private readonly shade: Partial<typeof sem>;

  constructor(shade: Partial<typeof sem> = {}) {
    this.shade = shade;
  }

  private get facts(): typeof sem {
    return { ...sem, ...this.shade };
  }

  get cap(): number {
    return this.facts.pendingKeys ? sem.maxLive : Number.POSITIVE_INFINITY;
  }

  enqueue(key: string, losesRegisterRace = false): Response {
    this.jobs.add(key); // persisted before any decision — a waiting job is a complete job
    if (this.live.has(key)) return { queued: true, already: true };
    if (this.pending.includes(key)) return { queued: true, waiting: true };
    if ((this.live.size < this.cap || !sem.pendingKeys) && !losesRegisterRace) {
      this.start(key);
      return { queued: true };
    }
    // `hasSlot()` said yes, `register` said no: the fresh task is cancelled unregistered, and the
    // key waits for the next free slot instead.
    this.pending.push(key);
    return { queued: true, waiting: true };
  }

  /**
   * `didCompleteWithError` for the task a losing `register` cancelled. Marked silent, `didFail`
   * swallows it; unmarked, it reports the track as failed and deletes the job it was about to wait
   * on — `removeJob` then `notifyListeners("failed")`.
   */
  loserCancelled(key: string): void {
    if (this.facts.marksLoserSilent) return;
    this.failures.push(key);
    this.jobs.delete(key);
  }

  /** `didFinishDownload` / `didFail` / a transfer that ended with no body: it stops being live. */
  settle(key: string): void {
    if (!this.live.delete(key)) return;
    this.jobs.delete(key); // removeJob on every terminal path
    if (sem.pumpsOnForget) this.pump();
  }

  /** `cancel` / `remove`: the track is withdrawn. */
  cancel(key: string): void {
    if (sem.dropsOnCancel) this.pending = this.pending.filter((pending) => pending !== key);
    this.jobs.delete(key);
    const wasLive = this.live.delete(key);
    if (sem.pendingKeys && (wasLive || sem.dropsOnCancel)) this.pump();
  }

  /** `pumpPending`: one start per free slot, in request order, from the persisted job. */
  private pump(): void {
    while (this.live.size < this.cap && this.pending.length > 0) {
      const key = this.pending.shift() as string;
      if (!this.jobs.has(key)) {
        // No job to start from: `startNextPending` drops the key. Whether the row is told is the
        // difference the review drew — dropped in silence, it sits on `downloading` until STALL_MS.
        if (this.facts.speaksForJobless) this.failures.push(key);
        continue;
      }
      this.start(key);
    }
  }

  private start(key: string): void {
    this.live.add(key);
    this.started.push(key);
    this.peak = Math.max(this.peak, this.live.size);
  }

  /** Let the live set run to completion, one settle at a time. */
  drain(): void {
    while (this.live.size > 0) this.settle([...this.live][0] as string);
  }
}

test('the plugin has a window, and its width is the one the app asks for', () => {
  assert.equal(sem.maxLive, 4, 'maxLive is a real number of transfers, not "as many as asked"');
  assert.equal(sem.pendingKeys, true, 'keys with no slot are held in a FIFO instead of started');
  assert.equal(sem.gatedInRegister, true, 'the cap is enforced where the task is registered');
  // The idempotency guard returns before the window is consulted, so a re-walk of a live key neither
  // consumes a slot nor replaces the transfer.
  const guardAt = enqueueBody.indexOf('if let live = liveTask(job.taskKey)');
  const slotAt = enqueueBody.indexOf('hasSlot()');
  assert.ok(guardAt >= 0, 'enqueue still has its idempotency guard');
  assert.ok(slotAt >= 0 && guardAt < slotAt, 'and it answers `already` before a slot is taken');
  assert.equal(sem.waitingAnswer, true, 'a job with no slot is answered as waiting');
  assert.equal(sem.pumpsOnForget, true, 'a transfer that ends starts the next waiting job');
  assert.equal(sem.dropsOnCancel, true, 'a cancelled track is dropped from the queue');
  assert.equal(sem.configuresWindow, true, 'configure({maxConcurrent}) widens the window itself');
  assert.equal(sem.adoptsAtBoot, true, 'a relaunch adopts the background session’s live tasks');
  // The boot reconcile promotes staged bytes and sweeps orphans; it must not open a transfer for
  // every job in the store — the window would then be blind to the boot path.
  assert.doesNotMatch(reconcileBody, /downloadTask\(with:/, 'reconcile starts no transfer');
  assert.doesNotMatch(reconcileBody, /\.resume\(\)/, 'reconcile resumes no transfer');
});

test('enqueuing 50 jobs starts at most maxLive, and each settle starts exactly one more, in order', () => {
  const window = new Window();
  for (let i = 0; i < 50; i += 1) window.enqueue(`audio:s${i}`);

  assert.equal(window.started.length, sem.maxLive, `${window.started.length} transfers live after a 50-job walk`);
  assert.equal(window.peak, sem.maxLive, 'and never more than the window, at any moment');

  for (let i = 0; i < 46; i += 1) {
    window.settle(`audio:s${i}`);
    assert.equal(window.started.length, 5 + i, `settle ${i} started ${window.started.length - 4} replacements`);
    assert.equal(window.started[4 + i], `audio:s${4 + i}`, `and it started the next job in request order`);
  }
  assert.equal(window.started.length, 50, 'every job eventually ran');
  assert.equal(window.peak, sem.maxLive, 'with the live set never wider than the window');
});

test('a job cancelled while it waits is never started', () => {
  const window = new Window();
  for (let i = 0; i < 10; i += 1) window.enqueue(`audio:s${i}`);
  assert.equal(window.pending.includes('audio:s5'), true, 'audio:s5 is waiting for a slot');

  window.cancel('audio:s5');
  window.drain();

  assert.equal(window.started.includes('audio:s5'), false, 'the cancelled track never opened a transfer');
  assert.equal(window.started.length, 9, 'and every other track ran');
  assert.equal(window.peak, sem.maxLive, 'the burst stayed inside the window');
});

test('a waiting job is not a failure, and stays pending', () => {
  const window = new Window();
  const answers: Response[] = [];
  for (let i = 0; i < 50; i += 1) answers.push(window.enqueue(`audio:s${i}`));

  for (let i = sem.maxLive; i < 50; i += 1) {
    assert.deepEqual(
      answers[i],
      { queued: true, waiting: true },
      `job ${i} was answered as waiting, not rejected`,
    );
    assert.equal(window.started.includes(`audio:s${i}`), false, `job ${i} has no transfer yet`);
  }
  assert.deepEqual(window.failures, [], 'nothing in the queue is reported as a failed download');
  assert.equal(window.pending.length, 46, 'and every one of them is still in the queue');
  assert.equal(window.jobs.size, 50, 'with its job on disk, so a slot can start it without JS');

  // The reply a waiting job gets is a resolve, and no rejection follows it in `enqueue`.
  const tail = enqueueBody.slice(enqueueBody.indexOf('holdPending(job.taskKey)'));
  assert.match(tail, /call\.resolve\(\["queued": true, "waiting": true\]\)/);
  assert.doesNotMatch(tail, /call\.reject/, 'a waiting job is never answered with a failure');
});

test('a 233-track playlist asks for hundreds of transfers and never has more than maxLive live', () => {
  const window = new Window();
  const TRACKS = 233;
  const keys: string[] = [];
  for (let i = 0; i < TRACKS; i += 1) {
    keys.push(`audio:s${i}`, `lyrics:s${i}`);
    if (i % 6 === 0) keys.push(`art:c${i}`); // one cover per album, not per track
  }

  for (const key of keys) window.enqueue(key);
  assert.equal(window.started.length, sem.maxLive, 'the walk opened only a window’s worth of transfers');
  assert.equal(window.pending.length, keys.length - sem.maxLive, 'the rest wait in request order');
  assert.equal(window.peak, sem.maxLive, `peak live tasks: ${window.peak}`);

  window.drain();
  assert.equal(window.started.length, keys.length, 'every transfer ran, exactly once');
  assert.equal(new Set(window.started).size, keys.length, 'with no key started twice');
  assert.equal(window.peak, sem.maxLive, `peak live tasks across the whole playlist: ${window.peak}`);
  assert.deepEqual(window.failures, [], 'and no queued job was reported as a failure');
});

/* ------------------------------------------------- 5. what the window must not break */

test('the window keeps every download invariant that already held', () => {
  const window = new Window();

  // (a) Idempotent enqueue for a live transfer: answered `already`, no second task, and the guard
  //     comes before the replacement and before the window (so a re-walk cannot consume a slot).
  const first = window.enqueue('audio:s1');
  const again = window.enqueue('audio:s1');
  assert.deepEqual(first, { queued: true }, 'the first enqueue starts the transfer');
  assert.deepEqual(again, { queued: true, already: true }, 'a live transfer answers `already`');
  assert.equal(window.started.length, 1, 'and no second transfer was created for it');

  const guardAt = enqueueBody.indexOf('if let live = liveTask(job.taskKey)');
  const stopAt = enqueueBody.indexOf('stopTask(key: job.taskKey, deliberate: true)');
  assert.ok(guardAt >= 0 && guardAt < stopAt, 'the idempotency guard returns before anything is cancelled');
  assert.match(enqueueBody, /call\.resolve\(\["queued": true, "already": true\]\)/, 'the answer is still `already`');

  // (b) Cancel by identity: the task that ended is forgotten by object, not by key.
  assert.match(source, /private func forgetTask\(_ task: URLSessionTask\)/, 'a terminal state is forgotten by identity');
  assert.match(source, /liveTasks\[key\] === task/, 'and only for the task that actually ended');
  assert.doesNotMatch(source, /forgetTask\(taskKey\)/, 'no terminal path forgets by key');

  // (c) The one-retry budget for -3000: spent once per track per launch, and an exhausted key does
  //     not persist or start anything (it cannot loop through the window either).
  assert.match(source, /fileErrorExhausted\(job\.taskKey\)/, 'enqueue consults the per-launch budget');
  const exhaustedTail = enqueueBody.slice(
    enqueueBody.indexOf('fileErrorExhausted(job.taskKey)'),
    enqueueBody.indexOf('persist(job: job)'),
  );
  assert.match(exhaustedTail, /call\.resolve\(\["queued": false, "givenUp": true\]\)/, 'an exhausted track is answered, not started');
  assert.doesNotMatch(exhaustedTail, /downloadTask\(with:|resume\(\)|holdPending/, 'nothing is started or queued for it');
  assert.match(source, /retried = takeFileErrorRetry\(taskKey\)/, 'the failure path takes the retry exactly when it is reported');

  // (d) The 206 door: a partial body is promoted, not failed.
  assert.match(source, /guard status == 200 \|\| status == 206/, 'a 206 is still accepted');
});

/* --------------------------- 6. the four edges the adversarial review found (beta.10) */

/** One task the background session hands back at boot (`getAllTasks`'s callback). */
interface Restored {
  key: string;
  state: 'running' | 'suspended' | 'completed';
  hasJob: boolean;
}

/**
 * `pruneOrphanTasks` and `adopt`, from the shipped source: what a relaunch does with the tasks the
 * background session survived with — the session outlives an install-over, so this is whatever
 * beta.9 left behind. `track(key)` is an `enqueue` that registered a key first, which
 * `getAllTasks` being asynchronous makes possible.
 */
class Boot {
  readonly live = new Map<string, string>();
  readonly cancelled: string[] = [];
  private readonly cap: number;
  private readonly shade: Partial<typeof sem>;

  constructor(cap: number, shade: Partial<typeof sem> = {}) {
    this.cap = cap;
    this.shade = shade;
  }

  private get facts(): typeof sem {
    return { ...sem, ...this.shade };
  }

  /** An `enqueue` that got there first: its own task holds the key, and a slot. */
  track(key: string): void {
    this.live.set(key, 'enqueue');
  }

  sweep(restored: Restored[]): void {
    for (const task of restored) {
      if (task.hasJob && this.adopt(task)) continue;
      // `markSilent` then `task.cancel()`: no event reaches JS for a task this launch does not own.
      this.cancelled.push(task.key);
    }
  }

  private adopt(task: Restored): boolean {
    if (!this.facts.adoptsWithinWindow) {
      // The reviewed shape: every surviving task with a job is adopted, however many there are.
      if (!this.live.has(task.key)) this.live.set(task.key, 'restored');
      return true;
    }
    if (this.live.has(task.key)) {
      // Ignored rather than cancelled is the defect: the restored task keeps running untracked.
      return !this.facts.adoptsOnlyUntracked;
    }
    if (this.facts.adoptsOnlyLive && task.state !== 'running') return false;
    if (this.live.size >= this.cap) return false;
    this.live.set(task.key, 'restored');
    return true;
  }
}

test('a relaunch adopts at most maxLive of the surviving backlog, and cancels the rest', () => {
  const restored: Restored[] = Array.from({ length: 300 }, (_, i) => ({
    key: `audio:s${i}`,
    state: 'running',
    hasJob: true,
  }));

  const boot = new Boot(sem.maxLive);
  boot.sweep(restored);
  assert.equal(boot.live.size, sem.maxLive, `a relaunch came up with ${boot.live.size} live tasks`);
  assert.equal(boot.cancelled.length, restored.length - sem.maxLive, 'and cancelled everything past the window');

  // The cancelled tasks keep their jobs, so the JS replay asks for them again — inside the window,
  // which is the whole point: a relaunch may not be wider than a launch.
  const replay = new Window();
  for (const key of [...boot.live.keys(), ...boot.cancelled]) replay.enqueue(key);
  assert.equal(replay.peak, sem.maxLive, `the replay peaked at ${replay.peak}`);

  // The reviewed shape: the boot sweep adopted the session's whole backlog, so the first launch
  // after the upgrade filled `liveTasks` and `register` refused every new start.
  const reviewed = new Boot(Number.POSITIVE_INFINITY, { adoptsWithinWindow: false });
  reviewed.sweep(restored);
  assert.equal(reviewed.live.size, restored.length, 'the reviewed sweep adopted the whole backlog');
  assert.equal(reviewed.cancelled.length, 0, 'and cancelled nothing');

  assert.equal(sem.adoptsWithinWindow, true, 'adopt is bounded by the same window as `register`');
});

test('a restored task the plugin already tracks is cancelled, not left running untracked', () => {
  const boot = new Boot(sem.maxLive);
  boot.track('audio:s1'); // `enqueue` registered this key while `getAllTasks` was still running
  boot.sweep([{ key: 'audio:s1', state: 'running', hasJob: true }]);

  assert.deepEqual(boot.cancelled, ['audio:s1'], 'the duplicate is cancelled');
  assert.equal(boot.live.get('audio:s1'), 'enqueue', 'and the tracked transfer is the only one under that key');
  assert.equal(boot.live.size, 1, 'a duplicate costs no second slot');

  // A task that will never call back must not hold a slot for the launch.
  const terminal = new Boot(sem.maxLive);
  terminal.sweep([
    { key: 'audio:s2', state: 'completed', hasJob: true },
    { key: 'audio:s3', state: 'suspended', hasJob: true },
  ]);
  assert.equal(terminal.live.size, 0, 'neither a finished nor a suspended task is adopted');
  assert.deepEqual(terminal.cancelled, ['audio:s2', 'audio:s3'], 'both are cancelled instead');

  // The reviewed shape: the duplicate fell through `if liveTasks[key] == nil`, so it was neither
  // adopted nor cancelled — it kept transferring outside `liveTasks`, uncancellable by key.
  const reviewed = new Boot(sem.maxLive, { adoptsOnlyUntracked: false, adoptsOnlyLive: false });
  reviewed.track('audio:s1');
  reviewed.sweep([{ key: 'audio:s1', state: 'running', hasJob: true }]);
  assert.deepEqual(reviewed.cancelled, [], 'the reviewed sweep left the duplicate running');
  assert.equal(reviewed.live.size, 1, 'while nothing tracked it');

  assert.equal(sem.adoptsOnlyUntracked, true, 'adopt refuses a key that is already tracked');
  assert.equal(sem.adoptsOnlyLive, true, 'and a task that will never call back');
  assert.equal(sem.cancelsUnadopted, true, 'and cancels what it will not adopt');
});

test('a waiting key whose job has gone is reported, not dropped in silence', () => {
  const window = new Window();
  for (let i = 0; i < 10; i += 1) window.enqueue(`audio:s${i}`);
  assert.equal(window.pending.includes('audio:s4'), true, 'audio:s4 waits at the head of the queue');

  window.jobs.delete('audio:s4'); // a job lost to a concurrent write, or removed by a cancel
  window.settle('audio:s0');

  assert.deepEqual(window.failures, ['audio:s4'], 'the row is told its download cannot start');
  assert.equal(window.started.includes('audio:s4'), false, 'and no transfer is opened for it');
  assert.equal(window.pending.includes('audio:s4'), false, 'the dead key leaves the queue');

  // The reviewed shape said nothing, so the row sat on `downloading` until the JS stall window
  // offered a retry STALL_MS later — for a key nothing was ever going to start.
  const reviewed = new Window({ speaksForJobless: false });
  for (let i = 0; i < 10; i += 1) reviewed.enqueue(`audio:s${i}`);
  reviewed.jobs.delete('audio:s4');
  reviewed.settle('audio:s0');
  assert.deepEqual(reviewed.failures, [], 'before the fix the drop was silent');

  assert.equal(sem.speaksForJobless, true, '`startNextPending` speaks for a job-less key');
});

test('the loser of the register race produces no failure, and keeps the job it waits on', () => {
  const window = new Window();
  for (let i = 0; i < sem.maxLive; i += 1) window.enqueue(`audio:s${i}`);
  assert.equal(window.live.size, sem.maxLive, 'the window is full');

  // `hasSlot()` answered yes, another caller took the slot, `register` refused: the fresh task is
  // cancelled unregistered, and the key waits for the next free slot.
  const answer = window.enqueue('audio:s9', true);
  assert.deepEqual(answer, { queued: true, waiting: true }, 'the loser waits rather than failing');
  window.loserCancelled('audio:s9');

  assert.deepEqual(window.failures, [], 'no `failed` event for a transfer that never started');
  assert.equal(window.jobs.has('audio:s9'), true, 'and its job is still on disk');

  window.settle('audio:s0');
  assert.equal(window.started.includes('audio:s9'), true, 'the pump starts it from that job');

  // The reviewed shape: the unmarked loser reached `didFail`, which reported the track and removed
  // the job — the row read `failed` while its key sat in `pendingKeys` with nothing to start.
  const reviewed = new Window({ marksLoserSilent: false });
  for (let i = 0; i < sem.maxLive; i += 1) reviewed.enqueue(`audio:s${i}`);
  reviewed.enqueue('audio:s9', true);
  reviewed.loserCancelled('audio:s9');
  assert.deepEqual(reviewed.failures, ['audio:s9'], 'before the fix the loser reported a failure');
  assert.equal(reviewed.jobs.has('audio:s9'), false, 'and its job was deleted');

  assert.equal(sem.marksLoserSilent, true, 'the plugin marks the loser silent before cancelling it');
  assert.equal(sem.failsOnlyWithJob, true, 'and `didFail` reports nothing for a key with no job');
});
