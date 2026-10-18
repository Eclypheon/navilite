/**
 * v2.0.0-beta.9 (unreleased) — the owner's note read **`failed: cannot create file`** on the shipped
 * beta.8, installed over beta.7, with zero `download.view` aborts server-side in 12 minutes.
 *
 * `cannot create file` is `NSURLErrorCannotCreateFile`, **-3000**: `URLSession` could not create the
 * download's OWN temp file — before a byte was written and before any request left the phone. So the
 * failure is a file-system condition, not a transfer, and three things follow, each modelled below
 * from the shipped source (`node --test` cannot run Swift, so the semantics are read out of it, the
 * way `download-restart.test.ts` reads `enqueue`/`forgetTask`):
 *
 *   1. the note carries `domain:code` — `cannot create file (-3000)` instead of the words alone — and
 *      a failure of our own step carries the path it was writing;
 *   2. `staging/` is created at the point of use and a creation failure fails the job with the path
 *      and the errno, instead of moving into nothing;
 *   3. a background session that survived an install-over can hand back tasks whose jobs are gone —
 *      each answers -3000 for ever — so `load()` cancels them before `reconcile()` and tells JS
 *      nothing;
 *   4. and the file-error family is retried **once per track per launch** (-3000/-3001/-3003): the
 *      pump's own re-enqueue is that retry, and a second occurrence sticks at `failed`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteDownloads.swift'), 'utf8');

/** One method or property's own body — sliced, so a claim is about that method only. */
function body(start: string, end: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `the plugin still has \`${start}\``);
  const until = source.indexOf(end, at + start.length);
  return source.slice(at, until === -1 ? undefined : until);
}

const didFailBody = body('fileprivate func didFail', 'fileprivate func didProgress');
const describeBody = body('fileprivate static func describe', 'fileprivate static func isFileError');
const localFailureBody = body('private func reportLocalFailure', '/* ---------------------------------------------------------------- methods */');
const loadBody = body('public override func load', '/* ---------------------------------------------------------------- methods */');
const pruneBody = body('private func pruneOrphanTasks', 'private func markSilent');
const enqueueBody = body('@objc func enqueue', '@objc func cancel');
const retryBody = body('private func takeFileErrorRetry', 'fileprivate static func localMessage');

/* --------------------------------------------- 1. the note names the code (and the path) */

test('a -3000 failure is reported with its domain and its code', () => {
  // The semantics, read out of the shipped source: the composed message, and the event payload.
  const codeInMessage = /\\\(ns\.code\)/.test(describeBody);
  const domainInPayload = /(?:"domain":\s*ns\.domain|data\["domain"\] = ns\.domain)/.test(didFailBody);
  const codeInPayload = /(?:"code":\s*ns\.code|data\["code"\] = ns\.code)/.test(didFailBody);

  const describe = (ns: { localizedDescription: string; code: number }): string =>
    codeInMessage ? `${ns.localizedDescription} (${ns.code})` : ns.localizedDescription;

  // The owner's exact string, on the exact error that produced it.
  const failure = { domain: 'NSURLErrorDomain', code: -3000, localizedDescription: 'cannot create file' };
  const message = describe(failure);
  assert.equal(message, 'cannot create file (-3000)', 'the words alone are not a diagnosis; the code is');

  const payload: Record<string, unknown> = { error: message };
  if (domainInPayload) payload.domain = failure.domain;
  if (codeInPayload) payload.code = failure.code;
  assert.equal(payload.domain, 'NSURLErrorDomain', 'the event carries the error domain');
  assert.equal(payload.code, -3000, '…and the numeric code');

  // Words without a code keep working: an error that is not an NSError must not print "nil".
  assert.equal(/error\.\?\.localizedDescription/.test(didFailBody), false, 'no bare localizedDescription is forwarded');
});

