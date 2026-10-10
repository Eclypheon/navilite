/**
 * Shuffle and repeat — the two controls the owner asked for on the spectrum screen.
 *
 * Both rules are pure functions so they can be pinned here without an audio element or a
 * browser (`AudioEngine` needs `new Audio()`), which is the whole reason they were pulled
 * out of the queue class in v1.1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { identityOrder, planAdvance, shuffleOrder } from '../src/state/queue.ts';

const rngFrom = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

test('shuffle keeps the playing track first and every other track exactly once', () => {
  const order = shuffleOrder(8, 3, rngFrom([0.1, 0.9, 0.4, 0.7, 0.2, 0.5, 0.8]));
  assert.equal(order[0], 3, 'turning shuffle on must not interrupt what is playing');
  assert.equal(order.length, 8);
  assert.deepEqual([...order].sort((a, b) => a - b), identityOrder(8));
});

test('shuffle is deterministic for a given rng, and off is the identity', () => {
  const rng = rngFrom([0.5, 0.25, 0.75, 0.125]);
  assert.deepEqual(shuffleOrder(6, 1, rng), shuffleOrder(6, 1, rngFrom([0.5, 0.25, 0.75, 0.125])));
  // A degenerate rng still produces a permutation, not a repeated index.
  const flat = shuffleOrder(5, 0, () => 0);
  assert.deepEqual([...flat].sort((a, b) => a - b), identityOrder(5));
  assert.deepEqual(identityOrder(3), [0, 1, 2]);
});

test('a queue of one shuffles to itself', () => {
  assert.deepEqual(shuffleOrder(1, 0, () => 0.5), [0]);
  assert.deepEqual(shuffleOrder(0, -1), []);
});

test('the end of the queue stops, loops or repeats according to the mode', () => {
  // Track ended on its own.
  assert.deepEqual(planAdvance(2, 3, true, 'off'), { kind: 'stop' });
  assert.deepEqual(planAdvance(2, 3, true, 'all'), { kind: 'play', cursor: 0 });
  assert.deepEqual(planAdvance(1, 3, true, 'one'), { kind: 'repeat-current' });
  // …but repeat-one must not trap the next button.
  assert.deepEqual(planAdvance(2, 3, false, 'one'), { kind: 'play', cursor: 0 });
  assert.deepEqual(planAdvance(1, 3, false, 'one'), { kind: 'play', cursor: 2 });
});

test('a person pressing next always gets a track, and an empty queue stops', () => {
  assert.deepEqual(planAdvance(2, 3, false, 'off'), { kind: 'play', cursor: 0 });
  assert.deepEqual(planAdvance(0, 3, false, 'off'), { kind: 'play', cursor: 1 });
  assert.deepEqual(planAdvance(0, 0, true, 'all'), { kind: 'stop' });
  assert.deepEqual(planAdvance(0, 0, false, 'off'), { kind: 'stop' });
});
