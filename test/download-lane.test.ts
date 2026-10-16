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

/**
 * v1.9.14, defect 1 — the one the owner saw from the phone.
 *
 * A 4xx from URLSession is a *successful transfer of an error body*: the response arrived, so
 * `didFinishDownloadingTo` runs and `didCompleteWithError` never does (`error == nil`). At 1.9.13
 * the only `statusCode` read in the file was inside `didCompleteWithError`, so the lyrics route's
 * `404` document for a track with no sidecar was staged, counted against its own `Content-Length`
 * (so the byte check agreed with it), moved to `<songId>.lyrics` and recorded `lyrics: {state:
 * "present"}` — the JSON blob in the Lyrics pane. Both assertions below fail against that tree.
 */
test('the completion handler reads the HTTP status, and only a 200 is ever promoted', () => {
  const handler = source.slice(source.indexOf('didFinishDownloadingTo'), source.indexOf('didWriteData'));
  assert.ok(handler.length > 0, 'the finish handler is in the file');
  assert.match(source, /let status = \(downloadTask\.response as\? HTTPURLResponse\)\?\.statusCode \?\? 0/, 'the response status is read');
  assert.match(handler, /guard status == 200 else \{/, 'and only a 200 reaches the staging path');
  assert.doesNotMatch(handler, /expectedContentLength[\s\S]*?\n\s*let status/, 'the status is read *before* the byte count, not after');
  assert.match(
    source,
    /plugin\?\.didFail\(taskKey: taskKey, error: NaviliteDownloads\.statusError\(status\), status: status\)/,
    'anything else is reported as failed, carrying the status JS maps to a miss',
  );
  assert.match(handler, /guard status == 200 else \{\s+try\? FileManager\.default\.removeItem\(at: location\)/, 'the staged bytes are deleted, never promoted');
  // The audio axis has the same hole (a non-200 body whose length matched would be promoted as
  // audio), so the guard is on the response, not on the kind.
  assert.doesNotMatch(handler, /kind == Self\.lyricsKind\) \{\s+let status/, 'the status check is not gated on the lyrics kind');
});

test('the route’s own error document is never stored as lyrics, wherever the bytes land', () => {
  assert.match(source, /fileprivate static func looksLikeRouteError\(_ url: URL\) -> Bool/, 'native carries the predicate');
  assert.ok(source.includes('head.hasPrefix("{\\"error\\"")'), 'the same first test as the parser: a body that opens with {"error"');
  assert.ok(source.includes('head.contains("no lyrics sidecar for this track")'), 'and the same second: the route’s own wording');
  assert.match(source, /if kind == Self\.lyricsKind, Self\.looksLikeRouteError\(destination\) \{/, 'the guard runs where the bytes become a row');
  assert.match(source, /"status": 404/, 'and the body is reported as the 404 it is, so JS records `none`, not `· retry`');
  // v1.9.15: the window is decoded lossily. `String(data:encoding:)` returns nil when byte 512
  // splits a UTF-8 character, which made this last door fail **open** — the one thing it may not
  // do. Both assertions fail against the 1.9.14 tree.
  assert.match(source, /String\(decoding: data\.prefix\(512\), as: UTF8\.self\)/, 'the 512-byte window is decoded with no nil branch');
  assert.doesNotMatch(source, /String\(data: data\.prefix\(512\), encoding: \.utf8\)/, 'the nil-returning initialiser is gone');
});

/**
 * v1.9.20 — the **album-art axis**, as source-level claims.
 *
 * Swift cannot be run from `node --test`, so this is where the two silent catastrophes the design
 * names are held: an art job without its own kind (which overwrites the song's audio job and hands
 * the player a JPEG) and an art file the boot sweep does not know about (which is deleted on the next
 * launch, taking the owner's covers with it).
 */
test('the art axis has its own kind, or a cover overwrites the song it belongs to', () => {
  assert.match(source, /private static let artKind = "art"/, 'the third kind exists');
  assert.match(source, /return suffix == artKind \? artKind : audioKind/, 'and the suffix maps to it');
  assert.match(
    source,
    /kind == Self\.artKind \? Self\.artKind : "mp3"/,
    'a job-less art transfer still lands as <cover>.art, never as <cover>.mp3',
  );
});

test('every field the art axis adds to a durable record is Optional', () => {
  /*
   * §I9, and it is a hard rule rather than a preference: `readIndex()` returns `[:]` when the decode
   * fails and the boot sweep then deletes **every file the index does not name** — so one
   * non-optional field added against the owner's 1.9.19 `index.json` is a silent deletion of every
   * download he has, and the same for a job in `navilite.offline.jobs`.
   */
  assert.match(source, /var coverArt: String\? = nil/, 'IndexRow.coverArt is optional');
  assert.match(source, /var art: ArtRow\? = nil/, 'IndexRow.art is optional');
  assert.match(source, /var coverOf: \[String\]\? = nil/, 'Job.coverOf is optional');
  assert.equal((source.match(/var coverArt: String\? = nil/g) ?? []).length, 2, 'on both the row and the job');
  assert.doesNotMatch(source, /var coverArt: String$/, 'never non-optional');
});

test('the boot sweep is taught the cover file, which is named after a cover id', () => {
  assert.match(source, /if let file = row\.art\?\.file, !file\.isEmpty \{ names\.append\(file\) \}/, 'the named set includes every art file');
  assert.match(source, /let named = Set\(\s*\n\s*index\.values\.flatMap \{ row -> \[String\] in/, 'and it is still the orphan predicate');
  assert.match(source, /if !named\.contains\(file\.lastPathComponent\)/, 'unchanged: a file no row names is swept');
});

test('remove deletes the shared cover only when the last row naming it goes', () => {
  assert.match(source, /let stillNamed = index\.values\.contains \{ \$0\.art\?\.file == file \}/, 'the scan reads the whole index');
  assert.match(
    source,
    /if !stillNamed, let base = baseURL \{\s*\n\s*try\? FileManager\.default\.removeItem\(at: base\.appendingPathComponent\(file\)\)/,
    'and the file goes with the last row that names it',
  );
  assert.match(source, /let removed = index\.removeValue\(forKey: songId\)/, 'the row that was removed is examined, not just dropped');
});

test('the cover is fanned out by cover id, and a body that is not an image is refused', () => {
  assert.match(source, /fileprivate static func looksLikeImage\(_ url: URL\) -> Bool/, 'the image sniff exists where the bytes become a row');
  assert.match(source, /guard Self\.looksLikeImage\(destination\) else \{/, 'and it refuses a body that is not an image');
  assert.match(source, /if kind == Self\.artKind \{/, 'the art branch of `finish`');
  assert.match(source, /let targets = index\.keys\.filter \{ key in/, 'which collects every row that names the cover');
  assert.match(source, /index\[key\]\?\.coverArt = cover/, 'and writes the cover id, so a row written by 1.9.19 learns it');
  assert.match(source, /index\[key\]\?\.art = artRow/, 'and the art row itself');
  assert.match(source, /"songId": cover, "kind": kind, "bytes": bytes/, 'the done event is keyed by the cover, never by a song');
  assert.match(source, /guard !targets\.isEmpty else \{/, 'a cover whose audio never landed is not recorded as a row');
});
