/**
 * §4 — the size a playlist will take, and the reconciliation rule for a staging row.
 *
 * Three claims, all pure and testable without a phone or a server:
 *   1. exact sum when every entry carries a `size`;
 *   2. the 320 kbit/s over-estimate when one is missing, flagged `exact: false` (the UI prefixes
 *      `up to`);
 *   3. zero entries is `0 B`, exact.
 *
 * And the §5 resume rule — a staging row whose written bytes match the expected length is promoted
 * to `complete`, anything else is `partial` and re-fetched — lives in `NaviliteDownloads.swift`'s
 * boot reconcile, where the bytes are (JS never touches the filesystem); `test/download-lane.test.ts`
 * asserts the native implementation reads as that rule.
 *
 * Plus the offline-lyrics axis (§"Offline lyrics"): a `present` lyric adds its measured bytes, a
 * `none` adds zero, and an unresolved lyric adds `LYRICS_ASSUMED_BYTES` and makes the figure
 * inexact (`up to`). The audio-only claims below pass rows with `none` lyrics so the audio math is
 * isolated from the lyric bound.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBytes, formatBytes, LYRICS_ASSUMED_BYTES, type IndexRow } from '../src/state/offline.ts';
import type { Song } from '../src/api/types.ts';

const song = (id: string, size: number | undefined, duration: number | undefined): Pick<Song, 'id' | 'size' | 'duration'> => ({ id, size, duration });

const row = (songId: string, lyrics?: IndexRow['lyrics']): IndexRow =>
  ({ songId, path: '', suffix: 'mp3', bytes: 0, state: 'complete', refs: [], title: '', artist: '', album: '', durationSec: 0, lyrics });

/** Rows that resolve every lyric to `none` (asked, nothing there) so audio math is isolated. */
const noneRows = (...ids: string[]): Map<string, IndexRow> =>
  new Map(ids.map((id) => [id, row(id, { state: 'none', bytes: 0 })]));

test('estimateBytes sums the exact size when every entry carries one', () => {
  const estimate = estimateBytes([song('a', 31_204_321, 231), song('b', 22_000_000, 180)], noneRows('a', 'b'));
  assert.equal(estimate.exact, true);
  assert.equal(estimate.total, 31_204_321 + 22_000_000);
});

test('a missing size falls back to the 320 kbit/s bound and is not exact', () => {
  const estimate = estimateBytes([song('a', 1_000_000, 100), song('b', undefined, 231)], noneRows('a', 'b'));
  assert.equal(estimate.exact, false);
  // 231 s at 40,000 B/s = 9,240,000 — above the 1 MB floor.
  assert.equal(estimate.total, 1_000_000 + 231 * 40_000);
});

test('the audio fallback never dips below one megabyte', () => {
  const estimate = estimateBytes([song('a', undefined, 1)], noneRows('a'));
  assert.equal(estimate.exact, false);
  assert.equal(estimate.total, 1_000_000);
});

test('zero entries is 0 B, exact', () => {
  const estimate = estimateBytes([]);
  assert.deepEqual(estimate, { total: 0, exact: true });
  assert.equal(formatBytes(estimate.total), '0 B');
});

test('formatBytes gives the owner the size he asked to see', () => {
  assert.equal(formatBytes(31_204_321), '29.8 MB');
  assert.equal(formatBytes(30 * 1024 * 1024), '30 MB');
  assert.equal(formatBytes(1_200_000_000), '1.1 GB');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(-5), '0 B');
});

/* ---------------------------------------------------- the offline-lyrics axis */

test('an unresolved lyric adds LYRICS_ASSUMED_BYTES and makes the figure inexact', () => {
  const estimate = estimateBytes([song('a', 31_204_321, 231)], new Map());
  assert.equal(estimate.exact, false);
  assert.equal(estimate.total, 31_204_321 + LYRICS_ASSUMED_BYTES);
});

test('a present lyric adds its real bytes and stays exact', () => {
  const rows = new Map([['a', row('a', { state: 'present', bytes: 4213 })]]);
  const estimate = estimateBytes([song('a', 31_204_321, 231)], rows);
  assert.equal(estimate.exact, true);
  assert.equal(estimate.total, 31_204_321 + 4213);
});

test('a none lyric adds zero and stays exact', () => {
  const rows = new Map([['a', row('a', { state: 'none', bytes: 0 })]]);
  const estimate = estimateBytes([song('a', 31_204_321, 231)], rows);
  assert.equal(estimate.exact, true);
  assert.equal(estimate.total, 31_204_321);
});

test('two playlists sharing a song count its lyric bytes once (deduped by songId)', () => {
  const rows = new Map([['a', row('a', { state: 'present', bytes: 4213 })]]);
  // The estimate is per song list; a shared song appears once per list and its row is looked up once.
  const estimate = estimateBytes([song('a', 31_204_321, 231), song('b', 22_000_000, 180)], rows);
  assert.equal(estimate.total, 31_204_321 + 22_000_000 + 4213 + LYRICS_ASSUMED_BYTES);
  assert.equal(estimate.exact, false);
});
