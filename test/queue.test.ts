/**
 * The play-reporting rule: half the track, or four minutes, whichever is first.
 * Navidrome only counts a play on scrobble — never on stream — so this is the switch
 * that decides whether the library records the listen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { playThresholdMs, shouldSubmitPlay } from '../src/state/queue.ts';

test('uses half the track when that is under four minutes', () => {
  assert.equal(playThresholdMs(180_000), 90_000);
  assert.equal(shouldSubmitPlay(89_999, 180_000), false);
  assert.equal(shouldSubmitPlay(90_000, 180_000), true);
});

test('caps at four minutes for long tracks', () => {
  assert.equal(playThresholdMs(20 * 60_000), 240_000);
  assert.equal(shouldSubmitPlay(239_999, 20 * 60_000), false);
  assert.equal(shouldSubmitPlay(240_000, 20 * 60_000), true);
});

test('an unknown duration falls back to the four-minute cap', () => {
  assert.equal(playThresholdMs(0), 240_000);
  assert.equal(playThresholdMs(Number.NaN), 240_000);
  assert.equal(playThresholdMs(-5), 240_000);
});
