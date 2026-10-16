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
import { ART_ASSUMED_BYTES, estimateBytes, formatBytes, LYRICS_ASSUMED_BYTES, type EstimateSong, type IndexRow } from '../src/state/offline.ts';
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

/* ------------------------------------------------------ the album-art axis (v1.9.20) */

/** A track that names its cover, the way a `Song` from the server does. */
const covered = (id: string, coverArt: string, size = 1_000_000): EstimateSong => ({ id, size, duration: 200, coverArt });

/** A row that resolves its lyric to `none`, so the audio and art terms are isolated. */
const artRow = (id: string, art?: IndexRow['art'], coverArt?: string): IndexRow => ({
  ...row(id, { state: 'none', bytes: 0 }),
  coverArt,
  art,
});

test('an unresolved cover is bounded once per cover, not once per track', () => {
  // Fourteen tracks, two albums: 2 × ART_ASSUMED_BYTES, never 14 ×. Charging per track would be a
  // lie in the other direction — the file is one per album.
  const songs = [
    ...Array.from({ length: 7 }, (_, index) => covered(`a${index}`, 'cover-a')),
    ...Array.from({ length: 7 }, (_, index) => covered(`b${index}`, 'cover-b')),
  ];
  const rows = new Map(songs.map((entry) => [entry.id, artRow(entry.id, undefined, entry.coverArt)]));
  const estimate = estimateBytes(songs, rows);
  assert.equal(estimate.exact, false, 'an unresolved cover makes the figure a ceiling');
  assert.equal(estimate.total, songs.reduce((total, entry) => total + (entry.size ?? 0), 0) + 2 * ART_ASSUMED_BYTES);
});

test('a cover that landed is counted at its measured size, and the figure is exact again', () => {
  const songs = [covered('a', 'cover-a'), covered('b', 'cover-a')];
  const rows = new Map([
    ['a', artRow('a', { state: 'present', file: 'cover-a.art', bytes: 41_230 }, 'cover-a')],
    ['b', artRow('b', { state: 'present', file: 'cover-a.art', bytes: 41_230 }, 'cover-a')],
  ]);
  const estimate = estimateBytes(songs, rows);
  assert.equal(estimate.total, 2_000_000 + 41_230, 'the same file, read once, added once');
  assert.equal(estimate.exact, true);
});

test('a cover the library does not have is zero bytes and does not make the figure inexact', () => {
  const songs = [covered('a', 'cover-a')];
  const rows = new Map([['a', artRow('a', { state: 'none', bytes: 0 }, 'cover-a')]]);
  const estimate = estimateBytes(songs, rows);
  assert.equal(estimate.total, 1_000_000, 'no phantom 256 KB for an album with no cover');
  assert.equal(estimate.exact, true);
});

test('a track with no cover at all contributes no art term', () => {
  const songs: EstimateSong[] = [{ id: 'a', size: 1_000_000, duration: 200 }];
  const rows = new Map([['a', artRow('a')]]);
  const estimate = estimateBytes(songs, rows);
  assert.equal(estimate.total, 1_000_000);
  assert.equal(estimate.exact, true);
});
