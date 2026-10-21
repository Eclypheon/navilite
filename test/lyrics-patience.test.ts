/**
 * The lyrics patience (v2.0-beta.24): a slow answer is not a cancelled one.
 *
 * The pane shows its empty message after `PATIENCE_MS`, and it used to *drop* the real answer at that
 * moment — so a slow link left "no lyrics yet" on screen for a track whose words arrived a second
 * later, while the README promised a late answer still paints. `deliverLyricsWithPatience` is the
 * whole rule, and it is driven here with plain promises (no DOM): an answer inside the window is
 * delivered once; a late one is delivered after the empty message; a source that throws is "no
 * lyrics", never an unhandled rejection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverLyricsWithPatience } from '../src/ui/lyrics.ts';
import type { LyricsDoc } from '../src/api/lyrics.ts';

const doc = (text: string): LyricsDoc => ({
  lines: [{ timeMs: null, text }],
  synced: false,
  source: 'route',
  fullRomaji: true,
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('an answer inside the patience is delivered once, and nothing expires', async () => {
  const delivered: Array<LyricsDoc | null> = [];
  let expired = 0;
  await deliverLyricsWithPatience(Promise.resolve(doc('fast')), 50, (value) => delivered.push(value), () => {
    expired += 1;
  });
  assert.deepEqual(delivered.map((value) => value?.lines[0]?.text), ['fast']);
  assert.equal(expired, 0);
});

test('a late answer still paints: the empty message first, then the words', async () => {
  const order: string[] = [];
  await deliverLyricsWithPatience(
    wait(30).then(() => doc('late')),
    5,
    (value) => order.push(`delivered:${value?.lines[0]?.text ?? 'none'}`),
    () => order.push('expired'),
  );
  /* The helper returns at the deadline; the late answer lands a moment after it. */
  assert.deepEqual(order, ['expired']);
  await wait(60);
  assert.deepEqual(order, ['expired', 'delivered:late']);
});

test('a source that throws is "no lyrics", not an unhandled rejection', async () => {
  const delivered: Array<LyricsDoc | null> = [];
  await deliverLyricsWithPatience(Promise.reject(new Error('offline')), 50, (value) => delivered.push(value), () => {
    throw new Error('an errored source is not a timeout');
  });
  assert.deepEqual(delivered, [null]);
});
