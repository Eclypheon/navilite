/**
 * The completion door (owner, v2.0.0-beta.6), in his words:
 *
 *   "even after 500 MB has been downloaded, it still shows 0 of 233 songs, whereas previously on
 *    live container it will download song by song"
 *
 * 500 MB across 233 tracks is about 2 MB each — every track's bytes arrived and none became a
 * `complete` row, so the defect is in the door the finished bytes go through. Two classes live there,
 * and this file reads them out of the shipped Swift, because Swift cannot be run from `node --test`:
 *
 *   1. **a `206` is not a failure.** This app sits behind Caddy, which passes Range through, so a
 *      resumed transfer answers `206 Partial Content` with perfectly good bytes; the old guard
 *      (`status == 200`) deleted them and reported `HTTP 206` — every track re-fetched for ever.
 *      The statuses the guard accepts are read out of the source and then driven as a model, so the
 *      test cannot drift from the file.
 *   2. **an unknown length is unverifiable, not a mismatch.** The byte check used to fall back to the
 *      JS job's `bytes` when the response carried no usable length — a stale or rounded guess — and a
 *      correct file then failed for ever. `0` means "nothing to check against", and promotes.
 *
 * Every assertion here fails against `v2.0-beta.6` (d0e44d5). The JavaScript half of the same
 * report — the figure that kept adding a settled transfer's bytes, and the control that never said
 * why — is pinned in `test/download-honest.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteDownloads.swift'), 'utf8');

test('a completed transfer accepts 200 and 206, and still rejects anything else', () => {
  const handler = source.slice(source.indexOf('didFinishDownloadingTo'), source.indexOf('didWriteData'));
  assert.ok(handler.length > 0, 'the finish handler is in the file');
  // The one door every finished body goes through: a whole response or a partial one.
  assert.match(handler, /guard status == 200 \|\| status == 206 else \{/, 'a 206 reaches the staging path');
  assert.match(
    handler,
    /guard status == 200 \|\| status == 206 else \{\s+try\? FileManager\.default\.removeItem\(at: location\)/,
    'and anything else is still deleted, never promoted',
  );

  // Read the accepted statuses OUT of the source, then drive the guard as a model: this is the
  // shipped behaviour, not a paraphrase of it.
  const accepted = new Set<number>();
  const guard = handler.match(/guard status == [^\n]+/);
  assert.ok(guard, 'the status guard is one line');
  for (const match of guard[0].matchAll(/status == (\d+)/g)) accepted.add(Number(match[1]));
  assert.deepEqual([...accepted].sort(), [200, 206], 'the guard names exactly a whole and a partial response');
  const promotes = (status: number): boolean => accepted.has(status);
  assert.equal(promotes(206), true, 'a partial response is a completion');
  assert.equal(promotes(200), true, 'and so is a whole one');
  assert.equal(promotes(404), false, 'a 404 body is still an error, never audio');
  assert.equal(promotes(500), false, 'and so is a server error');
});

test('a 206 is measured against its Content-Range total, never its range length', () => {
  assert.match(source, /fileprivate static func expectedTotal\(_ response: HTTPURLResponse\?\) -> Int/, 'the length is resolved by one named function');
  assert.match(source, /if response\.statusCode == 206 \{/, 'a partial response is asked for its own total');
  assert.match(source, /value\(forHTTPHeaderField: "Content-Range"\)/, 'from `Content-Range`');
  assert.match(source, /lastIndex\(of: "\/"\)/, 'whose total sits after the slash: bytes 0-…/2097152');
  // A whole response keeps the length it always used.
  assert.match(source, /let length = Int\(response\.expectedContentLength\)/, 'a 200 uses its Content-Length');
  assert.match(source, /return length > 0 \? length : 0/, 'and no length at all is 0, not a guess');
});

test('an unknown expected length is unverifiable, never a mismatch', () => {
  // The completion path: the response's own length, or "nothing to check against". The JS job's
  // `bytes` must NOT be the fallback — it is the stale guess that failed correct files for ever.
  assert.match(source, /let expected = responseExpected > 0 \? responseExpected : 0/, 'the fallback to the JS job’s guess is gone');
  assert.doesNotMatch(source, /job\?\.expectedBytes \?\? 0/, 'a job’s own guess never becomes the expected length');
  // …and the check itself promotes when there is nothing to compare against.
  assert.match(source, /let matches = expected <= 0 \|\| actual == expected/, 'an unverifiable file is promoted');
  assert.match(source, /guard matches else \{/, 'a real mismatch still is not');
});
