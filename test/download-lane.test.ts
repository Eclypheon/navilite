/**
 * v1.9.12's download lane: two transfers per song, keyed independently.
 *
 * The defect this file exists for is not visible from JavaScript at all — `src/state/offline.ts` is
 * forbidden to import the bridge (invariant 7), so it enqueues an audio job and a `suffix: 'lyrics'`
 * job and cannot see that the native side keyed both by the bare `songId`. The lyrics enqueue then
 * overwrote `jobs[songId]` and `cancelTask(songId)` cancelled the **audio** transfer; on the phone
 * the download produced nothing, the rows stayed `staging` and the control sat on `n of total · retry`
 * forever. Only the native source can fail this test, so the native source is what it reads.
 *
 * It is a text test by necessity (Swift cannot be run from `node --test`), and it is built so that
 * the shipped bug would have failed it:
 *
 *   - the task/job key is `"<kind>:<songId>"`, not the bare `songId`;
 *   - `cancelTask` takes a kind and its predicate is the whole key;
 *   - `remove` is the only thing that cancels both kinds;
 *   - a model of that keying, driven with the separator **read out of the Swift file**, shows the
 *     audio transfer surviving its song's lyrics enqueue — the reproduction, in one assertion.
 *
 * Plus the two halves of the file lifecycle the design promised: the staging file that is verified
 * before it is promoted (E1/E2), the day-old orphan sweep (E7), and invariant 9 applied to the files
 * themselves, not only to the directory that holds them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteDownloads.swift'), 'utf8');

test('the audio and lyrics transfers of one song are keyed by songId *and* kind', () => {
  // The one key builder: "<kind>:<songId>".
  assert.match(source, /private static func taskKey\(_ kind: String, _ songId: String\) -> String/, 'the key is built by a named function');
  assert.match(source, /"\\\(kind\):\\\(songId\)"/, 'the key contains the kind, not only the song');
  // Every task and every job goes through it — the bare songId cannot come back.
  assert.match(source, /task\?\.taskDescription = job\.taskKey/, 'the task description is the job key');
  assert.match(source, /jobs\[job\.taskKey\] = job/, 'the jobs dictionary is keyed by the job key');
  assert.doesNotMatch(source, /task\?\.taskDescription = songId/, 'a task is never described by the bare songId');
  assert.doesNotMatch(source, /jobs\[job\.songId\]/, 'a job is never stored under the bare songId');
  assert.doesNotMatch(source, /readJobs\(\)\[songId\]/, 'a completion never looks a job up by the bare songId');
});

test('cancel cancels one kind; remove is the only thing that cancels both', () => {
  assert.match(source, /private func cancelTask\(kind: String, songId: String\)/, 'cancelTask is kind-aware');
  assert.match(source, /"status": status/, 'a failure carries the HTTP status, so a 404 lyric can be a miss');
  assert.match(source, /for task in tasks where task\.taskDescription == key/, 'the predicate is the whole key');
  assert.doesNotMatch(source, /func cancelTask\(songId:/, 'the bare-songId cancel is gone');
  // `cancel` resolves a kind: one kind when the caller names it, both when it does not (a playlist
  // cancel stops the song, not one of its axes).
  assert.match(source, /if let kind = call\.getString\("kind"\)/, 'cancel accepts an optional kind');
  // `remove` cancels and drops both jobs, then deletes both files.
  assert.match(source, /for kind in \[Self\.audioKind, Self\.lyricsKind\] \{\n\s+cancelTask\(kind: kind, songId: songId\)/, 'remove stops both transfers');
  assert.match(source, /let suffixes = \["mp3", "flac", "wav", "m4a", "ogg", "opus", "lyrics"\]/, 'remove deletes the lyric file with the audio');
});

test('the shipped bug is reproducible: the lyrics enqueue does not touch the audio transfer', () => {
  // The separator is read out of the Swift key template, so this model cannot drift from the source.
  const template = source.match(/"\\\(kind\)(.*?)\\\(songId\)"/);
  assert.ok(template, 'the key template is present');
  const separator = template[1];
  const key = (kind: string, songId: string): string => `${kind}${separator}${songId}`;

  // The native side, modelled exactly: tasks are described by a key, a job is stored under one, and
  // a cancel is a predicate over that key.
  const tasks = new Map<string, { taskDescription: string; cancelled: boolean }>();
  const jobs = new Map<string, { songId: string; suffix: string }>();
  const enqueue = (songId: string, suffix: string): void => {
    const kind = suffix === 'lyrics' ? 'lyrics' : 'audio';
    jobs.set(key(kind, songId), { songId, suffix });
    tasks.set(key(kind, songId), { taskDescription: key(kind, songId), cancelled: false });
  };
  const cancel = (kind: string, songId: string): void => {
    for (const task of tasks.values()) if (task.taskDescription === key(kind, songId)) task.cancelled = true;
  };
  const remove = (songId: string): void => {
    for (const kind of ['audio', 'lyrics']) {
      cancel(kind, songId);
      jobs.delete(key(kind, songId));
    }
  };

  enqueue('abc', 'flac'); // the audio transfer, the long pole
  enqueue('abc', 'lyrics'); // …and its lyric, second — the enqueue the bug ran through
  assert.equal(jobs.get(key('audio', 'abc'))?.suffix, 'flac', 'the lyrics enqueue did not overwrite the audio job');
  assert.equal(jobs.get(key('lyrics', 'abc'))?.suffix, 'lyrics', 'and the lyric job is its own entry');
  assert.equal(tasks.get(key('audio', 'abc'))?.cancelled, false, 'the audio task survives its song’s lyrics enqueue');
  assert.equal(tasks.get(key('lyrics', 'abc'))?.cancelled, false, 'the lyric task was not cancelled either');

  remove('abc');
  assert.equal(tasks.get(key('audio', 'abc'))?.cancelled, true, 'remove stops the audio transfer');
  assert.equal(tasks.get(key('lyrics', 'abc'))?.cancelled, true, 'remove stops the lyrics transfer');
  assert.equal(jobs.size, 0, 'and it drops both jobs');
});

test('the transfer is staged, verified against a real byte count, and only then promoted', () => {
  assert.match(source, /staging\/<songId>\.<suffix>\.part/, 'the layout names the staging file');
  assert.ok(source.includes('"\\(songId).\\(suffix)\\(Self.stagingSuffix)"') || source.includes('"\\(songId).\\(suffix)\\(NaviliteDownloads.stagingSuffix)"'), 'a transfer writes into staging first');
  assert.match(source, /let expected = responseExpected > 0 \? responseExpected : \(job\?\.expectedBytes \?\? 0\)/, 'the check uses the response Content-Length for lyrics too');
  assert.match(source, /downloadTask\.response\?\.expectedContentLength/, 'which is the response’s own Content-Length');
  assert.match(source, /guard matches else \{/, 'a byte mismatch is not promoted');
});

test('the boot reconcile promotes, re-fetches and sweeps — no staging row is left unexamined', () => {
  assert.match(source, /reconcile\(\)\n\s+\}/, 'the reconcile runs at plugin load, before JS');
  assert.match(source, /if !stale, job\.expectedBytes > 0, actual == job\.expectedBytes \{/, 'E2: a byte-exact staging file is promoted');
  assert.match(source, /private static let stagingMaxAge: TimeInterval = 24 \* 60 \* 60/, 'E7: the 24 h staging sweep');
  assert.match(source, /try\? FileManager\.default\.removeItem\(at: file\)/, 'E1: anything else is deleted, never trusted');
  assert.match(source, /if !named\.contains\(file\.lastPathComponent\)/, 'E7: a file the index does not name is an orphan');
});

test('invariant 9 covers the files, not only the directory', () => {
  assert.match(source, /private func excludeFromBackup\(_ url: URL\)/, 'there is a per-file exclusion');
  assert.match(source, /excludeFromBackup\(dir\)/, 'the directory still carries it');
  assert.match(source, /excludeFromBackup\(destination\)/, 'and each file moved into place does too');
  assert.match(source, /excludeFromBackup\(indexPath\)/, 'including the index');
});
