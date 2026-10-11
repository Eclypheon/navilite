/**
 * v1.9.2 — the slow link, measured the way that actually matters: time to first audio.
 *
 * The owner's bar is *"performant enough to run smoothly on mobile data … the load times should be
 * nigh imperceptible"*, and off wifi his phone reaches the house through a relay: desktop-class
 * latency, mobile-class throughput. Two client-side answers, neither of which needs a server change:
 *
 *   - **`maxBitRate` on the stream request.** Subsonic streams the original unless the client says
 *     otherwise; Navidrome transcodes on demand. It is *never* a silent cap: it starts modest on an
 *     unmeasured link, steps down when a start was slow, steps back up when a start was quick, and
 *     disappears entirely at the top of the ladder (the original plays).
 *   - **queue-ahead**, which is `test/queue-ahead.test.ts` — on a high-latency link the number of
 *     round trips matters more than the bandwidth.
 *
 * What changed from v1.9.0: the measurement is no longer a transfer's throughput but *how long a
 * start took, request to first audio*. That is the number the owner feels, it needs no byte
 * accounting, and a start that never produced sound is the strongest evidence of all.
 *
 * Everything here is pure or URL-shaped, so it runs in milliseconds and cannot be flaky.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BITRATE_LADDER,
  ByteRate,
  FAST_START_MS,
  SLOW_START_MS,
  STARTING_KBPS,
} from '../src/state/bitrate.ts';
import { Library } from '../src/state/library.ts';
import { SubsonicClient } from '../src/api/subsonic.ts';
import type { Song } from '../src/api/types.ts';

// The client reads `location` to decide whether a deployment is cross-origin.
(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://navilite.example' };

/** A start that took longer than "slow" — a phone on a relay — is a rung down. */
const SLOW_START = SLOW_START_MS + 500;
/** A start that beat "fast" — wifi — is a rung up. */
const FAST_START = Math.max(1, FAST_START_MS - 500);

const song = (id: string): Song => ({ id, title: `Track ${id}`, duration: 2 });

test('an unmeasured link starts modest, and asks for the cap rather than guessing fast', () => {
  const rate = new ByteRate();
  assert.equal(
    rate.maxBitRate,
    STARTING_KBPS,
    'nothing measured yet is not a licence to ask for the original',
  );
  assert.equal(rate.lastStartMs, null, 'and no number is shown until a start has actually been timed');
  assert.equal(rate.count, 0);
  assert.ok(
    STARTING_KBPS < BITRATE_LADDER[BITRATE_LADDER.length - 1]!,
    'the start is not the top of the ladder',
  );
  // Every stream request therefore carries the parameter — see test/queue-ahead.test.ts, which
  // asserts the URL a real tap produces.
  const url = new URL(
    new Library(
      new SubsonicClient({ serverUrl: 'https://navilite.example', username: 'k', password: 'p' }),
    ).streamUrl(song('song-1'), STARTING_KBPS),
  );
  assert.equal(url.searchParams.get('maxBitRate'), String(STARTING_KBPS));
});

test('a slow start steps the cap down, a fast one steps it up, and the top of the ladder is the original', () => {
  const slow = new ByteRate();
  slow.noteStart(SLOW_START);
  assert.equal(slow.lastStartMs, SLOW_START, 'the number the app shows is the one it measured');
  assert.equal(slow.maxBitRate, 96, 'one slow start asks for 96 kbps — below what the last start managed');

  let rate = new ByteRate();
  for (let i = 0; i < BITRATE_LADDER.length; i += 1) rate.noteStart(FAST_START);
  assert.equal(
    rate.maxBitRate,
    null,
    'climbing off the top of the ladder means "no cap": the original file plays',
  );

  rate = new ByteRate();
  rate.noteStart(SLOW_START);
  rate.noteStart(FAST_START);
  assert.equal(rate.maxBitRate, 128, 'a fast start after a slow one puts the cap back where it started');
});

test('a sample that is not a measurement is not one — the rung stands, and no number is invented', () => {
  const rate = new ByteRate();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) rate.noteStart(bad);
  assert.equal(rate.count, 0, 'nothing was learned, so nothing was recorded');
  assert.equal(rate.lastStartMs, null, 'and the app does not invent a number');
  assert.equal(rate.maxBitRate, STARTING_KBPS, 'so the rung stands');

  const client = new SubsonicClient({ serverUrl: 'https://navilite.example', username: 'k', password: 'p' });
  const library = new Library(client);
  assert.equal(
    library.streamUrl(song('song-1')).includes('maxBitRate'),
    false,
    'no cap means the original file, and no parameter at all',
  );
  assert.equal(new URL(library.streamUrl(song('song-1'), 96)).searchParams.get('maxBitRate'), '96');
});