test('a failure of our own step names the file it was writing', () => {
  // `LocalFailure` carries the path, and the reporter puts it in the note AND in the payload.
  assert.match(source, /private struct LocalFailure: Error \{[\s\S]*?let path: String[\s\S]*?let underlying: Error/,
    'our own failures carry the path they were writing');
  assert.match(localFailureBody, /data\["path"\] = failingPath/, 'the path travels in the event');
  assert.match(localFailureBody, /"code": ns\.code/, 'and so does the code');
  assert.equal(/error\.localizedDescription/.test(source), false, 'no failure is reported by its words alone');
});

/* ------------------------------------------------- 2. no orphan task survives `load()` */

test('load() cancels every task whose job is gone, before it reconciles', () => {
  // Anchored to the START of a line: the words `reconcile()` also appear inside the comment above
  // the sweep, and a plain `indexOf` reads that mention as the call (it did, on the first version
  // of this test).
  const pruneAt = loadBody.search(/^\s*pruneOrphanTasks\(\)/m);
  const reconcileAt = loadBody.search(/^\s*reconcile\(\)/m);
  assert.ok(pruneAt >= 0, 'the boot sweep is called from load()');
  assert.ok(reconcileAt >= 0, 'and reconcile() is still the boot half of the state machine');
  assert.ok(pruneAt < reconcileAt, 'orphans are cleared BEFORE the reconcile walks the staging area');

  // The semantics, read out of the sweep's own body: a task survives only if a job names it —
  // and, since v2.0.0-beta.10, it is **adopted** into the live window so a re-enqueue of the same
  // key answers `already` instead of opening a second transfer.
  const keepsOnlyNamed = /if !key\.isEmpty, jobs\[key\] != nil,/.test(pruneBody) && /adopt\(task, key: key\)/.test(pruneBody);
  const silentBeforeCancel = pruneBody.indexOf('markSilent(task)') < pruneBody.indexOf('task.cancel()');
  const isSilentInDidFail = /if takeSilent\(task\) \{ return \}/.test(didFailBody);

  const jobs = new Set(['audio:s1']); // one persisted job; the rest are handovers from the last install
  const tasks = [
    { key: 'audio:s1', cancelled: false },
    { key: 'audio:gone', cancelled: false }, // install-over: the job is no longer in UserDefaults
    { key: 'lyrics:gone', cancelled: false },
    { key: '', cancelled: false }, // a task with no description at all is nobody's
  ];
  for (const task of tasks) {
    if (keepsOnlyNamed && task.key !== '' && jobs.has(task.key)) continue;
    task.cancelled = true;
  }

  assert.deepEqual(tasks.filter((task) => task.cancelled).map((task) => task.key), ['audio:gone', 'lyrics:gone', ''],
    'every task without a job is cancelled — and the one with a job is left alone');
  assert.equal(tasks.find((task) => task.key === 'audio:s1')?.cancelled, false, 'a live job is never cancelled by the sweep');

  assert.ok(keepsOnlyNamed, 'the sweep decides by "is this task named by a persisted job"');
  assert.ok(silentBeforeCancel, 'the cancellation is marked silent before it is issued');
  assert.ok(isSilentInDidFail, 'and didFail swallows it: no event reaches JS for an orphan');
});

/* ------------------------------------ 3. the file-error family is tried once per launch */

test('a second -3000 for the same track is not retried again in the same launch', () => {
  // The semantics, read out of the two bodies: the budget, and the answer enqueue gives once spent.
  const budget = /fileErrorRetried/.test(retryBody) && /fileErrorExhausted\.insert\(key\)/.test(retryBody);
  const givesUp = /fileErrorExhausted\(job\.taskKey\)/.test(enqueueBody)
    && /call\.resolve\(\["queued": false, "givenUp": true\]\)/.test(enqueueBody);
  const removesStaging = /stagingFile\(songId: songId, suffix: (?:suffix|job\.suffix)\)/.test(didFailBody)
    && /removeItem\(at: staging\)/.test(didFailBody);

  // The model: `takeFileErrorRetry` as written, then `enqueue`'s answer.
  const retried = new Set<string>();
  const exhausted = new Set<string>();
  const takeRetry = (key: string): boolean => {
    if (exhausted.has(key)) return false;
    if (retried.has(key)) {
      retried.delete(key);
      exhausted.add(key);
      return false;
    }
    retried.add(key);
    return true;
  };
  const enqueue = (key: string): { started: boolean } => {
    if (givesUp && exhausted.has(key)) return { started: false };
    return { started: true };
  };

  const KEY = 'audio:s1';
  assert.equal(takeRetry(KEY), true, 'the first -3000 is reported and the pump re-enqueues — that is the one retry');
  assert.equal(enqueue(KEY).started, true, '…and the retry is a real transfer');
  assert.equal(takeRetry(KEY), false, 'the second -3000 is NOT retried');
  assert.equal(enqueue(KEY).started, false, 'the pump\'s next pass starts nothing, so the row stays `failed`');
  assert.equal(takeRetry(KEY), false, 'and it stays given up for the rest of the launch');

  assert.ok(budget, 'the per-launch budget exists and is what stops the loop');
  assert.ok(givesUp, 'enqueue answers a spent key without starting a transfer');
  assert.ok(removesStaging, 'and the failed transfer\'s staging bytes are removed with it');

  // Per launch, per track: an instance property, never persisted, never shared across tracks.
  assert.match(source, /private var fileErrorRetried: Set<String> = \[\]/, 'the budget is in memory');
  assert.match(source, /private var fileErrorExhausted: Set<String> = \[\]/, '…and dies with the launch');
  assert.doesNotMatch(source, /fileError\w*.*UserDefaults|UserDefaults.*fileError/, 'it is not persisted');
  assert.match(source, /-3000, -3001, -3003/, 'the family is exactly the temp-file errors');
});
